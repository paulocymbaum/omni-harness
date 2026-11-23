# Runners por linguagem — Go, Rust, C++, C#/dotnet, Java

- **Status:** IMPLEMENTADO (F1–F6, 2026-11-23) — runners em `quality/lib/runners/{go,rust,cpp,java}.mjs` + gates finos de C# em `backend.mjs`; self-tests em `quality/test/runners-stacks.test.mjs`
- **Atualizado:** 2026-11-23
- **Origem:** pedido do dono: habilitar o harness para Go, Rust, C++, C# e Java, considerando as libs principais de teste e os scripts de build.
- **Domínio:** `quality/lib/runners/` (mecanismo), `quality/profile/` (dado), `quality/lib/tiers.mjs` (composição), `quality/lib/gates/` (níveis).

## Princípio (o mesmo do harness agnóstico)

**Runner é mecanismo no núcleo; QUAL stack, onde ela vive e como o projeto a invoca é dado do perfil.**

Contrato de um runner (padrão já estabelecido por `backend.mjs` e `flutter.mjs`):

1. **Filtro de escopo** — só roda se `entries` traz arquivos da stack (extensão + diretório-raiz do perfil). Zero arquivos da stack = zero custo.
2. **Config do perfil** — `PROFILE.runnerGo || {}` com `root`, `build`, `test`, `testFilter`, `workflow` (fallback "CI do projeto"). Camadas (`layers`) do perfil mapeiam paths → `byLayer.has('go')` liga o runner em `tiers.mjs`.
3. **Falha aberta** — `which('go')` ausente → `tool.missing`/`tool.delegated` WARN com impacto e ação; nunca silêncio, nunca crash.
4. **Passos via `step()`** — budget de tempo do tier, `capMs` por passo, proteção OOM, `tail()` no erro.
5. **Resultados tipados** — `build.pass/build.fail`, `tests.pass/tests.fail`, `format.pass/fail`, `lint.issue/lint.legacy/lint.pass` — com foco em **linhas adicionadas** (`addedLineSet`): problema em linha nova reprova; problema legado vira `lint.legacy` WARN.
6. **Parser puro testável** — a função que converte a saída da tool em resultados fica separada do spawn (`parseGoVet(output, byFile)` etc.) para o self-test rodar sem o binário instalado.

Ferramenta ausente no ambiente do hospedeiro segue o padrão `osv-scanner`: o RunStart lista ✔/✘ e o gate correspondente fica "não medido" com aviso — **IGNORADO não é aprovação**.

## Go

| Fase | Comando | Tier | Cap (ms) | Parser |
|---|---|---|---|---|
| fmt | `gofmt -l .` (saída vazia = pass) | rápido | 60k | lista de arquivos |
| vet | `go vet ./...` | rápido | 180k | `file:line:col: msg` |
| build | `go build ./...` | rotina | 300k | exit + tail |
| test (relacionados) | `go test <pkg dos arquivos tocados> -count=1` | rotina | 600k | exit + tail |
| test (completo) | `go test ./... -race -shuffle=on -count=1` | completo | 900k | exit + tail |
| lint | `golangci-lint run --out-format=line-number ./...` | rotina | 400k | `file:line: msg` |
| coverage (completo) | `go test ./... -coverprofile=cover.out -coverpkg=./...` | completo | 900k | percentual |
| vuln (completo) | `govulncheck ./...` | completo | 300k | exit + resumo |

**Config do perfil** (`runnerGo`): `root` (default `.`), `packages` (default `./...`), `testFilter` (regex `-run` opcional), `golangci` (bool — exigir golangci-lint ou só vet), `workflow` (fallback delegado).

**Libs de teste recomendadas** (vão no overlay do perfil do projeto, não no núcleo): `testing` (stdlib) + **testify** (`assert`/`require`/suite — padrão de mercado); **uber-go/mock** (mocks gerados); **testcontainers-go** (integração com banco/queue — delegado ao completo/CI, como o PostgreSQL do backend); **httptest** (stdlib) para handlers.

**Particularidades:** pacote Go = diretório → teste relacionado natural: `go test ./<dir-do-arquivo-tocado>` (multi-pacote: um passo por pacote, `step()` deduz do budget). `-race` exige cgo habilitado no hospedeiro — se falhar por ambiente, `tool.delegated` WARN (não reprova). `go.sum` entra no supply chain.

## Rust

| Fase | Comando | Tier | Cap (ms) | Parser |
|---|---|---|---|---|
| fmt | `cargo fmt --check` | rápido | 60k | diff `Diff in file` |
| check | `cargo check --all-targets` | rápido | 600k | `file:line:col: error` |
| clippy | `cargo clippy --all-targets -- -D warnings` | rotina | 600k | `file:line:col: warning/error` |
| build | `cargo build` | rotina | 600k | exit + tail |
| test (relacionados) | `cargo test -p <pkg> <module::path>` | rotina | 600k | exit + tail |
| test (completo) | `cargo test --all-features` | completo | 900k | exit + tail |
| vuln (completo) | `cargo audit` | completo | 120k | exit + advisory list |

**Config do perfil** (`runnerRust`): `root`, `workspace` (bool — usar `-p <pkg>` pelo Cargo.toml do diretório tocado), `clippyArgs` extras (ex.: `-W clippy::pedantic`), `audit` (bool), `workflow`.

**Libs de teste recomendadas:** `#[test]` (stdlib) + **tokio** com `#[tokio::test]` (async); **rstest** (parametrização/fixtures); **mockall** (mocks); **proptest**/quickcheck (property-based — completo); **criterion** (bench — só completo, sem gate); **assert_cmd** + **tempfile** (CLI/fs); **wiremock** (HTTP mock).

**Particularidades:** primeiro `clippy`/`check` de um projeto compila o mundo — capMs alto e `tool.timeout` warn honesto no tier rápido de máquina fria; sugerir `sccache` via env do perfil (mecanismo: `step()` aceita `env`). `target/` vai para `generatedGlobs`. `Cargo.lock` entra no supply chain. Parser rustc/clippy é o mesmo formato `file:line:col: severity: msg` — um parser só.

## C++ (CMake + CTest + LLVM)

| Fase | Comando | Tier | Cap (ms) | Parser |
|---|---|---|---|---|
| fmt | `clang-format --dry-run -Werror <arquivos tocados>` | rápido | 120k | exit por arquivo |
| configure | `cmake --preset <debug>` (`-DCMAKE_EXPORT_COMPILE_COMMANDS=ON`) | rotina | 300k | exit + tail |
| build | `cmake --build --preset <debug> -j<N>` | rotina | 600k | `file:line: col: error` |
| lint | `clang-tidy -p build <arquivos tocados> --warnings-as-errors=*` | rotina | 240k/arquivo | `file:line:col: warning: msg [check]` |
| test (relacionados) | `ctest --preset <debug> -R <módulo tocado> --output-on-failure` | rotina | 600k | exit + tail |
| test (completo + sanitizers) | preset `asan` (ASan+UBSan) + `ctest --preset asan` | completo | 900k | exit + tail do sanitizer |

**Config do perfil** (`runnerCpp`): `root`, `buildDir` (default `build/`), `presets` (`{debug, asan}` — nomes do `CMakePresets.json` do projeto), `tidyChecks` (lista), `testModule(dir)` (regex que mapeia caminho → nome de teste CTest), `workflow`.

**Libs de teste recomendadas:** **GoogleTest** (gtest + gmock — padrão de mercado; integra CTest nativamente); alternativas leves: **Catch2** ou **Doctest**; **FFF**/fakeit para doubles em C; sanitizers (ASan/UBSan/TSan) como **preset de build**, não ferramenta extra — vazamento detectado nos testes vira fail do passo com o tail do sanitizer.

**Particularidades:** clang-tidy **arquivo a arquivo, só nos tocados** (nunca o projeto inteiro no tier rotina); `compile_commands.json` vem do configure; `build/` em `generatedGlobs`; header alterado dispara os `.cpp` que o incluem (escopo ampliado via grep barato de `#include` — F4).

## C# / .NET — já suportado; o que falta são gates finos

O runner **existe** (`runners/backend.mjs`, R4-total): `dotnet build -warnaserror` + `dotnet test --filter` + ambiente dedicado (`backend-env.mjs`), tudo de `PROFILE.runnerDotnet` (`root`, `solution`, `testFilter`, `workflow`). Extensões propostas:

| Gate | Comando | Tier | Observação |
|---|---|---|---|
| fmt | `dotnet format <sln> --verify-no-changes` | rápido | só `.cs` tocados → alvo por projeto |
| supply chain nativo | `dotnet list package --vulnerable --include-transitive` | rotina | complementa osv-scanner |
| analyzers | Roslyn analyzers + `TreatWarningsAsErrors` no csproj | — | já coberto pelo `-warnaserror` |

**Libs de teste recomendadas:** **xUnit** (padrão de mercado); **NSubstitute** (mocks); **Shouldly** ou AwesomeAssertions para assertions fluentes — **evitar FluentAssertions** (mudou para licença paga em 2025); **Bogus** (dados de teste); **Testcontainers-dotnet** (integração — completo/delegado); **coverlet.collector** (coverage, completo).

## Java (Maven/Gradle via wrapper)

| Fase | Comando | Tier | Cap (ms) | Parser |
|---|---|---|---|---|
| build | `./mvnw -q -DskipTests package` ou `./gradlew build -x test` | rotina | 600k | exit + tail |
| test (relacionados) | `./mvnw test -pl <módulo> -am -Dtest=<Classe*>` ou `./gradlew <módulo>:test --tests` | rotina | 600k | exit + tail |
| test (completo) | `./mvnw verify` / `./gradlew build` | completo | 900k | exit + tail |
| fmt/lint | plugins declarados pelo perfil: `spotless:check`, `checkstyle:check`, `pmd:check`, `spotbugs:check` | rotina | 300k cada | exit + `[ERROR] file:line` |
| coverage (completo) | JaCoCo (plugin) — threshold do perfil | completo | — | percentual |
| vuln (completo) | OWASP dependency-check (plugin) | completo | 600k | exit + CVSS list |

**Config do perfil** (`runnerJava`): `root`, `buildTool` (`auto` por `pom.xml` vs `build.gradle*`; **wrapper primeiro** `./mvnw`/`./gradlew`, fallback binário global), `modules` (mapa caminho→módulo Maven para `-pl`), `tools` (`['spotless','checkstyle','pmd','spotbugs']` — só invoca o que o projeto declara), `jacocoThreshold`, `workflow`.

**Libs de teste recomendadas:** **JUnit 5** (jupiter — padrão); **Mockito** (mocks); **AssertJ** (assertions fluentes); **Testcontainers-Java** (integração — completo/delegado); **JaCoCo** (coverage); **PIT** (mutação — opcional, fora dos tiers).

**Particularidades:** sem wrapper no projeto → `tool.delegated` WARN pedindo o wrapper (nunca exigir Maven/Gradle global); JDK via `JAVA_HOME` do hospedeiro (`which('java')` antes); `target/`, `build/` em `generatedGlobs`; `gradle.lockfile`/`pom.xml` no supply chain.

## Supply chain (extensão do `supplyChain` existente)

Lockfiles: + `go.sum`, `Cargo.lock`, `packages.lock.json` (NuGet lock), `gradle.lockfile`, `paket.lock`. Fontes: + `go.mod`, `Cargo.toml`, `pom.xml`, `build.gradle*`. O `osv-scanner` continua a única ferramenta (ausente → WARN, padrão atual).

## Plano de implementação faseada (cada fase fecha com a bateria local verde)

| Fase | Entrega | Validação possível neste ambiente |
|---|---|---|
| **F1 — mecanismo compartilhado** | helpers de parser (`parseColonDiag`, `parseLineList`) em `runners/common.mjs` + unit-tests puros (sem binário) | total |
| **F2 — Go** | `runners/go.mjs` + camada exemplo + perfil `runnerGo` | parser/unit total; smoke real só com Go instalado |
| **F3 — Rust** | `runners/rust.mjs` + `runnerRust` | idem |
| **F4 — Java** | `runners/java.mjs` (wrapper auto) + `runnerJava` | idem |
| **F5 — C++** | `runners/cpp.mjs` (clang-format/tidy por arquivo + CTest) | idem |
| **F6 — C# fino** | `dotnet format` + `list package --vulnerable` no backend | **total** (dotnet ✔ no ambiente) |

Self-tests de runner seguem o padrão da suíte: **parser e montagem de comando com fixtures sintéticos** (a função pura recebe a saída gravada de uma execução real da tool e o veredito esperado); o smoke com binário real só roda quando `which()` acha a tool (como dart/dotnet hoje) — hospedeiro sem a stack fica no aviso aberto, nunca quebra.

## Decisões fechadas na implementação (2026-11-23)

1. **Ordem das fases** — F1 (parsers puros em `common.mjs`: `scanScope`, `parseColonDiag`, `parseLineList`, `classifyLintIssues`) → F2 Go → F3 Rust → F4 Java → F5 C++ → F6 C# fino, conforme planejado.
2. **Camada por stack** — sem fixture real por stack: parsers/montagens com fixtures sintéticos (`runners-stacks.test.mjs`); o caminho "tool ausente" é testado por hospedeiro sem a toolchain (skip condicional com motivo quando a tool existe). Smoke real continua condicional a `which()`.
3. **Golangci-lint** — **opt-in** (`runnerGo.golangci`); `go vet` roda sempre (stdlib, zero config). Ausente no hospedeiro = `tool.delegated` WARN com o workflow do perfil.
4. **Sanitizers C++** — **reprovam** (`tests.fail` com tail do sanitizer) no completo, via `runnerCpp.presets.asan` (preset do `CMakePresets.json` do projeto); sem preset declarado, não roda (não inventa config).
5. **Alias `runnerCsharp`** — **não implementado**: `runnerDotnet` único (um nome, zero ambiguidade; o campo já estava documentado e consumido).
6. **Extras ficados fora do desenho original** — Java: `detectBuildTool` aceita injeção de `exists`/`globalHas` (testável sem JDK); C++: `runnerCpp.cmakeArgs` e `testRegex`; Rust: teste relacionado por `--manifest-path` do `Cargo.toml` mais próximo (workspace sem saber o nome do pacote).
7. **languageOf** — `.go`/`.java`/`.cc`/`.cpp`/`.cxx`/`.c`/`.h`/`.hpp` mapeados (lizard parseia); **`.rs` de fora de propósito** (lizard não suporta Rust; `isSource` true mentiria nas métricas).
