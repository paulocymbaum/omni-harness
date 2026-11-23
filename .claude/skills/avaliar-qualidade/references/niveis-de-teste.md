# Níveis de teste

Cada nível inclui o anterior e só roda nas camadas e pacotes tocados. Os limites vêm de `quality/config/thresholds.json`, que espelha a QUALITY.md §3.

## Rápido (iteração; automático a cada edição)

Orçamento: menos de 3 s por arquivo. Todos os gates comparam com a versão do **HEAD**, então código legado não reprova sozinho.

| Gate | Regra |
|---|---|
| tamanho | Arquivo novo ≤ 400 linhas não vazias; legado acima de 400 não pode crescer (tolerância de +20 → ALERTA) |
| complexidade | Função nova com CC > 20 (C#/Python > 15) reprova; entre 10 e 20 → ALERTA; legada só reprova se piorar além de +2 acima do teto |
| tamanho-funcao | Função nova > 120 linhas reprova; > 60 → ALERTA |
| parametros | > 5 parâmetros → ALERTA |
| formato | Arquivo Dart formatado no HEAD que deixa de estar → REPROVADO (`dart format`) |
| fronteiras | `domain` sem Firebase, Flutter (exceto `foundation`), `data` ou `presentation`; `data` sem `presentation`; `shared`/`core` sem `features`; router do OCR sem `ocr`/`scraper`/`structurer`/SDKs pesados; `admin-web` sem `firebase/firestore`. Só imports **novos** |
| supressoes | Diretiva nova (`// ignore:`, `eslint-disable`, `@ts-ignore`…) → ALERTA para justificar |
| fallback-api | Novo `API fallback to Firestore` no app → REPROVADO |
| exports | Export removido de `functions/src/index.ts` → ALERTA (e risco crítico) |

A complexidade é medida pelo lizard (via `uvx`), sobre o código sem conteúdo de strings e regex, para não confundir aspas com código.

## Rotina (ao concluir uma entrega)

Orçamento: cerca de 3 min.

| Stack | O que roda |
|---|---|
| Flutter | `dart analyze` nos arquivos alterados (erro sempre reprova; aviso só nas linhas alteradas) + `flutter test` das features tocadas; feature sem teste → ALERTA |
| functions | `tsc --noEmit` (erros nos arquivos tocados reprovam) + build num diretório temporário (`functions/lib` é versionado) + `node --test` dos testes que importam os módulos alterados |
| OCR | `pnpm build` dos pacotes (se algum pacote mudou) + `tsc` e `vitest related` por pacote + `pytest` do validador Python |
| admin-web / site | `eslint` (erro reprova; aviso só nas linhas alteradas) + `vitest related` |
| backend | `dotnet build -warnaserror` + `dotnet test` sem integração PostgreSQL; sem dotnet → delegado ao `backend-ci.yml` |
| regras | Delegado ao CI se não houver firebase CLI + JDK |

## Completo (só risco alto ou crítico)

Orçamento: até 30 min.

| Stack | Além da rotina |
|---|---|
| Flutter | Suíte completa com cobertura + **cobertura do diff ≥ 80 %** (arquivo que nenhum teste carrega → ALERTA) |
| functions | Suíte unitária completa |
| OCR | Todos os pacotes + varredura completa do router |
| web | `vitest run` completo |
| backend | Integração PostgreSQL e migrator: delegados ao CI |
| dependências | `osv-scanner` se algum lockfile ou manifesto mudou |

## Quando algo não roda

Ferramenta ausente, dependências não instaladas, tempo esgotado ou execução delegada ao CI viram **ALERTA** com o motivo. Nunca viram APROVADO. Reporte isso ao usuário.

## Modo migração (`--migration-override`)

Para merge completo ou migração completa, onde todo o código chega como "novo" em
relação à base, os gates de métrica incremental viram falso positivo estrutural
(eles medem piora incremental, não sanidade do código que chega). Com
`node quality/run.mjs --tier <nível> --base <ref> --migration-override [motivo]`:

| Gate | Efeito no modo migração |
|---|---|
| tamanho, tamanho-funcao, parametros, complexidade, halstead-volume, halstead-difficulty, formato, supressoes, fronteiras, fallback-api, lint, cobertura-diff | resultados substituídos por um **IGNORADO** por gate, com motivo e contagem do suprimido |
| tipos, testes, exports, ferramentas | **permanecem ativos** (nunca são ignorados) |
| ratchet global | `node quality/baseline.mjs --check --migration-override [motivo]` devolve IGNORADO e exit 0; o baseline não é alterado |

A evidência registra o modo e o motivo; o `--json` inclui `migration.{reason,ignoredGates}`.
Use somente sob pedido explícito, para o caso de merge/migração completa — nunca
para validar trabalho incremental.
