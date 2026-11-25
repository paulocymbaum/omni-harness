# Contribuir para o Omni Harness

Obrigado por considerar contribuir! Este repo é o **núcleo agnóstico** do harness — ele não conhece produto nenhum (isso vive no perfil de cada projeto hospedeiro; exemplo: [`quality/examples/exemplo-saas/`](quality/examples/exemplo-saas/README.md)).

## Requisitos

- Node **>= 22** · git
- Opcional (lint do autofix): `cd quality/tools && npm ci`

## Exemplo SaaS de trabalho

1. `fork`/`branch` a partir de `main` — `feat/<slug>`, `fix/<slug>`, `docs/<slug>`.
2. **Conventional Commits** (`feat:`, `fix:`, `docs:`, `chore:` …).
3. Antes do PR, rode a bateria local (item abaixo). **READMEs multilíngues:** `README.md` (EN) é a referência — qualquer seção/tabela/mermaid novo nele deve ser espelhado em `README.pt-BR.md`/`README.es.md`/`README.zh-CN.md`; o gate `quality/test/readme-sync.test.mjs` reprova drift de estrutura.

```bash
node --test quality/test/profile.test.mjs quality/test/hosts.test.mjs quality/test/package.test.mjs quality/test/attach.test.mjs
node --test quality/test/gates.test.mjs quality/test/gates-novos.test.mjs quality/test/hooks.test.mjs quality/test/risk.test.mjs
HARNESS_PROFILE_DIR="$PWD/quality/examples/exemplo-saas/profile" node --test quality/test/gates.test.mjs quality/test/risk.test.mjs .claude/hooks/test/regras.test.mjs quality/test/jira-spec-sync.test.mjs
node quality/agents/sync-clinerules.mjs --check
```

4. **Projeto local — sem CI/Actions.** A validação é a bateria local acima; rode-a antes de commitar. Mantenedor: commit direto em `main` após a bateria verde. Contribuição externa (fork): abra o PR — será revisada e mergeada manualmente após rodar a mesma bateria; não há checks automáticos.

> O CI publica o check **`quality`** — é o contexto exigido pela proteção de `main`.

## Regras do núcleo

- **Nada de produto no motor**: camadas, fronteiras, runners, tracker, gitflow, PII, locale e prompts de domínio são **dado do perfil** (`quality/profile/`, `quality/hosts.json`, `quality/packs/`). Mudança de estrutura de vendor (ex.: Antigravity/VS Code) = atualizar dado/registro, nunca espalhar path no código.
- Falha aberta: hooks e gates nunca derrubam o trabalho por bug próprio — erros voltam ao agente com caminho e ação.
- Todo comportamento novo entra com **gate** (`quality/test/*.test.mjs`) e paridade documentada ([docs/parking-lot/harness-agnostico.md](docs/parking-lot/harness-agnostico.md)).
- Sem dados sensíveis (documento legal, token, uid, e-mail real) em código, teste, doc ou log.

## Reportando bugs

Abra uma issue com: versão (`omni-harness --version`), host (`omni-harness doctor`), passos mínimos, saída completa do gate. Detalhes de segurança: veja [SECURITY.md](SECURITY.md).
