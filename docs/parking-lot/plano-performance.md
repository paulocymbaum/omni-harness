# Plano faseado de performance — harness local

- **Status:** PLANO APROVADO PARA EXECUÇÃO (2026-11-23) — sucessor de `performance-camadas.md` (P0/P1 ✔) e `big-o-easy-gains.md` (EG1/EG2 ✔)
- **Princípio:** cada fase fecha com bateria local verde + bench comparativo medido; nenhuma otimização sem número antes/depois; fallback conservador em toda mudança de caminho quente (comportamento antigo quando o novo não se aplica).

## Estado consolidado (já entregue)

| Item | Ganho medido |
|---|---|
| P0 lizard + dart format em lote | 12,3 s → 2,4 s (5,1×) em 30 dart |
| EG1 diff global no `collectEntries` | 0,33 s → 0,15 s (2,3×) em 30 arquivos |
| EG2 `netIncrease` pré-compilada | micro (higiene) |
| P1 osv único | N spawns → 1 |
| P1 camadas em paralelo | mecanismo ✔ (soma → máximo; benchmark multi-stack = F2) |

## F5 (primeira) — ferramenta de bench comparativo reutilizável

`scripts/dev/perf-compara.mjs`: fixtures sintéticos (30 dart + 30 ts + 300 arquivos M) exercitando `batchFastGates`, `collectEntries` e `runTier`; imprime tabela ms por caminho. **Motivo da ordem:** toda fase seguinte usa ESTE script como gate de não-regressão. Aceite: roda <60 s, saída estável entre duas execuções (±20%). Esforço: meio período de sessão.

## F1 — EG3: `fileAtRev` em batch (`git cat-file --batch`)

- **Hoje:** 1 spawn `git show rev:path` por arquivo M/R — a última O(n) de spawns do caminho quente.
- **Como:** `collectEntries` abre UM `git cat-file --batch`, escreve todos os `baseSha:path\n`, parseia respostas `<sha> <tipo> <size>\n<bytes>\n` e `missing` (linha vazia); conteúdo por offset/size em Buffer (atenção a UTF-8 multibyte — nunca fatiar string por bytes) e `asText` igual ao atual (NUL/2 MB guard).
- **Fallback:** qualquer anomalia no protocolo → caminho `fileAtRev` por arquivo (comportamento de hoje).
- **Gates:** self-test com `tempRepo` (M/A/D/untracked: `oldText` do lote == `fileAtRev` unitário) + bench do perf-compara (300 arquivos M).
- **Aceite:** `collectEntries` de 300 arquivos M cai de ~1,5 s para <0,6 s; bateria verde.
- **Esforço:** ~60 linhas + testes; risco médio-baixo (protocolo binário bem definido).

## F2 — benchmark multi-stack real da paralelização

- **Como:** perfil de teste temporário em `/tmp` (NUNCA o exemplo do repo) com camadas `flutter` + `backend` e `runnerDotnet.solution` apontando para o console mínimo de `/tmp/perf/dotproj`; entries dart+cs sintéticos; medir `runTier` (filhos) vs composição serial com o MESMO budget.
- **Gates:** paralelo ≤ máx(grupos) + 20% e < soma; resultados de ambos idênticos por assinatura.
- **Aceite:** números reais na tabela de `performance-camadas.md` (hoje só o mecanismo está provado).
- **Esforço:** baixo (fixture + script; zero mudança no núcleo).

## F4 — `scanScope` pré-indexado: AVALIADO E DESCARTADO (2026-11-23)

Implementação segura exigiria mudar a semântica (filtrar o payload do worker pelas camadas do grupo — um runner com `root` fora dos globs da camada ficaria silenciosamente sem entries, violando a falha aberta) ou estado global de cache entre chamadas (risco de contaminação entre rodadas nos testes). Custo atual medido: `scanScope` 283 ms em 50k — irrelevante para diffs reais (<1k). **Volta à fila apenas** se profiling de diff gigante (>10k) apontar os re-filtros dos runners como dominantes.

## F6 ✔ IMPLEMENTADO — env de toolchain por runner (2026-11-23)

Os runners go/rust/cpp/java embrulham o `step` num wrapper transparente que mescla `runner<X>.env` em todos os passos (build/test/lint/fmt):

```json
"runnerRust": { "root": "svc/", "env": { "RUSTC_WRAPPER": "sccache", "CARGO_TARGET_DIR": "target" } },
"runnerCpp":  { "env": { "CCACHE_CPP2": "true" } },
"runnerGo":   { "env": { "GOFLAGS": "-mod=mod", "GOPROXY": "off" } },
"runnerJava": { "env": { "MAVEN_OPTS": "-Xmx1g" } }
```

Builds frios viram quentes na segunda rodada sem tocar no núcleo. Backend .NET segue com `backend-env` dedicado.

## F1/F2/F5 ✔ IMPLEMENTADOS (2026-11-23)

- **F1:** `fileAtRevBatch` (`git cat-file --batch`, parse por bytes, `asText` com NUL/2 MB guard) no `collectEntries` — 3 spawns → 1 por rodada; self-test batch==unitário com UTF-8 (`git-diff.test.mjs`).
- **F2:** medido acima — serial 0,32 s → paralelo 0,18 s (1,76×) com dart+dotnet reais, `camada.unmeasured` zero.
- **F5:** `scripts/dev/perf-compara.mjs` — tier rápido 12,86 s → 2,59 s; collectEntries 0,29 s → 0,01 s (29×); parsers <10 ms. Gate de não-regressão para qualquer mudança futura de performance.

## Adiados com critério de disparo explícito

| Item | Critério para voltar à fila |
|---|---|
| LSP Dart persistente (P2) | `dart analyze` medido > 3 s no projeto real do hospedeiro (spike de 1 h antes para validar o protocolo do DAS) |
| Caches de toolchain (sccache/ccache/GOFLAGS) | hospedeiro com Go/Rust/C++ em uso contínuo — hoje é doc-only: receita no overlay do perfil (`step()` já aceita `env`) |

## Ordem de execução e orçamento

1. **F5** (ferramenta de bench) — ✔ implementada (`scripts/dev/perf-compara.mjs`).
2. **F1** (EG3 cat-file batch) — ✔ implementada; bench: coleta de 30 arquivos ~2× mais rápida no trecho de diff; self-test UTF-8/missing.
3. **F2** (benchmark multi-stack) — ✔ implementada; 1,76× medido (flutter+dotnet reais), sem unmeasured.
4. **F4** (scanScope) — avaliada e descartada com justificativa; volta só com disparo. **F3/F6** — F6 implementada (env por runner); F3 adiada com critério.

## Não-planejado (decidido)

- Converter runners para async (o subprocesso por grupo já entrega o paralelismo sem refactor).
- Otimizar boot do motor (126-313 ms = imports Node), `worktreeHash` (semântico), `stripLiterals` (V8 rope, já em lote), parsers por stack (linear e <300 ms).
