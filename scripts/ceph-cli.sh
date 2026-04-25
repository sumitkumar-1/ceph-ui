#!/usr/bin/env bash
set -euo pipefail

API_BASE_DEFAULT="http://localhost:8080"
SESSION_FILE_DEFAULT=".ceph-ui-cli-session.json"

API_BASE="${CEPH_UI_API_BASE:-$API_BASE_DEFAULT}"
SESSION_FILE="${CEPH_UI_SESSION_FILE:-$SESSION_FILE_DEFAULT}"

usage() {
  cat <<EOF
Ceph UI CLI Companion

Usage:
  ./scripts/ceph-cli.sh connect --endpoint URL --access-key KEY --secret-key KEY [--region us-east-1] [--path-style true|false] [--api URL]
  ./scripts/ceph-cli.sh buckets [--api URL]
  ./scripts/ceph-cli.sh objects --bucket NAME [--prefix P] [--token T] [--max-keys N] [--api URL]
  ./scripts/ceph-cli.sh search --bucket NAME --query TEXT [--prefix P] [--token T] [--max-keys N] [--api URL]
  ./scripts/ceph-cli.sh meta --bucket NAME --key KEY [--api URL]
  ./scripts/ceph-cli.sh tags --bucket NAME --key KEY [--api URL]
  ./scripts/ceph-cli.sh content --bucket NAME --key KEY [--max-bytes N] [--api URL]
  ./scripts/ceph-cli.sh lifecycle --bucket NAME [--api URL]
  ./scripts/ceph-cli.sh policy --bucket NAME [--api URL]
  ./scripts/ceph-cli.sh health [--api URL]
  ./scripts/ceph-cli.sh session show
  ./scripts/ceph-cli.sh session clear

Notes:
  - Session id is persisted in ${SESSION_FILE} after connect.
  - All command output is raw JSON for script-friendly use.
EOF
}

extract_json_field() {
  local json="$1"
  local field="$2"
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$json" | jq -r ".${field} // empty"
    return
  fi
  printf '%s' "$json" | sed -n "s/.*\"${field}\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p" | head -n 1
}

save_session() {
  local session_id="$1"
  cat > "$SESSION_FILE" <<EOF
{"sessionId":"${session_id}","apiBase":"${API_BASE}"}
EOF
}

get_session_id() {
  if [[ ! -f "$SESSION_FILE" ]]; then
    echo "No session file found. Run connect first." >&2
    exit 1
  fi
  local content
  content="$(cat "$SESSION_FILE")"
  local session_id
  session_id="$(extract_json_field "$content" "sessionId")"
  if [[ -z "$session_id" ]]; then
    echo "Session file is invalid. Run session clear and connect again." >&2
    exit 1
  fi
  printf '%s' "$session_id"
}

request_json() {
  local method="$1"
  local path="$2"
  local body="${3:-}"
  local url="${API_BASE}${path}"
  if [[ "$method" == "GET" ]]; then
    curl -sS "$url"
  else
    curl -sS -X "$method" "$url" -H 'content-type: application/json' --data "$body"
  fi
}

cmd="${1:-}"
if [[ -z "$cmd" ]]; then
  usage
  exit 1
fi
shift || true

case "$cmd" in
  connect)
    endpoint=""
    access_key=""
    secret_key=""
    region="us-east-1"
    path_style="true"
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --endpoint) endpoint="$2"; shift 2 ;;
        --access-key) access_key="$2"; shift 2 ;;
        --secret-key) secret_key="$2"; shift 2 ;;
        --region) region="$2"; shift 2 ;;
        --path-style) path_style="$2"; shift 2 ;;
        --api) API_BASE="$2"; shift 2 ;;
        *) echo "Unknown arg: $1" >&2; exit 1 ;;
      esac
    done
    if [[ -z "$endpoint" || -z "$access_key" || -z "$secret_key" ]]; then
      echo "connect requires --endpoint, --access-key, --secret-key" >&2
      exit 1
    fi
    payload=$(cat <<EOF
{"endpoint":"${endpoint}","accessKey":"${access_key}","secretKey":"${secret_key}","region":"${region}","pathStyle":${path_style}}
EOF
)
    response="$(request_json POST "/api/connect" "$payload")"
    session_id="$(extract_json_field "$response" "sessionId")"
    if [[ -z "$session_id" ]]; then
      echo "$response"
      exit 1
    fi
    save_session "$session_id"
    echo "$response"
    ;;

  buckets)
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --api) API_BASE="$2"; shift 2 ;;
        *) echo "Unknown arg: $1" >&2; exit 1 ;;
      esac
    done
    sid="$(get_session_id)"
    request_json GET "/api/buckets?sessionId=${sid}"
    ;;

  objects|search)
    bucket=""
    prefix=""
    token=""
    max_keys="200"
    query=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --bucket) bucket="$2"; shift 2 ;;
        --prefix) prefix="$2"; shift 2 ;;
        --token) token="$2"; shift 2 ;;
        --max-keys) max_keys="$2"; shift 2 ;;
        --query) query="$2"; shift 2 ;;
        --api) API_BASE="$2"; shift 2 ;;
        *) echo "Unknown arg: $1" >&2; exit 1 ;;
      esac
    done
    if [[ -z "$bucket" ]]; then
      echo "$cmd requires --bucket" >&2
      exit 1
    fi
    if [[ "$cmd" == "search" && -z "$query" ]]; then
      echo "search requires --query" >&2
      exit 1
    fi
    sid="$(get_session_id)"
    path="/api/${cmd}?sessionId=${sid}&bucket=${bucket}&prefix=${prefix}&maxKeys=${max_keys}"
    if [[ -n "$token" ]]; then
      path="${path}&continuationToken=${token}"
    fi
    if [[ "$cmd" == "search" ]]; then
      path="${path}&query=${query}"
    fi
    request_json GET "$path"
    ;;

  meta|tags|content)
    bucket=""
    key=""
    max_bytes="262144"
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --bucket) bucket="$2"; shift 2 ;;
        --key) key="$2"; shift 2 ;;
        --max-bytes) max_bytes="$2"; shift 2 ;;
        --api) API_BASE="$2"; shift 2 ;;
        *) echo "Unknown arg: $1" >&2; exit 1 ;;
      esac
    done
    if [[ -z "$bucket" || -z "$key" ]]; then
      echo "$cmd requires --bucket and --key" >&2
      exit 1
    fi
    sid="$(get_session_id)"
    path="/api/object/${cmd}?sessionId=${sid}&bucket=${bucket}&key=${key}"
    if [[ "$cmd" == "content" ]]; then
      path="${path}&maxBytes=${max_bytes}"
    fi
    request_json GET "$path"
    ;;

  lifecycle|policy)
    bucket=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --bucket) bucket="$2"; shift 2 ;;
        --api) API_BASE="$2"; shift 2 ;;
        *) echo "Unknown arg: $1" >&2; exit 1 ;;
      esac
    done
    if [[ -z "$bucket" ]]; then
      echo "$cmd requires --bucket" >&2
      exit 1
    fi
    sid="$(get_session_id)"
    request_json GET "/api/bucket/${cmd}?sessionId=${sid}&bucket=${bucket}"
    ;;

  health)
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --api) API_BASE="$2"; shift 2 ;;
        *) echo "Unknown arg: $1" >&2; exit 1 ;;
      esac
    done
    sid="$(get_session_id)"
    request_json GET "/api/health/rgw?sessionId=${sid}"
    ;;

  session)
    sub="${1:-}"
    case "$sub" in
      show)
        if [[ -f "$SESSION_FILE" ]]; then
          cat "$SESSION_FILE"
        else
          echo "No session file found."
        fi
        ;;
      clear)
        rm -f "$SESSION_FILE"
        echo "Session cleared."
        ;;
      *)
        echo "Usage: ./scripts/ceph-cli.sh session [show|clear]" >&2
        exit 1
        ;;
    esac
    ;;

  help|-h|--help)
    usage
    ;;

  *)
    echo "Unknown command: $cmd" >&2
    usage
    exit 1
    ;;
esac
