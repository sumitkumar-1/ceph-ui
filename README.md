# Ceph UI (Java + Vanilla JS)

Standalone lightweight Ceph S3 browser:
- Java backend proxy (Javalin + AWS SDK v2)
- Vanilla HTML/CSS/JS frontend, synced into backend resources at run/build time
- In-memory short-lived sessions (no persistent credential storage, no cache)
- Built-in dark mode toggle (persisted in browser localStorage)
- CLI companion for API-driven browse/inspect workflows

## Project Layout

- `backend/` Java service, API, and Maven build
- `frontend/` source UI assets (`public/`)
- `scripts/` helper scripts for local run and image build
- `ckp/` Kubernetes manifests for corporate deployment

Using `backend/` + `frontend/` folders is the better long-term structure because it keeps backend and UI concerns isolated while still letting us ship one standalone app artifact.

## Run Locally

Requirements:
- Java 17+
- Maven 3.9+

```bash
./scripts/run-local.sh
```

Open:
- `http://localhost:8080`

Port override:

```bash
PORT=9090 ./scripts/run-local.sh
```

## CLI Companion

Use the CLI against the running backend (`http://localhost:8080` by default):

```bash
./scripts/ceph-cli.sh connect --endpoint http://localhost:7480 --access-key CKPDEMOACCESSKEY01 --secret-key CKPDEMOSECRETKEY01 --path-style true
./scripts/ceph-cli.sh buckets
./scripts/ceph-cli.sh objects --bucket ckp-demo-bulk --prefix batch-a/
./scripts/ceph-cli.sh search --bucket ckp-demo-bulk --prefix batch-a/ --query object-00
./scripts/ceph-cli.sh lifecycle --bucket ckp-demo-logs
./scripts/ceph-cli.sh policy --bucket ckp-demo-docs
```

Session is saved to `.ceph-ui-cli-session.json` (override with `CEPH_UI_SESSION_FILE`).

## Docker

Build image:

```bash
./scripts/build-image.sh
```

Run image:

```bash
docker run --rm -p 8080:8080 ceph-ui:local
```

## Corporate Deploy (Kubernetes)

Manifest bundle:

- `ckp/ceph-ui-k8s.yaml` (Namespace + Deployment + Service + Ingress)

Before apply, update:

1. Deployment image:
   - `your-registry.example.com/platform/ceph-ui:latest`
2. Ingress host:
   - `ceph-ui.example.corp`
3. TLS secret name (if used):
   - `ceph-ui-tls`
4. Ingress class (if not nginx):
   - `spec.ingressClassName`

Apply:

```bash
kubectl apply -f ckp/deployment.yaml
```

## Ceph Demo (Seeded)

Start a local Ceph demo RGW and seed sample data:

```bash
./scripts/ceph-demo-up.sh reef
```

Or:

```bash
./scripts/ceph-demo-up.sh squid
```

This script:
- Starts `quay.io/ceph/demo:<release>`
- Forces `RGW_NAME=localhost` so host-based bucket routing works with `http://localhost:7480`
- Creates a demo S3 user (if missing)
- Seeds buckets, prefixes, objects, object tags, bucket lifecycle and bucket policy
- Includes `ckp-demo-bulk` with 200 objects for virtual scrolling validation
- Prints endpoint + credentials for UI login

If your registry does not have those tags, override image explicitly:

```bash
CEPH_DEMO_IMAGE=quay.io/ceph/demo:latest ./scripts/ceph-demo-up.sh reef
```

Stop and remove demo container:

```bash
./scripts/ceph-demo-down.sh
```

## Implemented API

- `POST /api/connect`
  - Body: `{ endpoint, accessKey, secretKey, region, pathStyle }`
  - Returns: `{ sessionId }`
- `GET /api/buckets?sessionId=...`
- `GET /api/objects?sessionId=...&bucket=...&prefix=...&continuationToken=...&maxKeys=...`
- `GET /api/object/meta?sessionId=...&bucket=...&key=...`
- `GET /api/object/tags?sessionId=...&bucket=...&key=...`

## Notes

- `/api/objects` uses `ListObjectsV2` + continuation tokens + delimiter `/` for prefix navigation.
- `maxKeys` is clamped to `<= 1000`.
- Session TTL is 30 minutes and extends on access.
- Secret values are not intentionally logged and are masked in surfaced errors.
- Frontend assets are synced by `scripts/sync-frontend.sh`.
- Demo scripts seed data using `s3cmd` inside the Ceph demo container.
