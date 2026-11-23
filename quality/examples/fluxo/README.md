# Exemplo: host Fluxo (congelado em `fluxo@9b89bc9`)

Este diretório é um **exemplo completo e documentado** de um projeto hospedeiro do Omni Harness: perfil (`profile/profile.json`), overlay de prompts (`PROJETO.md`), skills e regras de domínio (`skills/`, `rules/`), pack de domínio (`pack-fluxo-domain.json`), configs legadas (`config/`), ratchet (`baseline.json`) e os gates de entrega do produto (`gates/`).

## Como usar

- **Não roda na suíte do núcleo.** Para exercitar o motor com este exemplo:

  ```bash
  HARNESS_PROFILE_DIR="$PWD/quality/examples/fluxo/profile" node --test quality/test/gates.test.mjs quality/test/risk.test.mjs quality/test/hooks.test.mjs
  HARNESS_PROFILE_DIR="$PWD/quality/examples/fluxo/profile" node --test quality/examples/fluxo/gates/version.test.mjs quality/examples/fluxo/gates/version-flow.test.mjs
  ```

- **Os gates em `gates/` pertencem a `quality/test/delivery/` do repo hospedeiro** (Fluxo). Seus imports relativos são válidos lá, não aqui — foram congelados como estão.
- Fonte da verdade de todo este conteúdo: monorepo **Fluxo**, commit `9b89bc9df04c7883b0197bbe85c34d67c66ab175`.
