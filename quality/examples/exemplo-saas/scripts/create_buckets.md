# Criacao de buckets dedicados para resize

## Objetivo

Criar buckets separados para evitar triggers desnecessarios do `storage-resize-images`.

Buckets:

- `gs://<PROJECT_ID>-fluxo-users`
- `gs://<PROJECT_ID>-fluxo-event-media`

## Comandos (gcloud)

```bash
PROJECT_ID="fluxo-ath"
LOCATION="southamerica-east1"

for suffix in fluxo-users fluxo-event-media; do
  BUCKET="${PROJECT_ID}-${suffix}"
  gcloud storage buckets create "gs://${BUCKET}" \
    --project="${PROJECT_ID}" \
    --location="${LOCATION}" \
    --uniform-bucket-level-access

done
```

## Verificacao

```bash
gcloud storage buckets list --project="${PROJECT_ID}" \
  --filter="name:${PROJECT_ID}-fluxo-"
```

## Observacoes

- Manter regiao alinhada ao Firestore/Functions reduz latencia e custo de egress.
- Com UBLA habilitado, autorizacao fica centralizada nas regras de Firebase Storage.
- So criar bucket com `gcloud` nao basta para o endpoint `firebasestorage.googleapis.com`.
  E obrigatorio vincular targets de Storage no Firebase CLI e fazer deploy das rules.

## Vincular targets de Storage e publicar regras (obrigatorio)

```bash
PROJECT_ID="fluxo-ath"

firebase target:apply storage default "${PROJECT_ID}.firebasestorage.app" --project "${PROJECT_ID}"
firebase target:apply storage users "${PROJECT_ID}-fluxo-users" --project "${PROJECT_ID}"
firebase target:apply storage event_media "${PROJECT_ID}-fluxo-event-media" --project "${PROJECT_ID}"
firebase target:apply storage legacy_avatars "${PROJECT_ID}-fluxo-avatars" --project "${PROJECT_ID}"
firebase target:apply storage legacy_stories "${PROJECT_ID}-fluxo-stories" --project "${PROJECT_ID}"

firebase deploy --only storage --project "${PROJECT_ID}"
```

## Migracao do bucket padrao (opcional, recomendado)

Se houver midia legada em `gs://<PROJECT_ID>.firebasestorage.app`, migre para os buckets dedicados:

```bash
# dry-run (sem escrita)
./scripts/migrate_default_bucket_media.sh --project-id <PROJECT_ID>

# execucao real (mantem origem)
./scripts/migrate_default_bucket_media.sh --project-id <PROJECT_ID> --execute

# execucao real + remove origem apos verificacao
./scripts/migrate_default_bucket_media.sh --project-id <PROJECT_ID> --execute --delete-source
```

Mapeamentos cobertos pelo script:

- `events/` -> `gs://<PROJECT_ID>-fluxo-event-media/events/`
- `users/`, `stories/`, `avatars/`, `user_uploads/`, `FCMImages/` -> `gs://<PROJECT_ID>-fluxo-users/users/`

Arquitetura canônica:

- `fluxo-users`: mídia de usuário (profile, media, stories)
- `fluxo-event-media`: mídia de evento (cover, gallery, stories de evento)
