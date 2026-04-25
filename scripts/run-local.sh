#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

"$ROOT_DIR/scripts/sync-frontend.sh"

cd "$ROOT_DIR/backend"
mvn -q -DskipTests compile
exec mvn exec:java
