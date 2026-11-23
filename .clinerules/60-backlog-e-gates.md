<!-- GERADO por quality/agents/sync-clinerules.mjs a partir de .claude/rules/backlog-e-gates.md. Não edite aqui. -->

# Regra de backlog e gates — loop de entrega

Aplicada em toda sessão. Complementa a skill `entrega-em-ciclo`.

## Invariantes do loop (nunca quebre)

1. **Spec `ready` antes de codificar** — nenhuma tarefa entra em `in_progress` sem spec investigado.
2. **Gates provando falha antes de implementar** — rode `eval.mjs --baseline` e confirme que os gates falham; se já passam, o gate não testa nada.
3. **Uma tarefa `in_progress` por vez** — `backlog.mjs mark in_progress` bloqueia se outra estiver rodando.
4. **`mark done` roda os gates** — nunca edite `status` diretamente no JSON; use o CLI.
5. **Dependências `done` primeiro** — `mark in_progress` bloqueia se deps não estiverem done.
6. **Gates congelados** — `mark in_progress` grava `gates_sha`; se os gates da tarefa mudarem depois, o `mark done` recusa até você registrar `--correcao "<o que mudou e por quê>"`. Gate pesado: `timeout_ms` no próprio gate (padrão 120 s, máximo 15 min).
7. **Status não se edita no JSON** — o hook `guarda-backlog.mjs` nega a edição direta de `status` em `backlog.json` (Claude Code); use `mark`.

## Épico da feature, BRD, fluxo do usuário e homologação

Detalhe e tabelas: `docs/jira/regras-de-epicos-e-cards.md`.

1. **Um épico por feature, todo card é filho dele.** O `sync-context.mjs` cria o épico antes do primeiro card, com a definição completa do backlog e um texto legível para pessoas.
2. **Antes de abrir cards, escreva o BRD e o fluxo do usuário** (`brd.md` e `fluxo-usuario.md` na pasta da entrega; `backlog.mjs init` cria os rascunhos). Cada um precisa de `Status: ready` e de nenhum dado pessoal. O BRD traz requisitos, **regras de negócio** e cenários **BDD**; o fluxo traz os passos e um diagrama mermaid (PNG opcional em `diagramas/fluxo-usuario.png`). Os dois vão no épico; sem eles o épico fica com `brd-pendente`/`fluxo-pendente`.
3. **Defina `homologacao`** no backlog (compose do Docker local, comando para subir, URL, roteiro). Ao marcar `done` a **última** tarefa, a feature vai para `em_homologacao` e todos os cards e o épico vão para **Homologation**. Se BRD, fluxo ou ambiente Docker não estiverem prontos, não vai: o `mark` sai com exit 1 e lista o que falta. Entregue o `homologacao.md` ao usuário; `homologar <dir> --aprovar` ou `--reprovar --motivo` fecha o ciclo.
4. Testes do Jira: `node scripts/tracker/test-funcional.mjs` (offline) e `node scripts/tracker/test-integracao.mjs` (real, com sandbox que se apaga).

## Bloqueio: nunca encerre calado

`blocked` não é um lugar para deixar a tarefa: é um pedido a alguém. Quando uma tarefa travar:

1. **Classifique o bloqueio.** *Técnico* (3 reparos sem progresso na mesma causa raiz): relate e peça rumo. *Decisão ou ação do usuário* (parecer, escolha de arquitetura, credencial, código de login, autorização de deploy): **pergunte ao usuário na hora** (`AskUserQuestion` no agente principal), com a opção recomendada. *Serviço externo fora do ar*: diga qual e até quando vale esperar.
2. `mark <dir> <ID> --status blocked --motivo "<o que falta> — <quem resolve>"`. O motivo vai para o card (que passa a "Blocked"). Se o `mark` sair com exit 1 por causa do Jira, o backlog já foi gravado: rode o `sync-context.mjs` indicado na mensagem e **não** diga que o card foi atualizado antes disso.
3. **Continue com o que não depende dela**: `node quality/delivery/backlog.mjs next <dir>`. Exit 0 traz a próxima tarefa; **exit 3 = travada** (só restam bloqueios), e a saída lista motivo e tarefas presas.
4. **Travada = pare e diga.** Entregue ao usuário a lista de bloqueios com a ação que cada um precisa. Nunca declare a feature concluída, não escreva "entrega concluída" no `entrega.md` e não pule a revisão final como se tudo estivesse `done`.
5. Subagente (`implementador`) não fala com o usuário: devolve `Resultado: blocked` ou `needs-decision` no handoff, e o **agente principal** transforma isso em pergunta ao usuário antes de seguir.
6. Quando o bloqueio cair: `mark ... --status in_progress` (o motivo antigo sai sozinho) e retome.

## Backlog vivo

O estado autoritativo está em `backlog.json`, não neste arquivo nem no README:
```
docs/entregas/2026-10-01-harness-entrega-em-ciclo/backlog.json
```

Para ver o estado atual:
```bash
node quality/delivery/backlog.mjs status docs/entregas/2026-10-01-harness-entrega-em-ciclo
```

## Anti-force-pass

Antes de qualquer entrega, rode:
```bash
node quality/delivery/validate-testes.mjs quality/test/delivery/*.test.mjs
node quality/delivery/integridade.mjs docs/entregas/2026-10-01-harness-entrega-em-ciclo
```

Padrões proibidos nos gate tests: `assert.ok(true)`, bloco vazio, `test.skip` incondicional.

## Jira

O card Jira (projeto `OFLUXO`) é o espelho que o time enxerga. Em **todo** passo do ciclo de entrega:

1. **Tarefa nova no `backlog.json`** → crie o card na hora: `node scripts/tracker/sync-context.mjs <dir> <ID> --status "To Do"`.
2. **Tarefa retitulada ou com escopo alterado** → re-sincronize: `node scripts/tracker/sync-context.mjs <dir> <ID>`.
3. **Mudança de status** → só pelo CLI (`backlog.mjs mark ... --status ...`), que espelha sozinho. Nunca edite `status` no JSON.
4. **Mudança em lote no backlog** → `node scripts/tracker/sync-context.mjs <dir> --all` e confira que a contagem de cards por status bate com `backlog.mjs status`.
5. **Bloqueio** → `--status blocked --motivo "..."`; o motivo vai para o card.
6. **Antes de encerrar uma sessão ou entrega** → rode o passo 4 e informe ao usuário o resultado.

**Card sem spec**: o card criado antes da spec nasce com a label `spec-pendente` e o texto "Spec ainda não escrita"; o hook `sync-spec-jira.mjs` o atualiza quando a spec é gravada e a label sai sozinha. A chave do card fica em `jira_key` na tarefa (o sync acha o card por ela, não por busca). Erro na busca do Jira aborta o sync com aviso e **nunca cria card duplicado**. Para listar tarefas sem spec (local, sem rede): `node scripts/tracker/sync-context.mjs <dir> --audit`.

Status do Jira vêm traduzidos conforme a conta (`A fazer`, `Em Progresso`, `Concluído`): compare sempre com `canonicalStatus` (`scripts/tracker/workflow.mjs`). Credenciais: `.env.local` (token pessoal de quem desenvolve) antes do `.env`; as `JIRA_*` vêm de um só arquivo. Quem move um card com o token do `.env.local` vira o responsável por ele (`FLUXO_JIRA_ASSIGN=0` desliga). Fluxo de movimentação: `docs/jira/regras-de-epicos-e-cards.md`.

Nunca coloque uid, e-mail, `businessId`, CPF/CNPJ ou token real em card, comentário ou título. Se faltar credencial `JIRA_*`, diga isso ao usuário em vez de seguir em silêncio.

Quando as credenciais estão em `.env` (`JIRA_*`), o `mark` espelha automaticamente. RB-014 (produto-owner + sync) está no backlog.
