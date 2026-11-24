#!/usr/bin/env bash
# Replicação local do backend-deploy.yml — para deploy sem minutos do GitHub Actions.
# Fonte da verdade: .github/workflows/backend-deploy.yml (mesma ordem, mesmos gates).
#
# Pré-requisitos (uma vez):
#   gcloud auth login && gcloud auth application-default login
#   gcloud config set project fluxo-ath
#   doppler login && doppler setup --project ofluxo --config prd  (token com acesso prd)
#
# Uso: bash scripts/deploy/local/deploy-api.sh
set -euo pipefail

# Todos os valores de produção vêm de defaults explícitos aqui no topo (QG-026): nada fixo no corpo.
PROJECT="${GCP_PROJECT:-fluxo-ath}"
REGION="${REGION:-southamerica-east1}"
AR_REPO="${AR_REPO:-fluxo}"
API_SERVICE="${API_SERVICE:-fluxo-api}"
MIGRATOR_JOB="${MIGRATOR_JOB:-fluxo-migrator}"
SYNC_JOBS="${SYNC_JOBS:-fluxo-artist-sync,fluxo-billing-reconcile,fluxo-civic-action-retention}"
CLOUDBUILD_CONFIG="${CLOUDBUILD_CONFIG:-backend/cloudbuild.deploy.yaml}"
VOLUME="${CREATOR_VOLUME:-creator-results}"
SHA="$(git rev-parse --short HEAD)"
API_TAG="${REGION}-docker.pkg.dev/${PROJECT}/${AR_REPO}/${API_SERVICE}:${SHA}"
MIG_TAG="${REGION}-docker.pkg.dev/${PROJECT}/${AR_REPO}/${MIGRATOR_JOB}:${SHA}"
APP_VERSION="$(node quality/version/bump.mjs --next backend --tagged-only)"
# Resultado do creator-worker: o job grava `file://<jobId>.json` e a API lê o mesmo mount.
# Volume de Cloud Storage exige ambiente gen2 (ver deploy do épico creator, seção do handoff).
RESULTS_BUCKET="${CREATOR_RESULTS_BUCKET:-fluxo-ath-creator-results}"
RESULTS_MOUNT="${CREATOR_RESULTS_MOUNT:-/app/var/creator-render}"

echo "== 1/7 Conferir recursos (${PROJECT} @ ${REGION})"
gcloud artifacts repositories describe "${AR_REPO}" --project="${PROJECT}" --location="${REGION}" > /dev/null
gcloud run services describe "${API_SERVICE}" --project="${PROJECT}" --region="${REGION}" > /dev/null
gcloud run jobs describe "${MIGRATOR_JOB}" --project="${PROJECT}" --region="${REGION}" > /dev/null
for job in ${SYNC_JOBS//,/ }; do gcloud run jobs describe "$job" --project="${PROJECT}" --region="${REGION}" > /dev/null; done

echo "== 2/7 Sincronizar secrets (Doppler prd -> Secret Manager)"
backend/deploy/secrets/sync-secrets.sh --layer api --gcp-project "${PROJECT}"

echo "== 3/7 Build por Cloud Build (${APP_VERSION})"
gcloud builds submit \
  --project="${PROJECT}" \
  --config="${CLOUDBUILD_CONFIG}" \
  --gcs-source-staging-dir="gs://${PROJECT}_cloudbuild/source" \
  --substitutions="_API_IMAGE=${API_TAG},_MIGRATOR_IMAGE=${MIG_TAG},_APP_VERSION=${APP_VERSION}" \
  backend

API_IMAGE="${API_TAG%@*}@$(gcloud artifacts docker images describe "${API_TAG}" --project="${PROJECT}" --format='value(image_summary.digest)')"
MIG_IMAGE="${MIG_TAG%@*}@$(gcloud artifacts docker images describe "${MIG_TAG}" --project="${PROJECT}" --format='value(image_summary.digest)')"

echo "== 4/7 Migration antes da nova API"
gcloud run jobs update "${MIGRATOR_JOB}" --project="${PROJECT}" --region="${REGION}" --image="${MIG_IMAGE}" --quiet
gcloud run jobs execute "${MIGRATOR_JOB}" --project="${PROJECT}" --region="${REGION}" --wait

echo "== 5/7 Candidato sem tráfego + readiness"
# Bucket do resultado do worker (idempotente): sem ele o candidato sobe sem o mount.
if ! gcloud storage buckets describe "gs://${RESULTS_BUCKET}" --project="${PROJECT}" > /dev/null 2>&1; then
  echo "  bucket ausente: criando gs://${RESULTS_BUCKET}"
  gcloud storage buckets create "gs://${RESULTS_BUCKET}" --project="${PROJECT}" --location="${REGION}" \
    --uniform-bucket-level-access --public-access-prevention > /dev/null
  gcloud storage buckets add-iam-policy-binding "gs://${RESULTS_BUCKET}" \
    --member="serviceAccount:$(gcloud run services describe "${API_SERVICE}" --project="${PROJECT}" --region="${REGION}" \
      --format='value(spec.template.spec.serviceAccountName)')" --role=roles/storage.objectAdmin > /dev/null
fi
gcloud run deploy "${API_SERVICE}" --project="${PROJECT}" --region="${REGION}" --image="${API_IMAGE}" \
  --execution-environment=gen2 \
  --add-volume "name=${VOLUME},type=cloud-storage,bucket=${RESULTS_BUCKET}" \
  --add-volume-mount "volume=${VOLUME},mount-path=${RESULTS_MOUNT}" \
  --no-traffic --tag="candidate-${SHA}" --quiet
SERVICE_JSON="$(gcloud run services describe "${API_SERVICE}" --project="${PROJECT}" --region="${REGION}" --format=json)"
CANDIDATE_URL="$(jq -r --arg tag "candidate-${SHA}" '.status.traffic[] | select(.tag == $tag) | .url' <<<"${SERVICE_JSON}")"
REVISION="$(jq -r '.status.latestCreatedRevisionName' <<<"${SERVICE_JSON}")"
test -n "${CANDIDATE_URL}" && test "${CANDIDATE_URL}" != "null"
test -n "${REVISION}" && test "${REVISION}" != "null"
curl --fail --show-error --silent --retry 8 --retry-delay 3 --retry-all-errors "${CANDIDATE_URL}/health/ready" > /dev/null
echo "  candidato pronto: ${REVISION} @ ${CANDIDATE_URL}"

echo "== 6/7 Promover candidato e atualizar jobs"
gcloud run services update-traffic "${API_SERVICE}" --project="${PROJECT}" --region="${REGION}" --to-revisions="${REVISION}=100" --quiet
gcloud run services update-traffic "${API_SERVICE}" --project="${PROJECT}" --region="${REGION}" --remove-tags="candidate-${SHA}" --quiet
for job in ${SYNC_JOBS//,/ }; do
  gcloud run jobs update "$job" --project="${PROJECT}" --region="${REGION}" --image="${API_IMAGE}" --quiet
done

echo "== 7/7 Smoke da revisão promovida"
URL="$(gcloud run services describe "${API_SERVICE}" --project="${PROJECT}" --region="${REGION}" --format='value(status.url)')"
curl --fail --show-error --silent --retry 3 --retry-delay 2 "${URL}/health/ready" > /dev/null
# O mount do resultado precisa sobreviver à promoção: sem ele a leitura da copy volta 500.
gcloud run services describe "${API_SERVICE}" --project="${PROJECT}" --region="${REGION}" --format=json \
  | jq -e --arg n "${VOLUME}" '(.spec.template.spec.containers[0].volumeMounts // []) | any(.name == $n)' > /dev/null
echo "API publicada: ${URL} (revisão ${REVISION}, imagem ${API_IMAGE}; resultado em gs://${RESULTS_BUCKET} @ ${RESULTS_MOUNT})"
