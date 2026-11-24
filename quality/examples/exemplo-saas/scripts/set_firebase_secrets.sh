#!/usr/bin/env bash
# Lê chaves de arquivos .env e as seta como secrets no Firebase Functions.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DEFAULT_ENV_LOCAL="${ROOT_DIR}/functions/.env.local"
DEFAULT_PROJECT_ID="${FIREBASE_PROJECT_ID:-}"
DEFAULT_FIREBASE_RC="${ROOT_DIR}/.firebaserc"

if [[ -z "${DEFAULT_PROJECT_ID:-}" && -f "$DEFAULT_FIREBASE_RC" ]]; then
  DEFAULT_PROJECT_ID="$(
    grep -E '"default"' "$DEFAULT_FIREBASE_RC" \
      | head -n1 \
      | sed -E 's/.*"default":[[:space:]]*"([^"]+)".*/\1/' \
      || true
  )"
fi

if [[ -z "${DEFAULT_PROJECT_ID:-}" ]]; then
  DEFAULT_PROJECT_ID="${GCLOUD_PROJECT:-}"
fi

ENV_FILES=("$@")
if [[ ${#ENV_FILES[@]} -eq 0 ]]; then
  CANDIDATES=("$DEFAULT_ENV_LOCAL")
  if [[ -n "${DEFAULT_PROJECT_ID:-}" ]]; then
    CANDIDATES+=("${ROOT_DIR}/functions/.env.${DEFAULT_PROJECT_ID}")
  fi
  for file in "${CANDIDATES[@]}"; do
    if [[ -f "$file" ]]; then
      ENV_FILES+=("$file")
    fi
  done
  if [[ ${#ENV_FILES[@]} -eq 0 ]]; then
    echo "Nenhum env encontrado. Tente: $0 functions/.env.local [outros_envs...]"
    exit 1
  fi
fi

missing=()
for file in "${ENV_FILES[@]}"; do
  if [[ ! -f "$file" ]]; then
    missing+=("$file")
  fi
done

if [[ ${#missing[@]} -ne 0 ]]; then
  echo "Arquivo(s) não encontrado(s): ${missing[*]}"
  echo "Use: $0 functions/.env.local [outros_envs...]"
  exit 1
fi

declare -a KEYS=(
  "SPOTIFY_CLIENT_ID"
  "SPOTIFY_CLIENT_SECRET"
  "BANDSINTOWN_APP_ID"
  "LASTFM_API_KEY"
  "SYMPLA_TOKEN"
  "ADMIN_API_KEY"
  "SONGKICK_ENABLED"
  "SYMPLA_ENABLED"
  "BANDSINTOWN_ENABLED"
  "EVENTIM_ENABLED"
  "TICKETMASTER_API_KEY"
  "TICKETMASTER_SECRET"
  "TICKETMASTER_ENABLED"
  "SYNC_ALL_LIMIT"
  "BANDSINTOWN_WEB_HOOK"
  "BANDSINTOWN_SECRET_KEY"
  "MENU_EXTRACTOR_ENABLED"
  "MENU_EXTRACTOR_BASE_URL"
  "MENU_EXTRACTOR_API_KEY"
  "MENU_EXTRACTOR_REFRESH_DAYS"
)

function read_env_value() {
  local key="$1"
  local value=""
  # Pega a última ocorrência entre os arquivos fornecidos, ignora linhas comentadas
  for file in "${ENV_FILES[@]}"; do
    local v
    v="$(grep -E "^${key}=" "$file" | grep -v '^[[:space:]]*#' | tail -n1 | cut -d= -f2- || true)"
    if [[ -n "${v:-}" ]]; then
      value="$v"
    fi
  done
  printf "%s" "$value"
}

echo "Usando envs: ${ENV_FILES[*]}"
for key in "${KEYS[@]}"; do
  value="$(read_env_value "$key" || true)"
  if [[ -z "${value:-}" ]]; then
    echo "⚠️  Chave $key não encontrada nos envs (${ENV_FILES[*]}), pulando."
    continue
  fi
  tmp="$(mktemp)"
  printf "%s" "$value" > "$tmp"
  echo "→ Definindo secret $key"
  firebase functions:secrets:set "$key" --data-file "$tmp"
  rm -f "$tmp"
done

echo "Pronto. Secrets definidos (onde havia valor)."
