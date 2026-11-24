# Exemplo: host Exemplo SaaS (congelado em `fluxo@9b89bc9`)

Este diretório é um **exemplo completo e documentado** de um projeto hospedeiro do Omni Harness: perfil (`profile/profile.json`), overlay de prompts (`PROJETO.md`), skills e regras de domínio (`skills/`, `rules/`), pack de domínio (`pack-exemplo-saas-domain.json`), configs legadas (`config/`), ratchet (`baseline.json`) e os gates de entrega do produto (`gates/`).

## Como usar

- **Não roda na suíte do núcleo.** Para exercitar o motor com este exemplo:

  ```bash
  HARNESS_PROFILE_DIR="$PWD/quality/examples/exemplo-saas/profile" node --test quality/test/gates.test.mjs quality/test/risk.test.mjs quality/test/hooks.test.mjs
  HARNESS_PROFILE_DIR="$PWD/quality/examples/exemplo-saas/profile" node --test quality/examples/exemplo-saas/gates/version.test.mjs quality/examples/exemplo-saas/gates/version-flow.test.mjs
  ```

- **Os gates em `gates/` pertencem a `quality/test/delivery/` do repo hospedeiro** (Exemplo SaaS). Seus imports relativos são válidos lá, não aqui — foram congelados como estão.
- Fonte da verdade de todo este conteúdo: monorepo **Exemplo SaaS**, commit `9b89bc9df04c7883b0197bbe85c34d67c66ab175`.
