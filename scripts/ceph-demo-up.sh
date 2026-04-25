#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTAINER_NAME="${CEPH_DEMO_CONTAINER_NAME:-ceph-ui-demo}"
RGW_HOST_PORT="${CEPH_DEMO_RGW_PORT:-7480}"
RGW_CONTAINER_PORT="${CEPH_DEMO_RGW_CONTAINER_PORT:-8080}"
RGW_ADMIN_PORT="${CEPH_DEMO_DASHBOARD_PORT:-5500}"
RGW_ENDPOINT_HOST="${CEPH_DEMO_ENDPOINT_HOST:-localhost}"
RGW_DNS_NAME="${CEPH_DEMO_RGW_DNS_NAME:-localhost}"
SEED_REGION="${CEPH_DEMO_REGION:-us-east-1}"
DEMO_UID="${CEPH_DEMO_UID:-ckp-demo}"
DEMO_ACCESS_KEY="${CEPH_DEMO_ACCESS_KEY:-CKPDEMOACCESSKEY01}"
DEMO_SECRET_KEY="${CEPH_DEMO_SECRET_KEY:-CKPDEMOSECRETKEY01}"

release="${1:-reef}"
IMAGE_OVERRIDE="${CEPH_DEMO_IMAGE:-}"

resolve_image() {
  if [[ -n "$IMAGE_OVERRIDE" ]]; then
    echo "$IMAGE_OVERRIDE"
    return 0
  fi

  local candidates=()
  case "$release" in
    reef)
      candidates=(
        "quay.io/ceph/demo:reef"
        "quay.io/ceph/demo:v18"
        "quay.io/ceph/demo:v18.2"
        "quay.io/ceph/demo:latest"
      )
      ;;
    squid)
      candidates=(
        "quay.io/ceph/demo:squid"
        "quay.io/ceph/demo:v19"
        "quay.io/ceph/demo:v19.2"
        "quay.io/ceph/demo:latest"
      )
      ;;
    latest)
      candidates=("quay.io/ceph/demo:latest")
      ;;
    *)
      echo "Unsupported release '$release'. Use: reef | squid | latest"
      exit 1
      ;;
  esac

  for candidate in "${candidates[@]}"; do
    if docker manifest inspect "$candidate" >/dev/null 2>&1; then
      echo "$candidate"
      return 0
    fi
  done

  echo "Could not resolve a valid Ceph demo image tag for release '$release'."
  echo "Tried:"
  for candidate in "${candidates[@]}"; do
    echo "  - $candidate"
  done
  echo "You can override with:"
  echo "  CEPH_DEMO_IMAGE=<image:tag> ./scripts/ceph-demo-up.sh $release"
  exit 1
}

IMAGE="$(resolve_image)"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required but not found."
  exit 1
fi

if docker ps -a --format '{{.Names}}' | grep -Fxq "$CONTAINER_NAME"; then
  echo "Container $CONTAINER_NAME already exists. Remove it with ./scripts/ceph-demo-down.sh first."
  exit 1
fi

if lsof -nP -iTCP:"${RGW_HOST_PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Host port ${RGW_HOST_PORT} is already in use. Override with CEPH_DEMO_RGW_PORT."
  echo "Example: CEPH_DEMO_RGW_PORT=7481 ./scripts/ceph-demo-up.sh ${release}"
  exit 1
fi

if lsof -nP -iTCP:"${RGW_ADMIN_PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Host port ${RGW_ADMIN_PORT} is already in use. Override with CEPH_DEMO_DASHBOARD_PORT."
  echo "Example: CEPH_DEMO_DASHBOARD_PORT=5501 ./scripts/ceph-demo-up.sh ${release}"
  exit 1
fi

echo "Starting Ceph demo container: $IMAGE"
docker run -d \
  --name "$CONTAINER_NAME" \
  -p "${RGW_HOST_PORT}:${RGW_CONTAINER_PORT}" \
  -p "${RGW_ADMIN_PORT}:5000" \
  -e MON_IP=127.0.0.1 \
  -e CEPH_PUBLIC_NETWORK=0.0.0.0/0 \
  -e DEMO_DAEMONS=osd,mds,rgw \
  -e RGW_NAME="${RGW_DNS_NAME}" \
  -e RGW_CIVETWEB_PORT="${RGW_CONTAINER_PORT}" \
  -e CEPH_DEMO_UID="${DEMO_UID}" \
  -e RGW_DEMO_UID="${DEMO_UID}" \
  -e DEMO_UID="${DEMO_UID}" \
  -e CEPH_DEMO_ACCESS_KEY="${DEMO_ACCESS_KEY}" \
  -e CEPH_DEMO_SECRET_KEY="${DEMO_SECRET_KEY}" \
  -e RGW_DEMO_ACCESS_KEY="${DEMO_ACCESS_KEY}" \
  -e RGW_DEMO_SECRET_KEY="${DEMO_SECRET_KEY}" \
  "$IMAGE" >/dev/null

echo "Waiting for RGW to become ready on http://${RGW_ENDPOINT_HOST}:${RGW_HOST_PORT} ..."
for _ in $(seq 1 90); do
  if ! docker ps --format '{{.Names}}' | grep -Fxq "$CONTAINER_NAME"; then
    echo "Ceph demo container exited before RGW became ready."
    docker logs --tail 120 "$CONTAINER_NAME" || true
    exit 1
  fi
  if docker exec "$CONTAINER_NAME" sh -lc "curl -fsS http://127.0.0.1:${RGW_CONTAINER_PORT} >/dev/null 2>&1" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

if ! docker exec "$CONTAINER_NAME" sh -lc "curl -fsS http://127.0.0.1:${RGW_CONTAINER_PORT} >/dev/null 2>&1" >/dev/null 2>&1; then
  echo "RGW did not become ready in time. Check logs:"
  echo "  docker logs $CONTAINER_NAME"
  exit 1
fi

echo "Ensuring demo RGW user exists..."
if ! docker exec "$CONTAINER_NAME" radosgw-admin user info --uid="$DEMO_UID" >/dev/null 2>&1; then
  docker exec "$CONTAINER_NAME" radosgw-admin user create \
    --uid="$DEMO_UID" \
    --display-name="CKP Demo User" \
    --access-key="$DEMO_ACCESS_KEY" \
    --secret-key="$DEMO_SECRET_KEY" >/dev/null
fi

s3cmd_exec() {
  docker exec "$CONTAINER_NAME" s3cmd \
    --access_key="$DEMO_ACCESS_KEY" \
    --secret_key="$DEMO_SECRET_KEY" \
    "$@"
}

ensure_bucket() {
  local bucket="$1"
  if s3cmd_exec ls "s3://${bucket}" >/dev/null 2>&1; then
    return
  fi
  s3cmd_exec mb "s3://${bucket}" >/dev/null
}

put_object() {
  local bucket="$1"
  local key="$2"
  local body="$3"
  local tmp_file
  tmp_file="$(mktemp)"
  printf '%s' "$body" > "$tmp_file"
  docker cp "$tmp_file" "${CONTAINER_NAME}:/tmp/ckp-seed.txt" >/dev/null
  rm -f "$tmp_file"
  s3cmd_exec put "/tmp/ckp-seed.txt" "s3://${bucket}/${key}" >/dev/null
}

put_bucket_policy() {
  local bucket="$1"
  local tmp_file
  tmp_file="$(mktemp)"
  cat > "$tmp_file" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowReadDemoDocs",
      "Effect": "Allow",
      "Principal": "*",
      "Action": ["s3:GetObject"],
      "Resource": ["arn:aws:s3:::${bucket}/*"]
    }
  ]
}
EOF
  docker cp "$tmp_file" "${CONTAINER_NAME}:/tmp/ckp-bucket-policy.json" >/dev/null
  rm -f "$tmp_file"
  s3cmd_exec setpolicy "/tmp/ckp-bucket-policy.json" "s3://${bucket}" >/dev/null
}

put_bucket_lifecycle() {
  local bucket="$1"
  local tmp_file
  tmp_file="$(mktemp)"
  cat > "$tmp_file" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<LifecycleConfiguration>
  <Rule>
    <ID>ExpireOldLogs</ID>
    <Filter>
      <Prefix>apps/</Prefix>
    </Filter>
    <Status>Enabled</Status>
    <Expiration>
      <Days>30</Days>
    </Expiration>
  </Rule>
</LifecycleConfiguration>
EOF
  docker cp "$tmp_file" "${CONTAINER_NAME}:/tmp/ckp-bucket-lifecycle.xml" >/dev/null
  rm -f "$tmp_file"
  s3cmd_exec setlifecycle "/tmp/ckp-bucket-lifecycle.xml" "s3://${bucket}" >/dev/null
}

tag_object() {
  local bucket="$1"
  local key="$2"
  local tags="$3"
  s3cmd_exec settagging "s3://${bucket}/${key}" "$tags" >/dev/null
}

echo "Seeding demo data (buckets/objects/prefixes/tags)..."
ensure_bucket "ckp-demo-docs"
ensure_bucket "ckp-demo-logs"
ensure_bucket "ckp-demo-media"
ensure_bucket "ckp-demo-bulk"

put_object "ckp-demo-docs" "team-a/readme.txt" "Welcome to Team A demo docs."
put_object "ckp-demo-docs" "team-a/specs/api-contract.md" "API contract placeholder for internal review."
put_object "ckp-demo-docs" "team-b/notes/2026-04-25.txt" "Daily notes for Team B."
put_object "ckp-demo-logs" "apps/ui/2026/04/25/app.log" "INFO startup complete"
put_object "ckp-demo-logs" "apps/api/2026/04/25/api.log" "INFO listed objects page 1"
put_object "ckp-demo-media" "images/onboarding/banner.txt" "binary-placeholder"
put_object "ckp-demo-media" "videos/demo/intro.txt" "binary-placeholder"

echo "Seeding bulk bucket (200 objects) for virtual scrolling test..."
for i in $(seq -w 1 200); do
  if ((10#$i <= 100)); then
    put_object "ckp-demo-bulk" "batch-a/team-a/object-${i}.txt" "bulk-demo-object-${i}"
  else
    put_object "ckp-demo-bulk" "batch-b/team-b/object-${i}.txt" "bulk-demo-object-${i}"
  fi
done

tag_object "ckp-demo-docs" "team-a/readme.txt" "env=demo&team=alpha&source=ckp"
tag_object "ckp-demo-docs" "team-b/notes/2026-04-25.txt" "env=demo&team=beta"
tag_object "ckp-demo-logs" "apps/ui/2026/04/25/app.log" "env=demo&type=log"
tag_object "ckp-demo-media" "images/onboarding/banner.txt" "env=demo&type=asset"

put_bucket_policy "ckp-demo-docs"
put_bucket_lifecycle "ckp-demo-logs"

docker exec "$CONTAINER_NAME" rm -f /tmp/ckp-seed.txt >/dev/null 2>&1 || true
docker exec "$CONTAINER_NAME" rm -f /tmp/ckp-bucket-policy.json /tmp/ckp-bucket-lifecycle.xml >/dev/null 2>&1 || true

cat <<EOF
Demo Ceph RGW is ready.
Endpoint:  http://${RGW_ENDPOINT_HOST}:${RGW_HOST_PORT}
AccessKey: ${DEMO_ACCESS_KEY}
SecretKey: ${DEMO_SECRET_KEY}
Region:    ${SEED_REGION}
PathStyle: true

Try in UI:
  ./scripts/run-local.sh
  open http://localhost:8080
  Governance examples:
    Lifecycle configured: ckp-demo-logs
    Policy configured:    ckp-demo-docs

Teardown:
  ./scripts/ceph-demo-down.sh
EOF
