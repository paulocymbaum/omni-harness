// Fluxo local de release: nome da branch, tags novas, ref a validar e destinos pendentes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROPAGATE_TO, isLatestLayerTag, latestReleaseBranch, newTags, newestReleaseBranch, pendingTargets, refsToCheck, releaseBranchFor, uniqueReleaseBranch, tagRefs } from '../lib/release-flow.mjs';

const v = (major, minor, patch, build = null) => ({ major, minor, patch, build });

test('releaseBranchFor usa a maior versão-alvo e descarta o +build', () => {
  const rows = [{ layer: 'site', to: v(0, 1, 0) }, { layer: 'flutter', to: v(23, 47, 76, 81) }, { layer: 'backend', to: v(0, 2, 0) }];
  assert.equal(releaseBranchFor(rows), 'release/23.47.76');
});

test('releaseBranchFor com plano vazio ou ausente não inventa release', () => {
  assert.equal(releaseBranchFor([]), null);
  assert.equal(releaseBranchFor(undefined), null);
});

test('releaseBranchFor compara numericamente (0.10.0 > 0.9.0)', () => {
  assert.equal(releaseBranchFor([{ to: v(0, 9, 0) }, { to: v(0, 10, 0) }]), 'release/0.10.0');
});

test('newTags devolve só as tags criadas pelo apply, em ordem', () => {
  assert.deepEqual(newTags(['a@v0.1.0', 'b@v0.1.0'], ['b@v0.1.0', 'b@v0.2.0', 'a@v0.1.0', 'a@v0.2.0']), ['a@v0.2.0', 'b@v0.2.0']);
  assert.deepEqual(newTags(['a@v0.1.0'], ['a@v0.1.0']), []);
});

test('tagRefs monta refs/tags/<tag> para o push atômico', () => {
  assert.deepEqual(tagRefs(['site@v0.1.0']), ['refs/tags/site@v0.1.0']);
});

test('refsToCheck devolve a local e a remota que existirem (a tag vale em qualquer uma)', () => {
  const only = (...names) => (ref) => names.includes(ref);
  assert.deepEqual(refsToCheck('main', only('main', 'origin/main')), ['main', 'origin/main']);
  assert.deepEqual(refsToCheck('main', only('origin/main')), ['origin/main']);
  assert.deepEqual(refsToCheck('main', only('main')), ['main']);
  assert.deepEqual(refsToCheck('main', only()), []);
});

test('pendingTargets lista os destinos que ainda não têm a release, na ordem do fluxo', () => {
  assert.deepEqual(PROPAGATE_TO, ['RELEASE', 'main', 'develop']);
  assert.deepEqual(pendingTargets(() => false), ['RELEASE', 'main', 'develop']);
  assert.deepEqual(pendingTargets((t) => t === 'main'), ['RELEASE', 'develop']);
  assert.deepEqual(pendingTargets(() => true), []);
});

test('latestReleaseBranch escolhe a maior release e ignora nomes fora do padrão', () => {
  assert.equal(latestReleaseBranch(['release/0.9.0', 'release/0.10.0', 'release/0.2.0']), 'release/0.10.0');
  assert.equal(latestReleaseBranch(['release/1.0.0-beta.1', 'feat/x', 'main']), null);
  assert.equal(latestReleaseBranch([]), null);
  assert.equal(latestReleaseBranch(undefined), null);
});

test('isLatestLayerTag: só a tag mais alta da camada precisa bater com o manifest', () => {
  const tags = ['backend@v0.1.0', 'backend@v0.2.0', 'site@v0.0.0', 'backend@v0.10.0'];
  assert.equal(isLatestLayerTag('backend@v0.10.0', tags), true);
  assert.equal(isLatestLayerTag('backend@v0.2.0', tags), false);
  assert.equal(isLatestLayerTag('backend@v0.1.0', tags), false);
  assert.equal(isLatestLayerTag('site@v0.0.0', tags), true);
  assert.equal(isLatestLayerTag('nao-e-tag', tags), false);
});

test('uniqueReleaseBranch evita o nome de uma release anterior e a retomada reconhece o sufixo', () => {
  const taken = new Set(['release/0.3.0', 'release/0.3.0-2']);
  assert.equal(uniqueReleaseBranch('release/0.3.0', (name) => taken.has(name)), 'release/0.3.0-3');
  assert.equal(uniqueReleaseBranch('release/0.4.0', (name) => taken.has(name)), 'release/0.4.0');
  assert.equal(latestReleaseBranch(['release/0.3.0', 'release/0.3.0-3', 'release/0.3.0-2', 'release/0.2.9']), 'release/0.3.0-3');
  assert.equal(latestReleaseBranch(['release/0.3.0-5', 'release/0.4.0']), 'release/0.4.0');
});

test('newestReleaseBranch retoma a release mais recente, não a de maior número', () => {
  assert.equal(newestReleaseBranch(['release/0.3.1', 'release/23.47.76', 'release/0.3.0']), 'release/0.3.1');
  assert.equal(newestReleaseBranch(['release/onibus-piloto-BH', 'release/0.3.1']), 'release/0.3.1');
  assert.equal(newestReleaseBranch([]), null);
  assert.equal(newestReleaseBranch(undefined), null);
});
