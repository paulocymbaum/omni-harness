#!/usr/bin/env bash

set -euo pipefail

# Migrate media prefixes from default Firebase Storage bucket
# to dedicated buckets used by storage-resize-images extensions.
#
# Safe by default:
# - DRY RUN (no writes)
# - No source deletion
#
# Usage examples:
#   ./scripts/migrate_default_bucket_media.sh --project-id fluxo-ath
#   ./scripts/migrate_default_bucket_media.sh --project-id fluxo-ath --execute
#   ./scripts/migrate_default_bucket_media.sh --project-id fluxo-ath --execute --delete-source

usage() {
  cat <<'EOF'
Usage:
  migrate_default_bucket_media.sh --project-id <PROJECT_ID> [options]

Options:
  --project-id <id>   Firebase/GCP project id (required)
  --execute           Run real copy (default is dry-run)
  --delete-source     Delete source objects after successful copy + verification
  --log-dir <path>    Log directory (default: ./logs)
  -h, --help          Show this help

Examples:
  ./scripts/migrate_default_bucket_media.sh --project-id fluxo-ath
  ./scripts/migrate_default_bucket_media.sh --project-id fluxo-ath --execute
  ./scripts/migrate_default_bucket_media.sh --project-id fluxo-ath --execute --delete-source
EOF
}

require_bin() {
  local bin="$1"
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "error: '$bin' not found in PATH" >&2
    exit 1
  fi
}

PROJECT_ID=""
EXECUTE=false
DELETE_SOURCE=false
LOG_DIR="./logs"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project-id)
      PROJECT_ID="${2:-}"
      shift 2
      ;;
    --execute)
      EXECUTE=true
      shift
      ;;
    --delete-source)
      DELETE_SOURCE=true
      shift
      ;;
    --log-dir)
      LOG_DIR="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown option '$1'" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ -z "$PROJECT_ID" ]]; then
  echo "error: --project-id is required" >&2
  usage
  exit 1
fi

if [[ "$DELETE_SOURCE" == true && "$EXECUTE" != true ]]; then
  echo "error: --delete-source requires --execute" >&2
  exit 1
fi

require_bin gsutil
mkdir -p "$LOG_DIR"

TS="$(date +%Y%m%d_%H%M%S)"
LOG_FILE="${LOG_DIR}/migrate_default_bucket_media_${PROJECT_ID}_${TS}.log"

SOURCE_BUCKET="gs://${PROJECT_ID}.firebasestorage.app"
USER_BUCKET="gs://${PROJECT_ID}-fluxo-users"
EVENT_BUCKET="gs://${PROJECT_ID}-fluxo-event-media"

MODE_FLAG="-n"
MODE_LABEL="DRY-RUN"
if [[ "$EXECUTE" == true ]]; then
  MODE_FLAG=""
  MODE_LABEL="EXECUTE"
fi

echo "[$(date)] mode=${MODE_LABEL} project=${PROJECT_ID}" | tee -a "$LOG_FILE"
echo "[$(date)] source=${SOURCE_BUCKET}" | tee -a "$LOG_FILE"
echo "[$(date)] log_file=${LOG_FILE}" | tee -a "$LOG_FILE"

run_rsync() {
  local src="$1"
  local dst="$2"
  echo "" | tee -a "$LOG_FILE"
  echo "[$(date)] rsync ${src} -> ${dst}" | tee -a "$LOG_FILE"

  if ! gsutil ls "${src}/**" >/dev/null 2>&1; then
    echo "[$(date)] source prefix not found; skipping ${src}" | tee -a "$LOG_FILE"
    return 0
  fi

  if [[ -n "$MODE_FLAG" ]]; then
    gsutil -m rsync -r "$MODE_FLAG" "${src}/" "${dst}/" 2>&1 | tee -a "$LOG_FILE"
  else
    gsutil -m rsync -r "${src}/" "${dst}/" 2>&1 | tee -a "$LOG_FILE"
  fi
}

count_objects() {
  local uri="$1"
  (gsutil ls -r "${uri}/**" 2>/dev/null || true) | grep -v '/$' | wc -l | tr -d ' '
}

verify_counts() {
  local src="$1"
  local dst="$2"
  local src_count dst_count
  src_count="$(count_objects "$src")"
  dst_count="$(count_objects "$dst")"
  echo "[$(date)] verify src=${src_count} dst=${dst_count} (${src} -> ${dst})" | tee -a "$LOG_FILE"
  if [[ "$dst_count" -lt "$src_count" ]]; then
    echo "[$(date)] warning: destination has fewer objects than source" | tee -a "$LOG_FILE"
    return 1
  fi
  return 0
}

delete_source_prefix() {
  local src="$1"
  if ! gsutil ls "${src}/**" >/dev/null 2>&1; then
    echo "[$(date)] source prefix not found; skip delete ${src}" | tee -a "$LOG_FILE"
    return 0
  fi
  echo "[$(date)] deleting source objects in ${src}" | tee -a "$LOG_FILE"
  gsutil -m rm -r "${src}/**" 2>&1 | tee -a "$LOG_FILE"
}

run_rsync "${SOURCE_BUCKET}/avatars" "${USER_BUCKET}/users"
run_rsync "${SOURCE_BUCKET}/events" "${EVENT_BUCKET}/events"
run_rsync "${SOURCE_BUCKET}/stories" "${USER_BUCKET}/users"
# Legacy prefixes
run_rsync "${SOURCE_BUCKET}/FCMImages" "${USER_BUCKET}/users"
run_rsync "${SOURCE_BUCKET}/users" "${USER_BUCKET}/users"
run_rsync "${SOURCE_BUCKET}/user_uploads" "${USER_BUCKET}/users"

if [[ "$EXECUTE" == true ]]; then
  echo "" | tee -a "$LOG_FILE"
  echo "[$(date)] running verification by object counts..." | tee -a "$LOG_FILE"

  ok=true
  verify_counts "${SOURCE_BUCKET}/avatars" "${USER_BUCKET}/users" || ok=false
  verify_counts "${SOURCE_BUCKET}/events" "${EVENT_BUCKET}/events" || ok=false
  verify_counts "${SOURCE_BUCKET}/stories" "${USER_BUCKET}/users" || ok=false
  verify_counts "${SOURCE_BUCKET}/FCMImages" "${USER_BUCKET}/users" || ok=false
  verify_counts "${SOURCE_BUCKET}/users" "${USER_BUCKET}/users" || ok=false
  verify_counts "${SOURCE_BUCKET}/user_uploads" "${USER_BUCKET}/users" || ok=false

  if [[ "$ok" != true ]]; then
    echo "[$(date)] verification failed; source deletion skipped." | tee -a "$LOG_FILE"
    echo "[$(date)] rollback hint: rsync back dedicated -> default using this same script logic." | tee -a "$LOG_FILE"
    exit 2
  fi

  if [[ "$DELETE_SOURCE" == true ]]; then
    echo "" | tee -a "$LOG_FILE"
    echo "[$(date)] delete-source enabled; removing original prefixes..." | tee -a "$LOG_FILE"
    delete_source_prefix "${SOURCE_BUCKET}/avatars"
    delete_source_prefix "${SOURCE_BUCKET}/events"
    delete_source_prefix "${SOURCE_BUCKET}/stories"
    delete_source_prefix "${SOURCE_BUCKET}/FCMImages"
    delete_source_prefix "${SOURCE_BUCKET}/users"
    delete_source_prefix "${SOURCE_BUCKET}/user_uploads"
  else
    echo "[$(date)] source deletion not requested; originals preserved." | tee -a "$LOG_FILE"
  fi
fi

echo "" | tee -a "$LOG_FILE"
echo "[$(date)] done (${MODE_LABEL})" | tee -a "$LOG_FILE"
echo "Log: ${LOG_FILE}"
