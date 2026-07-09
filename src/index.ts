/**
 * ============================================================
 * CLOUDFLARE WORKER — Proxy Inverso con Paginación Histórica
 * ============================================================
 * Funcionalidad principal:
 *  - Proxy inverso hacia api-service.teca.pe para eludir CORS
 *  - Gestión de sesión de pares (codigo, token) vía cookie Base64
 *  - Paginación de resultados locales (>10 elementos → páginas)
 *  - Desplazamiento automático hacia atrás en el tiempo cuando
 *    se agotan los registros del rango actual
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

/** Un par de credenciales: código de dispositivo + token de acceso */
interface DevicePair {
  codigo: string;
  token: string;
}

/**
 * Estado de paginación almacenado en la cookie del cliente.
 * Se serializa/deserializa en Base64+JSON para mantener el estado
 * entre llamadas sin consumir KV ni memoria del Worker.
 */
interface PaginationState {
  /** Lista de pares (codigo, token) aportados por el cliente */
  pairs: DevicePair[];
  /** Índice del par actualmente en consulta */
  pairIndex: number;
  /** Fecha de inicio del rango actual (YYYY-MM-DD) */
  currentInit: string;
  /** Fecha de fin del rango actual (YYYY-MM-DD) */
  currentEnd: string;
  /** Buffer de registros ya obtenidos pero aún no entregados */
  buffer: Record<string, unknown>[];
  /** Offset dentro del buffer para la página actual */
  bufferOffset: number;
  /** Indica si la API remota ya devolvió vacío (sin más datos) */
  exhausted: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTES
// ─────────────────────────────────────────────────────────────────────────────

const PAGE_SIZE = 10;           // Elementos por página entregados al cliente
const COOKIE_NAME = 'teca_pgstate'; // Nombre de la cookie de estado
const API_BASE = 'https://api-service.teca.pe/v1.0/devices';
const FETCH_TIMEOUT_MS = 15_000; // Timeout para llamadas a la API externa

// ─────────────────────────────────────────────────────────────────────────────
// MANEJADOR PRINCIPAL
// ─────────────────────────────────────────────────────────────────────────────

/**
 * handleQuery — Punto de entrada para GET /api/query y POST /api/query
 *
 * Flujo:
 *  1. Leer parámetros `codigo` y `token` de la petición (GET query string o POST body)
 *  2. Decidir si es una sesión nueva o continuación de una existente (via cookie)
 *  3. Intentar servir desde el buffer local; si se agota, pedir al rango
 *     siguiente (un día más atrás) o devolver hasMore:false
 *  4. Devolver la página con la cookie actualizada
 */
async function handleQuery(request: Request): Promise<Response> {
  // ── 1. Extraer parámetros de la petición ──────────────────
  const incoming = await extractParams(request);
  const existingState = readStateFromCookie(request);

  let state: PaginationState;

  if (incoming.length > 0) {
    /**
     * El cliente envía nuevos pares → iniciar o refrescar la sesión.
     * Siempre arrancamos con end=hoy, init=ayer.
     */
    const today = formatDate(new Date());
    const yesterday = formatDate(shiftDays(new Date(), -1));

    state = {
      pairs: incoming,
      pairIndex: 0,
      currentInit: yesterday,
      currentEnd: today,
      buffer: [],
      bufferOffset: 0,
      exhausted: false,
    };

    // Cargar el primer lote desde la API externa
    state = await fillBuffer(state);
  } else if (existingState) {
    /**
     * No llegan pares nuevos → continuación de paginación.
     * Usamos el estado almacenado en la cookie.
     */
    state = existingState;
  } else {
    // Sin estado previo ni parámetros nuevos
    return corsResponse(
      jsonError(400, 'Se requieren los parámetros "codigo" y "token".')
    );
  }

  // ── 2. Obtener la página actual ───────────────────────────
  const { page, newState } = await getNextPage(state);

  // ── 3. Construir respuesta con cookie actualizada ─────────
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

  return corsResponseWithCookie(response, COOKIE_NAME, cookieValue);
}

// ─────────────────────────────────────────────────────────────────────────────
// LÓGICA DE PAGINACIÓN
// ─────────────────────────────────────────────────────────────────────────────

/**
 * getNextPage — Extrae una página del buffer y avanza el estado.
 *
 * Si el buffer está vacío (o totalmente consumido) y la API aún no
 * está agotada, desplaza el rango un día más atrás y vuelve a llenar.
 * Repite hasta tener datos o confirmar que no hay más.
 */
async function getNextPage(
  state: PaginationState
): Promise<{ page: Record<string, unknown>[]; newState: PaginationState }> {

  let current = { ...state };

  // Intentar servir desde el buffer existente
  if (current.bufferOffset < current.buffer.length) {
    const page = current.buffer.slice(
      current.bufferOffset,
      current.bufferOffset + PAGE_SIZE
    );
    current.bufferOffset += PAGE_SIZE;
    return { page, newState: current };
  }

  // Buffer consumido: si ya estaba agotado, no hay más datos
  if (current.exhausted) {
    return { page: [], newState: current };
  }

  /**
   * Desplazamiento hacia atrás: mover el rango UN DÍA más antiguo.
   * El nuevo end es el init anterior; el nuevo init es un día antes.
   */
  const prevEnd = parseDate(current.currentInit);
  const prevInit = shiftDays(prevEnd, -1);

  current = {
    ...current,
    currentEnd: formatDate(prevEnd),
    currentInit: formatDate(prevInit),
    buffer: [],
    bufferOffset: 0,
  };

  current = await fillBuffer(current);

  // Verificar de nuevo si hay datos tras el refill
  if (current.buffer.length === 0) {
    current.exhausted = true;
    return { page: [], newState: current };
  }

  const page = current.buffer.slice(0, PAGE_SIZE);
  current.bufferOffset = PAGE_SIZE;
  return { page, newState: current };
}

/**
 * fillBuffer — Consulta la API externa para el rango de fechas actual
 * y llena el buffer del estado.
 *
 * Itera sobre todos los pares (codigo, token) almacenados en la sesión.
 * Los resultados de todos los pares se concatenan en el buffer.
 * Si todos devuelven vacío → marca exhausted = true.
 */
async function fillBuffer(state: PaginationState): Promise<PaginationState> {
  const allRecords: Record<string, unknown>[] = [];

  for (const pair of state.pairs) {
    try {
      const records = await fetchFromAPI(
        pair.codigo,
        pair.token,
        state.currentInit,
        state.currentEnd
      );
      allRecords.push(...records);
    } catch (err: unknown) {
      // Un fallo en un par no debe tumbar toda la respuesta; se registra y continúa
      console.error(`Error obteniendo datos para codigo=${pair.codigo}:`, err);
    }
  }

  return {
    ...state,
    buffer: allRecords,
    bufferOffset: 0,
    exhausted: allRecords.length === 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// LLAMADA A LA API EXTERNA
// ─────────────────────────────────────────────────────────────────────────────

/**
 * fetchFromAPI — Realiza el fetch real a api-service.teca.pe
 * con el formato de URL requerido.
 *
 * URL: https://api-service.teca.pe/v1.0/devices/{codigo}/report/json
 *      ?init={fecha_inicio}&end={fecha_fin}&token={token}
 *
 * Incluye timeout manual usando AbortController para evitar
 * que el Worker quede bloqueado ante APIs lentas o caídas.
 */
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

  // La API puede devolver un array directamente o un objeto con propiedad "data"
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

  // Respuesta vacía o formato inesperado → tratar como vacío
  return [];
}

// ─────────────────────────────────────────────────────────────────────────────
// EXTRACCIÓN DE PARÁMETROS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * extractParams — Lee los pares (codigo, token) del request.
 *
 * Soporta:
 *  - GET: ?codigo=X&token=Y  (un solo par)
 *  - GET: ?codigo=X1&token=Y1&codigo=X2&token=Y2  (múltiples, getAll)
 *  - POST JSON: { codigo, token } o { pairs: [{codigo, token}, ...] }
 *  - POST form-data: código y token como campos
 */
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
        // Formato: { pairs: [{codigo, token}, ...] }
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
        // Formato: { codigo, token }
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

// ─────────────────────────────────────────────────────────────────────────────
// MANEJO DE ESTADO EN COOKIE (Base64 + JSON)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * encodeState — Serializa el estado de paginación a Base64.
 * Se almacena en una cookie HttpOnly; Secure; SameSite=None
 * para permitir peticiones cross-origin desde el frontend web.
 */
function encodeState(state: PaginationState): string {
  const json = JSON.stringify(state);
  return btoa(unescape(encodeURIComponent(json)));
}

/**
 * decodeState — Deserializa el estado desde Base64.
 * Devuelve null si el valor es inválido o ha sido manipulado.
 */
function decodeState(encoded: string): PaginationState | null {
  try {
    const json = decodeURIComponent(escape(atob(encoded)));
    const parsed = JSON.parse(json) as PaginationState;

    // Validación mínima de integridad
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

/**
 * readStateFromCookie — Extrae y decodifica el estado de paginación
 * desde la cookie de la petición entrante.
 */
function readStateFromCookie(request: Request): PaginationState | null {
  const cookieHeader = request.headers.get('Cookie') ?? '';
  const cookies = parseCookies(cookieHeader);
  const encoded = cookies[COOKIE_NAME];
  if (!encoded) return null;
  return decodeState(encoded);
}

/**
 * parseCookies — Parsea el header Cookie en un objeto clave/valor.
 */
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

/**
 * formatDate — Convierte un objeto Date a string YYYY-MM-DD
 * usando UTC para evitar desfases por zona horaria.
 */
function formatDate(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * parseDate — Convierte un string YYYY-MM-DD a objeto Date (UTC).
 */
function parseDate(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/**
 * shiftDays — Devuelve una nueva fecha desplazada N días.
 * Valores negativos mueven hacia atrás en el tiempo.
 */
function shiftDays(date: Date, days: number): Date {
  const result = new Date(date.getTime());
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS DE RESPUESTA
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Origen exacto del frontend autorizado.
 * Con credentials:true el navegador exige un origen explícito,
 * nunca un wildcard «*».
 */
const ALLOWED_ORIGIN = 'https://asocie.pages.dev';

/**
 * Cabeceras CORS que se inyectan en TODAS las respuestas
 * (200, 4xx, 5xx y preflight OPTIONS).
 *
 * Reglas clave:
 *  - Allow-Origin: origen exacto del frontend (no «*»)
 *  - Allow-Credentials: true  → el navegador enviará cookies cross-origin
 *  - Vary: Origin            → CDN/caché no reutiliza la respuesta para
 *                              otros orígenes
 */
const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin':      ALLOWED_ORIGIN,
  'Access-Control-Allow-Credentials': 'true',
  'Access-Control-Allow-Methods':     'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers':     'Content-Type, Authorization, X-Requested-With',
  'Access-Control-Max-Age':           '86400',
  'Vary':                             'Origin',
};

/**
 * corsResponse — Clona una Response inyectando las cabeceras CORS.
 */
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

/**
 * corsResponseWithCookie — Igual que corsResponse pero además
 * establece la cookie de estado de paginación.
 *
 * Atributos de la cookie:
 *  - HttpOnly: no accesible desde JS del cliente (seguridad)
 *  - Secure: sólo sobre HTTPS (obligatorio en producción)
 *  - SameSite=None: permite envío cross-origin (necesario para el proxy)
 *  - Path=/: disponible en toda la app
 *  - Max-Age=86400: expira en 24 horas
 */
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

/**
 * jsonError — Crea una Response JSON de error con la estructura estándar.
 */
function jsonError(status: number, message: string): Response {
  return new Response(
    JSON.stringify({ error: true, status, message }),
    {
      status,
      headers: { 'Content-Type': 'application/json' },
    }
  );
}
