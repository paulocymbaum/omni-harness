# Quality Gates

This document defines the **deterministic quality gates** for every layer of the Exemplo SaaS monorepo: what each gate measures, its threshold, which tool enforces it and how to wire it into CI.

A gate only counts if it is **deterministic**. The same commit must always produce the same score, with no network calls to real providers, no wall-clock thresholds on shared runners and no LLM judgement. The OCR/LLM pipeline is evaluated against mocked providers and golden fixtures (see [§5.4](#54-menu-extractor-ocr_webscraper_crawler)).

Layers covered (from [README.md](README.md#arquitetura-e-módulos), mirrored on [`quality/config/layers.json`](quality/config/layers.json)):

| Layer | Path | Stack | Current CI |
|---|---|---|---|
| Mobile app | `lib/`, `packages/fluxo_presence_bridge` | Flutter / Dart | `presence-integrity.yml`: format, `flutter analyze`, `flutter test`, debug builds; `quality.yml` (job `flutter`): analyze, `flutter test --coverage`, diff-cover ≥ 80 % |
| Main API | `backend/` | .NET 10 Minimal API, EF Core, PostgreSQL | `backend-ci.yml`: `--warnaserror` build, unit + Postgres integration, migrator, Docker build |
| Legacy backend + jobs | `functions/` | Firebase Functions (TS), `node:test` | `jobs-deploy.yml` builds only; `presence-integrity.yml` runs `npm test` + 2 rules suites |
| Menu Extractor | `OCR_webscraper_crawler/` | TS (Hono, esbuild), Vitest, Python schema validator | `quality.yml` (job `ocr`): build, typecheck, testes |
| Admin panel | `admin-web/` | React + Vite, Vitest, Playwright | `quality.yml` (job `web`): lint, typecheck, testes |
| Public site | `ofluxo_site/` | React + Vite, Vitest, Playwright | `quality.yml` (job `web`): lint, typecheck, testes |
| Debate worker | `services/debate-worker/` | TS (Node 22, ffmpeg, Soniox STT), Vitest | `quality.yml` (job `web`): lint, typecheck, testes |
| Data and rules | `firestore.rules`, `storage.rules`, `backend/deploy/sql/` | Firestore rules, SQL | partial (identity + presence rules only) |
| Infra and CI | `infra/gcp/terraform`, `.github/workflows` | Terraform, GitHub Actions | `repository-security.yml`, gitleaks; todos os workflows com actions pinadas por SHA |
| Automation (ETL TSE) | `automation/` | Python 3, SQLite, Docker | **none** |

Detalhes de implementação do CI e pendências ficam no [§7](#7-ci-wiring).

---

## 1. Principles

1. **Ratchet, not a big bang.** Every metric has a *target* threshold for new code and a *baseline* for legacy code. CI fails when a metric gets **worse** than the committed baseline, or when new or touched code misses the target. The baseline may only go down.
2. **Diff-scoped strictness.** Strict thresholds apply to changed lines and files (diff coverage, per-function complexity on touched functions). Whole-repo thresholds start at the current value and ratchet.
3. **One report format per concern.** Coverage is always emitted as **LCOV or Cobertura**, complexity as **CSV or JSON**, and duplication as **jscpd JSON**. One script (`quality/check.mjs`) reads all of them, so every stack is judged the same way.
4. **Path-filtered.** A gate runs only when its layer changed, which keeps PR latency low.
5. **Suppressions are counted.** `// ignore:`, `eslint-disable`, `#pragma warning disable`, `[ExcludeFromCodeCoverage]` and `# noqa` are allowed but are counted, and the count is ratcheted.
6. **Gate output is in Portuguese (pt-BR).** Every gate result, on failure **and** on success, is reported in pt-BR: console lines, CI step names, GitHub annotations, the job summary and the PR scorecard. Third-party tools (ESLint, `dotnet`, `flutter analyze`, …) keep their native output in the logs, but the gate verdict and its explanation always come from `quality/check.mjs` or our own scripts, in pt-BR. See [§6.2](#62-mensagens-dos-gates-pt-br).

---

## 2. Gate catalogue

Gates are grouped in tiers. Lower tiers are cheaper and run first; a PR must pass all tiers that apply to the layers it touches.

| Tier | Gate | What it quantifies | Blocking? |
|---|---|---|---|
| **G0 Hygiene** | Format | Diff after the formatter = 0 | yes |
| | Secrets | gitleaks findings = 0, `check-sensitive-files.sh` passes | yes |
| | Suppression count | count of lint/coverage suppressions ≤ baseline | yes |
| **G1 Static** | Lint | errors = 0, warnings ≤ baseline | yes |
| | Type strictness | compiler in strict mode, `any`/`dynamic` count ≤ baseline | yes |
| **G2 Structure** | Cyclomatic complexity (CC) | CC per function | yes |
| | Cognitive complexity | Sonar cognitive complexity per function (TS) | yes |
| | Function length | NLOC per function or method | yes |
| | File/class length | NLOC per file or class | yes (ratchet) |
| | Parameter count | parameters per function | yes |
| | Nesting depth | max block nesting | yes |
| | Duplication | % duplicated tokens (jscpd) | yes |
| | Architecture boundaries | forbidden imports = 0 | yes |
| | Maintainability index | MI per type (.NET CA1505) | report only → yes |
| **G3 Tests** | Line/branch coverage | % per package or project, ≥ baseline | yes |
| | Diff coverage | % of changed executable lines covered | yes |
| | Test presence | every feature or module has ≥ 1 test file | yes (ratchet) |
| | Mutation score | % mutants killed on critical modules | nightly, then yes |
| **G4 Contracts** | Rules coverage | every Firestore/Storage `match` path has a test | yes |
| | Schema / golden | OCR output matches `schemas/menu.json` + golden fixtures | yes |
| | Migration safety | EF model in sync, SQL lint, idempotent re-run | yes |
| | API contract | OpenAPI diff has no breaking change without a version bump | yes |
| **G5 Supply chain** | Vulnerable deps | high/critical advisories = 0 | yes |
| | Pinned actions | third-party actions pinned by SHA | yes |
| | IaC scan | tflint / trivy config findings ≤ baseline | yes |
| **G6 Budgets** | Bundle size | gzip size per entry ≤ budget | yes |
| | Forbidden bundle deps | router bundle excludes heavy packages | yes |
| | App size | APK/IPA size delta ≤ budget | report only |

### 2.1 Migration override mode (`--migration-override`)

For a **complete merge or complete migration** (e.g. a first release that brings an
entire line of development into `main`), every file arrives as "new" against the
base, so the incremental-metric gates would fire on the whole stock — a structural
false positive. `--migration-override [motivo]` (explicit and auditable) downgrades
those gates to **IGNORADO** instead of failing the run:

- **Ignored gates:** file size, function size, parameters, complexity, Halstead,
  format, suppressions, architecture boundaries, REST→Firestore fallback, lint,
  diff coverage;
- **Still active:** types, tests, functions exports, tooling — plus the backend
  breakage/cost risk report;
- **Global ratchet:** `node quality/baseline.mjs --check --migration-override`
  returns IGNORADO and exits 0; the baseline itself is never changed;
- Every ignored gate is printed with the reason and the suppressed count, the run
  evidence records the mode, and `--json` includes it;
- Use only on explicit request for a whole merge/migration — never to bypass gates
  on incremental work.

---

## 3. Thresholds

**Target** applies to new and touched code. **Legacy** is the starting ceiling for untouched code and is stored in `quality/baseline.json`, where it only ratchets down.

### 3.1 Structural metrics

| Metric | Dart (Flutter) | C# (.NET) | TS (functions, OCR, web) | Python |
|---|---|---|---|---|
| CC per function, target | ≤ 10 | ≤ 10 | ≤ 10 | ≤ 10 |
| CC per function, hard ceiling | 20 | 15 (CA1502) | 20 | 15 |
| Cognitive complexity per function | — | — | ≤ 15 | — |
| NLOC per function | ≤ 60 (`build()` ≤ 80) | ≤ 50 | ≤ 60 | ≤ 50 |
| NLOC per file / class | ≤ 400 | ≤ 400 (excl. `Migrations/`) | ≤ 400 | ≤ 400 |
| Parameters per function | ≤ 5 (named params count) | ≤ 5 | ≤ 4 (use an options object) | ≤ 5 |
| Max nesting depth | ≤ 4 | ≤ 4 | ≤ 4 | ≤ 4 |
| Duplication (jscpd, min 70 tokens) | ≤ 3 % | ≤ 3 % | ≤ 3 % | ≤ 3 % |
| Maintainability index (CA1505) | — | ≥ 20 per type | — | — |
| Class coupling (CA1506) | — | ≤ 95 per type | — | — |

### 3.2 Test metrics

| Metric | Flutter | .NET | functions | OCR packages | admin-web / site | Python |
|---|---|---|---|---|---|---|
| Line coverage (target, 12 months) | 60 % | 80 % | 70 % | 85 % | 70 % | 90 % |
| Branch coverage (target) | — (not in LCOV from Dart) | 70 % | 60 % | 75 % | 60 % | 80 % |
| Diff coverage (changed lines) | 80 % | 85 % | 80 % | 90 % | 80 % | 90 % |
| Mutation score (critical modules) | — | 70 % | 60 % | 70 % | — | — |

**Critical modules** (mutation-tested and held to 90 % diff coverage):

- `.NET`: `Infrastructure/Security`, `Infrastructure/Idempotency`, `Infrastructure/Messaging` (outbox), `Infrastructure/Traffic`, `Infrastructure/EventProviders` (dedupe)
- `functions`: `payments/`, `presence/`, `identity/`, `crypto/`, `admin/`
- `OCR`: `packages/scraper` (SSRF-safe fetch, redirect validation), `packages/structurer` (price parsing), `packages/cardapios` (`shouldReprocess`)
- `Flutter`: `presence_integrity`, `user_coordinated_payments`, `identity`, `core/` API client

### 3.3 Baseline snapshot (2026-09-25)

These values were measured when this document was written. They show where the ratchet starts and why a big-bang threshold would fail on day one.

| Signal | Value |
|---|---|
| Dart files in `lib/` > 1 000 lines | **35** (largest: `map_page.dart` 9 301, `event_details_page.dart` 7 972, `feed_page.dart` 5 679) |
| Dart files in `lib/` > 400 lines | **92** |
| TS files in `functions/src` > 400 lines | **33** (largest: `identity_federated.ts` 3 628) |
| TS files in `OCR_webscraper_crawler` > 400 lines (non-test) | 1 |
| C# files > 400 lines (excluding migrations) | 2 (`EntityConfigurations.cs` 662, `MessagesModule.cs` 630) |
| Flutter features with **zero** tests | **17 of 31** (agenda, artists, auth, business_accounts, chat, communities, feed, friends, home, insights, interactions, messages, notifications, route_share, settings, share_route, tribes) |
| Dart `domain/` files importing Firebase/Flutter/`data`/`presentation` | 48 of 144 |
| `API fallback to Firestore` occurrences in `lib/features` | 23 (known divergence, [REST_AND_JOBS_ROLLOUT](docs/migration/REST_AND_JOBS_ROLLOUT_2026-09-19.md)) |
| Dart lint suppressions | 14 `// ignore:` + 7 `ignore_for_file` |
| `functions/tsconfig.json` | `noImplicitAny: false`, `sourceMap: false` |
| Coverage thresholds enforced anywhere | **none** (coverlet and `@vitest/coverage-v8` are installed but not gated) |
| Unpinned actions in `presence-integrity.yml` | 13 (`@v4` / `@v2` tags) |
| Router imports of `ocr`/`scraper`/`structurer` | 0 (compliant; the gate keeps it that way) |

Run `node quality/baseline.mjs --write` (see [§6](#6-shared-tooling-quality)) to produce the machine-readable version and commit it.

---

## 4. Cross-stack tools

Use the same tool across stacks wherever one exists, so scores are comparable.

| Concern | Tool | Stacks | Output |
|---|---|---|---|
| CC, NLOC, params (non-Dart) | [`lizard`](https://github.com/terryyin/lizard) | TS, C#, Python | CSV / XML |
| CC, NLOC, params, nesting (Dart) | [`dart_code_linter`](https://pub.dev/packages/dart_code_linter) (open-source fork of dart_code_metrics) | Dart | JSON |
| Duplication | [`jscpd`](https://github.com/kucherenko/jscpd) | all (dart, csharp, typescript, tsx, python) | JSON |
| Diff coverage | [`diff-cover`](https://github.com/Bachmann1234/diff_cover) | all (reads LCOV and Cobertura) | exit code + HTML |
| Dependency vulnerabilities | [`osv-scanner`](https://github.com/google/osv-scanner) | `pubspec.lock`, `package-lock.json`, `pnpm-lock.yaml`, `packages.lock.json`, `uv.lock` | SARIF |
| Workflow lint | `actionlint` + `zizmor` | GitHub Actions | SARIF |
| Container scan | `trivy image` | backend, functions jobs, OCR images | SARIF |

Example: run structural metrics for every non-Dart stack with one command.

```bash
# -C CC, -L NLOC per function, -a params. -i N = allowed warnings (ratchet value from baseline.json)
lizard backend/src functions/src OCR_webscraper_crawler/apps OCR_webscraper_crawler/packages \
       admin-web/src ofluxo_site/src OCR_webscraper_crawler/python/src \
  -x "*/Migrations/*" -x "*/node_modules/*" -x "*/dist/*" -x "*/lib/*" -x "*.test.ts" \
  -C 15 -L 60 -a 5 -w -i "$(jq .lizard.warnings quality/baseline.json)" \
  --csv > quality/reports/lizard.csv
```

```bash
# duplication across the whole repo; fails if > threshold %
npx jscpd --config .jscpd.json
```

```jsonc
// .jscpd.json
{
  "threshold": 3,
  "minTokens": 70,
  "reporters": ["json", "console"],
  "output": "quality/reports/jscpd",
  "format": ["dart", "csharp", "typescript", "tsx", "python"],
  "ignore": ["**/node_modules/**", "**/dist/**", "functions/lib/**", "**/Migrations/**",
             "**/*.g.dart", "**/*.freezed.dart", "lib/l10n/**", "build/**", "**/testdata/**"]
}
```

---

## 5. Per-layer implementation

### 5.1 Flutter app (`lib/`, `packages/fluxo_presence_bridge`)

**G0/G1: format and lint.** `analysis_options.yaml` only includes `flutter_lints` today. Tighten it:

```yaml
include: package:flutter_lints/flutter.yaml

analyzer:
  language:
    strict-casts: true
    strict-inference: true
    strict-raw-types: true
  errors:
    unused_import: error
    unused_local_variable: error
    dead_code: error
    missing_return: error
  exclude:
    - "**/*.g.dart"
    - "**/*.freezed.dart"
    - lib/l10n/**

linter:
  rules:
    - always_declare_return_types
    - avoid_dynamic_calls
    - cancel_subscriptions
    - close_sinks
    - prefer_final_locals
    - unawaited_futures
    - discarded_futures
    - use_build_context_synchronously
    - avoid_catches_without_on_clauses
    - only_throw_errors

dart_code_linter:
  metrics:
    cyclomatic-complexity: 20
    number-of-parameters: 5
    maximum-nesting-level: 4
    source-lines-of-code: 60
  metrics-exclude:
    - test/**
    - lib/l10n/**
```

`strict-*` modes will produce many findings at first. Enable them in a single PR, record the count in `baseline.json` under `dart.analyzerIssues`, and fail CI when the count grows (`flutter analyze --no-fatal-infos | tail -1` gives the total).

```bash
dart format --output=none --set-exit-if-changed lib test packages/fluxo_presence_bridge
flutter analyze --fatal-infos --fatal-warnings    # once baseline reaches 0; until then count-ratchet
dart run dart_code_linter:metrics analyze lib --reporter=json > quality/reports/dart-metrics.json
dart run dart_code_linter:metrics check-unused-files lib
dart run dart_code_linter:metrics check-unused-code lib
```

Check the `dart_code_linter` CLI flags against the version pinned in `pubspec.yaml`, because they have changed between releases.

**G2: file size ratchet.** The 35 files over 1 000 lines are almost all `presentation/*_page.dart`. Gate rule: **no Dart file may grow past its baseline line count, and no new file may exceed 400 NLOC.** Split pages by extracting section widgets into `presentation/widgets/` and moving state into cubits. The ratchet script in §6 enforces this per file.

**G2: architecture boundaries.** The README and `.github/copilot-instructions.md` describe `features/<f>/{domain,data,presentation}`. Enforce it with a deterministic import check (`quality/dart_boundaries.mjs`):

| From | Must not import |
|---|---|
| `features/*/domain/**` | `package:flutter/`, `package:cloud_firestore`, `package:firebase_*`, `../data/`, `../presentation/` |
| `features/*/data/**` | `../presentation/` |
| `features/A/**` | `features/B/data/**` or `features/B/presentation/**` (use `domain/` or `shared/`) |
| `shared/**`, `core/**` | `features/**` |

Starting count: 48 domain violations. Ratchet to 0.

**Migration-specific gate.** Count `API fallback to Firestore` in **write** paths (`create`, `update`, `delete`, `upsert*`) of repositories whose `USE_API_*_WRITE` flag defaults to `true`. Target: **0**. This blocks the double-write divergence recorded in the rollout document. Reads are ratcheted from 23.

**G3: tests and coverage.**

```bash
flutter test --coverage --test-randomize-ordering-seed=random
# remove generated and platform glue before measuring
lcov --remove coverage/lcov.info '**/*.g.dart' '**/*.freezed.dart' 'lib/l10n/*' 'lib/firebase_options.dart' \
     -o coverage/lcov.filtered.info
diff-cover coverage/lcov.filtered.info --compare-branch=origin/main --fail-under=80
```

- **Test presence gate:** for each `lib/features/<f>`, require `test/features/<f>/**_test.dart`. The 17 features without tests are listed in `baseline.json`. The list may only shrink, and new features must ship with tests.
- **Layer priority:** cubits/blocs (`bloc_test`) and `domain/` first, since they are cheap and deterministic. Then repository implementations with `fake_cloud_firestore` and a mocked `Exemplo SaaSApiClient`, covering both branches of each `USE_API_*` flag. Widget tests go last and only for critical flows (check-in, payments, identity).
- **Golden tests** (`matchesGoldenFile`) for neomorphic components in `lib/theme` and `shared/widgets`, generated on a single pinned Linux runner so the pixels stay deterministic.

**G6: app size.** `flutter build apk --analyze-size --target-platform android-arm64` writes a size JSON. Report the delta against `main` in the PR and fail if it exceeds +1 MiB without a `size-increase-approved` label.

### 5.2 Main API (`backend/`, .NET 10)

`Directory.Build.props` already sets `Nullable`, `AnalysisLevel=latest` and deterministic builds, and CI builds with `--warnaserror`. Add:

```xml
<!-- backend/Directory.Build.props -->
<PropertyGroup>
  <AnalysisMode>Recommended</AnalysisMode>
  <EnforceCodeStyleInBuild>true</EnforceCodeStyleInBuild>
  <TreatWarningsAsErrors>true</TreatWarningsAsErrors>
  <GenerateDocumentationFile>true</GenerateDocumentationFile>
  <NoWarn>$(NoWarn);CS1591</NoWarn> <!-- XML docs not mandatory; the file enables IDE0005 -->
</PropertyGroup>
<ItemGroup>
  <AdditionalFiles Include="$(MSBuildThisFileDirectory)CodeMetricsConfig.txt" />
</ItemGroup>
```

```text
# backend/CodeMetricsConfig.txt — thresholds for CA1502/CA1505/CA1506
CA1502: 15
CA1505: 20
CA1506(Type): 95
```

```ini
# backend/.editorconfig (excerpt)
[*.cs]
dotnet_diagnostic.CA1502.severity = error   # cyclomatic complexity
dotnet_diagnostic.CA1505.severity = warning # maintainability index; promote once baseline is clean
dotnet_diagnostic.CA1506.severity = warning # class coupling
dotnet_diagnostic.IDE0005.severity = error  # unused usings

[**/Migrations/*.cs]
generated_code = true
```

```bash
dotnet format backend/Exemplo SaaS.Backend.sln --verify-no-changes
```

**G2: module boundaries.** The backend is a modular monolith. Enforce that modules do not reach into each other, using [NetArchTest](https://github.com/BenMorris/NetArchTest) inside `Exemplo SaaS.Api.Tests`:

```csharp
public class ArchitectureTests
{
    private static readonly string[] Modules =
        ["Admin", "Artists", "Businesses", "Communities", "Events", "Exemplo SaaSEmpresas",
         "Identity", "Messages", "Notifications", "Profiles", "RouteShare"];

    [Theory]
    [MemberData(nameof(ModulePairs))]
    public void Module_does_not_depend_on_other_module(string from, string to)
    {
        var result = Types.InAssembly(typeof(Program).Assembly)
            .That().ResideInNamespace($"Exemplo SaaS.Api.Modules.{from}")
            .ShouldNot().HaveDependencyOn($"Exemplo SaaS.Api.Modules.{to}")
            .GetResult();
        Assert.True(result.IsSuccessful,
            $"Fronteira de módulo violada: {from} não pode depender de {to}. " +
            $"Tipos: {string.Join(", ", result.FailingTypeNames ?? [])}");
    }

    [Fact]
    public void Infrastructure_does_not_depend_on_modules()
    {
        var result = Types.InAssembly(typeof(Program).Assembly)
            .That().ResideInNamespace("Exemplo SaaS.Api.Infrastructure")
            .ShouldNot().HaveDependencyOn("Exemplo SaaS.Api.Modules")
            .GetResult();
        Assert.True(result.IsSuccessful,
            "Infrastructure não pode depender de Modules. " +
            $"Tipos: {string.Join(", ", result.FailingTypeNames ?? [])}");
    }

    public static TheoryData<string, string> ModulePairs() { /* all from≠to pairs, minus an explicit allowlist such as Admin→* */ }
}
```

Adjust the allowlist to cover dependencies that are intentional today (for example `Admin` and `Identity`), so the test documents them.

**G3: coverage.** `coverlet.collector` is already referenced.

```bash
dotnet test backend/Exemplo SaaS.Backend.sln -c Release --no-build \
  --collect:"XPlat Code Coverage" \
  -- DataCollectionRunSettings.DataCollector.Configuration.Format=cobertura \
     DataCollectionRunSettings.DataCollector.Configuration.ExcludeByFile="**/Migrations/*.cs" \
     DataCollectionRunSettings.DataCollector.Configuration.ExcludeByAttribute="GeneratedCodeAttribute,ExcludeFromCodeCoverageAttribute"
dotnet tool run reportgenerator -reports:"**/coverage.cobertura.xml" -targetdir:quality/reports/dotnet \
  -reporttypes:"Cobertura;TextSummary"
diff-cover quality/reports/dotnet/Cobertura.xml --compare-branch=origin/main --fail-under=85
```

Merge the unit and `PostgresIntegration` runs into one report; the integration run covers the persistence and outbox paths.

**G3: mutation.** Run [Stryker.NET](https://stryker-mutator.io/docs/stryker-net/introduction/) nightly on the critical namespaces:

```jsonc
// backend/tests/Exemplo SaaS.Api.Tests/stryker-config.json
{ "stryker-config": {
    "project": "Exemplo SaaS.Api.csproj",
    "mutate": ["**/Infrastructure/Security/**/*.cs", "**/Infrastructure/Idempotency/**/*.cs",
               "**/Infrastructure/Messaging/**/*.cs", "**/Infrastructure/EventProviders/**/*.cs"],
    "thresholds": { "high": 85, "low": 70, "break": 60 },
    "test-case-filter": "Category!=PostgresIntegration" } }
```

**G4: migrations and contracts.**

```bash
# EF model and migrations are in sync (EF Core 8+)
dotnet ef migrations has-pending-model-changes --project backend/src/Exemplo SaaS.Api
# lint hand-written SQL for locking or unsafe operations
squawk backend/deploy/sql/*.sql
# existing: backend/deploy/migrator/test-entrypoint.sh (fresh DB + re-run idempotency)
```

- **OpenAPI contract:** export the spec at build time with `Microsoft.AspNetCore.OpenApi` and diff it against `main` with `oasdiff breaking`. Any breaking change under `/api/v1` fails unless the PR carries the `api-breaking` label. The Flutter `Exemplo SaaSApiClient` depends on this contract.
- **Security boundary tests** (`ApiBoundaryTests.cs`) must enumerate all mapped endpoints, via `EndpointDataSource`, and assert that each non-health route returns 401 without a token and 401/403 without App Check. Then a new route cannot ship unprotected. This is the README's "protected by default" guarantee turned into a test.

### 5.3 Legacy backend and jobs (`functions/`)

**G1.** `functions/` has no ESLint and runs with `noImplicitAny: false`.

1. Set `"noImplicitAny": true`, `"noUnusedLocals": true`, `"noUnusedParameters": true`, `"noFallthroughCasesInSwitch": true` and `"sourceMap": true` (source maps are needed to map coverage back to TS). Record the resulting `tsc` error count as the baseline and ratchet it.
2. Add the shared ESLint config from [§5.6](#56-shared-eslint-config-typescript).

**G3: coverage.** Tests run with `node:test` against the compiled `lib/`. Wrap them with `c8`:

```jsonc
// functions/package.json
"test:coverage": "npm run build && c8 --reporter=lcov --reporter=text-summary --src src --all --exclude 'lib/**/index.js' node scripts/run_unit_tests.mjs",
"test:rules:all": "firebase emulators:exec --only firestore,storage --project fluxo-ath \"node --test test/firestore.*.rules.test.js test/storage.*.rules.test.js\""
```

```bash
c8 check-coverage --lines 50 --branches 40   # start at baseline; ratchet towards §3.2
diff-cover coverage/lcov.info --compare-branch=origin/main --fail-under=80
```

**Job coverage.** Each job name in `jobs/runner.ts` (`analytics-rollup`, `cleanup-daily`, `payments-expire`, …) must have at least one test that runs its handler against the Firestore emulator. A script compares runner job keys with test file references and fails on gaps.

**G3: mutation.** Run StrykerJS (`@stryker-mutator/core` with the command runner) nightly on `src/payments`, `src/presence`, `src/identity` and `src/crypto`.

**G2: size.** 33 files exceed 400 lines. Apply the per-file ratchet, and extract pure logic from `identity_federated.ts`, `businesses.ts` and `itinerary.routes.ts` into `services/` so it can be tested without the emulator.

**Migration gate.** For domains already served by REST (see `REST_AND_JOBS_ROLLOUT`), new **write** callables or triggers in `functions/src/features/{messages,events,profile,identity,businesses,communities,notifications}` fail CI unless the PR is labeled `legacy-write-approved`. The count of exported callables per migrated domain is ratcheted down.

### 5.4 Menu Extractor (`OCR_webscraper_crawler/`)

This layer has the best test base (34 test files, fixtures, golden JSON) but **no CI at all**. Its `lint` script is only `tsc --noEmit`.

**G1.** Add the shared ESLint config (§5.6) at the workspace root. Keep `tsconfig.base.json` as it is, since it is already strict.

**G2: architecture (from `ARCHITECTURE.md`).** "The router must not import `@menu-extractor/ocr`, `scraper`, or `structurer`." Enforce this twice:

```js
// OCR_webscraper_crawler/.dependency-cruiser.cjs
module.exports = { forbidden: [
  { name: 'router-stays-thin', severity: 'error',
    from: { path: '^apps/router' },
    to:   { path: '(^packages/(ocr|scraper|structurer)|@menu-extractor/(ocr|scraper|structurer)|cheerio|@google-cloud/documentai|@google-cloud/vertexai)' } },
  { name: 'packages-do-not-import-apps', severity: 'error', from: { path: '^packages' }, to: { path: '^apps' } },
  { name: 'shared-is-a-leaf', severity: 'error', from: { path: '^packages/shared' }, to: { path: '^packages/(?!shared)' } },
  { name: 'no-circular', severity: 'error', from: {}, to: { circular: true } },
]};
```

```bash
npx depcruise apps packages --config .dependency-cruiser.cjs
```

And at the bundle level (G6): build the router with `metafile: true` and have `scripts/check-bundle.mjs` fail if any input path matches the forbidden packages, or if `dist/index.js` exceeds its size budget (router ≤ 1.5 MiB unminified; set the budget from the first measured build plus 10 %). This protects the "sub-1 s cold start" goal.

**G3: coverage.** Per package, in `vitest.config.ts`:

```ts
test: {
  coverage: {
    provider: 'v8',
    reporter: ['text-summary', 'lcov', 'json-summary'],
    include: ['src/**/*.ts'],
    exclude: ['src/**/*.test.ts', 'src/index.ts'],
    thresholds: { lines: 85, branches: 75, functions: 85, statements: 85 },
  },
},
```

Keep `packages/scraper` (SSRF and redirect validation) at 95 % lines / 90 % branches, with StrykerJS (`@stryker-mutator/vitest-runner`) nightly at a break threshold of 70 %.

**G4: deterministic extraction eval.** `HOMOLOGACAO.md` states that the golden JSON "is generated by local-dev and **is not** compared automatically". Close that gap with a golden eval that uses **mocked** Document AI, Gemini and Firecrawl, so it is deterministic:

| Metric | Definition | Gate |
|---|---|---|
| Schema validity | `uv run --directory python menu-schema <output>` passes for every fixture | 100 % |
| Item recall | `|items ∩ golden| / |golden|` (match on normalized name) | ≥ baseline per fixture |
| Price exact-match | items whose price equals the golden price, as cents integer | ≥ baseline |
| Section accuracy | items assigned to the golden section | ≥ baseline |
| HP-xxx cases | layout parser cases from `HOMOLOGACAO.md` (for example HP-005 ≥ 180 items) | all pass |
| Smoke | `pnpm smoke` | pass |

Implement it as `scripts/eval-golden.mjs`, which writes `quality/reports/ocr-eval.json`; `quality/check.mjs` compares it with the baseline. When a parser change intentionally moves a golden, regenerate the golden in the same PR, where it is reviewed as a diff.

Python validator: `ruff check`, `ruff format --check` and `pytest --cov=menu_schema --cov-fail-under=90`, with `mccabe` enabled:

```toml
# OCR_webscraper_crawler/python/pyproject.toml
[tool.ruff.lint]
select = ["E", "F", "W", "I", "B", "UP", "C90", "PL", "SIM", "RUF"]
[tool.ruff.lint.mccabe]
max-complexity = 10
[tool.ruff.lint.pylint]
max-args = 5
max-branches = 12
max-statements = 50
```

### 5.5 Web apps (`admin-web/`, `ofluxo_site/`)

Both already have ESLint, Vitest and Playwright but no CI. `ofluxo_site` has `@vitest/coverage-v8` configured only for `src/platform/**` and without thresholds; `admin-web` has no coverage configuration.

- **G1:** `tsc -b` + `eslint . --max-warnings=0`, extended with §5.6.
- **G3:** add Vitest `coverage.thresholds` (70/60/70/70), include all of `src/**`, and run `diff-cover` at 80 %. Keep MSW handlers in `admin-web` as the only network boundary.
- **G3 E2E:** Playwright against Firebase emulators for `admin-web`'s mutation flows (report decision, verification review, event moderation). Each flow must assert that the audit record and idempotency key are written, because the README makes both mandatory.
- **G5:** `admin-web` must never read Firestore directly (README). Add an ESLint `no-restricted-imports` rule on `firebase/firestore` for `admin-web/src/**`.
- **G6:** [`size-limit`](https://github.com/ai/size-limit) per chunk. `admin-web` already defines `manualChunks` (firebase, mui, charts, query), so each chunk gets a budget. For `ofluxo_site`, budget the initial JS, and lazy-load `three` so it stays out of the initial bundle.
- **Accessibility (site):** `@axe-core/playwright` on landing routes, with zero serious or critical violations.

### 5.6 Shared ESLint config (TypeScript)

Create `quality/eslint/base.mjs` and import it from `functions/`, `OCR_webscraper_crawler/`, `admin-web/` and `ofluxo_site/`:

```js
import tseslint from 'typescript-eslint';
import sonarjs from 'eslint-plugin-sonarjs';

export default tseslint.config(
  ...tseslint.configs.strictTypeChecked,
  {
    plugins: { sonarjs },
    rules: {
      complexity: ['error', 10],
      'max-depth': ['error', 4],
      'max-params': ['error', 4],
      'max-lines': ['error', { max: 400, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': ['error', { max: 60, skipBlankLines: true, skipComments: true }],
      'sonarjs/cognitive-complexity': ['error', 15],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      'no-console': ['error', { allow: ['warn', 'error'] }], // use the structured logger
    },
  },
  { files: ['**/*.test.ts', '**/*.test.tsx', 'test/**'], rules: { 'max-lines-per-function': 'off', 'max-lines': 'off' } },
);
```

**Legacy violations** use ESLint's bulk suppressions (ESLint ≥ 9.24). Run `eslint . --suppress-all` once, commit `eslint-suppressions.json`, and CI then runs `eslint . --prune-suppressions` followed by a `git diff --exit-code eslint-suppressions.json`. New violations fail, fixed ones must be pruned, and the file only shrinks.

### 5.7 Data and rules (`firestore.rules`, `storage.rules`, SQL)

- **Rules test coverage:** extract every `match /<path>` from `firestore.rules` (1 941 lines) and `storage.rules` with `quality/rules_paths.mjs`. Each path must appear in at least one `functions/test/firestore.*.rules.test.js` or `storage.*.rules.test.js`. The uncovered list is ratcheted.
- **Emulator rule coverage:** after the rules suites, fetch `http://127.0.0.1:8080/emulator/v1/projects/fluxo-ath:ruleCoverage` (JSON; `.html` for humans) and fail if any `allow` expression was never evaluated in a covered path.
- **All rules suites in CI.** Only the identity and presence suites run today. `admin`, `events.web`, `feed`, `fluxo_empresas`, `payments` and `storage.payments` must run too (`test:rules:all` above).
- **SQL:** `squawk` for `backend/deploy/sql/*.sql` (§5.2), plus the existing migrator idempotency check.

### 5.8 Infrastructure and CI (`infra/gcp/terraform`, `.github/workflows`)

```bash
terraform -chdir=infra/gcp/terraform fmt -check -recursive
terraform -chdir=infra/gcp/terraform init -backend=false && terraform -chdir=infra/gcp/terraform validate
tflint --recursive --chdir infra/gcp/terraform
trivy config --severity HIGH,CRITICAL --exit-code 1 infra/gcp/terraform
actionlint
zizmor .github/workflows
```

- **Pinned actions:** `backend-ci.yml`, `backend-deploy.yml` and `jobs-deploy.yml` already pin by SHA; `presence-integrity.yml` has 13 unpinned `uses:`. Gate: any `uses:` without a 40-character SHA fails.
- **Never `plan`/`apply` in PR CI.** `infra/gcp/README.md` requires importing state first, so PR gates stay offline (`-backend=false`).

### 5.9 Supply chain (all stacks)

```bash
osv-scanner scan --recursive --lockfile pubspec.lock --lockfile functions/package-lock.json \
  --lockfile OCR_webscraper_crawler/pnpm-lock.yaml --lockfile admin-web/package-lock.json \
  --lockfile ofluxo_site/package-lock.json .
dotnet list backend/Exemplo SaaS.Backend.sln package --vulnerable --include-transitive   # fail on "has the following vulnerable packages"
trivy image --severity HIGH,CRITICAL --exit-code 1 fluxo-backend:ci
```

Adjust the lockfile paths to whichever files exist; for example, `admin-web` may use a different lockfile. Gate: no HIGH or CRITICAL advisory without an entry in `osv-scanner.toml` that has a reason and an expiry date.

---

## 6. Shared tooling (`quality/`)

```text
quality/
├── baseline.json          # committed ratchet values (only decreases, except coverage which only increases)
├── check.mjs              # reads reports/, compares with baseline.json, prints scorecard (pt-BR), exits 1 on regression
├── messages.pt-BR.json    # catálogo único das mensagens de sucesso/erro dos gates (§6.2)
├── baseline.mjs           # regenerates baseline.json from reports (--write); used after an intentional improvement
├── dart_boundaries.mjs    # import-rule checker for lib/features
├── rules_paths.mjs        # firestore/storage match path → test coverage
├── eslint/base.mjs        # shared TS lint config
└── reports/               # gitignored; CI artifacts
```

`baseline.json` shape:

```jsonc
{
  "generatedAt": "2026-09-25",
  "dart":      { "analyzerIssues": 0, "suppressions": 21, "boundaryViolations": 48,
                 "apiFallbackWrites": 0, "apiFallbackTotal": 23,
                 "featuresWithoutTests": ["agenda", "artists", "auth", "..."],
                 "fileLines": { "lib/features/map/presentation/map_page.dart": 9301, "...": 0 },
                 "coverage": { "lines": 0.0 } },
  "dotnet":    { "coverage": { "lines": 0.0, "branches": 0.0 }, "ca1505": 0, "mutation": 0 },
  "functions": { "tscErrorsStrict": 0, "coverage": { "lines": 0.0, "branches": 0.0 },
                 "fileLines": {}, "jobsWithoutTests": [] },
  "ocr":       { "coverage": {}, "eval": { "pt-br-cantina": { "recall": 1.0, "priceExact": 1.0 } },
                 "routerBundleBytes": 0 },
  "rules":     { "uncoveredPaths": [] },
  "lizard":    { "warnings": 0 },
  "jscpd":     { "percentage": 0.0 }
}
```

Fill the zeros with the first real run.

`check.mjs` rules:

- **"Lower is better" counters** (issues, violations, suppressions, file lines, lizard warnings, duplication %): fail if the current value is greater than the baseline.
- **"Higher is better"** (coverage, mutation score, eval metrics): fail if the current value is lower than the baseline minus 0.1 pp. The tolerance absorbs rounding only.
- **Lists** (features without tests, uncovered rule paths): fail if an item is added.
- **Improvements** print a hint (in pt-BR, see §6.2): `Melhoria detectada. Rode node quality/baseline.mjs --write para registrar o ganho.` A scheduled workflow also opens a PR that tightens the baseline weekly.
- All output follows the pt-BR message catalog in §6.2; `check.mjs` never prints a verdict in English.

### 6.1 Module scorecard

Every gate is pass/fail. In addition, `check.mjs` prints a **0–100 score per module** so trends are visible in PRs and in a weekly report. Each component is normalized to 0–1 and clamped:

| Component | Weight | Normalization |
|---|---|---|
| Line coverage | 25 | `coverage / target` |
| Branch coverage | 10 | `branches / target` |
| Complexity | 20 | `1 − (functions with CC > 10) / functions` |
| Size | 15 | `1 − (NLOC in files > 400) / total NLOC` |
| Duplication | 10 | `1 − dup% / 10` |
| Lint and types | 10 | `1 − min(1, issues / (kLOC × 5))` |
| Boundaries | 10 | `1 − min(1, violations / 10)` |

`score = Σ weight × component`. It is computed only from committed files and deterministic reports, so the same commit always produces the same score. Module = one Flutter feature, one .NET module, one functions domain folder, one OCR package, or one web app.

### 6.2 Mensagens dos gates (pt-BR)

Every result a gate produces, pass or fail, is written in Portuguese. The texts live in one catalog, `quality/messages.pt-BR.json`. `check.mjs` and all custom scripts (`dart_boundaries.mjs`, `rules_paths.mjs`, `check-bundle.mjs`, `eval-golden.mjs`, `baseline.mjs`) read their texts from it. No script hard-codes a verdict string, which keeps wording consistent and testable.

**Rules**

1. **Every gate prints exactly one verdict line**, whether it passes or fails. Silence is never success.
2. **A verdict names** the gate, the module, the measured value, the limit and, on failure, what to do next.
3. **Numbers use pt-BR formatting**, via `Intl.NumberFormat('pt-BR')`: `78,4 %` and `1.941 linhas`.
4. **Status words are fixed:** `APROVADO`, `REPROVADO`, `ALERTA` (report-only gates, never blocking) and `IGNORADO` (the layer did not change in this PR).
5. **Native tool output** from ESLint, `dotnet`, `flutter analyze`, `tsc`, lizard and others stays untranslated in the raw log. The gate adds a pt-BR verdict that summarizes it.
6. **Exit codes:** `0` means everything was approved (alerts allowed), `1` means at least one gate failed, and `2` means a configuration error, such as a missing report or an invalid baseline. Exit code `2` also has a pt-BR message.

**Catalog** (excerpt of `quality/messages.pt-BR.json`):

```jsonc
{
  "status": { "pass": "APROVADO", "fail": "REPROVADO", "warn": "ALERTA", "skip": "IGNORADO" },

  "gate.coverage.pass":   "Cobertura de linhas em {module}: {value} (mínimo {limit}).",
  "gate.coverage.fail":   "Cobertura de linhas em {module} caiu para {value} (mínimo {limit}). Adicione testes para as linhas alteradas.",
  "gate.diffCoverage.pass": "Cobertura do diff: {value} das linhas alteradas estão cobertas (mínimo {limit}).",
  "gate.diffCoverage.fail": "Cobertura do diff: só {value} das linhas alteradas estão cobertas (mínimo {limit}). Linhas sem teste: {lines}.",

  "gate.complexity.pass": "Complexidade ciclomática em {module}: nenhuma função acima de {limit}.",
  "gate.complexity.fail": "Complexidade ciclomática de {function} ({file}:{line}) é {value} (máximo {limit}). Extraia ramos para funções menores.",
  "gate.fileSize.pass":   "Tamanho de arquivos em {module}: nenhum arquivo cresceu além do baseline.",
  "gate.fileSize.fail":   "{file} tem {value} linhas (baseline {limit}). O arquivo não pode crescer; extraia widgets/serviços.",
  "gate.duplication.pass": "Duplicação de código: {value} (máximo {limit}).",
  "gate.duplication.fail": "Duplicação de código subiu para {value} (máximo {limit}). Trechos duplicados: {count}.",

  "gate.boundaries.pass": "Fronteiras de arquitetura em {module}: nenhuma importação proibida.",
  "gate.boundaries.fail": "Importação proibida em {file}: {from} não pode importar {to}.",
  "gate.routerBundle.fail": "O bundle do router inclui {package}. O router deve continuar enxuto (ver ARCHITECTURE.md).",
  "gate.apiFallback.fail": "Fallback de escrita para Firestore encontrado em {file}:{line}. Com USE_API_*_WRITE=true a API é a fonte autoritativa.",

  "gate.testPresence.fail": "A feature {module} não tem nenhum teste em test/features/{module}/.",
  "gate.rulesPaths.fail":   "O caminho {path} em {rulesFile} não é exercitado por nenhum teste de regras.",
  "gate.ocrEval.fail":      "Avaliação do fixture {fixture}: {metric} caiu de {limit} para {value}.",
  "gate.lint.fail":         "{tool} encontrou {value} problema(s) em {module} (baseline {limit}).",
  "gate.vulns.fail":        "{count} vulnerabilidade(s) HIGH/CRITICAL em {lockfile}: {ids}.",

  "summary.pass":    "Todos os gates foram aprovados ({passed}/{total}). Score médio: {score}/100.",
  "summary.fail":    "{failed} de {total} gate(s) reprovado(s). Corrija os itens acima antes do merge.",
  "summary.improved": "Melhoria detectada em {metric} ({before} → {after}). Rode node quality/baseline.mjs --write para registrar o ganho.",
  "error.config":    "Erro de configuração: {detail}. Verifique quality/baseline.json e os relatórios em quality/reports/."
}
```

**Console output** (`node quality/check.mjs`):

```text
✅ APROVADO   [cobertura]    Cobertura de linhas em backend/Events: 82,1 % (mínimo 80,0 %).
✅ APROVADO   [complexidade] Complexidade ciclomática em ocr/scraper: nenhuma função acima de 10.
⚠️ ALERTA     [manutenibilidade] Índice de manutenibilidade de MessagesModule é 18 (mínimo 20).
⏭️ IGNORADO   [infra]        Nenhuma alteração em infra/ neste PR.
❌ REPROVADO  [tamanho]      lib/features/map/presentation/map_page.dart tem 9.340 linhas (baseline 9.301). O arquivo não pode crescer; extraia widgets/serviços.
❌ REPROVADO  [fronteiras]   Importação proibida em lib/features/feed/domain/post.dart: domain não pode importar package:cloud_firestore.

Resultado: 2 de 14 gate(s) reprovado(s). Corrija os itens acima antes do merge.
```

On success:

```text
✅ APROVADO   [cobertura-diff] Cobertura do diff: 91,3 % das linhas alteradas estão cobertas (mínimo 80,0 %).
...
Resultado: Todos os gates foram aprovados (14/14). Score médio: 74/100.
💡 Melhoria detectada em dart.boundaryViolations (48 → 45). Rode node quality/baseline.mjs --write para registrar o ganho.
```

**GitHub Actions:** `check.mjs --github` also emits annotations with the same pt-BR text, so failures show up inline on the PR diff:

```text
::error file=lib/features/map/presentation/map_page.dart,title=Tamanho de arquivo::map_page.dart tem 9.340 linhas (baseline 9.301). O arquivo não pode crescer; extraia widgets/serviços.
::notice title=Gates de qualidade::Todos os gates foram aprovados (14/14). Score médio: 74/100.
```

It writes a pt-BR table to `$GITHUB_STEP_SUMMARY` with the columns **Gate · Módulo · Valor · Limite · Status**, followed by the per-module score table (**Módulo · Score · Cobertura · Complexidade · Tamanho · Duplicação · Lint · Fronteiras**).

**Tests and assertions written by us** follow the same rule. Examples include NetArchTest messages (§5.2), the Dart boundary script and the job-coverage check in `functions/`: their failure messages are in pt-BR. A unit test for `check.mjs` asserts that every `gate.*` key has both a `.pass` and a `.fail` text, and that every `{placeholder}` used in the code exists in the catalog.

CI **step names** in `quality.yml` are also in pt-BR, following the convention already used in `backend-ci.yml` (for example `Validar cobertura`, `Verificar fronteiras de arquitetura`, `Consolidar gates de qualidade`).

---

## 7. CI wiring

Add one workflow, `.github/workflows/quality.yml`, with path filters. Existing workflows stay as they are; `presence-integrity.yml` keeps its Flutter jobs, and the Flutter quality job below adds coverage and metrics.

```yaml
name: Gates de Qualidade
on:
  pull_request:
  push: { branches: [main] }
permissions: { contents: read }

jobs:
  changes:
    runs-on: ubuntu-latest
    outputs:
      flutter:   ${{ steps.f.outputs.flutter }}
      backend:   ${{ steps.f.outputs.backend }}
      functions: ${{ steps.f.outputs.functions }}
      ocr:       ${{ steps.f.outputs.ocr }}
      web:       ${{ steps.f.outputs.web }}
      infra:     ${{ steps.f.outputs.infra }}
    steps:
      - uses: actions/checkout@<sha>
      - id: f
        uses: dorny/paths-filter@<sha>
        with:
          filters: |
            flutter:   ['lib/**', 'test/**', 'packages/**', 'pubspec.*', 'analysis_options.yaml']
            backend:   ['backend/**']
            functions: ['functions/**', 'firestore.rules', 'storage.rules']
            ocr:       ['OCR_webscraper_crawler/**']
            web:       ['admin-web/**', 'ofluxo_site/**']
            infra:     ['infra/**', '.github/workflows/**']

  hygiene:            # G0 + G5, always runs
    runs-on: ubuntu-latest
    steps: [checkout, gitleaks, osv-scanner, actionlint, zizmor, jscpd, lizard]

  flutter:   { needs: changes, if: needs.changes.outputs.flutter == 'true',   steps: [analyze, dart_code_linter, boundaries, "test --coverage", diff-cover] }
  backend:   { needs: changes, if: needs.changes.outputs.backend == 'true',   steps: [format verify, arch tests, coverage, ef pending, squawk, oasdiff] }
  functions: { needs: changes, if: needs.changes.outputs.functions == 'true', steps: [tsc strict count, eslint, c8, "test:rules:all", rules_paths] }
  ocr:       { needs: changes, if: needs.changes.outputs.ocr == 'true',       steps: [eslint, depcruise, typecheck, "vitest --coverage", check-bundle, eval-golden, ruff, pytest] }
  web:       { needs: changes, if: needs.changes.outputs.web == 'true',       steps: [eslint, tsc, "vitest --coverage", size-limit, playwright] }
  infra:     { needs: changes, if: needs.changes.outputs.infra == 'true',     steps: [terraform fmt/validate, tflint, trivy config] }

  gate:
    needs: [hygiene, flutter, backend, functions, ocr, web, infra]
    if: always()
    runs-on: ubuntu-latest
    steps:
      - name: Coletar relatórios dos jobs
        uses: actions/download-artifact@<sha>   # collect quality/reports/** from all jobs
      - name: Consolidar gates de qualidade
        run: node quality/check.mjs --reports quality/reports --baseline quality/baseline.json --summary "$GITHUB_STEP_SUMMARY" --github
```

The job bodies above are shorthand; expand each item into the commands from §5. Pin every action by SHA, as `backend-ci.yml` does. Make `gate` the single required status check in branch protection.

**Nightly** (`quality-nightly.yml`): Stryker.NET, StrykerJS, full-repo `diff-cover` against the last release tag, and the weekly baseline-tightening PR.

**Local:** add `make quality` (or `pnpm quality` at the root) that runs the same scripts for the layers changed against `origin/main`, so developers see the gate before pushing.

**Status de implementação (2026-10-23, board [`docs/entregas/2026-10-23-board-qualidade/`](docs/entregas/2026-10-23-board-qualidade/SUMMARY.md)).** Onda 1 no ar: [`.github/workflows/quality.yml`](.github/workflows/quality.yml) existe com os jobs `mudancas` (paths-filter), `higiene` (self-testes do motor, `quality/baseline.mjs --check` e gates rápidos do diff contra `origin/main`), `flutter` (analyze + `flutter test --coverage` + `diff-cover` ≥ 80 %), `ocr` (typecheck + testes), `web` (admin-web, ofluxo_site e debate-worker: lint + testes) e o consolidador `gate` (`if: always()`; aceita só `success`/`skipped`). Todas as actions dos seis workflows estão pinadas por SHA. O [`quality/baseline.mjs`](quality/baseline.mjs) grava e verifica o `quality/baseline.json` (ratchet global de tamanho, supressões, fronteiras, fallbacks, features sem teste; CC por camada com `--full`). Continuam pendentes: `quality/check.mjs` (scorecard por módulo), `quality-nightly.yml` (mutação), jscpd no CI e a migração do `setup-java` v4 (depreciado) para v5. Backend e functions seguem nos workflows que já os cobrem (`backend-ci.yml`, `presence-integrity.yml`, `jobs-deploy.yml`), agora todos pinados. **Revival (2026-11-22, trilha E concluída — QG-022..027):** gate de custo para Cloud Run Job sempre em voo (`task-timeout × tick → execuções em voo → run-rate`, `quality/lib/cost-job.mjs`, teto em `thresholds.costJob`), chave dura `GH_ACTIONS=false` (só qualidade e deploy locais), `RELEASE` permanente + reciclagem de nome de release propagada + propagação por merge local, deploy scripts locais 100% parametrizados, lembrete determinístico de deploy pendente no Stop e summary de card Jira re-sincronizado.

---

## 8. Rollout

| Phase | Scope | Exit criterion |
|---|---|---|
| **1. Measure** (week 1) | Add `quality/`, run every tool in report-only mode, commit `baseline.json`, publish the scorecard in PR summaries | baseline committed; `gate` job green in report-only mode |
| **2. Ratchet** (weeks 2–3) | Turn on "no regression" for all counters and coverage; enable diff coverage; add CI for OCR, admin-web and ofluxo_site; run all rules suites | `gate` required in branch protection |
| **3. Boundaries** (weeks 3–5) | Dart boundary script, NetArchTest, dependency-cruiser, router bundle check, `apiFallbackWrites = 0`, pin actions | zero new boundary violations; fallback writes removed |
| **4. Strictness** (weeks 4–8) | `functions` `noImplicitAny`, Dart `strict-*`, shared ESLint config with bulk suppressions, CA1502/CA1505 | suppression files and counters trending down |
| **5. Depth** (month 2+) | Tests for the 17 untested Flutter features (feed, messages, friends, notifications and chat first), OCR golden eval, OpenAPI diff, mutation testing nightly → blocking on critical modules | §3.2 targets met for critical modules |
| **6. Decompose** (ongoing) | Split the 35 Dart files over 1 000 lines and the largest `functions/` files; each split PR lowers `fileLines` in the baseline | no file over 1 000 lines; score ≥ 70 per module |

**Ownership:** whoever changes a gate threshold, or regenerates the baseline with a *worse* value, must justify it in the PR description and get a CODEOWNERS approval for `quality/`.

---

## 9. Claude Code integration (hooks + skill)

> Workflow por workflow (sessão, edição, busca, gitflow, ciclo, Jira, ponte Cline): [docs/harness/INDEX.md](docs/harness/INDEX.md).

The gates are also enforced **while Claude edits code**, through Claude Code hooks backed by the same engine CI will use.

| Piece | Path |
|---|---|
| Engine (CLI) | `quality/run.mjs` — `--risk`, `--tier rapido\|rotina\|completo`, `--relatorio`, `--base remote`, `--json` |
| Hooks | `.claude/settings.json` → `quality/hooks/{session-start,post-edit,pre-bash,stop}.mjs` |
| Skill | `.claude/skills/avaliar-qualidade/` (workflow, risk matrix, tiers, report format) |
| Risk matrix (source of truth) | `quality/config/risk-matrix.json` |
| Thresholds | `quality/config/thresholds.json` (mirrors §3) |
| Messages (pt-BR, §6.2) | `quality/messages.pt-BR.json` |
| Self-tests | `node --test quality/test/*.test.mjs` |

**Risk matrix.** Every change is classified on two deterministic axes, **backend breakage** and **cost scaling**. The inputs are file paths, net added call sites to paid APIs, deltas in min-instances and cron runs per day, removed Functions exports, and diff size. The risk decides the required test tier and whether Claude is blocked or must ask the user.

**Three tiers.**
- **rápido** runs automatically on every edit, in under 3 s per file, and compares against `HEAD` so legacy code never fails by itself.
- **rotina** runs at delivery: lint and types on the touched packages, plus related tests.
- **completo** is reserved for high or critical risk: full suites, diff coverage, and dependency scan.

**Evidence.** `git commit`, `git push` and deploy commands are gated by `PreToolUse`: they require a passing run of the required tier for the exact current worktree hash. Critical risk, and deploys with cost flags, always ask for human confirmation.

**Report mode.** `node quality/run.mjs --relatorio` evaluates every layer (stack, static metrics, full suites, score) into `quality/reports/relatorio-<date>.md`. It runs only on explicit request.

**Baseline.** The hooks use `HEAD` as the ratchet baseline (diff-based), so `quality/baseline.json` from §6 is only needed for CI trend tracking.

### 9.1 Autocorreção leve de código de gate e de teste

`quality/lib/autofix.mjs`, chamado de dentro de `post-edit.mjs` (antes dos gates, no mesmo processo, para não disputar o arquivo com outro hook) e por `node quality/run.mjs --fix` (também no `git-pre-commit.mjs`). Escopo em `quality/config/autofix.json` (`quality/**/*.mjs`, hooks, `scripts/jira`, JSON de config, `test/**/*_test.dart`). `FLUXO_AUTOFIX=0` desliga.

- **Aplica sozinho (seguro):** CRLF→LF e newline final (não mexe em espaços dentro de literais); `dart format` em testes Dart (só se o arquivo já estava formatado no HEAD); correções seguras do Biome.
- **Devolve ao agente (exit 2, `arquivo:linha:col`):** erro de sintaxe (`node --check`, `JSON.parse`, `dart format`) e erro de lint **novo** (ratchet contra o HEAD). Sintaxe nunca é reescrita.
- **Lint:** Biome 2.6.4 isolado em `quality/tools/` (`cd quality/tools && npm install`), formatter desligado, só regras de correção (`quality/tools/biome.json`). Sem o binário, avisa e segue.
- **Trava:** após 3 falhas seguidas no mesmo arquivo na sessão, deixa de bloquear e manda relatar ao usuário.

### 9.2 Paridade Claude Code ↔ Cline

O Cline roda os **mesmos scripts** dos hooks do Claude: `quality/lib/cline-bridge.mjs` traduz o payload do Cline (`run_commands`/`execute_command` → `Bash`; `editor`/`write_to_file`/`replace_in_file`/`apply_patch` → `Write`/`Edit`/`MultiEdit`), roda o script e devolve o resultado no vocabulário do Cline. Descoberta: `.clinerules/hooks/<Evento>` (extensionless, executável). Testes: `quality/test/cline-bridge.test.mjs`.

| Claude | Cline | Como a negação chega ao agente |
|---|---|---|
| `PreToolUse` Bash: `pre-bash` (evidência), `pre-bash-gitflow`, `rtk`, guarda de busca | `PreToolUse` | shell no CLI/SDK: `overrideInput` troca o comando por `printf <motivo>; exit 1` (suave); extensão: `cancel:true` |
| `PreToolUse` edição: `guarda-backlog` | `PreToolUse` | `cancel:true` (parar a tarefa é a única negação de edição que o Cline oferece) |
| `PostToolUse` edição: `post-edit` (gates + autocorreção), `regras-de-dominio`, `guarda-entrega`, `post-edit-graphify`, `sync-spec-jira` | `PostToolUse` | `contextModification` (o Cline ignora cancel aqui) com o mesmo texto do exit 2 |
| `PostToolUse` Bash: `post-bash-gitflow`, `post-search-graphify` | `PostToolUse` | `contextModification` |
| `SessionStart`: `session-start` | `TaskStart`, `TaskResume` | `context` |
| `Stop`: `stop`, `lembrar-documentacao` | `TaskComplete` | `context` (o fim da tarefa não pode ser bloqueado como o `decision:block` do Claude) |
| `SubagentStop`: `handoff-subagente` | **sem equivalente** | o Cline não tem evento de fim de subagente; valide o bloco HANDOFF a mão |

Limites conhecidos: o Cline nunca foi executado de verdade contra estes hooks (só payloads sintéticos baseados no código do SDK); `TaskComplete` com `stop` pesado pode passar do tempo do hook (fail-open); a extensão VS Code antiga pode exigir "Enable Hooks".

## 10. Resource ceiling (CPU and memory)

The `rotina` and `completo` tiers and `--relatorio` run under a resource ceiling so they do not freeze the machine. It only slows the run: the gates check exactly the same things and nothing is skipped.

- **How:** `quality/lib/limits.mjs` relaunches the CLI inside a `systemd-run --user --scope` cgroup with `MemoryMax` (default 3072 MB), `MemorySwapMax=0` and `CPUQuota` (default 200%), at `nice 19` and idle I/O. Per tool: `vitest --maxWorkers`, `flutter test --concurrency`, `node --test --test-concurrency`, `dotnet build -m:1`, Node heap cap and .NET workstation GC. Config: `quality/config/resources.json`; env overrides `QUALITY_MEM_MAX_MB`, `QUALITY_CPU_QUOTA`, `QUALITY_WORKERS`.
- **Time ceilings scale** by `timeFactor` (default 3), so a slower gate does not time out into "not measured".
- **A gate killed for memory FAILS** (`tool.oom`), it never becomes a warning or a pass. Raise `QUALITY_MEM_MAX_MB` if that happens.
- **`OOMPolicy=continue` is required.** With the default policy (`stop`) systemd tears down the WHOLE scope when the kernel kills one process, including `run.mjs` itself, so no gate is reported. With `continue` only the offender dies and the gate fails with `tool.oom` (confirmed by the scope's `oom_kill` counter, not guessed from the exit code).
- **Do not add `MemoryHigh`.** Without swap the kernel throttles instead of killing and a gate can hang for minutes (measured: stuck over 40 s versus 0.14 s to be killed with `MemoryMax` only).
- **Off:** `QUALITY_RESOURCES=off` or `CI=true` (ephemeral runners). Without cgroup support (macOS, containers) it falls back to `nice`, workers and heap caps and prints a warning.
- **Measured** (`completo`, same files, site vitest suite): 46.8 s, 2.9 GB peak, 456 CPU-seconds unlimited versus 108.8 s, 0.8 GB peak, 218 CPU-seconds limited. Because the limited run is slower, start `completo` in the background (the shell tool caps a foreground command at 10 minutes).
- The graphify build uses the same ceiling: `node quality/agents/graphify-build.mjs [--update]`.
