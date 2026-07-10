/**
 * ============================================================
 * CLOUDFLARE WORKER — Proxy Inverso con Paginación Histórica
 * ============================================================
 * Funcionalidad principal:
 *  - Proxy inverso hacia api-service.teca.pe para eludir CORS
 *  - Gestión de sesión híbrida (Cookie, Cabecera X-Pagination-State o Body/Query Param)
 *  - Paginación robusta local de 5 elementos para evitar Timeouts
 *  - Desplazamiento automático hacia atrás en el tiempo con retroceso incremental
 *  - Condición de parada cuando la API remota devuelve vacío
 * ============================================================
 */


export default {
  async fetch(request: Request, env: unknown, ctx: ExecutionContext): Promise<Response> {
    // ── Manejo de Preflight CORS ─────────────────────────────
    if (request.method === 'OPTIONS') {
      return corsResponse(new Response(null, { status: 204 }));
    }

    try {
      const url = new URL(request.url);

      // ── Rutas del Worker ─────────────────────────────────────
      if (url.pathname === '/api/query' || url.pathname === '/') {
        return handleQuery(request);
      }

      return corsResponse(
        jsonError(404, 'Ruta no encontrada. Usa /api/query')
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Error interno desconocido';
      return corsResponse(jsonError(500, msg));
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// TIPOS
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTES
// ─────────────────────────────────────────────────────────────────────────────


const PAGE_SIZE = 5;               // Reducido a 5 elementos para prevenir límites de CPU
const COOKIE_NAME = 'teca_pgstate'; // Nombre de la cookie de respaldo
const API_BASE = 'https://api-service.teca.pe/v1.0/devices';
const FETCH_TIMEOUT_MS = 15_000;   // Timeout de red

const INITIAL_WINDOW_DAYS = 2;     // Ventana inicial de 2 días
const MAX_BACKFILL_ITERATIONS = 5; // Límite de retrocesos para no colapsar la CPU

// ─────────────────────────────────────────────────────────────────────────────
// MANEJADOR PRINCIPAL
// ─────────────────────────────────────────────────────────────────────────────


async function handleQuery(request: Request): Promise<Response> {
  // Extraemos los parámetros de forma unificada (POST/GET) y posibles estados
  const payload = await parseRequestPayload(request);

  // Intentamos leer el estado de sesión de 3 fuentes para máxima resiliencia:
  // 1. Cabecera personalizada 'X-Pagination-State' (Ideal para bypass de bloqueo de cookies)
  // 2. Parámetro explícito 'state' o 'cursor' (enviado por Body o Query string)
  // 3. Cookies tradicionales (como respaldo)
  let state: PaginationState | null = null;

  const headerState = request.headers.get('X-Pagination-State');
  if (headerState) {
    state = decodeState(headerState);
  }

  if (!state && payload.stateStr) {
    state = decodeState(payload.stateStr);
  }

  if (!state) {
    state = readStateFromCookie(request);
  }

  let activeState: PaginationState;

  if (payload.pairs.length > 0 && !state) {
    /**
     * Iniciar nueva sesión con credenciales provistas por el cliente
     */
    const today = formatDate(new Date());
    const initDay = formatDate(shiftDays(new Date(), -INITIAL_WINDOW_DAYS));

    activeState = {
      pairs: payload.pairs,
      pairIndex: 0,
      currentInit: initDay,
      currentEnd: today,
      buffer: [],
      bufferOffset: 0,
      exhausted: false,
    };

    activeState = await fillBufferWithBackfill(activeState);
  } else if (state) {
    /**
     * Continuación de sesión
     */
    activeState = state;
  } else {
    return corsResponse(
      jsonError(400, 'Se requieren los parámetros "codigo" y "token", o un "X-Pagination-State" / "state" válido.')
    );
  }

  // ── 2. Obtener la página de resultados actual ─────────────
  const { page, newState } = await getNextPage(activeState);

  // ── 3. Construir respuesta con estado serializado ─────────
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
    // Devolvemos el estado en el Body para que el frontend pueda persistirlo localmente
    state: cookieValue, 
  };

  const response = new Response(JSON.stringify(responseBody), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

  return corsResponseWithCookie(response, COOKIE_NAME, cookieValue);
}

// ─────────────────────────────────────────────────────────────────────────────
// LÓGICA DE PAGINACIÓN
// ─────────────────────────────────────────────────────────────────────────────


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

// ─────────────────────────────────────────────────────────────────────────────
// LLAMADA A LA API EXTERNA
// ─────────────────────────────────────────────────────────────────────────────


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

// ─────────────────────────────────────────────────────────────────────────────
// EXTRACCIÓN DE PARÁMETROS Y PAYLOAD
// ─────────────────────────────────────────────────────────────────────────────


interface RequestPayload {
  pairs: DevicePair[];
  stateStr?: string;
}

async function parseRequestPayload(request: Request): Promise<RequestPayload> {
  const url = new URL(request.url);
  const pairs: DevicePair[] = [];
  let stateStr: string | undefined = url.searchParams.get('state') || url.searchParams.get('cursor') || undefined;

  const codigos = url.searchParams.getAll('codigo');
  const tokens = url.searchParams.getAll('token');

  for (let i = 0; i < Math.min(codigos.length, tokens.length); i++) {
    if (codigos[i] && tokens[i]) {
      pairs.push({ codigo: codigos[i].trim(), token: tokens[i].trim() });
    }
  }

  if (request.method === 'POST') {
    const contentType = request.headers.get('content-type') ?? '';

    if (contentType.includes('application/json')) {
      try {
        const body = await request.clone().json() as any;
        if (body && typeof body === 'object') {
          if (body.state && typeof body.state === 'string') stateStr = body.state;
          if (body.cursor && typeof body.cursor === 'string') stateStr = body.cursor;

          if (Array.isArray(body.pairs)) {
            for (const p of body.pairs) {
              if (p && typeof p === 'object' && 'codigo' in p && 'token' in p) {
                pairs.push({
                  codigo: String(p.codigo).trim(),
                  token: String(p.token).trim(),
                });
              }
            }
          } else if ('codigo' in body && 'token' in body) {
            pairs.push({
              codigo: String(body.codigo).trim(),
              token: String(body.token).trim(),
            });
          }
        }
      } catch {}
    } else if (
      contentType.includes('application/x-www-form-urlencoded') ||
      contentType.includes('multipart/form-data')
    ) {
      try {
        const form = await request.clone().formData();
        const formState = form.get('state') || form.get('cursor');
        if (formState && typeof formState === 'string') stateStr = formState;

        const formCodigos = form.getAll('codigo') as string[];
        const formTokens = form.getAll('token') as string[];

        for (let i = 0; i < Math.min(formCodigos.length, formTokens.length); i++) {
          if (formCodigos[i] && formTokens[i]) {
            pairs.push({ codigo: formCodigos[i].trim(), token: formTokens[i].trim() });
          }
        }
      } catch {}
    }
  }

  return { pairs, stateStr };
}

// ─────────────────────────────────────────────────────────────────────────────
// MANEJO DE ESTADO
// ─────────────────────────────────────────────────────────────────────────────


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

// ─────────────────────────────────────────────────────────────────────────────
// UTILIDADES DE FECHAS
// ─────────────────────────────────────────────────────────────────────────────


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

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS DE RESPUESTA Y CORS
// ─────────────────────────────────────────────────────────────────────────────


const ALLOWED_ORIGIN = 'https://asocie.pages.dev';

// Importante: Agregamos 'X-Pagination-State' a las cabeceras permitidas por CORS
const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin':      ALLOWED_ORIGIN,
  'Access-Control-Allow-Credentials': 'true',
  'Access-Control-Allow-Methods':     'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers':     'Content-Type, Authorization, X-Requested-With, X-Pagination-State',
  'Access-Control-Max-Age':           '86400',
  'Vary':                             'Origin',
};

function corsResponse(response: Response): Response {
  const newHeaders = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
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
  cookieValue: string
): Response {
  const newHeaders = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
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
