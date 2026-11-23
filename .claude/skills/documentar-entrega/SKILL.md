---
name: documentar-entrega
description: Como documentar e encerrar uma tarefa no Fluxo, com docs de domínio em docs/, plano e entrega em docs/entregas/<AAAA-MM-DD>-<slug>/, resumo final (arquivos, decisões, pendências, riscos, próximos passos) e relatório de qualidade para o card do Jira. Use ao concluir uma tarefa, ao criar domínio novo, ao alterar arquitetura ou contratos, ou quando o hook lembrar-documentacao pedir atualização de docs.
---

# Documentar e entregar

Toda mudança relevante precisa estar refletida em Markdown.

## Quando atualizar `docs/`

Atualize ou crie docs ao:
- implementar domínio novo;
- alterar arquitetura, contrato REST, schema SQL ou regra de segurança;
- mudar flag `USE_API_*` ou estado da migração.

Use a pasta do domínio que já existe (`docs/empresas/`, `docs/eventos/`, `docs/identidade/`, `docs/migration/`, `docs/payments/`, `docs/artistas/` etc.). Só crie um arquivo novo na raiz de `docs/` se nenhuma pasta servir.

O hook `lembrar-documentacao` bloqueia o encerramento (uma vez por estado) quando há arquivo **novo** de domínio, módulo da API, migration/SQL ou feature das Functions sem nenhum `.md` alterado. Responda atualizando o doc ou explicando por que não é necessário.

## Arquivos da entrega

Cada entrega vive em `docs/entregas/<AAAA-MM-DD>-<slug>/` (ex.: `2026-10-23-board-qualidade/`).

Entrega simples:

```text
docs/entregas/<AAAA-MM-DD>-<slug>/
  SUMMARY.md    # visão/plano da entrega
  entrega.md    # resumo final + relatório de qualidade
```

Entrega gerenciada pelo ciclo (skill `entrega-em-ciclo`) acrescenta:

```text
docs/entregas/<AAAA-MM-DD>-<slug>/
  backlog.json  # máquina do ciclo (tarefas, status, gates)
  specs/        # <ID>.md por tarefa (Status ready)
  handoffs/     # blocos HANDOFF entre fases/agentes
  diagramas/    # PNGs Mermaid
```

Front matter obrigatório no `SUMMARY.md`, no `entrega.md` e nos docs de tarefa:

```yaml
---
jira: <CHAVE ou ->
tipo: plano | entrega | decisoes
dominios: [<domínios>]
atualizado: <AAAA-MM-DD>
---
```

## Conteúdo do `entrega.md`

1. arquivos criados;
2. arquivos alterados;
3. decisões principais;
4. pendências;
5. riscos;
6. próximos passos;
7. relatório de qualidade, copiado da saída de `node quality/run.mjs` no formato de `.claude/skills/avaliar-qualidade/references/formato-do-relatorio.md`.

Sem card, entregue os mesmos itens na resposta final.

## Fluxogramas Mermaid

Siga `.claude/rules/fluxogramas.md`. Ao documentar uma entrega, inclua um diagrama Mermaid quando houver fluxo de tela ou verificação, chamada entre camadas (Flutter, Functions, .NET) ou mudança de arquitetura ou contrato:

- no `plano.md`, para o fluxo planejado e as camadas impactadas;
- no `entrega.md`, para o fluxo como ficou implementado, nas seções de decisões principais ou próximos passos;
- no doc de domínio em `docs/`, quando o fluxo for permanente.

Em todos os casos, **mostre também o bloco ```` ```mermaid ```` na resposta final no CLI**, com 1 a 2 linhas dizendo o que ele mostra, e gere também o PNG em `docs/entregas/<slug>/diagramas/` com o link na resposta (ver a regra). Se a entrega não tem fluxo relevante, não force um diagrama.

## Fluxo de trabalho

1. Ler a estrutura atual.
2. Localizar modelos, serviços e telas impactados.
3. Mapear riscos de compatibilidade (`node quality/run.mjs --risk`).
4. Implementar em camadas: domínio e tipos → contratos e persistência → UI.
5. Documentar.
6. Validar no nível exigido pelo risco (skill `avaliar-qualidade`).
7. Entregar o resumo, com o fluxograma Mermaid quando a regra exigir.

O espelhamento no Jira está descrito em `README_AGENT_WORKFLOW.md` §5.
