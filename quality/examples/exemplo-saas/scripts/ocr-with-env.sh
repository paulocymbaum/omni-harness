#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OCR_DIR="${ROOT_DIR}/OCR_webscraper_crawler"
ENV_FILE="${OCR_DIR}/.env"

if [[ ! -d "${OCR_DIR}" ]]; then
  echo "OCR_webscraper_crawler workspace not found at ${OCR_DIR}" >&2
  exit 1
fi

if [[ -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
fi

cd "${OCR_DIR}"
exec pnpm "$@"
