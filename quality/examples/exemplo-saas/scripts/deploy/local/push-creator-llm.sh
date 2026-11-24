#!/usr/bin/env bash
# Injeta as chaves do LLM do Creator (Fluxo Creators) a partir do .env.local:
#   .env.local → Doppler prd → Secret Manager (creator_llm_base_url/creator_llm_api_key e os das chaves
#   alternativas, incl. creator_llm_free_api_key) → Cloud Run Job.
# Cadeia do worker (CS-006): nível gratuito (GroqCloud) → Vertex AI → Anthropic.
# Nunca imprime valores. Preencha CREATOR_LLM_API_KEY/CREATOR_LLM_FREE_API_KEY no .env.local antes de rodar.
# Uso: bash scripts/deploy/local/push-creator-llm.sh
set -euo pipefail

ENV_FILE="${ENV_FILE:-.env.local}"
PROJECT="${GCP_PROJECT:-fluxo-ath}"
REGION="${REGION:-southamerica-east1}"
DOPPLER_PROJECT="${DOPPLER_PROJECT:-ofluxo}"
DOPPLER_CONFIG="${DOPPLER_CONFIG:-prd}"
JOB="${CREATOR_JOB:-fluxo-creator-worker}"
CONTAINER="${CREATOR_CONTAINER:-worker}"
SA="${WORKER_TRIGGER_SA:-fluxo-api@${PROJECT}.iam.gserviceaccount.com}"
KEYS=(CREATOR_LLM_BASE_URL CREATOR_LLM_API_KEY CREATOR_LLM_MODEL CREATOR_LLM_MODEL_PLANNER CREATOR_LLM_MODEL_WRITER CREATOR_LLM_MODEL_PLANNER_FALLBACK CREATOR_LLM_MODEL_WRITER_FALLBACK CREATOR_LLM_FALLBACK_BASE_URL CREATOR_LLM_FALLBACK_API_KEY CREATOR_LLM_FREE_MODEL CREATOR_LLM_FREE_API_KEY)

[ -r "$ENV_FILE" ] || { echo "Arquivo ausente: $ENV_FILE" >&2; exit 1; }
gcloud auth list 2>/dev/null | grep -qE "@[a-z]" || { echo 'gcloud sem conta ativa: rode gcloud auth login.' >&2; exit 1; }

missing=0
for key in "${KEYS[@]}"; do
  value="$(grep -E "^${key}=" "$ENV_FILE" | tail -1 | cut -d= -f2-)"
  if [ -z "$value" ]; then echo "⚠ $key vazio no $ENV_FILE" >&2; missing=1; fi
done
[ "$missing" -eq 0 ] || { echo 'Preencha as chaves acima no .env.local e rode de novo.' >&2; exit 1; }

for key in "${KEYS[@]}"; do
  value="$(grep -E "^${key}=" "$ENV_FILE" | tail -1 | cut -d= -f2-)"
  doppler secrets set "$key=$value" --project "$DOPPLER_PROJECT" --config "$DOPPLER_CONFIG" >/dev/null
  echo "✓ Doppler ${DOPPLER_CONFIG}: $key"
done

# Secret Manager: só os sensíveis (os models ficam como env do job — não são segredo).
for pair in 'CREATOR_LLM_BASE_URL:creator_llm_base_url' 'CREATOR_LLM_API_KEY:creator_llm_api_key' 'CREATOR_LLM_FALLBACK_BASE_URL:creator_llm_fallback_base_url' 'CREATOR_LLM_FALLBACK_API_KEY:creator_llm_fallback_api_key' 'CREATOR_LLM_FREE_API_KEY:creator_llm_free_api_key'; do
  env_name="${pair%%:*}"; secret_id="${pair##*:}"
  value="$(grep -E "^${env_name}=" "$ENV_FILE" | tail -1 | cut -d= -f2-)"
  if gcloud secrets describe "$secret_id" --project "$PROJECT" >/dev/null 2>&1; then
    printf '%s' "$value" | gcloud secrets versions add "$secret_id" --project "$PROJECT" --data-file=- --quiet >/dev/null
    echo "✓ SM: $secret_id (nova versão)"
  else
    printf '%s' "$value" | gcloud secrets create "$secret_id" --project "$PROJECT" --replication-policy=automatic --data-file=- --quiet >/dev/null
    echo "✓ SM: $secret_id criado"
  fi
  gcloud secrets add-iam-policy-binding "$secret_id" --project "$PROJECT" \
    --member serviceAccount:"$SA" --role roles/secretmanager.secretAccessor --quiet >/dev/null 2>&1 || true
done

planner="$(grep -E '^CREATOR_LLM_MODEL_PLANNER=' "$ENV_FILE" | tail -1 | cut -d= -f2-)"
planner_fb="$(grep -E '^CREATOR_LLM_MODEL_PLANNER_FALLBACK=' "$ENV_FILE" | tail -1 | cut -d= -f2-)"
writer_fb="$(grep -E '^CREATOR_LLM_MODEL_WRITER_FALLBACK=' "$ENV_FILE" | tail -1 | cut -d= -f2-)"
fb_url="$(grep -E '^CREATOR_LLM_FALLBACK_BASE_URL=' "$ENV_FILE" | tail -1 | cut -d= -f2-)"
fb_key="$(grep -E '^CREATOR_LLM_FALLBACK_API_KEY=' "$ENV_FILE" | tail -1 | cut -d= -f2-)"
writer="$(grep -E '^CREATOR_LLM_MODEL_WRITER=' "$ENV_FILE" | tail -1 | cut -d= -f2-)"
model="$(grep -E '^CREATOR_LLM_MODEL=' "$ENV_FILE" | tail -1 | cut -d= -f2-)"
free_models="$(grep -E '^CREATOR_LLM_FREE_MODEL=' "$ENV_FILE" | tail -1 | cut -d= -f2-)"
# O gcloud usa a vírgula como separador de pares em --update-env-vars: os pares vão com delimitador alternativo
# (`^@^`), senão cada modelo do CSV seria lido como um par novo.
env_pairs="Creator__ElectoralContextEnabled=true@CREATOR_LLM_MODEL=${model:-google/gemini-2.5-flash}@CREATOR_LLM_MODEL_PLANNER=${planner:-google/gemini-2.5-flash}@CREATOR_LLM_MODEL_WRITER=${writer:-google/gemini-2.5-flash}@CREATOR_LLM_MODEL_WRITER_FALLBACK=${writer_fb:-claude-haiku-5-5}@CREATOR_LLM_MODEL_PLANNER_FALLBACK=${planner_fb:-claude-haiku-5-5}@CREATOR_LLM_FREE_MODEL=${free_models}"

gcloud run jobs update "$JOB" --project "$PROJECT" --region "$REGION" --container "$CONTAINER" \
  --update-env-vars "^@^${env_pairs}" \
  --set-secrets "CREATOR_DATABASE_URL=creator_database_url:latest,/secrets/cloudsql/server-ca.pem=fluxo-db-server-ca:latest,CREATOR_LLM_BASE_URL=creator_llm_base_url:latest,CREATOR_LLM_API_KEY=creator_llm_api_key:latest,CREATOR_LLM_FALLBACK_BASE_URL=creator_llm_fallback_base_url:latest,CREATOR_LLM_FALLBACK_API_KEY=creator_llm_fallback_api_key:latest,CREATOR_LLM_FREE_API_KEY=creator_llm_free_api_key:latest" >/dev/null
echo '✓ Job atualizado (env de models + secrets de LLM)'
gcloud run jobs execute "$JOB" --project "$PROJECT" --region "$REGION" --quiet >/dev/null
echo "✓ Execução disparada: gcloud run jobs executions list --job ${JOB} --region ${REGION}"
