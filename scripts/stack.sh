#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB_COMPOSE_FILE="$ROOT_DIR/docker-compose.postgres.yml"
MAP_COMPOSE_FILE="$ROOT_DIR/map-platform/docker-compose.yml"

log() {
  echo "[stack] $*"
}

ensure_env_file() {
  if [[ ! -f "$ROOT_DIR/.env" ]]; then
    cp "$ROOT_DIR/.env.example" "$ROOT_DIR/.env"
    log "Created .env from .env.example"
  fi
}

fix_legacy_database_port() {
  if grep -q '^DATABASE_URL=postgresql://supermarket:supermarket_dev_password@localhost:5432/supermarket$' "$ROOT_DIR/.env"; then
    sed -i 's|^DATABASE_URL=postgresql://supermarket:supermarket_dev_password@localhost:5432/supermarket$|DATABASE_URL=postgresql://supermarket:supermarket_dev_password@localhost:55432/supermarket|' "$ROOT_DIR/.env"
    log "Updated DATABASE_URL port in .env from 5432 to 55432"
  fi
}

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Required command not found: $cmd" >&2
    exit 1
  fi
}

setup_docker_access() {
  require_cmd docker

  if docker info >/dev/null 2>&1; then
    DOCKER_PREFIX=()
  else
    require_cmd sudo
    if sudo -n docker info >/dev/null 2>&1; then
      DOCKER_PREFIX=(sudo)
    else
      log "Docker needs sudo. Requesting sudo credentials..."
      sudo -v
      DOCKER_PREFIX=(sudo)
    fi
  fi

  if command -v docker-compose >/dev/null 2>&1; then
    COMPOSE_CMD=(docker-compose)
  else
    COMPOSE_CMD=(docker compose)
  fi
}

compose_run() {
  local compose_file="$1"
  shift
  "${DOCKER_PREFIX[@]}" "${COMPOSE_CMD[@]}" -f "$compose_file" "$@"
}

kill_port_if_busy() {
  local port="$1"
  local label="$2"

  if ! command -v lsof >/dev/null 2>&1; then
    return 0
  fi

  local pids
  pids="$(lsof -ti tcp:"$port" || true)"
  if [[ -z "$pids" ]]; then
    return 0
  fi

  log "Port $port is busy ($label). Stopping old process..."
  # shellcheck disable=SC2086
  kill $pids || true
  sleep 1

  local rest
  rest="$(lsof -ti tcp:"$port" || true)"
  if [[ -n "$rest" ]]; then
    # shellcheck disable=SC2086
    kill -9 $rest || true
  fi
}

start_stack() {
  ensure_env_file
  fix_legacy_database_port
  setup_docker_access

  bash "$ROOT_DIR/scripts/gen-dev-cert.sh"

  compose_run "$DB_COMPOSE_FILE" up -d
  compose_run "$MAP_COMPOSE_FILE" up -d

  kill_port_if_busy 4000 "API"
  kill_port_if_busy 5173 "Frontend"

  log "Starting API + frontend (HTTPS)..."
  cd "$ROOT_DIR"
  npm run dev:https
}

stop_stack() {
  setup_docker_access

  kill_port_if_busy 4000 "API"
  kill_port_if_busy 5173 "Frontend"

  compose_run "$DB_COMPOSE_FILE" down
  compose_run "$MAP_COMPOSE_FILE" down

  log "Stack stopped"
}

status_stack() {
  setup_docker_access

  log "Postgres stack:"
  compose_run "$DB_COMPOSE_FILE" ps

  log "Map stack:"
  compose_run "$MAP_COMPOSE_FILE" ps

  if command -v lsof >/dev/null 2>&1; then
    log "Listening processes on 4000/5173:"
    lsof -nP -iTCP:4000 -sTCP:LISTEN || true
    lsof -nP -iTCP:5173 -sTCP:LISTEN || true
  fi
}

restart_stack() {
  stop_stack
  start_stack
}

usage() {
  cat <<USAGE
Usage: bash scripts/stack.sh <start|stop|restart|status>
USAGE
}

ACTION="${1:-}"
case "$ACTION" in
  start)
    start_stack
    ;;
  stop)
    stop_stack
    ;;
  restart)
    restart_stack
    ;;
  status)
    status_stack
    ;;
  *)
    usage
    exit 1
    ;;
esac
