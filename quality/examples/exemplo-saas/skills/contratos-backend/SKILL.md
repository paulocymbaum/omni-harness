---
name: contratos-backend
description: Regras de contratos entre app, API .NET e Cloud Functions no Exemplo SaaS (DTOs, versionamento, breaking changes, enums centralizados, flags USE_API_* da migração Firestore → REST, Idempotency-Key, Problem Details). Use ao criar ou alterar endpoints, DTOs, repositórios do app que escolhem entre REST e Firestore, callables, migrations SQL ou qualquer payload trocado entre camadas.
---

# Contratos e backend

## Regras

- Defina DTOs claros.
- Preserve contratos antigos quando possível.
- Em breaking change, introduza versionamento ou adaptação.
- Centralize enums e mapeamentos (skill `modelo-de-contas`).
- Não espalhe lógica de negócio por controllers, endpoints ou telas.

## Migração Firestore → API (em andamento)

- Cada repositório do app escolhe entre REST e Firestore por uma flag `bool.fromEnvironment('USE_API_*')` declarada no próprio `*_repository_impl.dart` (exemplo: `lib/features/events/data/event_repository_impl.dart`).
- O cliente HTTP é `lib/core/network/fluxo_api_client.dart` (base padrão `https://api.ofluxo.app/api/v1/`, sobrescrita por `--dart-define FLUXO_API_BASE_URL`).
- **Com a flag ativa, a API é a fonte autoritativa:** propague o erro e não faça fallback de escrita para o Firestore. O gate rápido verifica isso.
- Estado por domínio: `docs/migration/MIGRATION_STATUS_2026-08-25.md` e `docs/migration/REST_AND_JOBS_ROLLOUT_2026-09-19.md`.

## API .NET (`backend/`)

- Módulos por capacidade em `backend/src/Exemplo SaaS.Api/Modules/`.
- `Idempotency-Key` obrigatório em `POST`, `PUT`, `PATCH` e `DELETE` sob `/api/v1`.
- Erros em Problem Details (`application/problem+json`) com `code` e `traceId`.
- Escrita de domínio e outbox na mesma transação.
- Toda rota é protegida por padrão (Firebase Auth + App Check), exceto `/health/live`, `/health/ready` e o webhook de PSP `POST /webhooks/billing/asaas`, que tem caminho exato em `PspWebhookPaths` e é autenticado pelo segredo do PSP.
- `IdempotencyMiddleware.IsExempt` é uma lista fixa. Além dos parciais do debate, só `POST /api/v1/billing/invoices/{guid}/charges` fica fora, porque chama o PSP e não pode rodar na transação do middleware. Quem entra nessa lista precisa exigir `Idempotency-Key` no handler e ter unicidade própria no banco (`UNIQUE(invoice_id, client_key)`).
- Schema: SQL idempotente em `backend/deploy/sql/`, aplicado pelo `fluxo-migrator`.

Detalhes em `backend/README.md`.

## Risco

Na matriz de qualidade, `Modules/**` e `Persistence/**` são risco **alto**. Migrations, SQL, segurança, idempotência e outbox são **crítico**. Rode `node quality/run.mjs --risk` antes de concluir.
