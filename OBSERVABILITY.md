# Observability & reliability

This service exposes **liveness**, **readiness**, and **Prometheus metrics** endpoints to support production operations.

## Endpoints

- **Liveness**: `GET /api/health`
  - Returns `200` when the process is up.
- **Readiness**: `GET /api/ready`
  - Returns `200` only when required dependencies are ready (DB initialized + Redis reachable).
  - Returns `503` while shutting down.
- **Metrics**: `GET /metrics`
  - Prometheus text format metrics (process metrics + HTTP metrics + websocket client gauge).

## Docker Compose (production)

`docker-compose.yml` includes a `prometheus` service that scrapes the backend `/metrics` endpoint and forwards samples via **remote_write**.

### Required environment variables

- **`PROM_REMOTE_WRITE_URL`**: remote_write endpoint URL (set in `.env` loaded by docker compose).

### Quick validation

From your host machine:

- `curl http://localhost:3000/api/health`
- `curl http://localhost:3000/api/ready`
- `curl http://localhost:3000/metrics | head`

Prometheus UI (optional):

- Open `http://localhost:9090` and verify target `backend` is **UP**.

## FreeRADIUS NOC metrics

The RADIUS container runs a Status-Server → Prometheus exporter when `RADIUS_METRICS_ENABLED=1` (default).

- **Exporter**: `http://<radius-host>:9812/metrics`
- **Scrape job**: `freeradius` in `observability/prometheus/prometheus.yml.tmpl` → `host.docker.internal:9812`
- **Alerts**: `FreeRadiusDown`, `FreeRadiusHighRejectRate` in `observability/prometheus/alerts.yml`

### Quick validation

- `curl http://localhost:9812/metrics | head`
- In Prometheus UI, verify target `freeradius` is **UP**
- Minimum metrics: `freeradius_up`, `freeradius_access_requests_total`, `freeradius_access_accepts_total`, `freeradius_access_rejects_total`, `freeradius_accounting_requests_total`

### Env

- `RADIUS_METRICS_ENABLED=1`
- `RADIUS_METRICS_PORT=9812`

## Notes

- If Redis or DB are down/unreachable, `/api/ready` returns `503` so orchestrators can avoid routing traffic.
- On `SIGTERM`/`SIGINT`, the server performs a best-effort graceful shutdown: stop cron, stop accepting new HTTP, close websockets, quit Redis, destroy DB.

