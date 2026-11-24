#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

# Unified cutover script for media architecture:
# - canonical user bucket: gs://<PROJECT_ID>-fluxo-users
# - canonical event bucket: gs://<PROJECT_ID>-fluxo-event-media
#
# Steps:
# 1) ensure users bucket exists
# 2) migrate media to canonical structure (dry-run or execute)
# 3) bind Firebase Storage targets to all canonical/legacy buckets
# 4) deploy extensions with a sanitized firebase config
# 5) deploy storage rules to all targets
# 6) show validation summary

usage() {
  cat <<'EOF'
Usage:
  cutover_users_bucket.sh --project-id <PROJECT_ID> [options]

Options:
  --project-id <id>    Firebase/GCP project id (required)
  --location <region>  Bucket region (default: southamerica-east1)
  --execute            Run real migration (default: dry-run only)
  --delete-source      Delete source prefixes after verification (requires --execute)
  --skip-extensions    Skip extensions deploy/reconfigure
  --skip-rules         Skip storage rules deploy
  -h, --help           Show this help

Examples:
  ./scripts/cutover_users_bucket.sh --project-id fluxo-ath
  ./scripts/cutover_users_bucket.sh --project-id fluxo-ath --execute
  ./scripts/cutover_users_bucket.sh --project-id fluxo-ath --execute --delete-source
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
LOCATION="southamerica-east1"
EXECUTE=false
DELETE_SOURCE=false
SKIP_EXTENSIONS=false
SKIP_RULES=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project-id)
      PROJECT_ID="${2:-}"
      shift 2
      ;;
    --location)
      LOCATION="${2:-}"
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
    --skip-extensions)
      SKIP_EXTENSIONS=true
      shift
      ;;
    --skip-rules)
      SKIP_RULES=true
      shift
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
require_bin firebase
require_bin node

if command -v gcloud >/dev/null 2>&1; then
  HAS_GCLOUD=true
else
  HAS_GCLOUD=false
fi

MODE_LABEL="DRY-RUN"
if [[ "$EXECUTE" == true ]]; then
  MODE_LABEL="EXECUTE"
fi

echo "== Cutover Users Bucket =="
echo "project:  ${PROJECT_ID}"
echo "location: ${LOCATION}"
echo "mode:     ${MODE_LABEL}"
echo

USERS_BUCKET="gs://${PROJECT_ID}-fluxo-users"
LEGACY_STORIES_BUCKET="gs://${PROJECT_ID}-fluxo-stories"
LEGACY_AVATARS_BUCKET="gs://${PROJECT_ID}-fluxo-avatars"
LEGACY_EVENT_BUCKET="gs://${PROJECT_ID}-fluxo-event-media"

echo "[1/5] Ensuring users bucket exists: ${USERS_BUCKET}"
if gsutil ls -b "${USERS_BUCKET}" >/dev/null 2>&1; then
  echo "bucket already exists."
else
  if [[ "$HAS_GCLOUD" == true ]]; then
    gcloud storage buckets create "${USERS_BUCKET}" \
      --project="${PROJECT_ID}" \
      --location="${LOCATION}" \
      --uniform-bucket-level-access
  else
    gsutil mb -p "${PROJECT_ID}" -l "${LOCATION}" -b on "${USERS_BUCKET}"
  fi
fi
echo

echo "[2/5] Migrating media prefixes to canonical buckets"
MIGRATE_ARGS=(--project-id "${PROJECT_ID}")
if [[ "$EXECUTE" == true ]]; then
  MIGRATE_ARGS+=(--execute)
fi
if [[ "$DELETE_SOURCE" == true ]]; then
  MIGRATE_ARGS+=(--delete-source)
fi
./scripts/migrate_default_bucket_media.sh "${MIGRATE_ARGS[@]}"

echo
echo "[2b/6] Migrating legacy dedicated buckets into canonical users/event buckets"
GSUTIL_MODE="-n"
if [[ "$EXECUTE" == true ]]; then
  GSUTIL_MODE=""
fi

if gsutil ls -b "${LEGACY_STORIES_BUCKET}" >/dev/null 2>&1; then
  echo "sync: ${LEGACY_STORIES_BUCKET}/stories -> ${USERS_BUCKET}/users"
  if [[ -n "$GSUTIL_MODE" ]]; then
    gsutil -m rsync -r "$GSUTIL_MODE" "${LEGACY_STORIES_BUCKET}/stories/" "${USERS_BUCKET}/users/"
  else
    gsutil -m rsync -r "${LEGACY_STORIES_BUCKET}/stories/" "${USERS_BUCKET}/users/"
  fi
else
  echo "skip: legacy stories bucket not found (${LEGACY_STORIES_BUCKET})"
fi

if gsutil ls -b "${LEGACY_AVATARS_BUCKET}" >/dev/null 2>&1; then
  echo "note: legacy avatars bucket exists (${LEGACY_AVATARS_BUCKET})."
  echo "      automatic remap avatars/{uid} -> users/{uid}/profile requires path transform."
  echo "      run manual transform if needed."
fi

if gsutil ls -b "${LEGACY_EVENT_BUCKET}" >/dev/null 2>&1; then
  echo "ok: event media bucket already canonical (${LEGACY_EVENT_BUCKET})"
fi
echo

echo "[3/6] Binding storage targets"
DEFAULT_BUCKET="gs://${PROJECT_ID}.firebasestorage.app"
if gsutil ls -b "${DEFAULT_BUCKET}" >/dev/null 2>&1; then
  firebase target:apply storage default "${PROJECT_ID}.firebasestorage.app" \
    --project "${PROJECT_ID}"
else
  echo "warn: default firebase bucket not found (${DEFAULT_BUCKET})"
fi

if gsutil ls -b "${USERS_BUCKET}" >/dev/null 2>&1; then
  firebase target:apply storage users "${PROJECT_ID}-fluxo-users" \
    --project "${PROJECT_ID}"
fi

if gsutil ls -b "gs://${PROJECT_ID}-fluxo-event-media" >/dev/null 2>&1; then
  firebase target:apply storage event_media "${PROJECT_ID}-fluxo-event-media" \
    --project "${PROJECT_ID}"
fi

if gsutil ls -b "${LEGACY_AVATARS_BUCKET}" >/dev/null 2>&1; then
  firebase target:apply storage legacy_avatars "${PROJECT_ID}-fluxo-avatars" \
    --project "${PROJECT_ID}"
fi

if gsutil ls -b "${LEGACY_STORIES_BUCKET}" >/dev/null 2>&1; then
  firebase target:apply storage legacy_stories "${PROJECT_ID}-fluxo-stories" \
    --project "${PROJECT_ID}"
fi
echo

if [[ "$SKIP_EXTENSIONS" == false ]]; then
  echo "[4/6] Deploying extensions"
  firebase deploy --only extensions --project "${PROJECT_ID}" --force
else
  echo "[4/6] Skipped extensions deploy"
fi
echo

if [[ "$SKIP_RULES" == false ]]; then
  echo "[5/6] Deploying storage rules"
  firebase deploy --only storage --project "${PROJECT_ID}"
else
  echo "[5/6] Skipped storage rules deploy"
fi
echo

echo "[6/6] Validation summary"
firebase ext:list --project "${PROJECT_ID}" --json > /tmp/ext-list-cutover.json
node -e "const d=require('/tmp/ext-list-cutover.json'); for(const x of d.result||[]){ console.log([x.instanceId,x.state,x.version].join('\t')); }"
echo
echo "Buckets:"
gsutil ls -p "${PROJECT_ID}" | grep "${PROJECT_ID}-fluxo-" || true
echo
echo "Cutover finished."
