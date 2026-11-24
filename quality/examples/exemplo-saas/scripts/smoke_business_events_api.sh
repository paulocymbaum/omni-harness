#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
POSTGRES_PASSWORD_PLACEHOLDER="${POSTGRES_PASSWORD_PLACEHOLDER:-__SET_POSTGRES_PASSWORD__}"

load_env_file() {
  local file="$1"
  if [[ -f "$file" ]]; then
    while IFS= read -r line || [[ -n "$line" ]]; do
      [[ "$line" =~ ^[[:space:]]*# ]] && continue
      [[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] || continue

      local key="${line%%=*}"
      local value="${line#*=}"

      if [[ -n "${!key:-}" ]]; then
        continue
      fi

      if [[ "$value" =~ ^\".*\"$ ]]; then
        value="${value:1:${#value}-2}"
      elif [[ "$value" =~ ^\'.*\'$ ]]; then
        value="${value:1:${#value}-2}"
      fi

      export "$key=$value"
    done < "$file"
  fi
}

build_postgres_conn_from_parts() {
  local host="${Database__Host:-}"
  local port="${Database__Port:-5432}"
  local db="${Database__Name:-}"
  local user="${Database__Username:-}"
  local pass="${Database__Password:-}"
  local ssl="${Database__SslMode:-Require}"

  if [[ -n "$host" && -n "$db" && -n "$user" && -n "$pass" ]]; then
    if [[ "$pass" == "$POSTGRES_PASSWORD_PLACEHOLDER" ]]; then
      return 1
    fi
    printf 'Host=%s;Port=%s;Database=%s;Username=%s;Password=%s;SSL Mode=%s' \
      "$host" "$port" "$db" "$user" "$pass" "$ssl"
    return 0
  fi

  return 1
}

load_env_file "$ROOT_DIR/.env"
load_env_file "$ROOT_DIR/.env.local"
load_env_file "$ROOT_DIR/backend/.env.local"

if [[ -z "${FLUXO_TEST_POSTGRES:-}" ]]; then
  if conn="$(build_postgres_conn_from_parts)"; then
    export FLUXO_TEST_POSTGRES="$conn"
    echo "[info] FLUXO_TEST_POSTGRES definido automaticamente via backend/.env.local"
  fi
fi

run_postgres_e2e=1

run_dotnet_test_isolated() {
  env \
    -u Firebase__ProjectId \
    -u Firebase__ProjectNumber \
    -u Firebase__RequireAppCheck \
    -u Firebase__AllowedAppIds__0 \
    -u ConnectionStrings__Postgres \
    -u Database__Host \
    -u Database__Port \
    -u Database__Name \
    -u Database__Username \
    -u Database__Password \
    -u Database__SslMode \
    -u Database__RootCertificate \
    /Users/amoreirath/.dotnet/dotnet test "$@"
}

postgres_host_from_conn() {
  local conn="$1"
  printf '%s' "$conn" | tr ';' '\n' | sed -n 's/^Host=//p' | head -n1
}

postgres_port_from_conn() {
  local conn="$1"
  local port
  port="$(printf '%s' "$conn" | tr ';' '\n' | sed -n 's/^Port=//p' | head -n1)"
  if [[ -z "$port" ]]; then
    port=5432
  fi
  printf '%s' "$port"
}

postgres_ssl_mode_from_conn() {
  local conn="$1"
  local ssl
  ssl="$(printf '%s' "$conn" | tr ';' '\n' | sed -n 's/^SSL Mode=//Ip' | head -n1 | tr '[:upper:]' '[:lower:]')"
  printf '%s' "$ssl"
}

postgres_force_local_ssl_disable() {
  local conn="$1"
  local host="$2"
  local ssl

  ssl="$(postgres_ssl_mode_from_conn "$conn")"
  case "$host" in
    127.0.0.1|localhost|::1)
      case "$ssl" in
        require|verifyca|verifyfull)
          if printf '%s' "$conn" | grep -qi 'SSL Mode='; then
            conn="$(printf '%s' "$conn" | sed -E 's/SSL Mode=[^;]*/SSL Mode=Disable/I')"
          else
            conn="${conn};SSL Mode=Disable"
          fi
          echo "[info] Host local detectado (${host}); ajustando SSL Mode para Disable no smoke e2e."
          ;;
      esac
      ;;
  esac

  printf '%s' "$conn"
}

postgres_reachable() {
  local host="$1"
  local port="$2"

  if command -v nc >/dev/null 2>&1; then
    nc -z -w 2 "$host" "$port" >/dev/null 2>&1
    return $?
  fi

  # fallback sem nc
  (echo > "/dev/tcp/${host}/${port}") >/dev/null 2>&1
}

if [[ "${FLUXO_TEST_POSTGRES:-}" == *"$POSTGRES_PASSWORD_PLACEHOLDER"* ]]; then
  echo "[warn] FLUXO_TEST_POSTGRES está com placeholder (${POSTGRES_PASSWORD_PLACEHOLDER})."
  echo "[warn] Smoke e2e autenticado de Postgres será pulado nesta execução."
  run_postgres_e2e=0
fi

if [[ -z "${FLUXO_TEST_POSTGRES:-}" ]]; then
  echo "[warn] FLUXO_TEST_POSTGRES não definido."
  echo "[warn] Smoke e2e autenticado de Postgres será pulado nesta execução."
  echo "[info] Exemplo: Host=127.0.0.1;Port=5432;Database=fluxo_test;Username=fluxo_api;Password=***;SSL Mode=Require"
  run_postgres_e2e=0
fi

if [[ "$run_postgres_e2e" -eq 1 ]]; then
  pg_host="$(postgres_host_from_conn "$FLUXO_TEST_POSTGRES")"
  pg_port="$(postgres_port_from_conn "$FLUXO_TEST_POSTGRES")"

  if [[ -z "$pg_host" ]]; then
    echo "[warn] Connection string sem Host. Smoke e2e Postgres será pulado."
    run_postgres_e2e=0
  else
    FLUXO_TEST_POSTGRES="$(postgres_force_local_ssl_disable "$FLUXO_TEST_POSTGRES" "$pg_host")"
    export FLUXO_TEST_POSTGRES
    if ! postgres_reachable "$pg_host" "$pg_port"; then
      echo "[warn] PostgreSQL indisponível em ${pg_host}:${pg_port}. Smoke e2e Postgres será pulado."
      run_postgres_e2e=0
    fi
  fi
fi

echo "==> Backend smoke (ApiBoundaryTests)"
run_dotnet_test_isolated \
  "$ROOT_DIR/backend/tests/Fluxo.Api.Tests/Fluxo.Api.Tests.csproj" \
  --no-build \
  --filter "FullyQualifiedName~ApiBoundaryTests"

echo "==> Backend smoke e2e autenticado (business + events)"
if [[ "$run_postgres_e2e" -eq 1 ]]; then
  run_dotnet_test_isolated \
    "$ROOT_DIR/backend/tests/Fluxo.Api.Tests/Fluxo.Api.Tests.csproj" \
    --filter "FullyQualifiedName~Authenticated_business_and_event_journey_smoke_passes_when_postgres_is_available"
else
  echo "[skip] e2e Postgres não executado (configure FLUXO_TEST_POSTGRES para habilitar)."
fi

echo "==> Flutter analyze (global)"
(cd "$ROOT_DIR" && flutter analyze)

echo "Pronto. Smoke API business/events concluído."