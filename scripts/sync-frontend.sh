#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FRONTEND_DIR="$ROOT_DIR/frontend/public"
BACKEND_PUBLIC_DIR="$ROOT_DIR/backend/src/main/resources/public"

mkdir -p "$BACKEND_PUBLIC_DIR"
rm -rf "$BACKEND_PUBLIC_DIR"/*
cp -R "$FRONTEND_DIR"/. "$BACKEND_PUBLIC_DIR"/

echo "Synced frontend assets to backend resources."
