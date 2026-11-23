# BRD — Harness de entrega em ciclo
Status: ready

Documento derivado de `backlog.json`, `SUMMARY.md`, `specs/RB-001` a `RB-015`, da skill `entrega-em-ciclo`, das regras `.claude/rules/backlog-e-gates.md` e dos scripts em `quality/delivery/`. Aqui o "usuário" é a pessoa ou o agente que conduz uma entrega. Os pontos que estavam em aberto foram verificados no código ou decididos (seção \"Decisões e verificações\").

## Objetivo e valor

O harness de entrega em ciclo faz uma entrega de software do Fluxo andar por fases verificáveis por máquina: investigar a spec, provar que os gates falham, implementar, rodar os gates, avaliar, documentar e compactar. O estado fica em `docs/entregas/<slug>/backlog.json`, e o espelho no Jira (projeto `OFLUXO`) acompanha cada passo.

Valor:

- Nenhuma tarefa vira `done` sem os gates passarem: o `mark done` roda os gates e bloqueia se falharem.
- Gates só valem se falham antes da implementação (`eval.mjs --baseline`), o que impede teste que não testa nada.
- Detectores de force-pass (`integridade.mjs`, `validate-testes.mjs`) barram marcação sem evidência e testes tautológicos.
- Agentes com papéis separados por fase (investigar, escrever gates, implementar, corrigir, avaliar, documentar, revisar) reduzem retrabalho e deixam handoffs rastreáveis.
- O time enxerga o andamento nos cards Jira, filhos do épico da feature.

Estado em 2026-11-14 segundo `backlog.json`: as 15 tarefas (RB-001 a RB-015) estão `done`. O `SUMMARY.md` foi regerado e mostra 15 `done`.

## Escopo

- Dentro:
  - Correção das referências quebradas do harness anterior (RB-001) e biblioteca comum `quality/delivery/lib.mjs` (RB-002).
  - `backlog.mjs`: `init`, `status`, `render` (RB-003), `validate` (RB-004), `mark` condicionado aos gates (RB-006); backlog movido para `docs/entregas/<slug>/` (RB-007).
  - Runner `eval.mjs` sem shell, com relatório, e modo `--baseline` (RB-005, RB-008).
  - Detector de force-pass `integridade.mjs` (RB-009) e hook `guarda-entrega.mjs` (RB-010).
  - Agentes do ciclo (RB-011) e skills `entrega-em-ciclo`, `implementar-tarefa` (RB-012), `compactar-entregas` (RB-013), `product-owner` com espelho Jira (RB-014).
  - Documentação final e specs de todas as tarefas (RB-015).
  - Extensões posteriores presentes no repositório e descritas nas regras e skills: `next`, épico Jira por feature, BRD e fluxo do usuário, homologação em Docker local, bloqueio com motivo, handoff entre fases.
- Fora:
  - Regras de domínio do produto Fluxo (contas, eventos, mapa): são tratadas por skills próprias, não pelo harness.
  - Implementação das entregas de produto em si; o harness só as conduz.
  - Alterar o `status` de tarefas fora do CLI `backlog.mjs mark`.

## Requisitos de negócio

- RN-01: Cada entrega tem um `backlog.json` autoritativo em `docs/entregas/<AAAA-MM-DD-slug>/` com tarefas, dependências e gates.
- RN-02: Nenhuma tarefa entra em implementação sem spec `Status: ready`.
- RN-03: Os gates de cada tarefa devem falhar antes da implementação (prova de baseline).
- RN-04: Uma tarefa só vai para `done` depois de todos os gates `command` passarem.
- RN-05: Só uma tarefa fica `in_progress` por vez, e só depois das dependências `done`.
- RN-06: O sistema detecta sinais de force-pass (tarefa `done` sem `done_at`, dependência não concluída, testes tautológicos, vazios ou com skip incondicional).
- RN-07: Bloqueio é um pedido a alguém: exige motivo, que vai para o card, e nunca encerra calado.
- RN-08: Cada tarefa tem um card Jira, filho do épico da feature, e os status acompanham o backlog.
- RN-09: Antes de abrir os cards, a feature tem BRD e fluxo do usuário, e antes de ser dada como entregue passa por homologação.
- RN-10: Cada fase do ciclo termina com um handoff estruturado, validado e gravado.
- RN-11: Uma entrega concluída é compactada em `SUMMARY.md`.
- RN-12: Os gates de uma tarefa ficam congelados ao entrar em `in_progress`; mudá-los antes do `done` só passa com uma correção registrada (`--correcao`), para ninguém afrouxar o gate para ficar verde.
- RN-13: O `status` de tarefa só muda pelo `mark`; a edição direta do `backlog.json` que muda status é negada por hook.
- RN-14: Cada gate tem timeout de 120 s por padrão e pode declarar `timeout_ms` (até 15 min) para suítes pesadas.
- RN-15: O harness é medido por indicadores calculáveis do próprio backlog (seção "Decisões e verificações").

## Regras de negócio

Estados da tarefa: `pending`, `in_progress`, `done`, `blocked`, `cancelled`. Tipos de gate: `command` (comando executado sem shell, aprovado se código 0, sem timeout e comando existente; timeout de 120 s por gate) e `manual` (pulado pelo runner, não conta como aprovado e não decide o `mark done`).

Validação do backlog (`backlog.mjs validate`): exige `id` e `title`, ids de tarefa e de gate únicos, status e tipo válidos, `depends_on` apontando para tarefas existentes, gate ligado a tarefa existente, gate `command` com comando array não vazio. `--require-specs` exige `specs/<ID>.md` para cada tarefa.

Transições (`backlog.mjs mark`):

- `in_progress`: bloqueado se há dependência não `done` ou outra tarefa `in_progress`; grava `started_at`.
- `blocked`: exige `--motivo`; o motivo vai para o card e sai sozinho quando a tarefa sai do bloqueio.
- `done`: roda os gates da tarefa; falhou, sai com erro e não grava; grava `done_at`.
- Editar `status` direto no JSON é proibido pela regra do projeto; o caminho é o CLI.
- `next`: exit 0 traz a próxima tarefa ou entrega concluída; exit 3 indica entrega travada (só restam bloqueios), caso em que se para e se informa o usuário.

Papéis por fase (agentes em `.claude/agents/`): `planejador` (plano, não edita), `investigador-de-spec` (fase A: specs), `eval-gate-author` (fase B: gate tests e baseline), `implementador` (fase C: uma tarefa por vez), `eval-gate-fixer` (fase D: repara gate falhando sem forjar evidência nem afrouxar assert), `avaliador-de-entrega` (fase E: laudo), `documentador` (fase F), `revisor-de-dominio` (revisão do diff, não edita). Subagente não fala com o usuário: devolve `blocked` ou `needs-decision` no handoff e o agente principal pergunta ao usuário.

Handoff: bloco `## HANDOFF` com campos Fase, Agente, Entrega, Tarefa, Resultado (`done`, `failed`, `blocked`, `needs-decision`) e seções Arquivos, Gates, Não verificado, Decisões para o usuário, Próximo passo. Resultado de gate: `pass`, `fail`, `manual-pendente`, `nao-executado`; `pass` só com a saída real do comando.

Pedidos de planejamento ("planejar", "levantar", "criar cards") param após a Fase A e esperam instrução explícita do usuário antes de implementar.

Jira: projeto `OFLUXO`; credenciais `JIRA_*` no `.env`; sem token o espelho não roda e o motivo é dito; falha do espelho sai com exit 1 com o comando de reparo e o backlog já está gravado; nunca criar card duplicado; nunca colocar uid, e-mail, `businessId`, CPF/CNPJ ou token em card. Labels de feature e versão, aditivas.

Homologação: ao marcar `done` a última tarefa, se BRD, fluxo do usuário e ambiente Docker local estão prontos, a feature vai para `em_homologacao` e cards e épico para "Homologation"; BRD e fluxo precisam de `Status: ready` e nenhum dado pessoal. A decisão é do usuário (`homologar --aprovar` ou `--reprovar --motivo`).

Guarda de escopo: o hook `guarda-entrega.mjs` avisa (não bloqueia) quando uma edição sai do escopo da entrega ativa (`quality/.state/entrega-ativa.json`); nada grava esse arquivo hoje, então o aviso só vale se alguém o criar.
Guarda de status: o hook `guarda-backlog.mjs` (`PreToolUse`) **nega** a edição de `Edit`, `MultiEdit` ou `Write` que mude o `status` de uma tarefa em `backlog.json`; tarefa nova só entra como `pending`. Vale no Claude Code; o Cline não tem hook que bloqueie.
Congelamento de gates: `mark in_progress` grava `gates_sha`; `mark done` recusa gates alterados sem `--correcao "<nota>"`, que fica em `gates_nota`.

Privacidade: nenhum dado pessoal em cards, comentários ou documentos do épico.

## Cenários de aceite (BDD)

### Cenário: tarefa só vira done com gates passando
- Dado uma tarefa `in_progress` com gates `command`
- Quando o condutor roda `backlog.mjs mark <dir> <ID> --status done` e um gate falha
- Então o comando sai com erro, lista o gate que falhou e o status não muda

### Cenário: prova de falha antes da implementação
- Dado uma tarefa com spec `ready` e gate test escrito
- Quando o condutor roda `eval.mjs <dir> <ID> --baseline`
- Então o relatório lista quais gates passaram e quais falharam, e um gate que já passa indica que não testa nada

### Cenário: gate manual não decide o done
- Dado uma tarefa com um gate `command` aprovado e um gate `manual`
- Quando o runner executa os gates
- Então o gate manual é pulado e a decisão de `done` depende só dos gates `command`

### Cenário: dependência não concluída bloqueia o início
- Dado uma tarefa cuja dependência está `pending`
- Quando o condutor tenta marcá-la `in_progress`
- Então o comando recusa e lista as dependências pendentes

### Cenário: só uma tarefa em andamento
- Dado uma tarefa já `in_progress`
- Quando o condutor tenta iniciar outra
- Então o comando recusa informando qual tarefa está em andamento

### Cenário: bloqueio exige motivo
- Dado uma tarefa que não consegue avançar
- Quando o condutor marca `blocked` sem `--motivo`
- Então o comando recusa; com motivo, o card Jira recebe o motivo

### Cenário: entrega travada
- Dado um backlog em que só restam tarefas bloqueadas
- Quando o condutor roda `backlog.mjs next <dir>`
- Então o comando sai com código 3, lista motivos e tarefas presas, e a entrega não é declarada concluída

### Cenário: detecção de force-pass
- Dado uma tarefa `done` sem `done_at` ou cuja dependência não está `done`
- Quando o condutor roda `integridade.mjs <dir>`
- Então o detector reporta o achado (aviso ou erro)

### Cenário: gate test tautológico é barrado
- Dado um arquivo de teste com `assert.ok(true)`, bloco vazio ou `test.skip` incondicional
- Quando `validate-testes.mjs` varre o arquivo
- Então o padrão é reportado como suspeito

### Cenário: spec obrigatória para todas as tarefas
- Dado um backlog com 15 tarefas
- Quando o condutor roda `backlog.mjs validate <dir> --require-specs`
- Então o comando falha se faltar `specs/<ID>.md` e passa quando todas existem

### Cenário: pedido de planejamento não avança para código
- Dado um pedido de "planejar" ou "criar cards"
- Quando a Fase A termina
- Então o agente principal mostra o resumo do backlog e as specs e para, aguardando instrução explícita

### Cenário: status espelhado no Jira
- Dado credenciais Jira no ambiente
- Quando uma tarefa muda de status pelo `mark`
- Então o card correspondente acompanha o status; sem credenciais o sistema avisa em vez de seguir calado

### Cenário: homologação ao concluir a última tarefa
- Dado BRD, fluxo do usuário e ambiente Docker prontos
- Quando a última tarefa vira `done`
- Então a feature vai para `em_homologacao` com cards e épico em "Homologation", e o usuário aprova ou reprova

### Cenário: homologação não inicia sem documentos
- Dado que o BRD ou o fluxo do usuário não está `ready` ou o compose não existe
- Quando a última tarefa vira `done`
- Então o `mark` sai com erro e lista as pendências

### Cenário: compactação da entrega
- Dado uma entrega concluída
- Quando o condutor roda `compactar-entregas.mjs <dir>`
- Então o `SUMMARY.md` é gerado com tarefas, status e gates

## Riscos e dependências

- Gates `manual` (EG-CICLO, EG-JIRA-MANUAL, EG-PILOTO) não são decididos pelo runner; a evidência de cada um está em `evidencias/<gate>.md`.
- As specs RB-001 a RB-014 são curtas e retroativas; só a RB-015 tem contrato detalhado. A RB-011 cita agentes `planejador`, `implementador` e `revisor`, enquanto o repositório tem hoje também investigador, autor de gates, fixer, avaliador e documentador.
- O hook `guarda-entrega.mjs` (RB-010) só avisa e depende de um `entrega-ativa.json` que nada grava; o bloqueio que importa (status) é o `guarda-backlog.mjs`.
- Dependências: Node 22 ou superior (`globSync` em `validate-testes.mjs`), credenciais `JIRA_*` para o espelho, Docker para a homologação, hooks do Claude Code registrados em `.claude/settings.json`.
- O harness é código de qualidade do repositório: mudanças nele afetam todas as entregas; as suítes `quality/test/delivery/*.test.mjs` são os gates.

## Decisões e verificações

- **Evidência dos gates manuais:** fica em `evidencias/EG-CICLO.md`, `EG-JIRA-MANUAL.md` e `EG-PILOTO.md` na pasta da entrega, com comando, data, resultado e o limite do que provam. EG-CICLO e EG-PILOTO vêm do teste `ciclo.integration.test.mjs` (CLI real, 33 testes de entrega aprovados); EG-JIRA-MANUAL vem da integração real do Jira (6 de 6).
- **Congelamento dos gates (RB-004):** requisito vigente. Não existia no código; passou a existir como RN-12 (`gates_sha` e `--correcao`), com teste.
- **Edição direta de `status`:** imposta por hook (RN-13), com teste. No Cline segue por regra e por `integridade.mjs`, porque o hook dele nunca cancela (cancelar aborta a tarefa inteira).
- **`SUMMARY.md`:** regerado; é gerado por `compactar-entregas.mjs` ao concluir a entrega.
- **Timeout por gate:** 120 s padrão; suíte pesada declara `timeout_ms` até 15 min (RN-14).
- **Métricas de sucesso (RN-15):** tempo de `in_progress` a `done` (`started_at` e `done_at`), número de bloqueios abertos, divergência entre backlog e Jira (`sync-context.mjs --audit` e contagem por status), uso de `--correcao` (`gates_nota`) e tarefas sem spec `ready`.
- **Aprovação da homologação:** quem conduz a entrega (o usuário dono do produto) decide com `homologar --aprovar` ou `--reprovar --motivo`; não há aprovação em duas pessoas.

### Cenário: gate alterado depois de iniciar a tarefa
- Dado uma tarefa em `in_progress` cujos gates foram alterados
- Quando o condutor roda `mark --status done` sem `--correcao`
- Então o `mark` sai com erro e a tarefa continua `in_progress`
- E com `--correcao "<nota>"` o `done` é gravado e a nota fica em `gates_nota`

### Cenário: edição direta de status
- Dado um agente que tenta mudar `status` no `backlog.json` por edição de arquivo
- Quando o hook de `PreToolUse` avalia a edição
- Então a edição é negada e a mensagem aponta o `mark`
