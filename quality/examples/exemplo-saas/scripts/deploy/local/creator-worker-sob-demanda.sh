#!/usr/bin/env bash
# Worker do Creator sob demanda (hotfix custo 2026-11-21): a API executa o Cloud Run Job do creator
# no enqueue (Creator:WorkerTrigger, código em CreatorWorkerTrigger.cs), o worker sai sozinho por ociosidade
# (CREATOR_IDLE_EXIT_SECONDS) e o Scheduler deixa de ser o motor para virar rede de segurança em cadência baixa.
# Idempotente: pode rodar de novo sem efeito colateral. Uso:
#   bash scripts/deploy/local/creator-worker-sob-demanda.sh                     # tick vira horário (rede)
#   bash scripts/deploy/local/creator-worker-sob-demanda.sh --pause-scheduler   # só demanda, sem rede
# Executar depois de `deploy-api.sh` ter publicado a imagem com o trigger (o env da API criado aqui
# preserva em deploys futuros: `gcloud run deploy` sem flags de env mantém o que existe).
# Mesmos parâmetros de deploy-worker.sh (CREATOR_JOB etc.): uma variante, uma fonte de valores (QG-026).
set -euo pipefail

PROJECT="${GCP_PROJECT:-fluxo-ath}"
REGION="${REGION:-southamerica-east1}"
JOB="${CREATOR_JOB:-fluxo-creator-worker}"
TICK="${CREATOR_TICK_JOB:-fluxo-creator-worker-tick}"
TICK_SCHEDULE="${CREATOR_TICK_SCHEDULE:-0 * * * *}"
IDLE_EXIT="${CREATOR_IDLE_EXIT:-60}"
API_SERVICE="${API_SERVICE:-fluxo-api}"
SA="${WORKER_TRIGGER_SA:-fluxo-api@${PROJECT}.iam.gserviceaccount.com}"

gcloud auth list 2>/dev/null | grep -qE "@[a-z]" || { echo 'gcloud sem conta ativa: rode gcloud auth login.' >&2; exit 1; }
gcloud config set project "$PROJECT" --quiet >/dev/null

echo "== 1/4 IAM: a API pode executar o job (mesma SA do job e da API)"
gcloud run jobs add-iam-policy-binding "$JOB" --project "$PROJECT" --region "$REGION" \
  --member "serviceAccount:${SA}" --role roles/run.invoker --quiet >/dev/null
echo "  roles/run.invoker em ${JOB} para ${SA}"

echo "== 2/4 Env do job: saída por ociosidade (60 s sem trabalho => execução Completed)"
gcloud run jobs update "$JOB" --project "$PROJECT" --region "$REGION" --container worker \
  --update-env-vars "CREATOR_IDLE_EXIT_SECONDS=${IDLE_EXIT}" >/dev/null
echo "  CREATOR_IDLE_EXIT_SECONDS=${IDLE_EXIT}"

echo "== 3/4 Scheduler ${TICK}: rede de segurança, não motor"
if [ "${1:-}" = "--pause-scheduler" ]; then
  gcloud scheduler jobs pause "$TICK" --project "$PROJECT" --location "$REGION" --quiet >/dev/null
  echo "  PAUSADO: disparo 100% por demanda (nenhuma execução sem uso)"
else
  gcloud scheduler jobs update http "$TICK" --project "$PROJECT" --location "$REGION" \
    --schedule "${TICK_SCHEDULE}" --quiet >/dev/null
  echo "  ${TICK_SCHEDULE} (rede de segurança em cadência baixa)"
fi

echo "== 4/4 Env da API: liga o disparo no enqueue"
gcloud run services update "$API_SERVICE" --project "$PROJECT" --region "$REGION" \
  --update-env-vars "Creator__WorkerTrigger__Enabled=true,Creator__WorkerTrigger__ProjectId=${PROJECT},Creator__WorkerTrigger__JobRegion=${REGION},Creator__WorkerTrigger__JobName=${JOB}" \
  --quiet >/dev/null
echo "  Creator:WorkerTrigger habilitado na ${API_SERVICE} (nova revisão)"
echo "✓ Sob demanda no ar. Prova: gcloud run jobs executions list --job ${JOB} --region ${REGION} --limit 3"
