#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

docker build -t ceph-ui:local "$ROOT_DIR"
echo "Built image ceph-ui:local"
