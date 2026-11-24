#!/bin/bash
# Captura ao vivo de um debate neste Mac, sem ação humana na hora (launchd chama este script).
#
# Uso: captura-ao-vivo.sh <debate-id> <url-da-transmissão> <worker HH:MM> <fim HH:MM>
#   worker: quando subir o worker (depois de a API abrir o debate; o Cloud Scheduler abre antes).
#   fim: quando encerrar; se o horário já passou hoje, vale o do dia seguinte (debate que vira a meia-noite).
#
# O que faz, em ordem:
#   1. impede o Mac de dormir (caffeinate) durante toda a captura;
#   2. manda a saída de áudio do sistema para o BlackHole 2ch (o worker lê dele; o Mac fica mudo);
#   3. abre a transmissão no Chrome (sessão já logada do usuário) e confere se há som no BlackHole;
#      sem som, reabre a página até 3 vezes e avisa por notificação do macOS;
#   4. sobe o worker em modo device lendo o BlackHole, com as chaves lidas do Secret Manager na hora;
#      se o worker cair antes do fim, sobe de novo;
#   5. no horário de fim, encerra o worker com SIGTERM (fecha o ASR, sobe a última parte e reporta stopped)
#      e devolve a saída de áudio original.
#
# Fonte device é a única permitida para emissora com DRM (ver services/debate-worker/README.md): o áudio é o que
# toca no Mac, sem contornar DRM. Logs em ~/Library/Logs/fluxo-debate/<debate-id>.log.
set -uo pipefail

DEBATE_ID="${1:?debate-id}"
STREAM_URL="${2:?url da transmissão}"
WORKER_AT="${3:?horário do worker HH:MM}"
END_AT="${4:?horário de fim HH:MM}"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
WORKER="$REPO/services/debate-worker"
CAPTURE_DEVICE="BlackHole 2ch"
LOG_DIR="$HOME/Library/Logs/fluxo-debate"
LOG="$LOG_DIR/$DEBATE_ID.log"
export PATH="/Users/amoreirath/google-cloud-sdk/bin:/Users/amoreirath/.nvm/versions/node/v22.13.1/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
mkdir -p "$LOG_DIR"
exec >>"$LOG" 2>&1

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }
notify() { osascript -e "display notification \"$1\" with title \"Fluxo · debate ao vivo\" sound name \"Basso\"" || true; }

# HH:MM em epoch: hoje; se já passou, amanhã.
epoch_of() { local e; e=$(date -j -f '%Y-%m-%d %H:%M' "$(date +%Y-%m-%d) $1" +%s); [ "$e" -le "$(date +%s)" ] && e=$((e + 86400)); echo "$e"; }
end_epoch=$(epoch_of "$END_AT")
worker_epoch=$(epoch_of "$WORKER_AT")
[ "$worker_epoch" -gt "$end_epoch" ] && worker_epoch=$(date +%s)
log "início da captura de $DEBATE_ID até $(date -r "$end_epoch" '+%d/%m %H:%M')"

caffeinate -dimsu -w $$ &

if ! SwitchAudioSource -a -t output | grep -qx "$CAPTURE_DEVICE"; then
  log "ERRO: $CAPTURE_DEVICE não instalado"; notify "BlackHole 2ch não instalado: captura não iniciou"; exit 1
fi
previous_output=$(SwitchAudioSource -c -t output)
restore_audio() { SwitchAudioSource -t output -s "$previous_output" >/dev/null && log "saída de áudio devolvida: $previous_output"; }
trap restore_audio EXIT
SwitchAudioSource -t output -s "$CAPTURE_DEVICE" >/dev/null && log "saída de áudio -> $CAPTURE_DEVICE"
osascript -e "set volume output volume 100" -e "set volume without output muted" || true

# Nível médio (dB) do BlackHole em 8 s; "-91" quando mudo.
level() {
  ffmpeg -hide_banner -nostats -f avfoundation -i ":$CAPTURE_DEVICE" -t 8 -af volumedetect -f null - 2>&1 \
    | sed -n 's/.*mean_volume: \(-*[0-9.]*\) dB.*/\1/p' | tail -1
}
has_sound() { local v; v=$(level); log "nível do BlackHole: ${v:-sem leitura} dB"; [ -n "$v" ] && awk "BEGIN{exit !($v > -60)}"; }

for attempt in 1 2 3; do
  log "abrindo a transmissão (tentativa $attempt): $STREAM_URL"
  open -a "Google Chrome" "$STREAM_URL"
  sleep 45
  has_sound && break
  [ "$attempt" = 3 ] && notify "Sem som da transmissão no BlackHole. Abra $STREAM_URL e dê play."
done

secret() { gcloud secrets versions access latest --secret="$1" --project fluxo-ath; }
export FLUXO_API_BASE_URL="https://fluxo-api-qkuhvcwkiq-rj.a.run.app"
export FLUXO_API_AUDIENCE="https://fluxo-api-qkuhvcwkiq-rj.a.run.app"
export WORKER_IMPERSONATE_SA="fluxo-debate-worker@fluxo-ath.iam.gserviceaccount.com"
export GOOGLE_CLOUD_PROJECT="fluxo-ath" VERTEX_PROJECT_ID="fluxo-ath" VERTEX_REGION="global" GEMINI_LOCATION="us-central1"
export AI_PROVIDER="anthropic" EXTRACTION_MODEL="gemini-2.5-flash" FACTCHECK_MODEL="gemini-2.5-pro"
export GEMINI_SEARCH_MODEL="gemini-2.5-flash" EMBEDDING_MODEL="gemini-embedding-001" WEB_SEARCH_PROVIDER="claude"
export SONIOX_MODEL="stt-rt-v5" SONIOX_ASYNC_MODEL="stt-async-v5" DEBATE_AUDIO_BUCKET="fluxo-ath-debates-audio"
SONIOX_API_KEY=$(secret SONIOX_API_KEY) || { log "ERRO: sem SONIOX_API_KEY"; notify "Sem acesso ao Secret Manager (gcloud): captura não iniciou"; exit 1; }
ANTHROPIC_API_KEY=$(secret ANTHROPIC_API_KEY) || log "aviso: sem ANTHROPIC_API_KEY (checagem pela IA fica parada)"
GOOGLE_FACTCHECK_API_KEY=$(secret GOOGLE_FACTCHECK_API_KEY) || true
export SONIOX_API_KEY ANTHROPIC_API_KEY GOOGLE_FACTCHECK_API_KEY

worker_pid=""
stop_worker() {
  [ -n "$worker_pid" ] && kill -0 "$worker_pid" 2>/dev/null || return 0
  log "encerrando o worker (SIGTERM)"; kill -TERM "$worker_pid"
  for _ in $(seq 1 30); do kill -0 "$worker_pid" 2>/dev/null || break; sleep 1; done
}
trap 'stop_worker; restore_audio' EXIT INT TERM

cd "$WORKER" || exit 1
wait_s=$((worker_epoch - $(date +%s)))
[ "$wait_s" -gt 0 ] && { log "aguardando ${wait_s}s até $WORKER_AT para subir o worker"; sleep "$wait_s"; }
while [ "$(date +%s)" -lt "$end_epoch" ]; do
  log "subindo o worker (device: $CAPTURE_DEVICE)"
  npx tsx src/cli.ts device --debate "$DEBATE_ID" --input-format avfoundation --input ":$CAPTURE_DEVICE" &
  worker_pid=$!
  while kill -0 "$worker_pid" 2>/dev/null && [ "$(date +%s)" -lt "$end_epoch" ]; do sleep 15; done
  if kill -0 "$worker_pid" 2>/dev/null; then break; fi
  wait "$worker_pid"; code=$?
  if [ "$code" = 0 ]; then log "worker encerrou normalmente (parada pela mesa)"; break; fi
  log "worker saiu com código $code antes do fim; reiniciando em 10 s"
  notify "Worker do debate caiu; reiniciando"
  sleep 10
done
stop_worker
log "captura encerrada"
