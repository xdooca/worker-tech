/**
 * ============================================================
 * CLOUDFLARE WORKER — Proxy Inverso con Paginación Histórica
 * ============================================================
 */

export default {
  async fetch(request: Request, env: unknown, ctx: ExecutionContext): Promise<Response> {
    // ── Manejo de Preflight CORS ─────────────────────────────
    if (request.method === 'OPTIONS') {
      return corsResponse(new Response(null, { status: 204 }), request);
    }

    try {
      const url = new URL(request.url);

      // ── Rutas del Worker ─────────────────────────────────────
      if (url.pathname === '/api/query' || url.pathname === '/') {
        return handleQuery(request);
      }

      return corsResponse(
        jsonError(404, 'Ruta no encontrada. Usa /api/query'),
        request
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Error interno desconocido';
      return corsResponse(jsonError(500, msg), request);
    }
  },
};

const ALLOWED_ORIGINS = ['https://asocie.pages.dev', 'https://plabee.app'];
const PAGE_SIZE = 3;
const COOKIE_NAME = 'teca_pgstate';
const API_BASE = 'https://api-service.teca.pe/v1.0/devices';
const FETCH_TIMEOUT_MS = 15_000;
const INITIAL_WINDOW_DAYS = 2;
const MAX_BACKFILL_ITERATIONS = 5;

interface DevicePair {
  codigo: string;
  token: string;
}

interface PaginationState {
  pairs: DevicePair[];
  pairIndex: number;
  currentInit: string;
  currentEnd: string;
  buffer: Record<string, unknown>[];
  bufferOffset: number;
  exhausted: boolean;
}

async function handleQuery(request: Request): Promise<Response> {
  const incoming = await extractParams(request);
  const existingState = readStateFromCookie(request);

  let state: PaginationState;

  if (incoming.length > 0) {
    const today = formatDate(new Date());
    const initDay = formatDate(shiftDays(new Date(), -INITIAL_WINDOW_DAYS));

    state = {
      pairs: incoming,
      pairIndex: 0,
      currentInit: initDay,
      currentEnd: today,
      buffer: [],
      bufferOffset: 0,
      exhausted: false,
    };

    state = await fillBufferWithBackfill(state);
  } else if (existingState) {
    state = existingState;
  } else {
    return corsResponse(
      jsonError(400, 'Se requieren los parámetros "codigo" y "token".'),
      request
    );
  }

  const { page, newState } = await getNextPage(state);

  const cookieValue = encodeState(newState);
  const responseBody = {
    data: page,
    hasMore: !newState.exhausted || newState.bufferOffset < newState.buffer.length,
    pairIndex: newState.pairIndex,
    currentRange: {
      init: newState.currentInit,
      end: newState.currentEnd,
    },
    pageSize: PAGE_SIZE,
  };

  const response = new Response(JSON.stringify(responseBody), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

  return corsResponseWithCookie(response, COOKIE_NAME, cookieValue, request);
}

async function getNextPage(
  state: PaginationState
): Promise<{ page: Record<string, unknown>[]; newState: PaginationState }> {

  let current = { ...state };

  if (current.bufferOffset < current.buffer.length) {
    const page = current.buffer.slice(
      current.bufferOffset,
      current.bufferOffset + PAGE_SIZE
    );
    current.bufferOffset += PAGE_SIZE;
    return { page, newState: current };
  }

  if (current.exhausted) {
    return { page: [], newState: current };
  }

  const prevEnd  = parseDate(current.currentInit);
  const prevInit = shiftDays(prevEnd, -1);

  current = {
    ...current,
    currentEnd:   formatDate(prevEnd),
    currentInit:  formatDate(prevInit),
    buffer:       [],
    bufferOffset: 0,
  };

  current = await fillBufferWithBackfill(current);

  if (current.buffer.length === 0) {
    current.exhausted = true;
    return { page: [], newState: current };
  }

  const page = current.buffer.slice(0, PAGE_SIZE);
  current.bufferOffset = PAGE_SIZE;
  return { page, newState: current };
}

async function fillBufferWithBackfill(state: PaginationState): Promise<PaginationState> {
  let accumulated: Record<string, unknown>[] = [];
  let currentInit = state.currentInit;
  const currentEnd  = state.currentEnd;
  let iterations    = 0;
  let reachedEmpty  = false;

  while (accumulated.length < PAGE_SIZE && iterations < MAX_BACKFILL_ITERATIONS) {
    iterations++;

    const batchRecords: Record<string, unknown>[] = [];
    for (const pair of state.pairs) {
      try {
        const records = await fetchFromAPI(
          pair.codigo,
          pair.token,
          currentInit,
          currentEnd
        );
        batchRecords.push(...records);
      } catch (err: unknown) {
        console.error(
          `[backfill iter=${iterations}] Error para codigo=${pair.codigo}:`, err
        );
      }
    }

    accumulated.push(...batchRecords);

    if (batchRecords.length === 0 && accumulated.length === 0) {
      if (iterations >= MAX_BACKFILL_ITERATIONS) {
        reachedEmpty = true;
        break;
      }
    }

    if (accumulated.length >= PAGE_SIZE) break;

    const nextEnd  = parseDate(currentInit);
    const nextInit = shiftDays(nextEnd, -1);
    currentInit    = formatDate(nextInit);
  }

  return {
    ...state,
    currentInit:  currentInit,
    currentEnd:   currentEnd,
    buffer:       accumulated,
    bufferOffset: 0,
    exhausted:    reachedEmpty || (accumulated.length === 0),
  };
}

async function fetchFromAPI(
  codigo: string,
  token: string,
  init: string,
  end: string
): Promise<Record<string, unknown>[]> {
  const targetUrl = `${API_BASE}/${encodeURIComponent(codigo)}/report/json` +
    `?init=${encodeURIComponent(init)}&end=${encodeURIComponent(end)}&token=${encodeURIComponent(token)}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let apiResponse: Response;
  try {
    apiResponse = await fetch(targetUrl, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'CloudflareWorkerProxy/1.0',
      },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Timeout o error de red al contactar la API: ${msg}`);
  } finally {
    clearTimeout(timeoutId);
  }

  if (!apiResponse.ok) {
    throw new Error(
      `La API externa respondió con HTTP ${apiResponse.status} para codigo=${codigo}`
    );
  }

  let data: unknown;
  try {
    data = await apiResponse.json();
  } catch {
    throw new Error(`La API externa devolvió JSON inválido para codigo=${codigo}`);
  }

  if (Array.isArray(data)) {
    return data as Record<string, unknown>[];
  }

  if (
    data !== null &&
    typeof data === 'object' &&
    'data' in (data as object) &&
    Array.isArray((data as Record<string, unknown>).data)
  ) {
    return (data as Record<string, unknown>).data as Record<string, unknown>[];
  }

  return [];
}

async function extractParams(request: Request): Promise<DevicePair[]> {
  const url = new URL(request.url);
  const pairs: DevicePair[] = [];

  if (request.method === 'GET') {
    const codigos = url.searchParams.getAll('codigo');
    const tokens = url.searchParams.getAll('token');

    for (let i = 0; i < Math.min(codigos.length, tokens.length); i++) {
      if (codigos[i] && tokens[i]) {
        pairs.push({ codigo: codigos[i].trim(), token: tokens[i].trim() });
      }
    }
    return pairs;
  }

  if (request.method === 'POST') {
    const contentType = request.headers.get('content-type') ?? '';

    if (contentType.includes('application/json')) {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return [];
      }

      if (
        body !== null &&
        typeof body === 'object' &&
        'pairs' in (body as object) &&
        Array.isArray((body as Record<string, unknown>).pairs)
      ) {
        const rawPairs = (body as Record<string, unknown>).pairs as unknown[];
        for (const p of rawPairs) {
          if (
            p !== null &&
            typeof p === 'object' &&
            'codigo' in (p as object) &&
            'token' in (p as object)
          ) {
            const pair = p as Record<string, unknown>;
            pairs.push({
              codigo: String(pair.codigo).trim(),
              token: String(pair.token).trim(),
            });
          }
        }
      } else if (
        body !== null &&
        typeof body === 'object' &&
        'codigo' in (body as object) &&
        'token' in (body as object)
      ) {
        const b = body as Record<string, unknown>;
        pairs.push({ codigo: String(b.codigo).trim(), token: String(b.token).trim() });
      }

    } else if (
      contentType.includes('application/x-www-form-urlencoded') ||
      contentType.includes('multipart/form-data')
    ) {
      const form = await request.formData();
      const codigos = form.getAll('codigo') as string[];
      const tokens = form.getAll('token') as string[];

      for (let i = 0; i < Math.min(codigos.length, tokens.length); i++) {
        if (codigos[i] && tokens[i]) {
          pairs.push({ codigo: codigos[i].trim(), token: tokens[i].trim() });
        }
      }
    }
  }

  return pairs;
}

function encodeState(state: PaginationState): string {
  const json = JSON.stringify(state);
  return btoa(unescape(encodeURIComponent(json)));
}

function decodeState(encoded: string): PaginationState | null {
  try {
    const json = decodeURIComponent(escape(atob(encoded)));
    const parsed = JSON.parse(json) as PaginationState;

    if (
      !Array.isArray(parsed.pairs) ||
      typeof parsed.currentInit !== 'string' ||
      typeof parsed.currentEnd !== 'string' ||
      !Array.isArray(parsed.buffer)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function readStateFromCookie(request: Request): PaginationState | null {
  const cookieHeader = request.headers.get('Cookie') ?? '';
  const cookies = parseCookies(cookieHeader);
  const encoded = cookies[COOKIE_NAME];
  if (!encoded) return null;
  return decodeState(encoded);
}

function parseCookies(cookieHeader: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of cookieHeader.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key) {
      result[key.trim()] = decodeURIComponent(rest.join('=').trim());
    }
  }
  return result;
}

function formatDate(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseDate(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function shiftDays(date: Date, days: number): Date {
  const result = new Date(date.getTime());
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function getCorsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get('Origin') || '';
  const isAllowed = ALLOWED_ORIGINS.includes(origin);
  
  return {
    'Access-Control-Allow-Origin': isAllowed ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods':     'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers':     'Content-Type, Authorization, X-Requested-With',
    'Access-Control-Max-Age':           '86400',
    'Vary':                             'Origin',
  };
}

function corsResponse(response: Response, request: Request): Response {
  const newHeaders = new Headers(response.headers);
  const cors = getCorsHeaders(request);
  for (const [key, value] of Object.entries(cors)) {
    newHeaders.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
}

function corsResponseWithCookie(
  response: Response,
  cookieName: string,
  cookieValue: string,
  request: Request
): Response {
  const newHeaders = new Headers(response.headers);
  const cors = getCorsHeaders(request);
  for (const [key, value] of Object.entries(cors)) {
    newHeaders.set(key, value);
  }

  const cookieStr =
    `${cookieName}=${encodeURIComponent(cookieValue)}; ` +
    'HttpOnly; Secure; SameSite=None; Path=/; Max-Age=86400';
  newHeaders.append('Set-Cookie', cookieStr);

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
}

function jsonError(status: number, message: string): Response {
  return new Response(
    JSON.stringify({ error: true, status, message }),
    {
      status,
      headers: { 'Content-Type': 'application/json' },
    }
  );
}
