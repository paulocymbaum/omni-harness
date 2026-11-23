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
| **P0** | **Lizard em lote no `fastGates`**: coletar arquivos por linguagem e medir via `lizardOnFiles` (chunks de 400 já existem) — 1 spawn raw + 1 sanitizado por chunk; `oldText` só na 2ª passada, sob demanda, para funções reprovadas | todas (tier rápido) | 8 spawns/arq → ~0,02. Diff de 50 dart: ~45 s → **~5 s** |
| **P0** | **`dart format` em lote**: aceita lista de paths — 1 spawn por chunk de 100; stdin por arquivo só nos reprovados | Dart | ~4 s (50 arq) → ~0,2 s |
| **P1** | **Runners de camada em paralelo**: hoje em série (`rodarCamadas`); exige `runAsync` + budget compartilhado | rotina/completo multi-stack | soma → máximo |
| **P1** | **osv-scanner único**: `--lockfile` múltiplo ou scan recursivo | supply chain | N spawns → 1 |
| **P1** | **eslint agregado por app** (tsc segue por workspace — não aceita multi-config) | TS web | n → 1 por app |
| **P2** | Cache de toolchain nos builds frios (sccache/ccache/GOFLAGS) via `env` do perfil no `step()` | go/rust/cpp/java | frio → quente |
| **P2** | `dart analyze` persistente (LSP) | Flutter | 0,2–5 s → ~50 ms |
| **P2** | `scanScope` pré-indexado (só se diffs >10k) | runners novos | n/a |

## O que NÃO precisa mexer

Parsers/montagens dos runners novos (microssegundos — tabela B); camadas .NET e flutter-test (1–2 spawns agregados); boot do motor, Budget, layerOf, risk (<10 ms).

## Próximos passos sugeridos

1. P0 lizard batch + dart format batch (mesma entrega; gate: tier rápido de diff sintético grande cai de ~45 s para <6 s).
2. P1 paralelização de camadas (trocar `step`/`run` síncronos por async nos runners de camada).
3. P1 osv único; P2 caches de build conforme stack do hospedeiro.
