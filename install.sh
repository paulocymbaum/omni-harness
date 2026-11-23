#!/usr/bin/env bash
# Omni Harness — instalador bootstrap.
#
#   Modo 1 (hoje, sem registry): a partir de uma cópia do repo
#     bash install.sh <destino> [--nome <projeto>]
#
#   Modo 2 (quando houver GitHub Releases):
#     RELEASE_URL="https://github.com/<ORG>/omni-harness/releases/download/v0.1.0/omni-harness-v0.1.0.tar.gz" \
#       curl -fsSL <url>/install.sh | bash -s -- <destino> [--nome <projeto>]
#
# Caminhos alternativos equivalentes: `pnpm dlx omni-harness init <destino>` ou
# `npx omni-harness init <destino>` após `npm publish` (ver README.md, seção Instalação).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST=""
NOME=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --nome) NOME="$2"; shift 2 ;;
    *) if [[ -z "$DEST" ]]; then DEST="$1"; else NOME="${NOME:-$(basename "$1")}"; fi; shift ;;
  esac
done

[[ -n "$DEST" ]] || { echo "uso: install.sh <destino> [--nome <projeto>]  (ou RELEASE_URL=... curl | bash -s -- <destino>)" >&2; exit 1; }
NOME="${NOME:-$(basename "$DEST")}"

# Modo 2: release remota → baixa e delega ao harness-init do tarball.
if [[ -n "${RELEASE_URL:-}" ]]; then
  TMP="$(mktemp -d)"
  echo "→ baixando ${RELEASE_URL}"
  curl -fsSL "$RELEASE_URL" | tar -xz -C "$TMP"
  INNER="$(find "$TMP" -maxdepth 1 -mindepth 1 -type d | head -1)"
  exec node "$INNER/scripts/harness-init.mjs" "$DEST" --nome "$NOME"
fi

# Modo 1: cópia local do repo (SCRIPT_DIR contém scripts/harness-init.mjs).
if [[ ! -f "$SCRIPT_DIR/scripts/harness-init.mjs" ]]; then
  echo "✗ rode este instalador a partir de uma cópia do repo omni-harness, ou defina RELEASE_URL" >&2
  exit 1
fi

command -v node >/dev/null || { echo "✗ node >= 22 é obrigatório" >&2; exit 1; }
exec node "$SCRIPT_DIR/scripts/harness-init.mjs" "$DEST" --nome "$NOME"
