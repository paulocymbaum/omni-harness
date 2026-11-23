# Omni Harness — núcleo agnóstico de agentes de código

> **Infraestrutura neutra de qualidade e workflow para agentes de código**: o mesmo motor de gates determinísticos, os mesmos hooks e o mesmo contexto de sessão em qualquer IDE ou CLI — e o conhecimento do projeto num **perfil** que o time edita sem tocar em código. Stack e arquitetura do hospedeiro são **dado de configuração**, não acoplamento. **Node 22, zero dependências.**
>
> Nasceu dentro do monorepo Fluxo e foi apartado (2026-11-22) — o Fluxo hoje é apenas o exemplo de hospedeiro em [`quality/examples/fluxo/`](quality/examples/fluxo/README.md).

## Como funciona (a ideia em 4 pilares)

1. **Motor determinístico** — `node quality/run.mjs` roda gates testáveis (`quality/gates/`) em três níveis: **rápido** (a cada edição), **rotina** (ao concluir) e **completo** (risco alto). Ferramenta ausente no hospedeiro = aviso aberto com impacto e ação; nunca silêncio, nunca crash.
2. **Perfil do hospedeiro** (`quality/profile/`) — tudo que varia por projeto: camadas/stacks, fronteiras de arquitetura, runners, thresholds, tracker, gitflow, política PII (packs), locale e overlay de prompts. Schema v1 validado (`quality/lib/profile.mjs`).
3. **Multi-host** — `harness-init` instala a integração certa para cada agente: hooks nativos (Claude Code, Cline) ou carriers de instruções (Codex, Copilot, Antigravity, Kiro). Mesma política, dois transportes.
4. **Ciclo de entrega** — investigação → gates que provam a falha → implementação → avaliação, com backlog versionado e espelho em tracker (Jira ou `none`).

## Stacks

O motor é agnóstico: **runner é mecanismo no núcleo; qual stack, onde ela vive e como o projeto a invoca é dado do perfil.** Runner sem config no perfil fica inerte — repo sem a stack não paga nada.

| Stack | Runner | Gates hoje |
|---|---|---|
| **Dart / Flutter** | `runners/flutter.mjs` | `dart analyze` arquivo a arquivo (foco em linhas adicionadas), testes relacionados por feature, suíte completa no nível completo |
| **TypeScript / Node** | `runners/typescript.mjs` (pnpm) | lint/tsc, testes relacionados, supply chain |
| **C# / .NET** | `runners/backend.mjs` (`runnerDotnet`) | `dotnet build -warnaserror` + `dotnet test --filter` + ambiente dedicado |
| **Python** | via uv | toolchain detectada (`uv`), falha aberta |
| **Go** | `runners/go.mjs` | `gofmt -l` + `go vet` (foco em linhas adicionadas) + testes por pacote alterado; suíte `-race` no completo; golangci-lint opt-in |
| **Rust** | `runners/rust.mjs` | `cargo fmt --check` + `clippy --all-targets` + teste por manifest do workspace; `--all-features` e `cargo audit` no completo |
| **C++** | `runners/cpp.mjs` | clang-format dry-run + configure/build CMake + CTest; clang-tidy arquivo a arquivo (opt-in); sanitizers ASan/UBSan via preset no completo |
| **Java** | `runners/java.mjs` | wrapper primeiro (`./mvnw`/`./gradlew`), build/test; plugins opt-in (spotless/checkstyle/pmd/spotbugs); módulos Maven via `-pl` |
| **C# / .NET** | `runners/backend.mjs` (`runnerDotnet`) | `dotnet build -warnaserror` + `dotnet test --filter` + ambiente dedicado; `dotnet format` e `list package --vulnerable` opt-in |

Camadas novas ligam o runner: o perfil do hospedeiro declara `{ id: 'go', globs: ['**/*.go'] }` (idem `rust`/`cpp`/`java`) e o config `runnerGo`/`runnerRust`/`runnerCpp`/`runnerJava` (`root`, `packages`, `race`, `golangci`, `clippyArgs`, `audit`, `presets`, `tidy`, `tools`, `modules`, `workflow`). Parsers e montagens de comando são funções puras com self-tests (`quality/test/runners-stacks.test.mjs`) — smoke real só quando `which()` acha a tool; desenho e libs de teste recomendadas em [`docs/parking-lot/runners-go-rust-cpp-csharp-java.md`](docs/parking-lot/runners-go-rust-cpp-csharp-java.md).

Hooks do RunStart listam ✔/✘ o que o hospedeiro tem (lizard, dart, flutter, dotnet, pnpm, uv, docker, firebase, osv-scanner…) — **IGNORADO não é aprovação**: o gate correspondente fica "não medido" com aviso.

## O que há aqui

| Caminho | Conteúdo |
|---|---|
| `quality/` | Motor de qualidade (gates, risco, níveis), hooks dos dois hosts, ciclo de entrega em backlog, perfil do hospedeiro (`quality/profile/`), packs de política (`quality/packs/`), self-tests (`quality/test/`) |
| `.claude/`, `.clinerules/` | Hooks e regras dos hosts Claude Code e Cline (mesma política, dois transportes) |
| `scripts/harness-init.mjs` | Instalador: semeia o núcleo num repo hospedeiro novo |
| `quality/examples/fluxo/` | **Exemplo completo** de um host multi-stack (perfil, overlay, skills, gates) — fora da suíte e do discovery |
| `docs/harness/` | Documentação operacional, um doc por workflow |
| `docs/parking-lot/` | Desenho da arquitetura agnóstica (R0–R5) e do suporte Go/Rust/C++/Java |

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

O perfil declara **tudo que varia por projeto**: camadas/stacks, fronteiras de arquitetura, métricas do ratchet, runners por stack (`runnerDotnet`, `runnerTs`, Flutter/Python; `runnerGo`/`runnerRust`/`runnerCpp`/`runnerJava` no desenho F1–F6), tracker (`jira`/`none`), gitflow (permanentes e matriz), política PII via packs, locale e overlay de prompts. Schema v1 validado por `quality/lib/profile.mjs`; gate em `quality/test/profile.test.mjs`. Exemplo completo de um host real em `quality/examples/fluxo/`.

Testes do motor que exercitam o exemplo (gates, risco, hooks, tracker):

```bash
HARNESS_PROFILE_DIR="$PWD/quality/examples/fluxo/profile" node --test quality/test/gates.test.mjs quality/test/risk.test.mjs
```

## Documentação

- Operacional, por workflow: [`docs/harness/INDEX.md`](docs/harness/INDEX.md)
- Arquitetura agnóstica e decisões (R0–R5): [`docs/parking-lot/harness-agnostico.md`](docs/parking-lot/harness-agnostico.md)
- Runners por linguagem (Go, Rust, C++, C#, Java — desenho F1–F6): [`docs/parking-lot/runners-go-rust-cpp-csharp-java.md`](docs/parking-lot/runners-go-rust-cpp-csharp-java.md)
- Inventário do bundle: [`HARNESS-MANIFEST.txt`](HARNESS-MANIFEST.txt)

## Comunidade

- **Contribuir:** [CONTRIBUTING.md](CONTRIBUTING.md) — branches `feat/*`, Conventional Commits. **Projeto local, sem CI/Actions**: a bateria local é a validação; o mantenedor committa direto em `main` com ela verde. Contribuição externa entra por PR de fork, revisada e mergeada manualmente após a mesma bateria.
- **Segurança:** [SECURITY.md](SECURITY.md) — reporte por advisory privado, nunca em issue pública.
- **Conduta:** [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) (Contributor Covenant 2.1).
- **Licença:** [MIT](LICENSE).
