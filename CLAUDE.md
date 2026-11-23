@AGENTS.md

## Claude Code

- As skills de `.claude/skills/` carregam pela descrição. Ao tocar num tema da tabela de módulos do AGENTS.md, use a skill correspondente antes de editar.
- Para tarefas grandes, delegue a leitura inicial ao agente `planejador` e a revisão final ao `avaliador-de-entrega`.
- Hooks de `.claude/hooks/` e `quality/hooks/` rodam sozinhos. Quando um deles bloquear, corrija a causa; não contorne.
- O fluxo completo do harness, doc por workflow, está em [docs/harness/INDEX.md](docs/harness/INDEX.md).

## Regras sempre ativas

@.claude/rules/backlog-e-gates.md
@.claude/rules/fluxogramas.md
@.claude/rules/economia-de-tokens.md
@.claude/rules/autofix-gates.md
@.claude/rules/comandos-curtos.md
@.claude/rules/gitflow-branches.md
