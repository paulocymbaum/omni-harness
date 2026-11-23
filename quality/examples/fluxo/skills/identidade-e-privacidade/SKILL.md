---
name: identidade-e-privacidade
description: Regras de identidade legal (CPF/CNPJ), verificação, identidade federada, prova humana e privacidade de dados no Fluxo. Use ao tocar em CPF, CNPJ, documentos, verificação de conta, consentimentos, identidade federada, copresença, ou ao expor qualquer dado de usuário em resposta pública, perfil, mapa, feed, site ou log.
---

# Identidade e privacidade

## Regra central de identidade

- Pessoa física se relaciona conceitualmente a **CPF**.
- Entidade de negócio se relaciona conceitualmente a **CNPJ**.
- Ambos usam armazenamento seguro e abstrações de verificação.
- CPF/CNPJ **nunca** são display público.
- O sistema verifica sem expor o documento.

## Obrigatório

- Nunca expor CPF/CNPJ bruto em resposta pública, perfil público, documento público ou log.
- Preferir hash, tokenização ou referência segura (`cpfHash`, `cnpjHash`).
- Diferenciar identidade legal de identidade pública.
- Documentar o que é público, privado e interno em cada campo novo.
- Manter a arquitetura aberta para identidade federada e prova humana.
- Não acoplar blockchain como dependência obrigatória do core.
- Não substituir verificação por um booleano simplista sem camada de modelo.

## Verificado por máquina

O hook `.claude/hooks/regras-de-dominio.mjs`:
- **bloqueia** CPF ou CNPJ formatado (literal) em código fora de testes e fixtures;
- **avisa** quando um campo `cpf`/`cnpj` bruto aparece em camada pública (`ofluxo_site/src`, `lib/features/*/presentation`, DTOs de resposta da API, `functions/src/http`);
- **avisa** quando uma dependência de blockchain entra num manifesto.

Arquivos de regras de segurança (`firestore.rules`, `storage.rules`) e a borda de segurança da API são risco **crítico** na matriz de qualidade.

## Onde está o código

| Camada | Caminho |
|---|---|
| App | `lib/features/identity/`, `lib/features/account_context/`, `lib/features/presence_integrity/` |
| API | `backend/src/Fluxo.Api/Modules/Identity/`, `backend/src/Fluxo.Api/Infrastructure/Security/` |
| Functions | `functions/src/identity/`, `functions/src/features/identity_federated.ts`, `functions/src/presence/` |
| Plugin nativo | `packages/fluxo_presence_bridge/` |

## Docs relacionados

- `docs/IDENTITY_FEDERADA_CPF_CNPJ.md`
- `docs/IDENTIDADE.md`
- `docs/ROLLOUT_IDENTITY_FLAGS.md`
- `docs/FIRESTORE_RULES_IDENTITY.md`
- `docs/PRIVACY_DELETE.md`
- Teste ponta a ponta: `./scripts/test_identity_federation.sh`
