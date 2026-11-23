# Levantamento de performance por camada (motor + runners)

- **Status:** LEVANTAMENTO (medições no hospedeiro de referência, 2026-11-23) — implementação das melhorias é tarefa separada
- **Ambiente:** laptop HP (Linux, Node 22.23, lizard via `uvx --offline`, dart/flutter/dotnet/pnpm/uv/docker/firebase ✔; go/cargo/java/maven/cmake/clang ✘ — custos desses marcados N/A ou estimados)
- **Método:** (A) motor real `quality/run.mjs` cronometrado; (B) parsers/filtros dos runners com entradas sintéticas grandes (bench puro, sem spawn); (C) custo de spawn real por toolchain em projeto mínimo; (D) análise estática de quantos spawns cada camada faz por arquivo/diff.

## A. Custo fixo do motor (medido)

| Execução | Tempo real |
|---|---|
| `--risk` (boot Node + imports + git) | 126 ms |
| `--tier rapido --files` (4 arquivos .mjs, worktree limpo — gates de texto pulam sem diff) | 189 ms |
| `--tier rotina` (idem) | 313 ms |

Boot do motor é irrelevante. O custo do tier rápido vem dos **spawns por arquivo** (D1).

## B. Custo computacional dos runners (medido, sem spawn)

| Componente | Escala | Tempo |
|---|---|---|
| `parseColonDiag` (go vet/clippy/rustc/clang-tidy) | 10k linhas | 14 ms |
| `classifyLintIssues` | 1k diagnósticos | 12 ms |
| `goPackages` | 5k arquivos | 4 ms |
| `parseLineList` | 5k arquivos | 2 ms |
| `layerOf` (matchAny do perfil) | 5k paths | 1,3 ms |
| `scanScope` | 50k entries | 283 ms |
| `Budget.timeout` | 100k chamadas | 6 ms |

**Conclusão: o custo computacional dos runners é desprezível. Toda a performance está no custo de spawn e em quantas vezes cada camada spawna.**

## C. Custo de spawn real por toolchain (medido, projeto mínimo)

| Tool | Custo medido | Nota |
|---|---|---|
| `dart format --stdin` (1 arquivo) | **82 ms** | base do gargalo D1 |
| `dart analyze` (projeto mínimo) | 207–400 ms | escala com o tamanho real do projeto |
| `flutter analyze --no-pub` | 612–1.172 ms | boot do flutter tool |
| lizard via `uvx --offline` (1 arquivo) | **~90 ms** | base do gargalo D1 |
| `pnpm -v` | 418 ms | boot pnpm |
| `dotnet --version` | 282 ms | boot SDK |
| `dotnet build` (console mínimo) | **3,5 s frio** / **887 ms quente** | backend hoje: 1 build + 1 test |
| `node --test` (boot) | 43 ms | functionsRoutine |
| go/cargo/maven/ctest/clang-tidy | N/A aqui | caps já definidos por runner (60k–900k ms) |

## D. Gargalos por camada (análise estática × números de C)

### D1. Tier rápido (`fastGates`) — **o maior gargalo do harness**

Cada arquivo **Dart** alterado paga, por gate:
- `complexityGate`: 2 spawns lizard (raw + sanitizado) **+ 2 para o `oldText`** do ratchet = 4
- `halsteadGate`: 2 + 2 = 4 spawns lizard
- `formatGate`: 1–2 spawns `dart format`

**Total: 8–10 spawns ≈ 0,9 s POR ARQUIVO** no nível que roda a cada edição. Diff de 50 arquivos Dart = ~45 s no "rápido". Arquivos TS/JS pagam os 8 spawns lizard. Crescimento linear no tamanho do diff — o rápido escala mal em merge grande.

### D2. Camada Flutter

`dart analyze` 1 spawn por alvo (≤8) + 1 `flutter test` por iteração ✔ já concentrado. Custo dominante: `dart analyze` (escala com projeto) e `flutter test` (boot ~10–30 s real). Ganho possível via analysis server persistente (P2).

### D3. Camadas TS (`functions`, `ocr`, `web`)

`tsc`/build temporário + `node --test`/`vitest` + `eslint` — **1 spawn por workspace/app tocado** (até 3×n). Muitos workspaces alterados = D1 em menor escala. `eslint` já aceita lista de arquivos ✔.

### D4. Camada .NET (`backendRoutine`)

2–4 spawns **total** ✔ o mais eficiente por desenho. Custo dominante é o build (3,5 s frio → 0,9 s quente medidos).

### D5. Camadas novas (go/rust/cpp/java)

2–4 spawns **total** por camada ✔ desenho enxuto (fmt chunk + vet/clippy + test). Custo futuro dominante: builds frios — cache via env do perfil (sccache/ccache/GOFLAGS) é a alavanca; o `step()` já aceita `env`.

### D6. `supplyChain` (completo)

1 spawn osv-scanner **por lockfile** (N spawns; 10 lockfiles = 10 × 1–2 s).

## Melhorias priorizadas

| # | Proposta | Camada | Ganho estimado |
|---|---|---|---|
| **P0 ✔ IMPLEMENTADO (2026-11-23)** | **Lizard em lote no `fastGates`**: `batchFastGates` mede todo o diff com `lizardBatch` (1 spawn raw + 1 sanitizado por chunk de 400, raw+sanitizado para cc e halstead) e mede o `oldText` **só dos arquivos suspeitos** (alguma função acima de algum alvo) — veredito idêntico ao ratchet por arquivo, com self-test de equivalência (`quality/test/gates-batch.test.mjs`) | todas (tier rápido) | **medido: 12,3 s → 2,4 s (5,1×) em 30 dart; motor real 2,5 s** |
| **P0 ✔ IMPLEMENTADO (2026-11-23)** | **`dart format` em lote**: `formatGatesBatch` roda 1 spawn por chunk de 100 paths quando o disco é igual ao diff (checagem barata de leitura); divergentes/reprovados caem no caminho stdin individual (fiel ao diff) | Dart | ~4 s (50 arq) → ~0,2 s |
| **P1 ✔ IMPLEMENTADO (2026-11-23)** | **osv-scanner único**: 1 spawn com `--lockfile` repetido para todos os lockfiles (+ go.sum/Cargo.lock/gradle.lockfile/paket.lock/packages.lock.json no filtro; bug latente `r.status`/`timeout` do `run()` corrigido para `r.code`/`timeoutMs`) | supply chain | N spawns → 1 |
| **P1 ✔ IMPLEMENTADO (2026-11-23)** | **Runners de camada em paralelo**: `runTier` async com um subprocesso por grupo de camada (`quality/lib/camada-filha.mjs`, stdin JSON → stdout JSON; budget fatiado entre os grupos; <2 grupos = serial sem overhead; falha/timeout do filho = `camada.unmeasured` WARN). `rodarCamadas` por grupos (`GRUPOS` em `tiers.mjs`); `run.mjs`/`stop.mjs` async | rotina/completo multi-stack | soma → máximo (self-test `tiers-paralelo.test.mjs`: filhos reais == serial; benchmark multi-stack completo depende de hospedeiro com 2+ toolchains) |
| **P1 ✔ FECHADO SEM AÇÃO (2026-11-23)** | **eslint agregado**: já é 1 spawn por app com todos os arquivos do app (`eslintGate` em `typescript.mjs`); tsc não aceita multi-config e segue por workspace — nada a mudar | TS web | já agregado |
| **P2 ✔ SUPORTADO VIA PERFIL (2026-11-23)** | Cache de toolchain nos builds frios: `step()` já aceita `env` — o hospedeiro declara `sccache`/`ccache`/`GOFLAGS` no `runnerRust`/`runnerCpp`/`runnerGo` do perfil; mecanismo pronto, configuração é do projeto | go/rust/cpp/java | frio → quente (depende do hospedeiro) |
| P2 (pendente) | `dart analyze` persistente (LSP) — exige daemon entre rodadas; avaliar se o ganho justifica o estado compartilhado | Flutter | 0,2–5 s → ~50 ms |
| P2 (pendente) | `scanScope` pré-indexado (só se diffs >10k) | runners novos | n/a |

## O que NÃO precisa mexer

Parsers/montagens dos runners novos (microssegundos — tabela B); camadas .NET e flutter-test (1–2 spawns agregados); boot do motor, Budget, layerOf, risk (<10 ms).

## Próximos passos sugeridos

1. P0 lizard batch + dart format batch (mesma entrega; gate: tier rápido de diff sintético grande cai de ~45 s para <6 s).
2. P1 paralelização de camadas (trocar `step`/`run` síncronos por async nos runners de camada).
3. P1 osv único; P2 caches de build conforme stack do hospedeiro.
