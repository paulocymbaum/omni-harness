#!/usr/bin/env bash
# Integração local contra os dados reais do fluxo-ath.
#
# Sobe só o emulador de Functions (sem Auth/Firestore emulados), então as
# Functions locais leem e gravam no Firestore real do fluxo-ath — os mesmos dados
# que o app vê em produção — e chamam o extrator de cardápios local (:8090).
# O app roda com o perfil "fluxo (integracao, dados fluxo-ath)" do VS Code.
#
# ATENÇÃO: tudo o que as Functions gravarem vai para produção. Por isso o
# extrator roda SEM mocks: nenhum cardápio fictício pode parar num lugar real.
#   - Gemini: ligado se GEMINI_API_KEY (ou GEMINI_VERTEX_PROJECT + ADC) estiver
#     definido no shell ou em OCR_webscraper_crawler/.env; senão fica desligado
#     (catálogos estruturados, como Menudino, funcionam; PDFs e páginas sem
#     estrutura respondem "cardápio sendo melhorado").
#   - Firecrawl: só com FIRECRAWL_API_KEY; sem chave, não é usado.
#
# Requer `firebase login` com uma conta com acesso ao fluxo-ath. Ctrl+C encerra tudo.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OCR_DIR="${ROOT_DIR}/OCR_webscraper_crawler"
PROJECT_ID="fluxo-ath"
EXTRACTOR_PORT=8090
LOG_DIR="$(mktemp -d -t integracao-fluxo-ath-XXXXXX)"
PIDS=()

if [[ -f "${OCR_DIR}/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${OCR_DIR}/.env"
  set +a
fi

GEMINI_ENABLED=false
if [[ -n "${GEMINI_API_KEY:-}" || -n "${GEMINI_VERTEX_PROJECT:-}" ]]; then
  GEMINI_ENABLED=true
fi

if [[ -n "${JAVA_HOME:-}" ]]; then
  export PATH="${JAVA_HOME}/bin:${PATH}"
fi
java_major="$(java -version 2>&1 | sed -nE 's/.*version "([0-9]+).*/\1/p' | head -1)"
if [[ -z "${java_major}" ]]; then
  echo "Java não encontrado; os emuladores do Firebase precisam de um JDK (defina JAVA_HOME)." >&2
  exit 1
fi

# firebase-tools 14+ exige Java 21; a 13 ainda roda com Java 11+.
if [[ -n "${FIREBASE_CMD:-}" ]]; then
  read -r -a firebase_cmd <<< "${FIREBASE_CMD}"
elif [[ "${java_major}" -lt 21 ]]; then
  echo "Java ${java_major} detectado: usando firebase-tools@13 (instale JDK 21+ para a CLI atual)."
  firebase_cmd=(npx -y firebase-tools@13)
elif command -v firebase >/dev/null 2>&1; then
  firebase_cmd=(firebase)
else
  firebase_cmd=(npx -y firebase-tools@15)
fi

if [[ -z "${GOOGLE_APPLICATION_CREDENTIALS:-}" ]] &&
   ! compgen -G "${HOME}/.config/firebase/*application_default_credentials.json" >/dev/null; then
  echo "Sem credenciais do Firebase: rode '${firebase_cmd[*]} login' com uma conta do ${PROJECT_ID}." >&2
  exit 1
fi

for port in "${EXTRACTOR_PORT}" 5002 4001 4401 4501 9500; do
  if lsof -iTCP:"${port}" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Porta ${port} já está em uso; pare o que estiver ouvindo nela (task integracao:stop)." >&2
    exit 1
  fi
done

cleanup() {
  local status=$?
  for pid in "${PIDS[@]}"; do
    # Cada serviço roda no próprio grupo de processos (setsid); encerra o grupo todo.
    kill -INT -- "-${pid}" 2>/dev/null || true
  done
  for pid in "${PIDS[@]}"; do
    for _ in $(seq 20); do kill -0 "${pid}" 2>/dev/null || break; sleep 0.5; done
    kill -KILL -- "-${pid}" 2>/dev/null || true
  done
  echo "Logs em ${LOG_DIR}"
  exit "${status}"
}
trap cleanup EXIT INT TERM

wait_for() {
  local description="$1" timeout="$2" log="$3"
  shift 3
  for _ in $(seq "${timeout}"); do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  echo "Tempo esgotado esperando ${description}. Últimas linhas (${log}):" >&2
  tail -20 "${log}" >&2
  exit 1
}

echo "==> Build das Functions e do extrator"
npm --prefix "${ROOT_DIR}/functions" run build >"${LOG_DIR}/build.log" 2>&1
(
  cd "${OCR_DIR}"
  pnpm -r --fail-if-no-match --filter './packages/*' build
  pnpm --fail-if-no-match --filter ./apps/combined build
) >>"${LOG_DIR}/build.log" 2>&1

echo "==> Extrator de cardápios em :${EXTRACTOR_PORT} (sem mocks, Gemini $([[ ${GEMINI_ENABLED} == true ]] && echo LIGADO || echo DESLIGADO))"
(
  cd "${OCR_DIR}/apps/combined"
  exec env GCP_PROJECT_ID="${GEMINI_VERTEX_PROJECT:-local-dev}" USE_LOCAL_STORES=true \
    OCR_PROVIDER=gemini GEMINI_ENABLED="${GEMINI_ENABLED}" \
    MOCK_OCR=false MOCK_DOCUMENT_AI=false MOCK_GEMINI=false MOCK_FIRECRAWL=false \
    ALLOW_LOCAL_SCRAPE=false PORT="${EXTRACTOR_PORT}" API_KEY= setsid node dist/index.js
) >"${LOG_DIR}/extractor.log" 2>&1 &
PIDS+=($!)
wait_for "o extrator" 30 "${LOG_DIR}/extractor.log" curl -sf "http://127.0.0.1:${EXTRACTOR_PORT}/healthz"

echo "==> Emulador de Functions contra o Firestore/Auth reais do ${PROJECT_ID}"
(
  cd "${ROOT_DIR}"
  exec env CI=true \
    NODE_OPTIONS="--require ${ROOT_DIR}/functions/lib/shared/functionsConfigCompat.js" \
    setsid "${firebase_cmd[@]}" emulators:start --only functions --project "${PROJECT_ID}"
) >"${LOG_DIR}/functions.log" 2>&1 &
PIDS+=($!)
wait_for "o emulador de Functions" 240 "${LOG_DIR}/functions.log" \
  grep -q "All emulators ready" "${LOG_DIR}/functions.log"

echo "==> Integração fluxo-ath pronta: Functions em :5002 (Android: 10.0.2.2), extrator em :${EXTRACTOR_PORT}"
echo "    Logs: ${LOG_DIR}/functions.log e ${LOG_DIR}/extractor.log — Ctrl+C encerra."
wait -n "${PIDS[@]}"
echo "Um dos serviços parou; encerrando." >&2
exit 1
