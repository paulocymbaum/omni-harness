# Regra de branches — nunca trabalhar em main, release ou develop

Aplicada em toda sessão (Claude Code, Cline e demais agentes). Detalhe e receitas: skill `gitflow`. Os hooks `quality/hooks/pre-bash-gitflow.mjs` e `post-bash-gitflow.mjs` bloqueiam parte disto; a regra vale mesmo onde o hook não alcança.

## Regra

1. **Jamais edite, commite, faça rebase/reset ou corrija direto em `main`, `release` (`RELEASE`, `release/*`) ou `develop`.** Essas branches só recebem merge, pelo fluxo do Gitflow.
2. **Antes da primeira edição**, rode `git branch --show-current`. Se estiver em uma das três, **pare e troque** para a branch de trabalho correta; não edite "só para ver" nem planeje commitar depois.
3. **Crie a branch certa, com o pai certo**, sincronizado com o origin (`git pull --ff-only` antes):

   | Trabalho | Branch | Nasce de | Volta para |
   |---|---|---|---|
   | feature | `feat/<slug>` | `develop` | `develop` |
   | correção | `fix/<slug>` | `develop` | `develop` |
   | manutenção, deploy registrado, docs | `chore/<slug>` | `develop` | `develop` |
   | produção urgente | `hotfix/<slug>` | `main` | `main` + `develop` (backmerge) |
   | estabilização de uma release | `fix/<slug>` ou `hotfix/<slug>` | conforme a skill `gitflow` | a release |

4. **Merge só na direção da matriz da skill `gitflow`.** `main` é publicada pela release (`release/x.y.z → main`); nunca por commit ou push seu. A release propaga para `RELEASE`, `main` e `develop` pelo gêmeo local (`release-bump.mjs`) — com `GH_ACTIONS=false` (default), por **merge local**; com Actions ligado, por PR.
5. **`RELEASE` é permanente (QG-025):** push sem merge-commit no head é negado com o comando de retomada (`release-bump.mjs`). **Não crie `release/x.y.z-N` na mão**: o gêmeo recicla o nome da release anterior quando ela está 100% propagada; sufixo `-N` só existe com propagação pendente.
6. **Propagação quebrou no meio?** Rode `node scripts/deploy/local/release-bump.mjs` de novo — é idempotente e diz quais destinos ficaram pendentes.
7. **Entrega gerenciada (`backlog.json`)** também roda em branch de trabalho: use a `feat/` da entrega, nunca a release.
8. **Se o repositório já estiver numa dessas três com mudanças pendentes**, não commite lá: crie a branch de trabalho a partir do estado atual (`git switch -c fix/<slug>`), commite nela e siga o merge normal. Conte ao usuário o que encontrou.
9. **Deploy não é exceção.** Registro de deploy (`deploy.md`) e correção publicada saem da branch de trabalho; quem leva à release é o merge, não um commit direto.
10. **Hook bloqueou? Corrija a causa**, não contorne (`--no-verify`, `git -c`, trocar de branch só para driblar). Sem permissão clara para a ação, pergunte ao usuário.

## Erro que já aconteceu (não repita)

- Uma correção do Creator e o registro do seu deploy foram commitados **direto na `RELEASE`** (`f6f179b7`, `25a4cc44`) e o remoto recebeu o push logo em seguida. A sessão não conferiu a branch antes de editar. Sempre `git branch --show-current` antes do primeiro `Edit`.
