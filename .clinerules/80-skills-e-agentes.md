<!-- GERADO por quality/agents/sync-clinerules.mjs. Não edite aqui. -->

# Skills e agentes do harness (Claude Code ↔ Cline)

Um conteúdo, dois hosts: o Claude Code carrega estes arquivos automaticamente; no Cline,
LEIA o arquivo indicado antes de editar o domínio correspondente (AGENTS.md §7).

## Skills — leia `.claude/skills/<tema>/SKILL.md` antes de editar o domínio

| Tema | Quando ler |
|---|---|
| avaliar-qualidade | Avalia a qualidade do código afetado no monorepo Exemplo SaaS com gates determinísticos (tamanho, complexidad… |
| brainstorm-ideias | Brainstorm de ideias novas com documentação viva no parking lot. |
| busca-de-codigo | Busca de código com o grafo do graphify (graphify query, path, explain, affected) em vez de Grep, Glob, grep … |
| documentar-entrega | Como documentar e encerrar uma tarefa no Exemplo SaaS, com docs de domínio em docs/, plano e entrega em docs/… |
| entrega-em-ciclo | Orquestra o ciclo completo de uma entrega: investigação → gates → implementação → avaliação → compactação. |
| gitflow | Gitflow determinístico do Exemplo SaaS na camada do agente (harness). |
| implementar-tarefa | Como implementar uma tarefa do backlog de entrega em ciclo. |
| liberar-portas | Encerra os processos que escutam uma ou várias portas TCP locais (emuladores, servidores de teste, API .NET, … |
| modo-conciso | Respostas curtas no estilo "caveman" para gastar menos tokens de saída, sem perder precisão técnica. |
| onboarding-assessment | >- |
| product-owner | Triage e gestão do backlog de entrega. |
| revisar-entrega | Revisão técnica ao final do loop de backlog. |

## Agents — leia `.claude/agents/<papel>.md` antes de delegar/imitar o papel

| Papel | Quando usar |
|---|---|
| avaliador-de-entrega | Fase E do ciclo de entrega (avaliação final). |
| documentador | Atualiza a documentação do Exemplo SaaS depois de uma implementação. |
| eval-gate-author | Fase B do ciclo de entrega. |
| eval-gate-fixer | Fase D do ciclo de entrega. |
| implementador | Fase C do ciclo de entrega. |
| investigador-de-spec | Fase A do ciclo de entrega. |
| planejador | Rodada A de tarefas grandes no Exemplo SaaS. |
