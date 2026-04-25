#!/usr/bin/env bash
set -euo pipefail

CONTAINER_NAME="${CEPH_DEMO_CONTAINER_NAME:-ceph-ui-demo}"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required but not found."
  exit 1
fi

if docker ps -a --format '{{.Names}}' | grep -Fxq "$CONTAINER_NAME"; then
  docker rm -f "$CONTAINER_NAME" >/dev/null
  echo "Removed container: $CONTAINER_NAME"
else
  echo "No container found named: $CONTAINER_NAME"
fi
