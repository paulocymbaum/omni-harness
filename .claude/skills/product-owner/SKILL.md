---
name: product-owner
description: Triage e gestão do backlog de entrega. Escolhe a próxima seção do roadmap a atacar, abre ou atualiza o backlog.json correspondente, espelha no Jira (Epic + Stories) e mantém o status alinhado entre backlog local e Jira. Use ao iniciar uma nova entrega, ao priorizar, ou ao receber credenciais Jira.
---

# Product Owner — gestão de backlog e Jira

## Responsabilidades

1. **Triage**: decide qual entrega atacar com base no roadmap e nos objetivos do produto.
2. **Abertura de entrega**: inicializa `backlog.json` e cria o épico Jira.
3. **Espelhamento**: mantém status do backlog local sincronizado com o Jira.
4. **Visibilidade**: renderiza o backlog em Markdown e adiciona comentários de progresso nos cards.

## Credenciais necessárias

No `.env` (nunca no código):
```
JIRA_BASE_URL=https://paulocymbaum.atlassian.net
JIRA_EMAIL=contato@ofluxo.app
JIRA_API_TOKEN=<token gerado em id.atlassian.com/manage-profile/security/api-tokens>
JIRA_PROJECT_KEY=OFLUXO
```

## Exemplo SaaS de abertura de nova entrega

```bash
# 1. Inicializar backlog (com a categoria da feature para os cards do Jira)
node quality/delivery/backlog.mjs init docs/entregas/<AAAA-MM-DD-slug> --feature <slug-da-feature> --versao <tag> --categoria <categoria>

# 2. Espelhar no Jira (cria ou atualiza card)
node scripts/tracker/sync-context.mjs docs/entregas/<slug> <ID> --status "To Do"

# 3. Ver status
node quality/delivery/backlog.mjs status docs/entregas/<slug>
```

## Categorias (labels) de feature nos cards

Todo card criado ou atualizado pelo espelho recebe categorias (labels) do Jira:

- `feature-<slug>` — slug da feature, ex.: `feature-fluxo-onibus`. Origem: campo `featureSlug` do `backlog.json` (flag `--feature` do `init`) ou, na falta, derivado do diretório da entrega (sem o prefixo de data).
- `versao-<tag>` — tag de versão, ex.: `versao-v1.0`. Origem: `--versao`/`version` do backlog; sem flag, usa a data de criação do backlog (`created`).
- **Categorias extras:** `categories: []` no `backlog.json` ou flags `--categoria <label>` (repetível) no `init` e no `sync-context.mjs`.
- **Summary do card é limpo:** `<ID> — <título>` — sem feature e sem data. A data de criação é o campo nativo `created` do card; feature e versão vivem nas labels. Matching de card existente: `labels = "feature-<slug>"` + id da tarefa, com fallback legado para cards antigos (`[backlog.id]` no nome).
- Labels são **aditivas**: o re-sync nunca remove labels colocadas manualmente (patch `update.labels` na API v3).
- A description do card também declara `Feature:` e `Categorias:` no topo.
- Sanitização automática para o alfabeto do Jira (acentos/espaços viram hífen) — ver `sanitizeJiraLabel`/`cardLabels` em `quality/delivery/lib.mjs`.

Regra: entrega promovida do parking lot usa **o mesmo slug do arquivo da feature** (`docs/parking-lot/<slug>.md`) para o Jira filtrar por feature.

## Exemplo SaaS de espelhamento contínuo

O `backlog.mjs mark` espelha automaticamente se `JIRA_API_TOKEN` estiver no ambiente.

Para espelhar manualmente uma tarefa específica:
```bash
node scripts/tracker/sync-context.mjs docs/entregas/<slug> <ID>
```

Para espelhar todas as tarefas de uma entrega:
```bash
node scripts/tracker/sync-context.mjs docs/entregas/<slug> --all
```

## Mapeamento de status

| Backlog | Jira |
|---|---|
| `pending` | To Do |
| `in_progress` | In Progress |
| `done` | Done |
| `blocked` | Blocked |
| `cancelled` | Cancelled |

## Board ativo

- Projeto: `OFLUXO`
- Board: 34 (`https://paulocymbaum.atlassian.net/jira/software/projects/OFLUXO/boards/34`)
- Tipo de issue padrão: Story (id 10036)

## Regras de PO

- Nunca mova um card para "Done" no Jira sem o `backlog.mjs mark --status done` ter passado os gates.
- Cards `blocked` no backlog devem ter `--motivo` documentado.
- Um épico Jira por entrega (`docs/entregas/<slug>`); stories para as tarefas.
- Comentários de progresso são adicionados pelo `sync-context.mjs` automaticamente.

## Jira sempre em dia

Regra permanente (ver `.claude/rules/backlog-e-gates.md`): tarefa nova ou retitulada → `node scripts/tracker/sync-context.mjs <dir> <ID>`; status → só pelo `backlog.mjs mark`; lote → `sync-context.mjs <dir> --all` e confira que a contagem por status bate com `backlog.mjs status`; antes de encerrar, sincronize e informe o resultado. Nunca coloque uid, e-mail, `businessId`, CPF/CNPJ ou token real em card.
