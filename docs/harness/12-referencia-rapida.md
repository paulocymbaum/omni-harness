---
titulo: Referência rápida
atualizado: 2026-11-21
fontes: [quality/.state, quality/config, docs/harness]
---

# 12. Referência rápida

## Comandos

| Momento | Comando |
|---|---|
| Risco e nível exigido | `node quality/run.mjs --risk` |
| Iteração / entrega / release | `node quality/run.mjs --tier rapido\|rotina\|completo [--base remote]` |
| Autocorreção de gate/teste | `node quality/run.mjs --fix` |
| Plano de versão / apply / check | `npm run version:bump [-- --apply\|--init\|--next <camada>\|--check]` |
| Release local completa | `node scripts/deploy/local/release-bump.mjs [--dry-run] [--no-main]` |
| Deploy por passo (probe antes; `GH_ACTIONS=false`: `--local` direto) | `node scripts/deploy/release.mjs --probe` · `--run <id> [--local]` |
| Grafo | `graphify query\|path\|explain\|affected "<identificador>"` · `node quality/agents/graphify-build.mjs [--update]` |
| Estado do backlog | `node quality/delivery/backlog.mjs status\|next <dir>` |
| Gates de tarefa / prova de falha | `node quality/delivery/eval.mjs <dir> <ID> [--baseline]` |
| Mudança de status | `node quality/delivery/backlog.mjs mark <dir> <ID> --status … [--motivo …]` |
| Espelho Jira | `node scripts/tracker/sync-context.mjs <dir> <ID>\|--all\|--epic` |
| Espelho de regras p/ Cline | `node quality/agents/sync-clinerules.mjs [--check]` |
| Porta ocupada | `node scripts/dev/liberar-portas.mjs <porta>… [--dry-run]` |

## Variáveis de ambiente

| Variável | Efeito | Doc |
|---|---|---|
| `GRAPHIFY_HOOK_MODE=soft\|strict\|off` (ou `GRAPHIFY_HOOK_STRICT=0\|1`) | guarda de busca: dica única / nega no Claude / desliga | 04 |
| `HARNESS_PROFILE` (alias `FLUXO_PROFILE`) | escolhe o perfil ativo em `quality/profile/` (obrigatório só se houver mais de um) | 01 |
| `HARNESS_PROFILE_DIR` | dir de perfis alternativo (ex.: `quality/examples/exemplo-saas/profile` exercita o motor com o exemplo completo) | 01 |
| `RTK_DISABLED=1` | desliga a reescrita rtk | 04 |
| `HARNESS_SKIP_QUALITY_GATES=1` (alias `FLUXO_SKIP_QUALITY_GATES`) | pula gates do pre-commit | 10 |
| `HARNESS_AUTOFIX=0` (alias `FLUXO_AUTOFIX`) | desliga autocorreção no post-edit | 03 |
| `HARNESS_JIRA_AUTOSYNC=0` (alias `FLUXO_JIRA_AUTOSYNC`) | desliga autosync de spec → card | 03, 08 |
| `HARNESS_JIRA_SYNC=0` (alias `FLUXO_JIRA_SYNC`) | desliga o espelho backlog → Jira do `mark`/homologação | 08 |
| `QUALITY_MEM_MAX_MB` / `QUALITY_CPU_QUOTA` / `QUALITY_WORKERS` / `QUALITY_RESOURCES=off` | teto de recursos dos gates | 10 |
| `JIRA_BASE_URL` / `JIRA_EMAIL` / `JIRA_API_TOKEN` / `JIRA_PROJECT_KEY` | credenciais do espelho (`.env`) | 08 |
| `GH_ACTIONS=true` (default: **false**) | religa o caminho Actions (probe, dispatch, PR); desligado = só qualidade e deploy locais | 06 |

## Arquivos de estado (`quality/.state/`)

| Arquivo | Nasce quando | Seguro apagar? |
|---|---|---|
| `evidence/` | cada nível aprovado (hash da árvore) | sim — invalida a evidência: o commit/push vai pedir nível de novo |
| `graphify-guard.json` | consulta ao graphify bem-sucedida (janela de 30 min) | sim — a janela fecha |
| `anti-loop.json` | detector anti-loop por sessão | sim |
| `sessions/` | inventário e risco por sessão | sim |
| `entrega-ativa.json` | durante entrega em ciclo (escopo da tarefa) | sim — desliga a guarda-entrega (doc 07) |

## Índice por sintoma

| Sintoma | Onde procurar |
|---|---|
| "Meu commit/push/deploy foi bloqueado" | evidência por hash → docs 02 e 04; gitflow → doc 05 |
| "O hook reprovou meu arquivo" | runbook do nível rápido/autofix → doc 03; limites → doc 10 |
| "Busca bruta negada (strict)" | janela do graphify → doc 04 |
| "CNPJ/CPF no código bloqueou" | regras de domínio → doc 03 |
| "Tarefa não marca `done`" | gates mapeados → doc 07; espelho Jira → doc 08 |
| "Editei o backlog.json e foi negado" | guarda-backlog → doc 07 |
| "Release diz 'nada a versionar' mas há pendente" | plano contra origin/develop (`--head`) → doc 06 |
| "Deploy falhou no Actions em segundos" | billing sem saldo → probe + caminho local → doc 06 |
| "Homologação aprovada e o deploy ficou pra trás" | detector no Stop (`quality/lib/deploy-pendente.mjs`) → docs 02 e 06 |
| "Dica do graphify toda hora no Cline" | modos soft/strict → doc 04 |
| "Cline abortou a tarefa inteira" | semântica `cancel` → doc 09 |
| "Conflito git parou tudo" | runbook do post-bash-gitflow → doc 05 |
| "Agente encerrou sem handoff" | bloco HANDOFF → doc 11 |

## Testes (por arquivo, nunca a suíte inteira)

```bash
node --test quality/test/hooks.test.mjs            # session-start, stop, post-edit, pre-bash
node --test quality/test/gitflow.test.mjs quality/test/gitflow-hooks.test.mjs
node --test quality/test/search-guard.test.mjs
node --test quality/test/anti-loop.test.mjs
node --test quality/test/autofix.test.mjs
omni-harness hosts [destino] [--json]              # hosts suportados e paths resolvidos (com overrides do hospedeiro)
node --test quality/test/hosts.test.mjs              # integração por host (claude-code, cline, codex, vscode, antigravity, kiro, opencode, kimicode)
node --test quality/test/ide-providers.test.mjs      # matriz funcional dos provedores: init + hook/carrier respondendo + doctor, provedor a provedor
node --test quality/test/package.test.mjs              # pacote npm: bin, files e fluxo dlx de ponta a ponta
# Testes de motor com fixtures do exemplo: bootstrap-example-profile ativa o perfil automaticamente (sem env):
HARNESS_PROFILE_DIR="$PWD/quality/examples/exemplo-saas/profile" node --test quality/examples/exemplo-saas/gates/version.test.mjs quality/examples/exemplo-saas/gates/version-flow.test.mjs
node --test quality/test/release-flow.test.mjs
node --test quality/test/cline-bridge.test.mjs
node --test quality/test/jira-workflow-statuses.test.mjs
node --test quality/test/delivery/referencias.test.mjs   # referências do harness não quebram
node --test quality/test/profile.test.mjs                # perfil do projeto valida (schema v1 + paridade)
node --test quality/test/delivery/backlog.test.mjs       # (e os demais por arquivo)
node --test quality/test/delivery/ciclo.integration.test.mjs
```

## Convenções que atravessam tudo

- Vereditos de gate: `APROVADO` / `REPROVADO` / `ALERTA` / `IGNORADO` — alerta e ignorado **não são** aprovação.
- Mensagens de hook e de script em pt-BR (`quality/messages.pt-BR.json`), com caminho e ação.
- Falha aberta: bug de hook nunca derruba o trabalho do agente.
- Dados sensíveis nunca em código, log, doc ou card (CPF/CNPJ, tokens, e-mails, uids).
- Resposta curta e precisa (regra economia-de-tokens); código, commit, doc e aviso de segurança nunca comprimidos.

## Fontes

- Todos os docs: [docs/harness/INDEX.md](INDEX.md) · Regras: [.claude/rules/](../../.claude/rules) · Skills: [.claude/skills/](../../.claude/skills)

