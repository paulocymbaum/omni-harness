# Omni Harness — núcleo agnóstico de agentes de código

![quality](https://github.com/paulocymbaum/omni-harness/actions/workflows/quality.yml/badge.svg)

> Núcleo agnóstico de stack/arquitetura para agentes de código (Claude Code, Cline, Codex, VS Code/Copilot, Antigravity, Kiro): hooks, gates determinísticos, ciclo de entrega em backlog, perfis por projeto. **Node 22, zero dependências.** Foi apartado do monorepo Fluxo (2026-11-22) — o Fluxo hoje é apenas o exemplo de hospedeiro em [`quality/examples/fluxo/`](quality/examples/fluxo/README.md).

## O que há aqui

| Caminho | Conteúdo |
|---|---|
| `quality/` | Motor de qualidade (gates, risco, níveis), hooks dos dois hosts, ciclo de entrega em backlog, perfil do hospedeiro (`quality/profile/`), packs de política (`quality/packs/`), self-tests (`quality/test/`) |
| `.claude/`, `.clinerules/` | Hooks e regras dos hosts Claude Code e Cline (mesma política, dois transportes) |
| `scripts/harness-init.mjs` | Instalador: semeia o núcleo num repo hospedeiro novo |
| `quality/examples/fluxo/` | **Exemplo completo** de um host multi-stack (perfil, overlay, skills, gates) — fora da suíte e do discovery |
| `docs/harness/` | Documentação operacional, um doc por workflow |
| `docs/parking-lot/harness-agnostico.md` | Desenho da arquitetura agnóstica (R0–R5) e decisões |

## Hosts de agente suportados

`harness-init` instala a integração certa para cada host — hooks nativos onde existem, carrier de instruções onde o host só lê prompt:

| Host | Estrutura instalada | Como o harness roda |
|---|---|---|
| **Claude Code** | `.claude/settings.json` + `.claude/hooks/` + regras/agents | hooks nativos (SessionStart/Pre/Post/Stop/SubagentStop) |
| **Cline** | `.clinerules/hooks/` + regras espelhadas `.clinerules/*.md` | hooks finos delegando ao `cline-bridge` |
| **Codex CLI** | `AGENTS.md` da raiz | padrão cross-tool; gates via CLI (`node quality/run.mjs`) |
| **VS Code (Copilot)** | `.github/copilot-instructions.md` | instruções apontando AGENTS.md + gates via CLI |
| **Antigravity (Google)** | `.antigravity/rules/omni-harness.md` + `AGENTS.md` | carrier de regras do workspace |
| **Kiro (AWS)** | `.kiro/steering/omni-harness.md` + `AGENTS.md` | steering sempre-on |

Seleção no instalador: `--hosts claude-code,cline` (default) · `--hosts all` · `--hosts vscode,kiro`. `omni-harness doctor` mostra o que está instalado.

**Paths sobrescritáveis:** estruturas proprietárias mudam rápido — os paths são **dado do hospedeiro**, não código: `quality/hosts.json` (formato: `{"hosts": {"<id>": {"carrier": "...", "integration": [...]}}}`) sobrescreve o registro default sem tocar a lib. Exemplo real no Fluxo: [`quality/examples/fluxo/hosts.json`](quality/examples/fluxo/hosts.json). Listar resolvidos: `omni-harness hosts [destino] [--json]`.

## Instalação e distribuição

O harness é **Node 22, zero dependências** — o canal natural é npm/pnpx. `pip`/`uv` não se aplicam (não é Python).

| Canal | Comando | Estado |
|---|---|---|
| **npm / pnpm dlx** (primário) | `pnpm dlx omni-harness init <destino> --nome <projeto>` | requer `npm publish` (package.json pronto na raiz; `files` já permite exemplo fora e núcleo dentro) |
| **git / curl** (sem registry, hoje) | `bash install.sh <destino> --nome <projeto>` a partir de uma cópia; com GitHub Releases: `RELEASE_URL=<tarball> curl -fsSL <url>/install.sh \| bash -s -- <destino>` | `install.sh` pronto |
| **brew** (secundário, macOS/Linux) | `brew tap <ORG>/tap && brew install omni-harness` | fórmula template em `Formula/omni-harness.rb` (preenche `<ORG>`, `sha256` e publica o tap após a primeira release no GitHub) |

CLI instalado: `omni-harness init|sync|doctor|--version`. `doctor` checa node >= 22, ferramentas externas (git, rtk, graphify, pnpm, dotnet, flutter, uv, biome) e o perfil do hospedeiro.

## Início rápido

```bash
node scripts/harness-init.mjs <destino> --nome <projeto>   # semeia o núcleo num repo hospedeiro
cd <destino> && (git init) && cd quality/tools && npm ci   # Biome do autofix
node quality/agents/sync-clinerules.mjs                    # espelha regras para o Cline
node --test quality/test/profile.test.mjs                  # perfil valida contra o schema
node quality/run.mjs --tier rapido                         # motor de qualidade
```

## Perfis

O perfil declara **tudo que varia por projeto**: camadas/stacks, fronteiras de arquitetura, métricas do ratchet, runners (Flutter/TS/.NET/Python), tracker (`jira`/`none`), gitflow (permanentes e matriz), política PII via packs, locale e overlay de prompts. Schema v1 validado por `quality/lib/profile.mjs`; gate em `quality/test/profile.test.mjs`. Exemplo completo de um host real em `quality/examples/fluxo/`.

Testes do motor que exercitam o exemplo (gates, risco, hooks, tracker):

```bash
HARNESS_PROFILE_DIR="$PWD/quality/examples/fluxo/profile" node --test quality/test/gates.test.mjs quality/test/risk.test.mjs
```

## Documentação

- Operacional, por workflow: [`docs/harness/INDEX.md`](docs/harness/INDEX.md)
- Arquitetura agnóstica e decisões (R0–R5): [`docs/parking-lot/harness-agnostico.md`](docs/parking-lot/harness-agnostico.md)
- Inventário do bundle: [`HARNESS-MANIFEST.txt`](HARNESS-MANIFEST.txt)

## Comunidade

- **Contribuir:** [CONTRIBUTING.md](CONTRIBUTING.md) — branches `feat/*`, Conventional Commits, bateria local antes do PR (CI `quality` obrigatório em `main`).
- **Segurança:** [SECURITY.md](SECURITY.md) — reporte por advisory privado, nunca em issue pública.
- **Conduta:** [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) (Contributor Covenant 2.1).
- **Licença:** [MIT](LICENSE).
