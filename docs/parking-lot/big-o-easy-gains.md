# Big O por script e easy gains de performance

- **Status:** ANÁLISE (2026-11-23) — cobre os módulos do caminho quente (toda rodada de gates, toda edição, todo evento de hook) e os frios por amostragem
- **n** = arquivos alterados no diff · **L** = linhas do arquivo · **R** = regras do perfil · **C** = camadas · **E** = evidências do hash
- **Medidas deste hospedeiro** (lizard 90 ms/spawn, dart format 82 ms, git ~5-15 ms/spawn, dart analyze 207-400 ms)

## Caminho quente (roda a cada edição / commit / stop)

| Módulo.função | Big O | Sobre o quê | Status |
|---|---|---|---|
| `glob.globToRegex` | O(1) amortizado | cache Map por glob ✔ | ok |
| `glob.matchAny` | O(G) por chamada | G = globs da regra | ok |
| `layers.layerOf` | O(C·G) por arquivo | medido 1,3 ms/5k paths | ok |
| `git.changedFiles` | O(n) + 2 spawns fixos | ✔ | ok |
| `git.fileAtRev` (via `collectEntries`) | **O(n) spawns** (`git show` por arquivo M/R) | **EG3: `git cat-file --batch` único** | easy gain documentado |
| `git.diffTexts` (via `collectEntries`) | **O(n) spawns + O(n) tmpdirs** (mkdtemp+2 writes+`git diff --no-index`+rm por arquivo M/R) | **EG1: 1 `git diff -U0` global parseado** | **✔ IMPLEMENTADO** |
| `git.worktreeHash` | O(diff total + untracked lidos) ×2 por rodada | semântico (detecção de sujeira) | não mexer |
| `sanitize.stripLiterals` | O(L) char a char | V8 rope; sanitização já em lote no lizardBatch | não mexer |
| `gates/fast.batchFastGates` | O(n) gates puros + **O(n/C400) spawns lizard** + 1 spawn dart format/chunk | P0 ✔ | ok |
| `gates/fast.formatGate` (unitário, hooks 1 arquivo) | O(1) spawn stdin | caminho de 1 arquivo | ok |
| `risk.classifyRisk` | O(n·R) com regexes pré-compiladas | **EG2: `netIncrease` compilava `new RegExp` por arquivo** | **✔ IMPLEMENTADO** |
| `risk.runsPerDay`/`cronExprs` | O(linhas + campos) | guard `SCHEDULE_LINE` antes do matchAll ✔ | ok |
| `cost-job.*` | O(comandos) com FLAG_CACHE ✔ | — | ok |
| `state.loadSession/findEvidence/recordEvidence` | O(1) I/O, O(E) scan | E pequeno (prune 7 dias ✔) | ok |
| `report.renderResults` | O(r log r) sort | r = resultados | ok |
| `messages.t` | O(1) catálogo em memória ✔ | — | ok |
| `env.harnessEnv` | O(1) | — | ok |
| `tiers.runTier` (P1) | O(g) subprocessos em paralelo; custo = grupo mais lento | g = grupos ativos | ok |

## Por evento de hook (custo por edição/busca/commit)

| Hook | Big O | Status |
|---|---|---|
| `post-edit` → `rapidoGates(1 arquivo)` | O(1) spawn por gate do arquivo (caminho unitário) | ok |
| `pre-bash` (dispatch/gitflow) | O(1) leituras + 1 classifyRisk O(n·R) quando há commit | ok |
| `session-start` | O(state) — lembretes + inventário | ok |
| `anti-loop` | O(1) memória | ok |
| `search-guard`/`shell-search` | O(1)-O(comando) por busca | ok |

## Caminho frio (entrega, relatório, tracker — one-shot ou rede)

| Módulo | Big O | Observação |
|---|---|---|
| `relatorio.runRelatorio` | O(camadas × runners) spawns + leitura de todos os .dart p/ fallback (O(n·L)) | frio, explícito; aceitável |
| `delivery/backlog` | O(tarefas) JSON local | ok |
| `tracker/sync-context` | O(tarefas) + rede Jira por card | rede domina; fora do escopo local |
| `delivery/test-hygiene` | O(testes × checks) | ok |
| `harness-init` | O(arquivos copiados) one-shot | ok |
| `autofix` | O(arquivos) × ferramenta | ok |
| `gitflow/versioning/release-flow` | O(1)-O(branch) + git | ok |

## Easy gains

### EG1 ✔ IMPLEMENTADO — `collectEntries` sem spawn por arquivo
`git.mjs`: `diffTexts` rodava **mkdtemp + 2 writes + `git diff --no-index` + rmSync por arquivo modificado** (O(n) spawns de processo + O(n) tmpdirs por rodada de gates — tier rápido, hooks de edição e Stop pagam isso). Agora `collectEntries` faz **1 `git diff -U0 --no-color` global**, parseia as seções `diff --git`/`@@` uma vez e distribui `added`/`removed` por caminho (Map); A/untracked e D continuam pelos caminhos de split sem spawn; fallback para `diffTexts` só em caso de seção ausente. Ganho: 2n spawns → ~2 spawns por rodada + O(n) parse em memória.

### EG2 ✔ IMPLEMENTADO — regex de `netIncrease` pré-compilada
`risk.costRuleSignals` compilava `new RegExp(re)` para cada regra `netIncrease` **por arquivo** do diff. Agora compila uma vez no load (mesmo padrão de `REGRAS_COST.regexes`).

### EG3 (documentado, não implementado) — `fileAtRev` em batch
`git show rev:path` por arquivo M/R continua O(n) spawns. `git cat-file --batch` (1 processo, stdin com `rev:path` por linha) derruba para 1 spawn; médio risco (protocolo de saída com tamanho em bytes) — implementar só se profiling de monorepo grande apontar o I/O como dominante.

## O que NÃO é easy gain (medido ou semântico)

- Parsers dos runners por stack: O(n) linear e <300 ms em 50k (sessão anterior).
- `stripLiterals` char a char: V8 otimiza; sanitização já paga só 2 spawns por chunk no lote.
- `worktreeHash`: ler untracked é semântica do hash anti-sujeira.
- `layerOf` linear em camadas: 1,3 ms/5k — cache de RegExp já existe no glob.
- Boot do motor (126-313 ms): imports Node, não é código do harness.
