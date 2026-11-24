#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${1:-}"
EXTRA_ARGS=()

if [[ -n "$PROJECT_ID" ]]; then
  EXTRA_ARGS+=(--project "$PROJECT_ID")
fi

echo "[1/3] Validando extensions manifest (dry-run)..."
firebase deploy --only extensions --dry-run "${EXTRA_ARGS[@]}"

echo "[2/3] Aplicando extensions..."
firebase deploy --only extensions "${EXTRA_ARGS[@]}"

echo "[3/3] Aplicando regras (Firestore + Storage)..."
firebase deploy --only firestore:rules,storage "${EXTRA_ARGS[@]}"

echo "Concluido."
