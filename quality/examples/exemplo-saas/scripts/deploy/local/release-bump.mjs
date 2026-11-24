#!/usr/bin/env node
// Bump de versão por camada SEM GitHub Actions: gêmeo local do workflow release-tag.yml.
// Exemplo SaaS (SKILL gitflow): develop → release/x.y.z (bump + tags) → PR/merge em RELEASE, main e develop.
// Nada de commit direto em RELEASE/main/develop: o bump nasce numa release/*, como manda a regra de branches.
//
//   node scripts/deploy/local/release-bump.mjs [--dry-run] [--no-main] [--skip-propagate]
//     --dry-run         só mostra o plano (não cria branch, tag, push nem PR)
//     --no-main         não propaga para a main (padrão: propaga; o RELEASE → main não roda no Actions)
//     --skip-propagate  cria e publica a release/* com as tags, sem abrir PRs
//
// Idempotente: se a release/* já foi publicada, retoma da propagação. Antes de publicar roda o gate
// completo (o mesmo que o hook de push exige) — não há atalho em volta dele.
import { spawnSync } from 'node:child_process';

import { PROPAGATE_TO, estrategiaPropagacao, newTags, newestReleaseBranch, pendingTargets, releaseBranchFor, tagRefs, uniqueReleaseBranch } from '../../../quality/lib/release-flow.mjs';
import { GH_ACTIONS_ENABLED } from '../gh-actions.mjs';

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
// RELEASE → main não roda no Actions: o script local é o caminho. `--no-main` é a exceção explícita.
const withMain = !args.has('--no-main');
const skipPropagate = args.has('--skip-propagate');

/** Papel de cada destino no título do merge (grafo legível: publicação, produção, backmerge). */
const PAPEL_DO_DESTINO = { RELEASE: 'publicação', main: 'produção', develop: 'backmerge' };

/** Versão no nome `release/x.y.z[-N]`; devolve a branch inteira se o padrão não casar. */
function versaoDaBranch(branch) {
  const m = /release\/(\d+\.\d+\.\d+(?:-\d+)?)/.exec(branch);
  return m ? m[1] : branch;
}

const sh = (cmd, argv, opts = {}) => spawnSync(cmd, argv, { encoding: 'utf8', ...opts });
const git = (...argv) => sh('git', argv);
const out = (r) => (r.stdout ?? '').trim();
const die = (message) => {
  process.stderr.write(`✗ ${message}\n`);
  process.exit(1);
};
const step = (message) => process.stdout.write(`→ ${message}\n`);

function must(r, what) {
  if (r.status !== 0) die(`${what}: ${(r.stderr || r.stdout || '').trim().split('\n').slice(-3).join(' | ')}`);
  return out(r);
}

/** Como must, mas lança (a propagação captura e imprime o comando de retomada — QG-025). */
function exige(r, what) {
  if (r.status !== 0) throw new Error(`${what}: ${(r.stderr || r.stdout || '').trim().split('\n').slice(-3).join(' | ')}`);
  return out(r);
}

function plan() {
  // O plano conta contra origin/develop (a origem da release), NÃO contra a branch de pé na
  // máquina: rodar o gêmeo local a partir de main/RELEASE não pode esconder o pendente de develop.
  const r = sh('node', ['quality/version/bump.mjs', '--json', '--head', 'origin/develop']);
  must(r, 'plano de bump');
  return JSON.parse(out(r));
}

/** release/* publicada de maior versão (para retomar a propagação depois de uma falha). */
const publishedRelease = () =>
  newestReleaseBranch(out(git('for-each-ref', '--sort=-committerdate', '--format=%(refname:strip=3)', 'refs/remotes/origin/release/')).split('\n').filter(Boolean).map((n) => `release/${n}`));

const remoteHasBranch = (branch) => out(git('ls-remote', '--heads', 'origin', branch)) !== '';
const contains = (branch) => (target) => git('merge-base', '--is-ancestor', `origin/${branch}`, `origin/${target}`).status === 0;

function runGates() {
  step('gate completo (mesmo nível que o hook de push exige)…');
  const r = sh('node', ['quality/run.mjs', '--tier', 'completo', '--base', 'remote'], { stdio: 'inherit' });
  if (r.status !== 0) die('gate completo reprovado: corrija antes de versionar. Nada foi publicado.');
}

function applyBump(branch) {
  must(git('switch', '-c', branch, 'origin/develop'), `criar ${branch} a partir de origin/develop`);
  const before = out(git('tag', '--list', '*@v*')).split('\n').filter(Boolean);
  step('aplicando o bump (manifests, commits e tags)…');
  must(sh('node', ['quality/version/bump.mjs', '--apply']), 'bump --apply');
  const after = out(git('tag', '--list', '*@v*')).split('\n').filter(Boolean);
  return newTags(before, after);
}

function publish(branch, tags) {
  step(`publicando ${branch} e ${tags.length} tag(s) de forma atômica…`);
  must(git('push', '--atomic', '-u', 'origin', branch, ...tagRefs(tags)), 'push atômico');
}

/**
 * Propagação da release para um destino. Estratégia (QG-024/QG-025):
 *   GH_ACTIONS=true  → PR via gh + merge commit (como o release-tag.yml fazia);
 *   GH_ACTIONS=false → merge local --no-ff direto na branch de destino (mesmo resultado).
 */
function propagate(branch, target) {
  step(`${branch} → ${target}`);
  if (estrategiaPropagacao(GH_ACTIONS_ENABLED) === 'merge-local') return mergeLocal(branch, target);
  const existing = out(sh('gh', ['pr', 'list', '--head', branch, '--base', target, '--state', 'open', '--json', 'number', '--jq', '.[0].number']));
  const number = existing || out(sh('gh', ['pr', 'create', '--base', target, '--head', branch, '--title', `release: ${branch} → ${target} (bump de versões)`,
    '--body', `Bump de versão por camada (\`quality/version/bump.mjs\`). Gerado por scripts/deploy/local/release-bump.mjs.\n\nGate completo local aprovado antes da publicação.`])).split('/').pop();
  if (!number) throw new Error(`não consegui abrir o PR ${branch} → ${target}`);
  exige(sh('gh', ['pr', 'merge', String(number), '--merge']), `merge do PR #${number} em ${target}`);
}

/** Merge local da release na branch de destino — gêmeo do `gh pr merge --merge` (merge commit). */
function mergeLocal(branch, target) {
  exige(git('fetch', 'origin', target), `fetch ${target}`);
  const volta = out(git('branch', '--show-current'));
  exige(git('switch', target), `switch para ${target} (merge local da release)`);
  const papel = PAPEL_DO_DESTINO[target] ?? target;
  const versao = versaoDaBranch(branch);
  const titulo = `release ${versao}: ${papel} em ${target}`;
  exige(git('merge', '--no-ff', `origin/${branch}`, '-m', `${titulo}\n\nBump de versões por camada (quality/version/bump.mjs), propagado por merge local com GH_ACTIONS=false.`), `merge ${branch} → ${target}`);
  exige(git('push', 'origin', target), `push ${target}`);
  if (volta && volta !== target) exige(git('switch', volta), `voltar para ${volta}`);
  process.stdout.write(`  merge local feito: ${branch} → ${target} (${titulo})\n`);
}

/** Escolha da branch da release: plano novo (com reciclagem de nome) ou retomada da última publicada. */
function escolherBranch(rows) {
  const named = releaseBranchFor(rows);
  // Reciclagem (QG-025): release anterior TOTALMENTE propagada libera o mesmo nome — a branch
  // velha é apagada (local + remoto) e a nova recorta de origin/develop. Pendente? Sufixo -2, -3…
  const liberada = (candidate) => pendingTargets(contains(candidate)).length === 0;
  const planned = named ? uniqueReleaseBranch(named, remoteHasBranch, liberada) : null;
  // Plano vazio pode ser release já publicada e ainda não propagada (as tags já existem): retoma dela.
  const resumable = planned ? null : publishedRelease();
  return { planned, liberada, branch: planned ?? resumable };
}

/** Apaga a branch velha (local + remoto) quando o nome vai ser reciclado: conteúdo já em todos os destinos. */
function reciclarSePropagada(branch, planned, liberada) {
  if (!remoteHasBranch(branch) || !planned || !liberada(branch)) {
    if (remoteHasBranch(branch)) step(`${branch} já está publicada: retomando da propagação.`);
    return;
  }
  step(`${branch} no remoto está totalmente propagada: reciclando o nome (delete + recorte de origin/develop).`);
  git('branch', '-D', branch);
  must(git('push', 'origin', '--delete', branch), `apagar ${branch} velha (já propagada em todos os destinos)`);
}

/** Propaga para todos os destinos pendentes; falha acusa o que falta e o comando de retomada. */
function propagarTudo(branch, wanted) {
  const pending = pendingTargets(contains(branch)).filter((t) => wanted.includes(t));
  for (const target of pending) {
    try {
      propagate(branch, target);
    } catch (err) {
      const faltam = pending.slice(pending.indexOf(target));
      die(`propagação falhou (${target}): ${err.message}\n  Destinos ainda pendentes: ${faltam.join(', ')}\n  Retome depois: node scripts/deploy/local/release-bump.mjs (idempotente — retoma da propagação; a release já publicada não é re-publicada)`);
    }
  }
}

function main() {
  must(git('fetch', '--tags', '--force', 'origin'), 'git fetch');
  if (out(git('status', '--porcelain')) !== '') die('árvore suja: commite ou guarde as mudanças antes.');
  const { rows } = plan();
  const { planned, liberada, branch } = escolherBranch(rows);
  if (!branch) {
    process.stdout.write('✓ nada a versionar: todas as camadas já estão com a versão de seus últimos commits.\n');
    return;
  }
  process.stdout.write(`Release ${branch}:\n${rows.map((row) => `  ${row.layer}`).join('\n')}\n`);
  if (dryRun) {
    process.stdout.write('(dry-run) nada foi criado.\n');
    return;
  }
  reciclarSePropagada(branch, planned, liberada);
  if (!remoteHasBranch(branch)) {
    runGates();
    publish(branch, applyBump(branch));
  }
  if (skipPropagate) return;
  propagarTudo(branch, PROPAGATE_TO.filter((t) => withMain || t !== 'main'));
  must(git('fetch', '--tags', '--force', 'origin'), 'git fetch final');
  const check = sh('node', ['quality/version/bump.mjs', '--check'], { stdio: 'inherit' });
  process.stdout.write(check.status === 0 ? '✓ versões e tags em dia.\n' : '! --check ainda acusa pendência (destinos não propagados, ex.: main com --no-main).\n');
}

main();
