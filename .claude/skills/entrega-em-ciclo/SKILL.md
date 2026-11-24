---
name: entrega-em-ciclo
description: Orquestra o ciclo completo de uma entrega: investigação → gates → implementação → avaliação → compactação. Use quando for iniciar ou continuar uma entrega gerenciada pelo backlog.mjs. Referência principal para o agente principal e para o skill implementar-tarefa.
---

# Entrega em ciclo

O ciclo de entrega do Exemplo SaaS gerencia tarefas por meio do `backlog.json` em `docs/entregas/<slug>/`.

## Ponto de entrada — leia antes de qualquer ação

Ao receber uma solicitação de trabalho, identifique a intenção:

| Intenção detectada | O agente faz | Para aqui? |
|---|---|---|
| Planejar / levantar escopo / criar cards | Fase 0 + Fase A | **Sim — aguarda aprovação** |
| Implementar (entrega já planejada e aprovada) | Fase B em diante | Não (segue o ciclo) |
| Continuar entrega em andamento | Verificar estado e retomar na fase correta | Não |

**Regra:** pedidos de planejamento ("planejar", "levantar", "analisar o que precisa", "criar cards", "o que precisa mudar") **nunca avançam para implementação** sem instrução explícita do usuário depois da apresentação do plano.

---

## Diretório de uma entrega

```
docs/entregas/<AAAA-MM-DD-slug>/
  backlog.json       ← fonte da verdade (tarefas, gates, status)
  specs/             ← uma spec por tarefa (ID.md, Status: ready)
  SUMMARY.md         ← gerado pelo compactar-entregas.mjs ao fechar
```

---

## Fase 0 — Inicializar entrega e criar épico Jira

Executada apenas uma vez, ao abrir uma entrega nova.

```bash
# 1. Criar o diretório e backlog.json
node quality/delivery/backlog.mjs init docs/entregas/<AAAA-MM-DD-slug>

# 2. Editar backlog.json: adicionar tarefas com status pending, título e gates esperados
#    (o agente faz isso manualmente com Write/Edit antes de seguir)

# 3. Criar épico e stories no Jira
node scripts/tracker/sync-context.mjs docs/entregas/<slug> <ID> --status "To Do"
#    (repetir para cada tarefa do backlog)
```

O `sync-context.mjs` lê `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` e `JIRA_PROJECT_KEY` do `.env`.
Se as credenciais não estiverem disponíveis, registrar o impedimento no backlog (`--status blocked --motivo "credenciais Jira ausentes"`) e prosseguir sem sync.

---

## Fase A — Investigar specs e apresentar plano

```bash
# Delegar ao investigador-de-spec para cada tarefa pendente
# (Agent tool com subagent_type=investigador-de-spec)
```

O `investigador-de-spec`:
- Lê o código atual relevante
- Escreve `specs/<ID>.md` com `Status: ready`
- Não toca em código de produção

**Ao terminar a Fase A, o agente principal:**
1. Exibe o resumo do backlog: `node quality/delivery/backlog.mjs status docs/entregas/<slug>`
2. Lista cada spec criada com o contrato de implementação resumido
3. Exibe os links Jira gerados
4. **PARA** — não avança para a Fase B sem instrução explícita do usuário

---

## Fase B — Provar falha (baseline dos gates)

Executada somente após aprovação do usuário.

```bash
node quality/delivery/eval.mjs docs/entregas/<slug> <ID> --baseline
```

Confirma que os gates falham antes de qualquer implementação. Se já passarem, o gate não testa nada — revisar a spec.

---

## Antes dos cards: BRD, fluxo do usuário e épico

Ao abrir a entrega (`backlog.mjs init <dir> --feature <slug> --compose <docker-compose> --url <url> --roteiro "<passo>"…`), escreva `brd.md` (requisitos, regras de negócio, cenários BDD) e `fluxo-usuario.md` (passos e mermaid), ambos com `Status: ready`. O épico da feature no Jira recebe os dois (e os PNGs de `diagramas/fluxo-usuario*.png`) e todo card nasce filho dele: `node scripts/tracker/sync-context.mjs <dir> --epic` cria só o épico; `--all` cria o épico e todos os cards. Regras de nome e status: `docs/jira/regras-de-epicos-e-cards.md`.

## Fase C — Implementar

```bash
# Marcar in_progress (bloqueia se dependências não estiverem done)
node quality/delivery/backlog.mjs mark docs/entregas/<slug> <ID> --status in_progress

# Delegar ao implementador
# (Agent tool com subagent_type=implementador)

# Marcar done (roda gates automaticamente e espelha no Jira se credenciais disponíveis)
node quality/delivery/backlog.mjs mark docs/entregas/<slug> <ID> --status done

# Próxima tarefa do loop: exit 0 = há tarefa ou acabou; exit 3 = TRAVADA (restam só bloqueios)
node quality/delivery/backlog.mjs next docs/entregas/<slug>
```

Se o `mark` sair com exit 1 por causa do Jira, o backlog já foi gravado e o card **não** acompanhou: rode o `sync-context.mjs` que a mensagem indica antes de seguir.

---

## Fase D — Revisão de código (relatório de gates)

Executada assim que **todas** as tarefas estiverem `done`.

```bash
# 1. Estado final do backlog
node quality/delivery/backlog.mjs status docs/entregas/<slug>

# 2. Integridade anti-force-pass
node quality/delivery/integridade.mjs docs/entregas/<slug>

# 3. Validar estrutura dos gate tests
node quality/delivery/validate-testes.mjs quality/test/delivery/*.test.mjs

# 4. Eval-gates de cada tarefa (repetir para cada ID no backlog)
node quality/delivery/eval.mjs docs/entregas/<slug> <ID>

# 5. Qualidade do diff (nível pelo risco — ver skill avaliar-qualidade)
node quality/run.mjs --risk
node quality/run.mjs --tier rotina   # ou --tier completo se risco alto/crítico
```

Use a skill **`revisar-entrega`** para o passo a passo completo e o formato do relatório.
O relatório gerado aqui vai para o `entrega.md` (item 7 do conteúdo).

---

## Fase E — Revisão de domínio e laudo final

```bash
# Revisão de domínio
# (Agent tool com subagent_type=revisor-de-dominio)

# Laudo final
# (Agent tool com subagent_type=avaliador-de-entrega)
```

---

## Fase F — Documentar e compactar

```bash
# (Agent tool com subagent_type=documentador)
node quality/delivery/compactar-entregas.mjs docs/entregas/<slug>
```

---

## Portas ocupadas (gates e ambiente local)

Gates que sobem serviços locais (emulador do Firestore na 8089, Postgres descartável na 55432, Vite na 5173) podem falhar por "address already in use". Use a skill **`liberar-portas`**: `node scripts/dev/liberar-portas.mjs <porta>... [--dry-run]`. Rode `--dry-run` antes e só encerre processos que você subiu nesta tarefa.

---

## Comandos de referência rápida

```bash
# Estado atual
node quality/delivery/backlog.mjs status docs/entregas/<slug>

# Integridade
node quality/delivery/integridade.mjs docs/entregas/<slug>

# Gates de uma tarefa
node quality/delivery/eval.mjs docs/entregas/<slug> <ID>

# Bloquear (motivo = o que falta + quem resolve; depois, pergunte ao usuário se a ação for dele)
node quality/delivery/backlog.mjs mark docs/entregas/<slug> <ID> --status blocked --motivo "motivo"

# Compactar
node quality/delivery/compactar-entregas.mjs docs/entregas/<slug>

# Liberar portas ocupadas (uma, várias ou faixa)
node scripts/dev/liberar-portas.mjs 8089 55432 --dry-run
```

---

## Fase F — Homologação (Docker local)

Ao marcar `done` a **última** tarefa, o `mark` inicia sozinho a homologação se BRD, fluxo do usuário e ambiente Docker estiverem prontos: a feature vai para `em_homologacao`, todos os cards e o épico para **Homologation**, e a pasta da entrega ganha `homologacao.md` (como subir, onde testar, roteiro). Se faltar algo, o `mark` sai com exit 1 e lista as pendências (corrija e rode `node quality/delivery/backlog.mjs homologar <dir>`). Passe o roteiro ao usuário; ele decide: `homologar <dir> --aprovar` (cards e épico vão para **Production** — Done só depois do deploy) ou `homologar <dir> --reprovar --motivo "..."` (voltam a **In Progress** para correção). Depois do deploy em produção: `homologar <dir> --deploy` (cards e épico em **Done**). Nunca declare a feature entregue antes do deploy.

---

## Regras do ciclo

1. **Nenhuma tarefa entra em implementação sem spec em `Status: ready`.**
2. **Nenhuma tarefa é marcada `done` sem os gates passando** — o `mark` bloqueia automaticamente.
3. **Uma tarefa por vez em `in_progress`** — o `mark in_progress` bloqueia se outra estiver rodando.
4. **Dependências devem estar `done`** antes de `in_progress`.
5. **Tarefas `blocked` não bloqueiam as demais, mas também não somem**: siga com `backlog.mjs next` (exit 3 = travada, só restam bloqueios), pergunte ao usuário o que cada bloqueio precisa e **nunca declare a entrega concluída** com bloqueio aberto. Protocolo completo: `.claude/rules/backlog-e-gates.md` ("Bloqueio: nunca encerre calado").
6. **Gates não podem ser alterados depois de criados** sem justificativa documentada na spec.
7. **Planejamento para na Fase A.** O agente não avança para implementação sem instrução explícita após a apresentação do plano.

---

## Agentes do ciclo

| Agente / Skill | Fase | Quando usar |
|---|---|---|
| `investigador-de-spec` | A | spec em draft → ready |
| `planejador` | — | plano arquitetural antes de abrir o backlog (features grandes) |
| `implementador` | C | escrever o código |
| skill `revisar-entrega` | D | relatório de eval-gates após todas as tarefas done |
| `revisor-de-dominio` | E | revisão de domínio após o relatório de gates |
| `avaliador-de-entrega` | E | laudo final antes de fechar |
| `documentador` | F | atualizar docs/ e entrega.md |

---

## Entrega ativa (guarda-entrega)

Quando `quality/.state/entrega-ativa.json` existe, o hook `guarda-entrega.mjs` avisa se uma edição sair do escopo da tarefa. Para desativar, apague o arquivo.

```json
{ "taskId": "RB-009", "scope": ["quality/delivery/integridade.mjs"] }
```

---

## Jira

O `backlog.mjs mark` chama `tryJiraSync` automaticamente se `JIRA_API_TOKEN` estiver no ambiente (não-bloqueante). Para criar o épico e as stories na Fase 0, use `sync-context.mjs` diretamente. Para espelhar todas as tarefas de uma vez:

```bash
node scripts/tracker/sync-context.mjs docs/entregas/<slug> --all
```

Credenciais esperadas no `.env`: `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_PROJECT_KEY`.

## Jira sempre em dia

Regra permanente (ver `.claude/rules/backlog-e-gates.md`): tarefa nova ou retitulada → `node scripts/tracker/sync-context.mjs <dir> <ID>`; status → só pelo `backlog.mjs mark`; lote → `sync-context.mjs <dir> --all` e confira que a contagem por status bate com `backlog.mjs status`; antes de encerrar, sincronize e informe o resultado. Nunca coloque uid, e-mail, `businessId`, CPF/CNPJ ou token real em card.
