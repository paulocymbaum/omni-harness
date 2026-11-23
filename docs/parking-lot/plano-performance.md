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

## F4 — `scanScope` pré-indexado (condicional)

- **Disparo:** só se diffs reais >10k entries aparecerem no uso (hoje: 283 ms em 50k — irrelevante).
- **Como:** 1 passe construindo Map `prefixo-de-camada → entries[]` e cada runner pega do Map; segunda passada só para fontes sem camada.
- **Gates:** <50 ms em 50k; equivalência com `scanScope` atual.
- **Esforço:** baixo; **só entrar na fila quando o disparo ocorrer.**

## Adiados com critério de disparo explícito

| Item | Critério para voltar à fila |
|---|---|
| LSP Dart persistente (P2) | `dart analyze` medido > 3 s no projeto real do hospedeiro (spike de 1 h antes para validar o protocolo do DAS) |
| Caches de toolchain (sccache/ccache/GOFLAGS) | hospedeiro com Go/Rust/C++ em uso contínuo — hoje é doc-only: receita no overlay do perfil (`step()` já aceita `env`) |

## Ordem de execução e orçamento

1. **F5** (ferramenta de bench) — meio de sessão; desbloqueia validação de tudo.
2. **F1** (EG3 cat-file batch) — 1 sessão; último easy gain grande do caminho quente.
3. **F2** (benchmark multi-stack) — baixo esforço; fecha a evidência da paralelização.
4. **F4** (scanScope) — só com disparo. **F3/F6** — adiados com critério.

## Não-planejado (decidido)

- Converter runners para async (o subprocesso por grupo já entrega o paralelismo sem refactor).
- Otimizar boot do motor (126-313 ms = imports Node), `worktreeHash` (semântico), `stripLiterals` (V8 rope, já em lote), parsers por stack (linear e <300 ms).
