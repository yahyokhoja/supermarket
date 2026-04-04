#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OK=true

say_ok() { echo "[OK] $*"; }
say_warn() { echo "[WARN] $*"; }
say_err() { echo "[ERR] $*"; OK=false; }

check_env() {
  if [[ ! -f "$ROOT_DIR/.env" ]]; then
    say_err ".env not found (run: cp .env.example .env)"
    return
  fi

  local db_url
  db_url="$(grep -E '^DATABASE_URL=' "$ROOT_DIR/.env" | head -n1 | cut -d'=' -f2- || true)"
  if [[ -z "$db_url" ]]; then
    say_err "DATABASE_URL is missing in .env"
  elif [[ "$db_url" == *":55432/"* || "$db_url" == *":55432" ]]; then
    say_ok "DATABASE_URL port is 55432"
  else
    say_warn "DATABASE_URL does not use port 55432: $db_url"
  fi
}

check_ports() {
  if ! command -v lsof >/dev/null 2>&1; then
    say_warn "lsof not found; skip port checks"
    return
  fi

  if lsof -nP -iTCP:4000 -sTCP:LISTEN >/dev/null 2>&1; then
    say_ok "API is listening on 4000"
  else
    say_warn "API is not listening on 4000"
  fi

  if lsof -nP -iTCP:5173 -sTCP:LISTEN >/dev/null 2>&1; then
    say_ok "Frontend is listening on 5173"
  else
    say_warn "Frontend is not listening on 5173"
  fi
}

check_compose() {
  local compose_helper="$ROOT_DIR/scripts/compose-run.sh"
  if [[ ! -x "$compose_helper" ]]; then
    say_warn "compose helper not found"
    return
  fi

  if bash "$compose_helper" "$ROOT_DIR/docker-compose.postgres.yml" ps >/tmp/doctor-db.txt 2>/tmp/doctor-db.err; then
    say_ok "Postgres compose available"
  else
    say_warn "Cannot read Postgres compose status: $(tr '\n' ' ' </tmp/doctor-db.err)"
  fi

  if bash "$compose_helper" "$ROOT_DIR/map-platform/docker-compose.yml" ps >/tmp/doctor-map.txt 2>/tmp/doctor-map.err; then
    say_ok "Map compose available"
  else
    say_warn "Cannot read map compose status: $(tr '\n' ' ' </tmp/doctor-map.err)"
  fi
}

check_health() {
  if ! command -v curl >/dev/null 2>&1; then
    say_warn "curl not found; skip HTTP health checks"
    return
  fi

  local code
  code="$(curl -sk -o /dev/null -w '%{http_code}' https://localhost:4000/api/health || true)"
  if [[ "$code" == "200" ]]; then
    say_ok "https://localhost:4000/api/health -> 200"
  else
    code="$(curl -s -o /dev/null -w '%{http_code}' http://localhost:4000/api/health || true)"
    if [[ "$code" == "200" ]]; then
      say_ok "http://localhost:4000/api/health -> 200"
    else
      say_warn "API health endpoint unavailable (http/https localhost:4000)"
    fi
  fi

  code="$(curl -sk -o /dev/null -w '%{http_code}' https://localhost:4000/api/health/ready || true)"
  if [[ "$code" == "200" ]]; then
    say_ok "readiness endpoint -> 200"
  elif [[ "$code" == "503" ]]; then
    say_warn "readiness endpoint -> 503 (dependencies not ready)"
  else
    say_warn "readiness endpoint unavailable"
  fi
}

main() {
  check_env
  check_compose
  check_ports
  check_health

  if [[ "$OK" == true ]]; then
    echo "\nDoctor result: PASS"
    exit 0
  fi

  echo "\nDoctor result: FAIL"
  exit 1
}

main "$@"
