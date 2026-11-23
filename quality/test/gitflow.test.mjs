// Testes da política Gitflow pura (quality/lib/gitflow.mjs): taxonomia, branch pai,
// matriz de merge, push/pull/commit/rebase e o parser de comandos git.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyBranch, createDecision, mergeDecision, pushDecision, pullDecision,
  rebaseDecision, resetDecision, branchDeleteDecision, parseGitOps,
} from '../lib/gitflow.mjs';

const denied = (d, keyRx) => { assert.equal(d.decision, 'deny'); if (keyRx) assert.match(d.key, keyRx); };
const ok = (d) => assert.deepEqual(d.ok, true);

test('taxonomia: classifica permanentes, tipos e versão de release', () => {
  assert.equal(classifyBranch('main').type, 'permanent');
  assert.equal(classifyBranch('develop').type, 'permanent');
  assert.equal(classifyBranch('feat/pulso/mapa').kind, 'feat');
  assert.equal(classifyBranch('fix/cnpj').kind, 'fix');
  assert.equal(classifyBranch('chore/deps').kind, 'chore');
  assert.equal(classifyBranch('hotfix/app-review').kind, 'hotfix');
  assert.equal(classifyBranch('release/1.4.0').versionOk, true);
  assert.equal(classifyBranch('release/1.4.0-beta.1').versionOk, true);
  assert.equal(classifyBranch('release/onibus-piloto').versionOk, false);
  assert.equal(classifyBranch('etl-dados-eleitorais').type, 'fora');
});

test('criação: pai correta por tipo, versão obrigatória em release', () => {
  ok(createDecision('feat/x', 'develop', null));
  denied(createDecision('feat/x', 'main', null), /wrongParent/);
  ok(createDecision('feat/x', 'main', 'origin/develop')); // startPoint explícito aponta o pai
  denied(createDecision('hotfix/x', 'develop', null), /wrongParent/);
  ok(createDecision('hotfix/x', 'main', null));
  ok(createDecision('release/1.4.0', 'develop', null));
  denied(createDecision('release/nome', 'develop', null), /releaseVersion/);
  denied(createDecision('release/1.4.0', 'main', null), /wrongParent/);
  denied(createDecision('docs/x', 'develop', null), /taxonomy/);
  denied(createDecision('develop', 'develop', null), /taxonomy/);
});

test('matriz de merge: develop ⇄ trabalho; main só release/hotfix; backmerges', () => {
  ok(mergeDecision('develop', 'feat/x'));
  ok(mergeDecision('feat/x', 'develop'));
  ok(mergeDecision('develop', 'release/1.4.0')); // backmerge da versão
  ok(mergeDecision('develop', 'hotfix/x')); // backmerge do hotfix
  ok(mergeDecision('main', 'release/1.4.0'));
  ok(mergeDecision('main', 'hotfix/x'));
  ok(mergeDecision('release/1.4.0', 'fix/a'));
  denied(mergeDecision('main', 'feat/x'), /mainWork/);
  denied(mergeDecision('develop', 'main'), /mainToDevelop/);
  denied(mergeDecision('develop', 'etl-x'), /developTaxonomy/);
  denied(mergeDecision('feat/a', 'feat/b'), /featureCross/);
  denied(mergeDecision('feat/a', 'main'), /featureCross/);
  denied(mergeDecision('hotfix/a', 'develop'), /hotfixBase/);
  denied(mergeDecision('release/1.4.0', 'feat/a'), /releaseBase/);
});

// PART2_MARKER

test('push: main proibido, develop só com merge commit, força e delete', () => {
  denied(pushDecision({ target: 'main' }), /push\.main/);
  denied(pushDecision({ target: 'develop', currentIsMergeCommit: false }), /developDirect/);
  ok(pushDecision({ target: 'develop', currentIsMergeCommit: true }));
  denied(pushDecision({ target: 'feat/x', force: true }), /push\.force/);
  ok(pushDecision({ target: 'feat/x', forceWithLease: true }));
  denied(pushDecision({ target: 'develop', forceWithLease: true }), /forceProtected/);
  denied(pushDecision({ target: 'release/1.4.0', force: true }), /forceProtected/);
  denied(pushDecision({ target: 'main', deleting: true }), /delete\.protected/);
  ok(pushDecision({ target: 'feat/x', deleting: true, targetMerged: true }));
  assert.equal(pushDecision({ target: 'feat/x', deleting: true, targetMerged: false }).decision, 'ask');
});

test('pull exige rebase em branch de trabalho; rebase/reset não tocam permanentes', () => {
  denied(pullDecision('feat/x', false), /pull\.rebase/);
  ok(pullDecision('feat/x', true));
  ok(pullDecision('develop', false));
  ok(pullDecision('hotfix/x', false));
  denied(rebaseDecision('develop'), /rebase\.protected/);
  ok(rebaseDecision('feat/x'));
  denied(resetDecision('main', true), /reset\.protected/);
  ok(resetDecision('feat/x', true));
  ok(resetDecision('develop', false));
  denied(branchDeleteDecision('develop'), /delete\.protected/);
  ok(branchDeleteDecision('feat/x'));
});

test('parser: ops principais de comandos comuns', () => {
  assert.deepEqual(parseGitOps('git switch -c feat/x'), [{ op: 'switch', mutating: true, create: true, branch: 'feat/x', startPoint: null }]);
  const [ck] = parseGitOps('git checkout -b fix/y origin/develop');
  assert.equal(ck.branch, 'fix/y');
  assert.equal(ck.startPoint, 'origin/develop');
  assert.deepEqual(parseGitOps('git merge origin/develop'), [{ op: 'merge', mutating: true, source: 'develop' }]);
  assert.deepEqual(parseGitOps('git push origin feat/x')[0].targets, [{ branch: 'feat/x', deleting: false }]);
  assert.deepEqual(parseGitOps('git push origin HEAD:main')[0].targets, [{ branch: 'main', deleting: false }]);
  assert.equal(parseGitOps('git push --force origin feat/x')[0].force, true);
  assert.deepEqual(parseGitOps('git push origin --delete feat/x')[0].targets, [{ branch: 'feat/x', deleting: true }]);
  assert.deepEqual(parseGitOps('git push origin :feat/velha')[0].targets, [{ branch: 'feat/velha', deleting: true }]);
  assert.equal(parseGitOps('git push --dry-run origin main').length, 0);
  assert.equal(parseGitOps('git pull --rebase origin feat/x')[0].rebase, true);
  assert.deepEqual(parseGitOps('git rebase origin/develop'), [{ op: 'rebase', mutating: true }]);
  assert.equal(parseGitOps('git rebase --continue')[0].resolver, true);
  assert.equal(parseGitOps('git reset --hard HEAD~1')[0].hard, true);
  assert.equal(parseGitOps('git branch -D feat/x')[0].op, 'branch-delete');
  const [ad] = parseGitOps('git add lib/a.dart');
  assert.deepEqual([ad.op, ad.resolver], ['add', true]);
  assert.equal(parseGitOps('git merge --abort')[0].resolver, true);
});

test('parser: sem falsos positivos em help, heredoc, strings e comandos aninhados', () => {
  assert.equal(parseGitOps('git commit --help').length, 0);
  assert.equal(parseGitOps('git switch --help').length, 0);
  assert.equal(parseGitOps('cat > notes.md <<EOF\ngit push origin main\nEOF').length, 0);
  assert.deepEqual(parseGitOps('git commit -m "a; git push; firebase deploy"').map((o) => o.op), ['commit']);
  assert.deepEqual(parseGitOps('git status && git diff HEAD').length, 0);
  assert.deepEqual(parseGitOps('bash -c "git commit -m x"').map((o) => o.op), ['commit']);
  assert.deepEqual(parseGitOps('rtk git push origin HEAD').map((o) => o.op), ['push']);
  assert.deepEqual(parseGitOps('GIT_EDITOR=true git commit').map((o) => o.op), ['commit']);
  assert.deepEqual(parseGitOps('git -C backend commit -am x').map((o) => o.op), ['commit']);
  assert.deepEqual(parseGitOps('echo "git push"').length, 0);
});
