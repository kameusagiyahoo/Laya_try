#!/usr/bin/env bash
set -Eeuo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

python_bin="${PYTHON_BIN:-python3}"
if ! command -v "$python_bin" >/dev/null 2>&1; then
  echo "ERROR: Python 3.10+ is required." >&2
  exit 1
fi

if ! "$python_bin" -c 'import sys; raise SystemExit(sys.version_info < (3, 10))'; then
  echo "ERROR: Python 3.10+ is required." >&2
  exit 1
fi

if [[ ! -d .venv ]]; then
  echo "Creating .venv ..."
  "$python_bin" -m venv .venv
fi

venv_python="$repo_dir/.venv/bin/python"
if ! "$venv_python" -c 'import fastapi, google.adk, laya, uvicorn' >/dev/null 2>&1; then
  echo "Installing server dependencies ..."
  if "$venv_python" -m pip --version >/dev/null 2>&1; then
    "$venv_python" -m pip install --upgrade pip
    "$venv_python" -m pip install torch --index-url https://download.pytorch.org/whl/cpu
    "$venv_python" -m pip install -r backend/requirements.txt
  elif command -v uv >/dev/null 2>&1; then
    uv pip install --python "$venv_python" --torch-backend cpu -r backend/requirements.txt
  else
    echo "ERROR: pip is unavailable in .venv. Install python3-venv or uv." >&2
    exit 1
  fi
fi

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

server_host="${LAYA_HOST:-127.0.0.1}"
server_port="${LAYA_PORT:-8000}"
health_host="$server_host"
if [[ "$health_host" == "0.0.0.0" ]]; then health_host="127.0.0.1"; fi

echo "Starting Laya on ${server_host}:${server_port} (first model download can take several minutes) ..."
"$venv_python" -m uvicorn backend.server.main:app --host "$server_host" --port "$server_port" &
server_pid=$!
trap 'kill "$server_pid" 2>/dev/null || true' EXIT INT TERM

for attempt in $(seq 1 600); do
  if ! kill -0 "$server_pid" 2>/dev/null; then
    wait "$server_pid"
    exit $?
  fi
  if curl --fail --silent "http://${health_host}:${server_port}/health" >/dev/null 2>&1; then
    echo "READY: http://${health_host}:${server_port}/"
    wait "$server_pid"
    exit $?
  fi
  if (( attempt % 15 == 0 )); then echo "Waiting for model preload ... ${attempt}s"; fi
  sleep 1
done

echo "ERROR: health check timed out after 600 seconds." >&2
exit 1
