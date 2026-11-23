<!-- GERADO por quality/agents/sync-clinerules.mjs a partir de .claude/rules/deploy-actions-billing.md. Não edite aqui. -->

# Regra de deploy — probe do Actions antes de todo deploy

Aplicada em toda sessão (Claude Code, Cline e demais agentes). Sonda: `node scripts/deploy/release.mjs --probe` (billing via `gh api`, barato); inconclusivo → sonda de dispatch `deploy-probe.yml` (~2 s de runner) que o `--run` já faz sozinho. Fonte técnica: `scripts/deploy/actions-quota.mjs`.

## Regra

1. **Antes de TODO comando de deploy por Actions** (`release.mjs --run` sem `--local`, `gh workflow run`, `gh run rerun`, acompanhamento de esteira): rode o probe.
2. **Sem saldo (exit 1) → deploy por script local SEMPRE**: `node scripts/deploy/release.mjs --run <id> --local` ou o script direto de `scripts/deploy/local/`. Nunca repita tentativa no Actions nem "conserte" workflow por causa do billing.
3. **Inconclusivo** (billing sem escopo no token): siga com `--run` — o orquestrador faz a sonda de dispatch e cai para o local se ela falhar.
4. **Push em RELEASE/main também dispara esteiras**: com saldo esgotado isso não substitui deploy — o passo segue por script local.
5. Saldo esgotado é transitório (renovação mensal do plano free): re-probe depois da renovação; nada para migrar em código.

## Chave dura GH_ACTIONS (default false)

`scripts/deploy/gh-actions.mjs` exporta `GH_ACTIONS_ENABLED = process.env.GH_ACTIONS === 'true'` — **ausente do ambiente = desligado**. Desligado (o estado padrão, hardcoded):

- **NENHUMA chamada a `gh api`/`gh workflow`/probe/dispatch**: `actions-quota.mjs` nem spawnou o `gh`; `release.mjs` recusa `--run` de passo de Actions com a instrução `--local` e o `--probe` responde `Actions DESLIGADO — deploy por script local SEMPRE` (exit 1).
- **USAR SOMENTE os scripts locais de qualidade e deploy**: `node quality/run.mjs`, `node scripts/deploy/local/release-bump.mjs`, `scripts/deploy/local/deploy-{api,web,worker}.sh`.
- Passos locais do grafo (`validacao`, `versionar`, `jira-done`) continuam funcionando sem `--local`.
- **Religar** (billing renovado): `export GH_ACTIONS=true` no ambiente e re-probe. Nada no repo religa sozinho.

Estado atual e runbook completo: [docs/entregas/2026-11-14-fluxo-creator/deploy.md](../../docs/entregas/2026-11-14-fluxo-creator/deploy.md) (seção "Bloqueio atual").
