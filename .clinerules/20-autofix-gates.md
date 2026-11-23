<!-- GERADO por quality/agents/sync-clinerules.mjs a partir de .claude/rules/autofix-gates.md. Não edite aqui. -->

# Regra de autocorreção e lint em código de gate e teste

Aplicada em toda sessão. Detalhe técnico: QUALITY.md §9.1. Código: `quality/lib/autofix.mjs`.

## O que o hook faz sozinho (você não precisa rodar nada)

A cada edição de arquivo de gate ou teste (`quality/**/*.mjs`, `.claude/hooks/**`, `scripts/tracker/**`, JSON de `quality/`, `test/**/*_test.dart`) o `post-edit` normaliza EOL/newline final, aplica `dart format` e correções seguras do Biome, e checa sintaxe e lint. Em lote: `node quality/run.mjs --fix` (o pre-commit também roda).

No Cline o mesmo `post-edit` roda em `.clinerules/hooks/PostToolUse` → `quality/hooks/cline-post-tool-use.mjs` via `quality/lib/cline-bridge.mjs` (ferramentas `editor`, `write_to_file`, `replace_in_file`, `apply_patch`). O Cline ignora cancelamento no PostToolUse, então o erro volta como `contextModification` (texto igual ao do exit 2 do Claude). Trate-o da mesma forma: edite o arquivo. A extensão VS Code do Cline exige "Enable Hooks".

## Quando ele bloquear (exit 2 no Claude; mensagem de contexto no Cline)

1. Leia `arquivo:linha:col` da mensagem e **edite o arquivo**. Sintaxe nunca é reescrita pelo hook.
2. **Não contorne**: nada de `biome-ignore`, `eslint-disable`, `FLUXO_AUTOFIX=0`, `--no-verify` nem apagar a regra em `quality/tools/biome.json`.
3. Import não usado **não** é removido sozinho (pode ter efeito colateral): remova você, ou use-o.
4. Lint só bloqueia erro **novo** frente ao HEAD; erro legado não é seu para consertar nesta tarefa.
5. Depois de 3 falhas seguidas no mesmo arquivo o hook para de bloquear e avisa: **relate ao usuário** em vez de insistir.

## Erros que já aconteceram (não repita)

- **Falha de ferramenta lida como "limpo".** Config inválida do Biome saía com código ≠ 0 e zero diagnóstico, e o `--fix` dizia "sem pendências". Ao mexer em `quality/tools/biome.json` ou no `autofix.mjs`, confirme com um arquivo que **tem** erro conhecido que o lint ainda pega (`quality/test/autofix.test.mjs`). Chave de config: `recommended` fica dentro de `linter.rules`, e `preset` não existe.
- **Nunca `git stash -u -- <arquivo>`** para "comparar com o HEAD": ele guarda o arquivo novo e some com o seu trabalho. Compare com `git show HEAD:<arquivo>` ou um repo temporário (`tempRepo` em `quality/test/helpers.mjs`).
- **Teste de gate que falha não é prova de regressão sua.** Antes de concluir, rode o arquivo isolado (`node --test <arquivo>`) e confira se a falha vem do que você tocou. Os `quality/test/delivery/*.test.mjs` de outras entregas (`bil-*`, `dv-*`, `fc-*`) checam código de produto da branch e falham fora do seu escopo; relate, não conserte.
- **`node --test quality/test/delivery/*.test.mjs` passa de 120 s.** Rode por arquivo (regra `comandos-curtos.md`).
- **Biome ausente** (`quality/tools/node_modules`): o lint é pulado com aviso. Instale com `cd quality/tools && npm install`; não trate o aviso como aprovação do lint.
- **`?.` (optional chaining) funde funções no lizard.** O parser dessincroniza em `?.` e agrega tudo num único "blob" de complexidade (custou 4 iterações no QG-022/024). Em `quality/lib` e `scripts`, use forma explícita (`a && a.b`, `a != null && a.b`) — ver comentário em `scripts/deploy/gh-actions.mjs`.
- **Desestruturação conta 1 parâmetro por propriedade no lizard**: `function f({ a, b, c, d, e, f })` = 6 params (alerta). Receba o objeto (`opts`) e acesse os campos, ou desestruture ≤ 5.
- **Loop de sufixo infinito em `uniqueReleaseBranch`**: `exists = () => true` com `liberada` sempre false nunca retorna. Em teste, simule o remoto finito (`existe` só para os nomes reais).
