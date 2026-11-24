#!/usr/bin/env bash
# Login do gcloud como a conta de serviço de LEITURA do Firestore (fluxo-harness-reader),
# com a chave vinda do Doppler (projeto ofluxo, config dev_personal). A chave nunca vai
# para disco nem para o log. Use com `source`, para exportar CLOUDSDK_CONFIG no seu shell:
#
#   source scripts/doppler/gcp-harness-login.sh
#   gcloud firestore databases list --project="$GCP_PROJECT_ID"
#
# Requisito: `doppler login --scope <pasta do repositório>` já feito (workplace o_fluxo).
# Para encerrar: `gcp_harness_logout`.
_doppler_cfg="${FLUXO_DOPPLER_CONFIG:-dev_personal}"
_gcp_get() { doppler secrets get "$1" -p ofluxo -c "$_doppler_cfg" --plain 2>/dev/null; }

GCP_PROJECT_ID="$(_gcp_get GCP_PROJECT_ID)"
if [ -z "$GCP_PROJECT_ID" ]; then
  echo "gcp-harness-login: GCP_PROJECT_ID ausente em ofluxo/$_doppler_cfg (faça doppler login no escopo do repositório)." >&2
  return 1 2>/dev/null || exit 1
fi
export GCP_PROJECT_ID

_cfg_dir="$(mktemp -d "${TMPDIR:-/tmp}/gcloud-harness.XXXXXX")" && chmod 700 "$_cfg_dir"
if _gcp_get GCP_SERVICE_ACCOUNT_KEY_JSON | CLOUDSDK_CONFIG="$_cfg_dir" gcloud auth activate-service-account --key-file=/dev/stdin >/dev/null 2>&1; then
  export CLOUDSDK_CONFIG="$_cfg_dir"
  gcp_harness_logout() { rm -rf "$CLOUDSDK_CONFIG"; unset CLOUDSDK_CONFIG GCP_PROJECT_ID; unset -f gcp_harness_logout; }
  echo "gcloud ativo como $(_gcp_get GCP_SERVICE_ACCOUNT_EMAIL) (somente leitura do Firestore, projeto $GCP_PROJECT_ID)."
else
  rm -rf "$_cfg_dir"
  echo "gcp-harness-login: falha ao ativar a conta de serviço." >&2
  return 1 2>/dev/null || exit 1
fi
unset _doppler_cfg _cfg_dir
