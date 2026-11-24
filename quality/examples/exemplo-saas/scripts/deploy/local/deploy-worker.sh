#!/usr/bin/env bash
# Deploy local do Creator Worker (Cloud Run Job fluxo-creator-worker) — imagem + env + execução.
# Espelho do fluxo do runbook backend/deploy/secrets/creator-doppler.md (sem Actions):
#   1. auth do gcloud ativa (o push do AR e o update do job usam a MESMA credencial);
#   2. build da imagem a partir do HEAD com tag sha-<commit> + latest;
#   3. push dos dois no Artifact Registry;
#   4. update do container `worker` com o digest (o job tem sidecar cloud-sql-proxy: --container é obrigatório);
#   5. volume GCS compartilhado com a API em /app/var/creator-render (o render/store.ts grava `file://<jobId>.json`
#      local; sem o volume o arquivo morre com o container do job e a API responde 500 ao ler a copy);
#   6. push-creator-llm.sh: paridade .env.local → Doppler prd → SM/env (modelos Vertex `google/gemini-2.5-flash`) e dispara 1 execução.
# Uso: bash scripts/deploy/local/deploy-worker.sh [--skip-build]
set -euo pipefail

# Todos os valores de produção vêm de defaults explícitos aqui no topo (QG-026): nada fixo no corpo.
PROJECT="${GCP_PROJECT:-fluxo-ath}"
REGION="${REGION:-southamerica-east1}"
AR_HOST="${AR_HOST:-${REGION}-docker.pkg.dev}"
AR_REPO="${AR_REPO:-fluxo}"
JOB="${CREATOR_JOB:-fluxo-creator-worker}"
IMAGE="${CREATOR_IMAGE:-fluxo-creator-worker}"
CONTAINER="${CREATOR_CONTAINER:-worker}"
VOLUME="${CREATOR_VOLUME:-creator-results}"
RESULTS_BUCKET="${CREATOR_RESULTS_BUCKET:-fluxo-ath-creator-results}"
RESULTS_MOUNT="${CREATOR_RESULTS_MOUNT:-/app/var/creator-render}"
DOCKERFILE="${CREATOR_DOCKERFILE:-services/creator-worker/Dockerfile}"
AR="${AR_HOST}/${PROJECT}/${AR_REPO}/${IMAGE}"
SHA="$(git rev-parse --short HEAD)"
SKIP_BUILD=false
[ "${1:-}" = "--skip-build" ] && SKIP_BUILD=true

echo "== 1/6 Auth do gcloud (o push do AR e o job usam a mesma credencial)"
account="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null | head -1)"
if [ -z "$account" ]; then
  echo "✗ gcloud sem credencial ativa. Rode:" >&2
  echo "    gcloud auth login" >&2
  echo "  e rode este script de novo." >&2
  exit 1
fi
echo "  conta ativa: $account"

echo "== 2/6 Build da imagem (sha-$SHA)"
if [ "$SKIP_BUILD" = true ]; then
  echo "  --skip-build: usando a imagem local existente"
else
  docker build -f "${DOCKERFILE}" -t "${AR}:sha-${SHA}" -t "${AR}:latest" . > /tmp/worker-deploy-build.log 2>&1
  echo "  build ok (log: /tmp/worker-deploy-build.log)"
fi

echo "== 3/6 Push no Artifact Registry"
docker push "${AR}:sha-${SHA}" > /tmp/worker-deploy-push.log 2>&1
docker push "${AR}:latest" >> /tmp/worker-deploy-push.log 2>&1
digest="$(docker inspect --format '{{index .RepoDigests 0}}' "${AR}:sha-${SHA}" | cut -d@ -f2)"
echo "  digest sha256:${digest:7:12}… (log: /tmp/worker-deploy-push.log)"

echo "== 4/6 Update do job (container worker, com o sidecar de proxy intacto)"
gcloud run jobs update "$JOB" --project "$PROJECT" --region "$REGION" --quiet \
  --container "$CONTAINER" --image "${AR}@${digest}" > /tmp/worker-deploy-update.log 2>&1

echo "== 5/6 Volume GCS do resultado (compartilhado com a API em ${RESULTS_MOUNT})"
job_sa="$(gcloud run jobs describe "$JOB" --project "$PROJECT" --region "$REGION" \
  --format='value(spec.template.spec.template.spec.serviceAccountName)')"
if ! gcloud storage buckets describe "gs://${RESULTS_BUCKET}" > /dev/null 2>&1; then
  echo "  bucket ausente: criando gs://${RESULTS_BUCKET}"
  gcloud storage buckets create "gs://${RESULTS_BUCKET}" --project "$PROJECT" --location "$REGION" \
    --uniform-bucket-level-access --public-access-prevention >> /tmp/worker-deploy-volume.log 2>&1
  gcloud storage buckets add-iam-policy-binding "gs://${RESULTS_BUCKET}" --member "serviceAccount:${job_sa}" \
    --role roles/storage.objectAdmin >> /tmp/worker-deploy-volume.log 2>&1
fi
# Volume é nível de job; o mount é por container e precisa vir DEPOIS de --container.
gcloud run jobs update "$JOB" --project "$PROJECT" --region "$REGION" \
  --add-volume "name=${VOLUME},type=cloud-storage,bucket=${RESULTS_BUCKET}" --quiet \
  >> /tmp/worker-deploy-volume.log 2>&1
gcloud run jobs update "$JOB" --project "$PROJECT" --region "$REGION" \
  --container "$CONTAINER" --add-volume-mount "volume=${VOLUME},mount-path=${RESULTS_MOUNT}" \
  >> /tmp/worker-deploy-volume.log 2>&1
echo "  gs://${RESULTS_BUCKET} montado em ${RESULTS_MOUNT} (log: /tmp/worker-deploy-volume.log)"

echo "== 6/6 Paridade de env (.env.local → Doppler → job) e execução de fumo"
bash scripts/deploy/local/push-creator-llm.sh

image_now="$(gcloud run jobs describe "$JOB" --project "$PROJECT" --region "$REGION" --format=json \
  | CREATOR_CONTAINER="$CONTAINER" node -e 'const j=JSON.parse(require("fs").readFileSync(0));const c=j.spec.template.spec.template.spec.containers.find((x)=>x.name===process.env.CREATOR_CONTAINER);process.stdout.write(c?c.image:"")')"
case "$image_now" in
  *"${digest}"*) echo "✓ Worker no ar com a imagem nova (${image_now})" ;;
  *) echo "✗ Imagem do job não confere: ${image_now}" >&2; exit 1 ;;
esac

# O handoff do resultado depende do mount: sem ele a API não lê o file://<jobId>.json.
gcloud run jobs describe "$JOB" --project "$PROJECT" --region "$REGION" --format=json \
  | CREATOR_VOLUME="$VOLUME" CREATOR_MOUNT="$RESULTS_MOUNT" node -e 'const j=JSON.parse(require("fs").readFileSync(0));const c=j.spec.template.spec.template.spec.containers.find((x)=>x.name===process.env.CREATOR_CONTAINER);const m=(c&&c.volumeMounts||[]).find((x)=>x.name===process.env.CREATOR_VOLUME);if(!m){console.error("✗ Worker sem o mount do resultado (resultado do job não chegará à API)");process.exit(1)}process.stdout.write("✓ Mount de resultado presente em "+m.mountPath+"\n")'

echo "Execuções: gcloud run jobs executions list --job $JOB --project $PROJECT --region $REGION --limit 3"
