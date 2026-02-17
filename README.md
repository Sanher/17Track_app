# 17Track App

Servidor Node.js para gestionar trackings de 17Track por owner (por ejemplo `david` y `mireia`) y exponer una API REST pensada para integrarse con Home Assistant.

## Características

- Alta/baja/listado de trackings por owner.
- Consulta de estado normalizado por tracking.
- Resolución por alias/nota (`/resolve`).
- Override manual de `delivered` por tracking.
- Refresco manual y refresco condicional en background.
- Logs estructurados para requests y llamadas a 17Track.

## Requisitos

- Node.js 20+ (recomendado).
- Token de API de 17Track (`TRACK17_TOKEN`).

## Arranque local

```bash
npm ci
TRACK17_TOKEN="tu_token" npm start
```

Por defecto escucha en `8787`.

## Variables de entorno

- `TRACK17_TOKEN`: token de 17Track (obligatorio).
- `PORT`: puerto HTTP (default `8787`).
- `DATA_DIR`: carpeta de persistencia (default `./data`).
- `APP_LOG_LEVEL`: `debug|info|warn|error` (default `info`).
- `TRACK17_TIMEOUT_MS`: timeout de llamadas a 17Track (default `15000`).

Background refresher:

- `BG_ENABLED` (`1|true|yes|on` para activar).
- `BG_INTERVAL_MIN` (default `15`).
- `BG_NORMAL_INTERVAL_MIN` (default `45`).
- `BG_SLOW_HOURS` (CSV, default `"8,20"`).
- `BG_DELAY_MS` (default `5000`).
- `DELIVERED_RETENTION_DAYS` (default `7`, `0` desactiva borrado automático de entregados).

Integración con Home Assistant (notificaciones):

- `HA_URL`
- `HA_TOKEN`
- `HA_SCRIPT` (default `jarvis_17track_notify`)

## Endpoints principales

- `GET /health`
- `GET /api/_build`
- `GET /api/carriers`
- `GET /api/owner/:owner/trackings`
- `POST /api/owner/:owner/tracking`
- `DELETE /api/owner/:owner/tracking/:tracking`
- `POST /api/owner/:owner/tracking/:tracking/override`
- `GET /api/owner/:owner/resolve?q=...`
- `POST /api/owner/:owner/refresh_if_needed`
- `GET /api/bg/status`

## Ejemplos rápidos

```bash
# Listar trackings de david
curl http://localhost:8787/api/owner/david/trackings

# Añadir tracking
curl -X POST http://localhost:8787/api/owner/david/tracking \
  -H "Content-Type: application/json" \
  -d '{"tracking":"PH7NAW040990190G","carrier_alias":"correos","note":"cafetera"}'

# Borrar tracking
curl -X DELETE http://localhost:8787/api/owner/david/tracking/PH7NAW040990190G
```

## Persistencia

El estado se guarda en `DATA_DIR/store.json`.

## Troubleshooting de refresco

- Si `GET /api/bg/status` devuelve `enabled=false`, no hay refresco automático.
- Activa `BG_ENABLED` en la config del add-on y reinicia.
- Puedes arrancarlo manualmente para diagnóstico con `POST /api/bg/start`.
- Si un owner no tiene trackings, el refresco se omite (`reason: no_trackings`).

## Estado del proyecto

Este repo contiene la app backend.  
La definición de add-on de Home Assistant vive en tu repo `sanher-ha-addons`.
