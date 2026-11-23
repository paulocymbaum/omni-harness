---
name: gitflow
description: Gitflow determinístico do Fluxo na camada do agente (harness). Mapeia feat, fix, chore, hotfix e release com branch pai correta, matriz de merges (develop ⇄ trabalho, release → main via pipeline), push/pull com sincronização obrigatória do remote e runbook de conflitos. Use antes de criar branches, mesclar, puxar, publicar ou resolver conflitos git; os hooks quality/hooks/pre-bash-gitflow.mjs e post-bash-gitflow.mjs bloqueiam desvios com mensagens acionáveis em pt-BR.
allowed-tools: Bash(git status *), Bash(git log *), Bash(git diff *), Bash(git branch *), Read, Grep
---

# Gitflow do Fluxo (harness do agente)

O repositório é **compartilhado**: todo push é observado por outras pessoas e pela pipeline. O fluxo é garantido por hooks determinísticos, não pela memória do agente — se um hook bloquear, leia o motivo e siga a receita da mensagem; nunca tente contornar.

## Fluxo canônico

```
MAIN → DEVELOP → FEAT ⇄ DEVELOP (versão) → RELEASE (PIPELINE) → MAIN
```

## Mapa dos casos

| Tipo | Nasce de (pai) | Volta para | Nome | Commit direto | Exemplo |
|---|---|---|---|---|---|
| `feat/` | develop | develop | `feat/<slug>` | não (só via merge em develop) | `feat/mapa-caronas` |
| `fix/` | develop | develop | `fix/<slug>` | não | `fix/cnpj-mascara` |
| `chore/` | develop | develop | `chore/<slug>` | não | `chore/deps` |
| `hotfix/` | main | main + develop (backmerge) | `hotfix/<slug>` | sim (estabilização) | `hotfix/app-review` |
| `release/` | develop | main (pipeline) + develop (backmerge) | `release/x.y.z[-sufixo]` | sim, via fix/ e hotfix/ | `release/1.4.0-beta.1` |

`main` e `develop` são permanentes: nenhum push de commit simples, nenhum rebase/reset --hard, nenhum delete.

## Regras por comando (o que os hooks bloqueiam)

- **Criação** (`git switch -c` / `git checkout -b`): taxonomia obrigatória; branch pai correta; pai sincronizada com origin (`git pull --ff-only` antes); startPoint explícito (ex.: `origin/develop`) é aceito.
- **Merge**: matriz de direção. Bloqueia main ← feat/fix/chore/develop; develop ← main ou branch fora da taxonomia; trabalho ← trabalho/main; hotfix ← develop; release ← develop/feat/main.
- **Commit**: negado em main e develop (develop recebe apenas merges — o push em develop exige merge commit no HEAD).
- **Pull**: em feat/fix/chore exige `--rebase` (história linear).
- **Push**: main negado (quem publica main é a pipeline da release); develop só com merge commit; sincroniza com origin antes (atrás → `git pull --rebase origin <branch>`; divergido → rebase + resolver conflitos + publicar); `--force` negado (após rebase use `--force-with-lease`, nunca em main/develop/release); delete de main/develop negado; delete de branch não mesclada em develop pede confirmação.
- **Rebase / reset --hard**: apenas em branches de trabalho.
- **Remote inacessível**: o hook pede confirmação humana (`ask`) em vez de deixar operar sem sync.

## Conflitos (runbook automático)

Detectado um conflito após um comando, o hook `post-bash-gitflow` **para o fluxo** (decision block) com:
- arquivos em conflito (`git diff --name-only --diff-filter=U`);
- passos: `git status` → resolver blocos `<<<<<<< ======= >>>>>>>` (contexto de cada lado: `git log --merge -p <arquivo>`) → `git add <arquivos>` → conclusão → publicar;
- conclusão por operação: merge → `git commit`; rebase → `git rebase --continue` (+ `git push --force-with-lease`); cherry-pick → `git cherry-pick --continue`;
- abandono: `git merge --abort` / `git rebase --abort` / `git cherry-pick --abort`.

Enquanto houver conflito não resolvido, o `pre-bash-gitflow` nega qualquer comando git que não seja de resolução.

## Receitas

```bash
# Feature (FEAT ⇄ DEVELOP)
git switch develop && git pull --ff-only && git switch -c feat/<slug>
# … trabalho, commits …
git push -u origin feat/<slug>                 # publica a branch de trabalho
git switch develop && git merge feat/<slug> && git push origin develop

# Correção em produção (hotfix: main → main + develop)
git switch main && git pull --ff-only && git switch -c hotfix/<slug>
# … correção …
git push -u origin hotfix/<slug>               # merge em main via PR/patch
git switch develop && git merge hotfix/<slug> && git push origin develop  # backmerge

# Release (develop → RELEASE → PIPELINE → MAIN, com backmerge da versão)
git switch develop && git pull --ff-only && git switch -c release/1.4.0
git push -u origin release/1.4.0               # dispara a pipeline
# estabilização: apenas fix/ e hotfix/ entram na release
```

## Versionamento por camada (bump determinístico)

Cada camada de `quality/config/layers.json` tem versão própria, salva como **tag `<camada>@vX.Y.Z`** criada na branch release e propagada para main e develop pelos merges. O bump é determinístico por commits convencionais desde a última tag **daquela camada**: `BREAKING CHANGE` (footer ou `!`) → major; `feat` → minor; qualquer outro commit que toque a camada → patch. Camada sem tag usa a versão do manifest (`pubspec.yaml`, `package.json` de admin-web/site/debate-worker/creator-worker/creator-render/functions, `<Version>` em `backend/Directory.Build.props`) e, sem manifest, parte de `0.1.0`. O sufixo `+build` do pubspec é preservado entre bumps.

```bash
npm run version:bump                 # plano (dry run) por camada
npm run version:bump -- --apply      # na release/*: grava manifests, commit e tags
npm run version:bump -- --init       # primeira vez: tags de baseline (versão atual de cada manifest) nas camadas sem tag
npm run version:bump -- --next site  # versão que a camada terá no próximo apply (usada pelos builds)
npm run version:bump -- --check      # tags alcançáveis em main, develop e release + manifests sincronizados (exit 2 se violar)
```

- **Produção:** o workflow `.github/workflows/release-tag.yml` roda a cada push em `RELEASE` (branch longa que dispara os deploys): `--init` na primeira vez, `--apply` depois, push de commits e tags, GitHub Release por tag nova. Requer que a proteção de `RELEASE` aceite push do `github-actions[bot]`; o merge para `main` é opt-in (variável de repositório `RELEASE_MERGE_MAIN=true`).
- `--apply` e `--init` exigem branch `release/*` ou `RELEASE` e árvore limpa; cria `chore(release): <camada>@vX.Y.Z` para camadas com manifest e a tag anotada.
- A cada apply o CLI também regenera `ofluxo_site/public/versions.json` (derivado das tags, ignorado nos ranges de bump): por ambiente (prod ← main, hml ← RELEASE, dev ← develop), `front` (web/ios/android) e `backend` (api/funções/dados). O rodapé de versões que lia esse arquivo saiu do menu do app em 06/11/2026, a pedido do produto; o widget `lib/shared/widgets/menu_versions_footer.dart` continua no código, sem uso. O arquivo pode ser regenerado com `npm run version:bump -- --versions`.
- Depois do apply: merge da release em main (pipeline) + backmerge em develop, então `--check` tem que passar.
- **Sem saldo no Actions (ou para rodar na hora):** `node scripts/deploy/local/release-bump.mjs [--dry-run] [--no-main]` é o gêmeo local do `release-tag.yml`. Cria `release/x.y.z` a partir de `origin/develop` (maior versão-alvo entre as camadas), roda o gate completo, aplica o bump, publica a branch e as tags de forma atômica e abre/mergeia os PRs para `RELEASE` e `develop` e `main` (o RELEASE → main não roda no Actions; `--no-main` pula). Idempotente: se a release já foi publicada, retoma da propagação da mais recente por data de commit. Nunca commita direto em `RELEASE`/`main`/`develop`.
- **Deploy nunca sai com versão pendente:** `release.mjs --run deploy-*` recusa enquanto `bump.mjs` tiver plano não vazio; rode antes `node scripts/deploy/release.mjs --run versionar --local`.
- `--check` valida cada tag em `main`, `develop` e na release pela ref **local ou `origin/`** (a que estiver à frente): clone sem checkout de `main` não acusa falta.
- Política pura: `quality/lib/versioning.mjs`; testes: `node --test quality/test/version.test.mjs quality/test/version-flow.test.mjs`.

## Onde está implementado

| Peça | Arquivo |
|---|---|
| Política pura (taxonomia, matriz, decisões, parser) | [quality/lib/gitflow.mjs](../../../quality/lib/gitflow.mjs) |
| Versionamento por camada (bump determinístico) | [quality/lib/versioning.mjs](../../../quality/lib/versioning.mjs) e [quality/version/bump.mjs](../../../quality/version/bump.mjs) |
| Estado git (branch atual, conflito, sync origin) | [quality/lib/gitstate.mjs](../../../quality/lib/gitstate.mjs) |
| Hook `PreToolUse` (Bash) | [quality/hooks/pre-bash-gitflow.mjs](../../../quality/hooks/pre-bash-gitflow.mjs) |
| Hook `PostToolUse` (Bash) — para no conflito | [quality/hooks/post-bash-gitflow.mjs](../../../quality/hooks/post-bash-gitflow.mjs) |
| Registro dos hooks | [.claude/settings.json](../../settings.json) |
| Mensagens pt-BR | `quality/messages.pt-BR.json` (prefixo `gitflow.`) |
| Testes | `node --test quality/test/gitflow.test.mjs quality/test/gitflow-hooks.test.mjs` |
