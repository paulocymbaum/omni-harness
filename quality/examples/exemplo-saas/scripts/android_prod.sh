#!/usr/bin/env bash

# Helper to run the app in release and build the Android App Bundle with the
# correct production defines. Works from the repo root.

set -euo pipefail

ACTION=""
# Shell variables and CLI flags take precedence over ignored local env files.
MAPBOX_TOKEN="${MAPBOX_TOKEN:-}"
MAPBOX_DOWNLOADS_TOKEN="${MAPBOX_DOWNLOADS_TOKEN:-}"
FLUXO_ENV="${FLUXO_ENV:-prod}"
USE_FUNCTIONS_EMULATOR="${USE_FUNCTIONS_EMULATOR:-false}"
BUILD_NAME=""
BUILD_NUMBER=""
DEVICE_ID=""

read_env_value() {
  local key="$1"
  local file="$2"
  local line
  local value

  line="$(grep -m 1 "^${key}=" "$file" || true)"
  [[ -n "$line" ]] || return 1

  value="${line#*=}"
  value="${value%$'\r'}"
  if [[ "$value" == \"*\" && "$value" == *\" ]]; then
    value="${value:1:${#value}-2}"
  elif [[ "$value" == \'*\' && "$value" == *\' ]]; then
    value="${value:1:${#value}-2}"
  fi

  printf '%s' "$value"
}

usage() {
  cat <<'EOF'
Usage:
  scripts/android_prod.sh run     [--mapbox-token TOKEN] [--device-id ID]
  scripts/android_prod.sh bundle  [--mapbox-token TOKEN] [--build-name X] [--build-number Y]

Flags (can also be provided via env vars):
  --mapbox-token TOKEN   Overrides MAPBOX_TOKEN env var. Required for both actions.
  --device-id ID         Optional device id for flutter run (use `flutter devices`).
  --build-name X         Optional build name (defaults to pubspec version name).
  --build-number Y       Optional build number (defaults to pubspec version code).

Env defaults:
  MAPBOX_TOKEN is loaded from .env.local or .env when not already set.
  MAPBOX_DOWNLOADS_TOKEN is loaded separately for Gradle dependency access.
  FLUXO_ENV=prod
  USE_FUNCTIONS_EMULATOR=false

Examples:
  MAPBOX_TOKEN=pk.x.y ./scripts/android_prod.sh run
  MAPBOX_TOKEN=pk.x.y ./scripts/android_prod.sh bundle --build-number 42
EOF
  exit 1
}

if [[ ! -f pubspec.yaml ]]; then
  echo "Run this script from the project root" >&2
  exit 1
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    run|bundle)
      ACTION="$1"; shift ;;
    --mapbox-token)
      MAPBOX_TOKEN="$2"; shift 2 ;;
    --device-id)
      DEVICE_ID="$2"; shift 2 ;;
    --build-name)
      BUILD_NAME="$2"; shift 2 ;;
    --build-number)
      BUILD_NUMBER="$2"; shift 2 ;;
    -h|--help)
      usage ;;
    *)
      echo "Unknown option: $1" >&2
      usage ;;
  esac
done

if [[ -z "$ACTION" ]]; then
  echo "Choose 'run' or 'bundle'" >&2
  usage
fi

for env_file in .env.local .env; do
  if [[ -f "$env_file" ]]; then
    if [[ -z "$MAPBOX_TOKEN" ]]; then
      MAPBOX_TOKEN="$(read_env_value MAPBOX_TOKEN "$env_file" || true)"
    fi
    if [[ -z "$MAPBOX_DOWNLOADS_TOKEN" ]]; then
      MAPBOX_DOWNLOADS_TOKEN="$(read_env_value MAPBOX_DOWNLOADS_TOKEN "$env_file" || true)"
    fi
  fi
done

if [[ -z "$MAPBOX_TOKEN" ]]; then
  echo "MAPBOX_TOKEN not set. Provide it via --mapbox-token, the shell environment, .env.local or .env." >&2
  exit 1
fi

if [[ "$MAPBOX_TOKEN" == sk.* ]]; then
  echo "MAPBOX_TOKEN must be a public Mapbox token (pk.*), not a secret token (sk.*)." >&2
  exit 1
fi

if [[ -n "$MAPBOX_DOWNLOADS_TOKEN" ]]; then
  export MAPBOX_DOWNLOADS_TOKEN
fi

if [[ "$USE_FUNCTIONS_EMULATOR" != "true" && "$USE_FUNCTIONS_EMULATOR" != "false" ]]; then
  echo "USE_FUNCTIONS_EMULATOR must be true or false" >&2
  exit 1
fi

if [[ "$ACTION" == "bundle" && ! -f android/key.properties ]]; then
  echo "Warning: android/key.properties not found; release signing may fail" >&2
fi

if [[ "$ACTION" == "run" ]]; then
  CMD=(
    flutter run --release
    --dart-define MAPBOX_TOKEN="$MAPBOX_TOKEN"
    --dart-define FLUXO_ENV="$FLUXO_ENV"
    --dart-define USE_FUNCTIONS_EMULATOR="$USE_FUNCTIONS_EMULATOR"
  )
  if [[ -n "$DEVICE_ID" ]]; then
    CMD+=(-d "$DEVICE_ID")
  fi
else
  CMD=(
    flutter build appbundle --release
    --dart-define MAPBOX_TOKEN="$MAPBOX_TOKEN"
    --dart-define FLUXO_ENV="$FLUXO_ENV"
    --dart-define USE_FUNCTIONS_EMULATOR="$USE_FUNCTIONS_EMULATOR"
  )
  if [[ -n "$BUILD_NAME" ]]; then
    CMD+=(--build-name "$BUILD_NAME")
  fi
  if [[ -n "$BUILD_NUMBER" ]]; then
    CMD+=(--build-number "$BUILD_NUMBER")
  fi
fi

echo "Action: $ACTION"
echo "FLUXO_ENV=$FLUXO_ENV, USE_FUNCTIONS_EMULATOR=$USE_FUNCTIONS_EMULATOR"
echo "Executing flutter command..."

"${CMD[@]}"

if [[ "$ACTION" == "bundle" ]]; then
  printf '\nBundle ready at: build/app/outputs/bundle/release/app-release.aab\n'
fi
