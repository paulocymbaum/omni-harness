#!/usr/bin/env bash
# Define os secrets mínimos da identidade federada no Firebase Functions.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DEFAULT_ENV_LOCAL="${ROOT_DIR}/functions/.env.local"
DEFAULT_FIREBASE_RC="${ROOT_DIR}/.firebaserc"
DEFAULT_PROJECT_ID="${FIREBASE_PROJECT_ID:-${GCLOUD_PROJECT:-}}"

if [[ -z "${DEFAULT_PROJECT_ID:-}" && -f "$DEFAULT_FIREBASE_RC" ]]; then
  DEFAULT_PROJECT_ID="$(
    grep -E '"default"' "$DEFAULT_FIREBASE_RC" \
      | head -n1 \
      | sed -E 's/.*"default":[[:space:]]*"([^"]+)".*/\1/' \
      || true
  )"
fi

ENV_FILES=("$@")
if [[ ${#ENV_FILES[@]} -eq 0 && -f "$DEFAULT_ENV_LOCAL" ]]; then
  ENV_FILES+=("$DEFAULT_ENV_LOCAL")
fi

if [[ ${#ENV_FILES[@]} -eq 0 ]]; then
  echo "Nenhum env encontrado. Tente: $0 functions/.env.local"
  exit 1
fi

declare -a KEYS=(
  "IDENTITY_PEPPER"
  "IDENTITY_PROVIDER_AUTH_TOKEN"
)

function read_env_value() {
  local key="$1"
  local value=""
  for file in "${ENV_FILES[@]}"; do
    [[ -f "$file" ]] || continue
    local v
    v="$(grep -E "^${key}=" "$file" | grep -v '^[[:space:]]*#' | tail -n1 | cut -d= -f2- || true)"
    if [[ -n "${v:-}" ]]; then
      value="$v"
    fi
  done
  printf "%s" "$value"
}

echo "Projeto Firebase: ${DEFAULT_PROJECT_ID:-não detectado}"
echo "Usando envs: ${ENV_FILES[*]}"

for key in "${KEYS[@]}"; do
  value="$(read_env_value "$key" || true)"
  if [[ -z "${value:-}" ]]; then
    echo "⚠️  Chave $key não encontrada, pulando."
    continue
  fi
  tmp="$(mktemp)"
  printf "%s" "$value" > "$tmp"
  echo "→ Definindo secret $key"
  if [[ -n "${DEFAULT_PROJECT_ID:-}" ]]; then
    firebase functions:secrets:set "$key" --project "$DEFAULT_PROJECT_ID" --data-file "$tmp"
  else
    firebase functions:secrets:set "$key" --data-file "$tmp"
  fi
  rm -f "$tmp"
done

echo "Pronto. Secrets da identidade federada definidos."
