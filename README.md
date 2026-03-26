# HA IMAP Tracker

Servidor Node.js para gestionar paquetes por owner (por ejemplo `owner_a` y `owner_b`) y exponer una API REST pensada para integrarse con Home Assistant.

## Características

- Alta/baja/listado de trackings por owner.
- Soporte IMAP-only (`source=imap`).
- Consulta de estado normalizado por tracking.
- Resolución por alias/nota (`/resolve`).
- Override manual de `delivered` por tracking.
- Refresco manual y refresco condicional en background.
- Logs estructurados para requests y auditoría.
- Worker IMAP para ingesta de eventos desde buzones (Gmail/Outlook).
- Interfaz web ligera para revisar paquetes por owner y corregir alias/courier.

## Requisitos

- Node.js 20+ (recomendado).
- Python 3.10+ (para ejecutar el worker IMAP).

## Arranque local

```bash
npm ci
npm start
```

Por defecto escucha en `8787`.

Worker IMAP (ejecucion manual):

```bash
npm run imap:worker
```

## Variables de entorno

- `PORT`: puerto HTTP (default `8787`).
- `DATA_DIR`: carpeta de persistencia (default `./data`).
- `APP_LOG_LEVEL`: `debug|info|warn|error` (default `info`).
- `APP_JSON_LIMIT`: límite de payload JSON (default `256kb`).
- `APP_API_KEY`: si se define, protege la API (excepto `/health` y `/api/_build`) con `X-API-Key` o `Authorization: Bearer`.
- `IMAP_ACCOUNTS_JSON`: array JSON de cuentas IMAP para el worker.
- `IMAP_ACCOUNTS_FILE`: ruta a fichero JSON de cuentas (alternativa a `IMAP_ACCOUNTS_JSON`).
- `IMAP_DEFAULT_OWNER`: owner por defecto para cuentas sin `owner`.
- `IMAP_WORKER_DOTENV_PATH`: ruta del `.env` que carga el worker (default `.env`).
- `IMAP_INGEST_BASE_URL`: base URL del backend (default `http://127.0.0.1:8787`).
- `IMAP_INGEST_API_KEY`: API key para `POST /imap/ingest` (si no se define, usa `APP_API_KEY`).
- `IMAP_WORKER_STATE_PATH`: estado del worker (default `./data/imap_worker_state.json`).
- `IMAP_WORKER_LOOKBACK_DAYS`: dias a revisar en primera ejecucion (default `60`).
- `IMAP_WORKER_FETCH_LIMIT`: maximo de mensajes nuevos por cuenta y ejecucion (default `120`).
- `IMAP_INGEST_BATCH_SIZE`: tamano de lote por POST (default `100`).
- `IMAP_INGEST_TIMEOUT_SEC`: timeout HTTP/IMAP del worker (default `20`).
- `IMAP_WORKER_DRY_RUN`: si `true`, no envia al backend.

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
- `HA_AUDIT_LOG_ENABLED` (`1|true|yes|on`) para enviar eventos de auditoría al logbook de HA.
- `HA_AUDIT_LOG_LEVEL`: `debug|info|warn|error` (default `warn`).
- `HA_AUDIT_LOG_NAME`: nombre en logbook (default `HA IMAP Tracker`).
- `HA_AUDIT_LOG_ENTITY_ID`: opcional, para asociar entradas a una entidad.

## Worker IMAP

El worker lee buzones y empuja eventos a `/api/owner/:owner/imap/ingest`.
`source=imap` es la única fuente activa.
En primera ejecución, el lookback por defecto queda limitado a los últimos dos meses.

## UI web

La app sirve una UI en `/` y `/ui` para uso local o via ingress del add-on.

- Agrupa paquetes por owner.
- Permite editar alias y courier manual para IMAP.
- Permite marcar `delivered` o `undelivered`.
- Permite borrar entradas antiguas o incorrectas.
- La retención de entregados sigue en `7` días si no se revierten a `undelivered`.

Configura `IMAP_ACCOUNTS_JSON` con un objeto por cuenta:

```json
[
  {
    "email": "correo1@gmail.com",
    "provider": "gmail",
    "owner": "owner_a",
    "auth": "password",
    "password_env": "IMAP_GMAIL_1_APP_PASSWORD"
  },
  {
    "email": "correo6@outlook.com",
    "provider": "outlook",
    "owner": "owner_b",
    "auth": "oauth2",
    "tenant": "consumers",
    "client_id_env": "OUTLOOK_IMAP_CLIENT_ID",
    "client_secret_env": "OUTLOOK_IMAP_CLIENT_SECRET",
    "refresh_token_env": "OUTLOOK_IMAP_REFRESH_TOKEN"
  }
]
```

Notas:

- Gmail: usa app passwords (`auth=password`) y guarda el valor real en la env var indicada por `password_env`.
- `password_env` debe contener el nombre de variable (ej: `IMAP_GMAIL_1_APP_PASSWORD`), no la password literal.
- Outlook: usa OAuth2 (`auth=oauth2`) con `client_id`, `client_secret` y `refresh_token` en env vars.
- No subas secretos al repo: usa `.env` local o secretos del add-on en Home Assistant.

Filtros opcionales por cuenta (`filters` dentro de cada objeto):

- `only_amazon` (`true|false`): exige remitente/contenido relacionado con Amazon.
- `allowed_sender_domains` (`string[]`): lista blanca de dominios remitente.
- `required_keywords_all` (`string[]`): todas deben aparecer en asunto/cuerpo.
- `required_keywords_any` (`string[]`): al menos una debe aparecer.
- `reject_keywords_any` (`string[]`): si alguna aparece, se descarta.
- `destination_keywords_all` (`string[]`): alias semantico para destino (ej. `["mislata"]`).
- `require_dkim_pass` / `require_spf_pass` / `require_dmarc_pass` (`true|false`): valida `Authentication-Results`.

Ejemplo cuenta con filtro "solo Amazon para Mislata":

```json
{
  "email": "filtro@correo.com",
  "provider": "gmail",
  "owner": "owner_b",
  "auth": "password",
  "password_env": "IMAP_GMAIL_FILTER_APP_PASSWORD",
  "filters": {
    "only_amazon": true,
    "destination_keywords_all": ["mislata"],
    "allowed_sender_domains": ["amazon.es", "amazon.com"],
    "require_dkim_pass": true
  }
}
```

## Endpoints principales

- `GET /health`
- `GET /api/_build`
- `GET /api/owner/:owner/trackings`
- `POST /api/owner/:owner/tracking`
- `DELETE /api/owner/:owner/tracking/:tracking`
- `POST /api/owner/:owner/tracking/:tracking/override`
- `GET /api/owner/:owner/resolve?q=...`
- `POST /api/owner/:owner/refresh_if_needed`
- `GET /api/bg/status`
- `GET /api/ui/owners`
- `GET /api/owner/:owner/imap/accounts`
- `POST /api/owner/:owner/imap/accounts`
- `DELETE /api/owner/:owner/imap/accounts/:email`
- `POST /api/owner/:owner/imap/ingest`
- `PATCH /api/owner/:owner/tracking/:tracking/meta`

Nota de seguridad: `GET /api/store` devuelve el estado completo. En producción activa `APP_API_KEY`.

## Ejemplos rápidos

```bash
# Listar trackings de owner_a
curl http://localhost:8787/api/owner/owner_a/trackings

# Añadir tracking
curl -X POST http://localhost:8787/api/owner/owner_a/tracking \
  -H "Content-Type: application/json" \
  -d '{"tracking":"PH7NAW040990190G","note":"cafetera"}'

# Añadir tracking con source imap
curl -X POST http://localhost:8787/api/owner/owner_a/tracking \
  -H "Content-Type: application/json" \
  -d '{"tracking":"AMZ-ORDER-123","source":"imap","imap_account":"owner_a@example.com","note":"amazon"}'

# Ingesta de eventos IMAP (normalmente desde un worker externo)
curl -X POST http://localhost:8787/api/owner/owner_a/imap/ingest \
  -H "Content-Type: application/json" \
  -d '{"account_email":"owner_a@example.com","items":[{"tracking":"AMZ-ORDER-123","status":"in_transit","description":"En camino","is_out_for_delivery":false}]}'

# Borrar tracking
curl -X DELETE http://localhost:8787/api/owner/owner_a/tracking/PH7NAW040990190G
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
