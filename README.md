# teca-proxy-worker

## Descripción del Proyecto

Cloudflare Worker que actúa como **proxy inverso** hacia `api-service.teca.pe`, resolviendo CORS
y proveyendo un sistema de **paginación histórica automática** por fechas.

---

## Arquitectura

```
Cliente Web  ──GET/POST──▶  Cloudflare Worker  ──fetch──▶  api-service.teca.pe
                ◀──JSON──        (proxy)        ◀──JSON──
                 (CORS)       (paginación)
```

---

## Endpoints

| Método | Ruta | Descripción |
|--------|------|-------------|
| `GET` | `/api/query` | Consulta con `?codigo=X&token=Y` |
| `POST` | `/api/query` | Consulta con body JSON |
| `OPTIONS` | `/api/query` | Preflight CORS (automático) |

---

## Parámetros de entrada

### GET — Un par
```
GET /api/query?codigo=DEVICE001&token=mytoken123
```

### GET — Múltiples pares
```
GET /api/query?codigo=DEV001&token=tok1&codigo=DEV002&token=tok2
```

### POST JSON — Par único
```json
{ "codigo": "DEVICE001", "token": "mytoken123" }
```

### POST JSON — Múltiples pares
```json
{
  "pairs": [
    { "codigo": "DEV001", "token": "tok1" },
    { "codigo": "DEV002", "token": "tok2" }
  ]
}
```

---

## Respuesta JSON

```json
{
  "data": [ /* Array de registros (≤ 10 por página) */ ],
  "hasMore": true,
  "pairIndex": 0,
  "currentRange": {
    "init": "2026-07-06",
    "end": "2026-07-07"
  },
  "pageSize": 10
}
```

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `data` | `Array` | Registros de la página actual |
| `hasMore` | `boolean` | `false` cuando no hay más datos históricos |
| `currentRange` | `Object` | Rango de fechas consultado |
| `pageSize` | `number` | Tamaño de página (constante: 10) |

---

## Lógica de paginación histórica

```
1ª petición  → init = ayer,  end = hoy         → datos paginados
2ª petición  → buffer local (misma fecha)      → siguiente página
N-ésima…     → buffer agotado                  → retrocede 1 día
              → init = anteayer, end = ayer     → nuevos datos
              → si API devuelve []              → hasMore: false ✋
```

---

## Estado de sesión

El estado de paginación se almacena en una **cookie Base64**:
- Nombre: `teca_pgstate`
- Atributos: `HttpOnly; Secure; SameSite=None; Path=/; Max-Age=86400`
- Contenido: `PaginationState` serializado → JSON → Base64

El cliente solo necesita enviar la cookie en cada petición de "siguiente página" (los navegadores lo hacen automáticamente).

---

## URL de la API externa construida

```
https://api-service.teca.pe/v1.0/devices/{codigo}/report/json
  ?init={YYYY-MM-DD}
  &end={YYYY-MM-DD}
  &token={token}
```

---

## Headers CORS emitidos

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, OPTIONS
Access-Control-Allow-Headers: Content-Type, Authorization, X-Requested-With
Access-Control-Max-Age: 86400
```

---

## Stack técnico

- **Runtime**: Cloudflare Workers (ES Modules)
- **Framework**: Hono v4
- **Build**: Vite + @hono/vite-build
- **Deploy**: Cloudflare Pages
- **Tipos**: @cloudflare/workers-types

---

## Comandos

```bash
npm run build          # Compilar TypeScript → dist/
npm run dev            # Servidor de desarrollo (Vite)
npm run dev:sandbox    # Worker local en puerto 3000
npm run deploy         # Build + deploy a Cloudflare Pages
```

---

## Despliegue

- **Plataforma**: Cloudflare Pages
- **URL Producción**: https://teca-proxy-worker.pages.dev
- **URL de deploy**: https://fa2ec973.teca-proxy-worker.pages.dev
- **Estado**: ✅ En producción
- **Última actualización**: 2026-07-09
