#!/usr/bin/env bash
# Live smoke test: real menu fetched from a restaurant URL and saved on the
# restaurant's place document. Firebase runs on local emulators; only --real
# calls an external service (Gemini).
#
#   - Menu extractor (apps/combined): real HTTP fetch/scrape of the URL with
#     in-memory job stores. By default OCR / Gemini / Firecrawl are MOCKED; with
#     --real, PDFs are transcribed and menus structured by real Gemini calls.
#   - Firebase emulators (functions, firestore, auth) under the demo-fluxo project.
#   - functions/scripts/smoke_menu_extraction_emulator.mjs seeds a restaurant with that
#     website, calls extractPlaceMenu and checks the menu saved in Firestore.
#
# Usage: scripts/smoke_menu_extraction_local.sh [--real | --no-gemini] [--url <menu url>]
#          [--min-items N] [--expect-improving]
# --no-gemini: nothing mocked, Gemini switched off (GEMINI_ENABLED=false) — structured
# catalogs are saved; PDFs / unstructured pages must return the "being improved"
# message (check that with --expect-improving).
# Default URL is the Menudino catalog used in OCR_webscraper_crawler/HOMOLOGACAO.md;
# with --real it is the Holy Burger PDF menu (exercises Gemini OCR).
# --real needs GEMINI_API_KEY (Gemini Developer API) or, for Vertex AI,
# GEMINI_VERTEX_PROJECT plus ADC. GEMINI_MODEL / GEMINI_OCR_MODEL are passed through.
# Requires Java 21+ (firebase-tools 14+). Set JAVA_HOME to pick a JDK, and
# FIREBASE_CMD to override the CLI (default: `firebase`, else `npx firebase-tools@15`).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OCR_DIR="${ROOT_DIR}/OCR_webscraper_crawler"
PROJECT_ID="demo-fluxo"
LOG_DIR="$(mktemp -d -t menu-smoke-XXXXXX)"
PIDS=()

REAL=false
NO_GEMINI=false
CHECK_ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --real) REAL=true ;;
    --no-gemini) NO_GEMINI=true ;;
    *) CHECK_ARGS+=("$1") ;;
  esac
  shift
done
GEMINI_ENABLED=false
if [[ "${NO_GEMINI}" == true ]]; then
  MOCKS=false
  EXTRACTOR_PROJECT=local-dev
elif [[ "${REAL}" == true ]]; then
  GEMINI_ENABLED=true
  if [[ -z "${GEMINI_API_KEY:-}" && -z "${GEMINI_VERTEX_PROJECT:-}" ]]; then
    echo "--real needs GEMINI_API_KEY, or GEMINI_VERTEX_PROJECT with ADC credentials." >&2
    exit 1
  fi
  MOCKS=false
  EXTRACTOR_PROJECT="${GEMINI_VERTEX_PROJECT:-local-dev}"
  if [[ " ${CHECK_ARGS[*]-} " != *" --url "* ]]; then
    CHECK_ARGS+=(--url "https://www.holyburger.com.br/assets/holy.pdf")
  fi
else
  MOCKS=true
  EXTRACTOR_PROJECT=local-dev
fi

if [[ -n "${JAVA_HOME:-}" ]]; then
  export PATH="${JAVA_HOME}/bin:${PATH}"
fi
java_major="$(java -version 2>&1 | sed -nE 's/.*version "([0-9]+).*/\1/p' | head -1)"
if [[ -z "${java_major}" || "${java_major}" -lt 21 ]]; then
  echo "Java 21+ is required by the Firebase emulators (found: ${java_major:-none}). Set JAVA_HOME." >&2
  exit 1
fi

if [[ -n "${FIREBASE_CMD:-}" ]]; then
  read -r -a firebase_cmd <<< "${FIREBASE_CMD}"
elif command -v firebase >/dev/null 2>&1; then
  firebase_cmd=(firebase)
else
  firebase_cmd=(npx -y firebase-tools@15)
fi

for port in 8080 5002 8081 9099; do
  if lsof -iTCP:"${port}" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port ${port} is already in use; stop whatever is listening there first." >&2
    exit 1
  fi
done

cleanup() {
  local status=$?
  for pid in "${PIDS[@]}"; do
    # Each service runs in its own process group (setsid); stop the whole group.
    kill -INT -- "-${pid}" 2>/dev/null || true
  done
  for pid in "${PIDS[@]}"; do
    for _ in $(seq 20); do kill -0 "${pid}" 2>/dev/null || break; sleep 0.5; done
    kill -KILL -- "-${pid}" 2>/dev/null || true
  done
  if [[ ${status} -ne 0 ]]; then
    echo "Logs kept in ${LOG_DIR}" >&2
  else
    rm -rf "${LOG_DIR}"
  fi
}
trap cleanup EXIT

wait_for() {
  local description="$1" timeout="$2" log="$3"
  shift 3
  for _ in $(seq "${timeout}"); do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  echo "Timed out waiting for ${description}. Last log lines (${log}):" >&2
  tail -20 "${log}" >&2
  exit 1
}

echo "==> Building functions and menu extractor"
npm --prefix "${ROOT_DIR}/functions" run build >"${LOG_DIR}/build.log" 2>&1
# Run from inside the workspace: pnpm resolves path filters against the current
# directory, not --dir, so `--dir ... --filter ./apps/...` silently builds nothing.
(
  cd "${OCR_DIR}"
  pnpm -r --fail-if-no-match --filter './packages/*' build
  pnpm --fail-if-no-match --filter ./apps/combined build
) >>"${LOG_DIR}/build.log" 2>&1

if [[ "${NO_GEMINI}" == true ]]; then
  echo "==> Starting menu extractor (nothing mocked, Gemini OFF) on :8080"
elif [[ "${MOCKS}" == true ]]; then
  echo "==> Starting menu extractor (OCR / Gemini / Firecrawl mocked) on :8080"
else
  if [[ -n "${GEMINI_API_KEY:-}" ]]; then gemini_via="Gemini API key"; else gemini_via="Vertex AI (${EXTRACTOR_PROJECT})"; fi
  echo "==> Starting menu extractor (REAL Gemini OCR + structuring via ${gemini_via}) on :8080"
fi
(
  cd "${OCR_DIR}/apps/combined"
  exec env GCP_PROJECT_ID="${EXTRACTOR_PROJECT}" USE_LOCAL_STORES=true OCR_PROVIDER=gemini \
    GEMINI_ENABLED="${GEMINI_ENABLED}" \
    MOCK_OCR="${MOCKS}" MOCK_DOCUMENT_AI="${MOCKS}" MOCK_GEMINI="${MOCKS}" MOCK_FIRECRAWL=true \
    PORT=8080 API_KEY= setsid node dist/index.js
) >"${LOG_DIR}/extractor.log" 2>&1 &
PIDS+=($!)
wait_for "the menu extractor" 30 "${LOG_DIR}/extractor.log" curl -sf http://127.0.0.1:8080/healthz

echo "==> Starting Firebase emulators (functions, firestore, auth) for ${PROJECT_ID}"
(
  cd "${ROOT_DIR}"
  exec env CI=true setsid "${firebase_cmd[@]}" emulators:start \
    --only functions,firestore,auth --project "${PROJECT_ID}"
) >"${LOG_DIR}/emulators.log" 2>&1 &
PIDS+=($!)
wait_for "the Firebase emulators" 240 "${LOG_DIR}/emulators.log" \
  grep -q "All emulators ready" "${LOG_DIR}/emulators.log"

echo "==> Running live extraction smoke test"
FIRESTORE_EMULATOR_HOST=127.0.0.1:8081 \
FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 \
SMOKE_PROJECT_ID="${PROJECT_ID}" \
  node "${ROOT_DIR}/functions/scripts/smoke_menu_extraction_emulator.mjs" ${CHECK_ARGS[@]+"${CHECK_ARGS[@]}"}

if [[ "${REAL}" == true ]]; then
  echo "==> Extractor stages (from its log):"
  grep -E '"msg":"(OCR complete|scrape complete|menu structuring complete)"' "${LOG_DIR}/extractor.log" \
    | grep -oE '"(stage|method|pages|confidence|itemCount)":("[^"]*"|[0-9.]+)' \
    | paste -sd' ' | sed 's/ "stage"/\n"stage"/g; s/^/  /'
  # FallbackStructurer silently uses the layout parser when Gemini fails; a real
  # run must have been structured by Gemini (or by an already-structured catalog).
  if grep -q '"msg":"menu structuring complete"' "${LOG_DIR}/extractor.log" &&
     grep '"msg":"menu structuring complete"' "${LOG_DIR}/extractor.log" | grep -q '"method":"layout"'; then
    echo "✘ Gemini structuring did not run (fell back to the layout parser); see ${LOG_DIR}/extractor.log" >&2
    exit 1
  fi
  echo "✔ structured by Gemini, not the layout fallback"
fi
