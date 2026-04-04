#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -lt 2 ]]; then
  echo "Usage: bash scripts/compose-run.sh <compose-file> <args...>" >&2
  exit 1
fi

COMPOSE_FILE="$1"
shift

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required" >&2
  exit 1
fi

if command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_CMD=(docker-compose)
else
  COMPOSE_CMD=(docker compose)
fi

if docker info >/dev/null 2>&1; then
  DOCKER_PREFIX=()
else
  if ! command -v sudo >/dev/null 2>&1; then
    echo "docker needs root access and sudo is not installed" >&2
    exit 1
  fi

  if sudo -n docker info >/dev/null 2>&1; then
    DOCKER_PREFIX=(sudo)
  else
    sudo -v
    DOCKER_PREFIX=(sudo)
  fi
fi

"${DOCKER_PREFIX[@]}" "${COMPOSE_CMD[@]}" -f "$COMPOSE_FILE" "$@"
