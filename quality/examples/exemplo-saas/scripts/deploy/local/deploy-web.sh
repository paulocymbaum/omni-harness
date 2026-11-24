#!/usr/bin/env bash
# Deploy local do Fluxo Web (espelho do fluxo-web-deploy.yml sem Actions).
# Fontes dos VITE_*: Doppler prd quando os Firebase estão lá; sem eles, extrai os valores PÚBLICOS
# do bundle publicado (client config é público por design — mesmo conteúdo do ar hoje).
# Deploy hosting via credencial de serviço: FB_DEPLOY_KEY (json de service account) ou ADC.
set -euo pipefail

# Todos os valores de produção vêm de defaults explícitos aqui no topo (QG-026): nada fixo no corpo.
PROJECT="${GCP_PROJECT:-fluxo-ath}"
DOPPLER_PROJECT="${DOPPLER_PROJECT:-ofluxo}"
DOPPLER_CONFIG="${DOPPLER_CONFIG:-prd}"
SITE_DIR="${SITE_DIR:-ofluxo_site}"
SITE_LAYER="${SITE_LAYER:-site}"
HOSTING_TARGET="${FIREBASE_HOSTING_TARGET:-hosting:ofluxo}"
SITE_URL="${SITE_URL:-https://ofluxo.web.app/}"
export VITE_USE_EMULATORS=false VITE_UI_PREVIEW=false VITE_WEB_BETA_OPEN=true
export VITE_APP_VERSION="$(node quality/version/bump.mjs --next "${SITE_LAYER}" --tagged-only)"
export VITE_MAPBOX_TOKEN="$(doppler secrets get VITE_MAPBOX_TOKEN --project "$DOPPLER_PROJECT" --config "$DOPPLER_CONFIG" --plain)"

if doppler secrets get VITE_FIREBASE_API_KEY --project "$DOPPLER_PROJECT" --config "$DOPPLER_CONFIG" --plain >/dev/null 2>&1; then
  echo "VITE_FIREBASE_* via Doppler ${DOPPLER_CONFIG}"
  doppler run --project "$DOPPLER_PROJECT" --config "$DOPPLER_CONFIG" -- npm run build --prefix "$SITE_DIR"
else
  echo 'VITE_FIREBASE_* ausentes no Doppler — extraindo do bundle publicado (valores públicos).'
  python3 scripts/deploy/local/extract-web-env.py > /tmp/vite-extracted.env
  set -a
  # shellcheck disable=SC1091
  . /tmp/vite-extracted.env
  set +a
  npm run build --prefix "$SITE_DIR"
fi

test -s "${SITE_DIR}/dist/index.html"

if [ -n "${GOOGLE_APPLICATION_CREDENTIALS:-}" ] || [ -f "${FB_DEPLOY_KEY:-/tmp/fb-deploy-key.json}" ]; then
  export GOOGLE_APPLICATION_CREDENTIALS="${GOOGLE_APPLICATION_CREDENTIALS:-${FB_DEPLOY_KEY:-/tmp/fb-deploy-key.json}}"
fi
npx --yes firebase-tools@15 deploy --only "$HOSTING_TARGET" --project "$PROJECT" --non-interactive

echo 'Smoke do site publicado:'
curl -fsS --retry 3 "$SITE_URL" >/dev/null && echo 'site no ar ✓'
