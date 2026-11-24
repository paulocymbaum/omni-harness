// Testes da política pura de versionamento por camada (quality/lib/versioning.mjs):
// semver com sufixo de build, tags <camada>@vX.Y.Z, classificação de bump por commits
// convencionais e manifests (package.json / pubspec.yaml).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyManifestVersion, bumpVersion, classifyBump, commitsByLayer, currentVersion,
  formatVersion, highestLayerVersion, layerTagName, parseLayerTag, parseManifestVersion,
  parseVersion, planLayer, buildVersionsManifest, stripDerivedFiles,
} from '../../../lib/versioning.mjs';

const v = (s) => parseVersion(s);
const c = (subject, body = '') => ({ subject, body });

test('parse/format de versão e tag de camada', () => {
  assert.deepEqual(v('1.2.3'), { major: 1, minor: 2, patch: 3, build: null });
  assert.deepEqual(v('22.46.71+78'), { major: 22, minor: 46, patch: 71, build: 78 });
  assert.equal(formatVersion(v('22.46.71+78')), '22.46.71+78');
  assert.deepEqual(parseLayerTag('site@v1.4.2'), { layer: 'site', version: { major: 1, minor: 4, patch: 2, build: null } });
  assert.equal(parseLayerTag('v1.0.0'), null);
  assert.equal(parseLayerTag('site@v1.0'), null);
  assert.equal(layerTagName('flutter', v('23.0.0+78')), 'flutter@v23.0.0'); // build fica no manifest
});

test('bump semver preserva o sufixo de build', () => {
  assert.equal(formatVersion(bumpVersion(v('0.1.1'), 'patch')), '0.1.2');
  assert.equal(formatVersion(bumpVersion(v('0.1.1'), 'minor')), '0.2.0');
  assert.equal(formatVersion(bumpVersion(v('22.46.71+78'), 'major')), '23.0.0+78');
  assert.equal(formatVersion(bumpVersion(v('1.2.3'), null)), '1.2.3');
});

test('maior tag da camada vence; tags de outras camadas não interferem', () => {
  const tags = ['site@v1.2.0', 'site@v1.10.0', 'site@v1.9.9', 'backend@v2.0.0'];
  assert.deepEqual(highestLayerVersion(tags, 'site'), v('1.10.0'));
  assert.equal(highestLayerVersion(tags, 'ocr'), null);
});

test('classifyBump: breaking > feat > demais', () => {
  assert.equal(classifyBump([]), null);
  assert.equal(classifyBump([c('fix(site): y')]), 'patch');
  assert.equal(classifyBump([c('chore: x'), c('fix: y')]), 'patch');
  assert.equal(classifyBump([c('fix: y'), c('feat(site): x')]), 'minor');
  assert.equal(classifyBump([c('feat!: breaking')]), 'major');
  assert.equal(classifyBump([c('feat(mapa)!: x')]), 'major');
  assert.equal(classifyBump([c('fix: y', 'BREAKING CHANGE: api muda')]), 'major');
  assert.equal(classifyBump([c('fix: y', 'menção no meio: BREAKING CHANGE: não vale')]), 'patch');
  assert.equal(classifyBump([c('fix: a'), c('feat: b'), c('feat!: c')]), 'major');
});

test('manifests: parse e aplicação preservando o resto do arquivo', () => {
  const pkg = '{\n  "name": "ofluxo_site",\n  "version": "0.0.0",\n  "type": "module"\n}\n';
  assert.deepEqual(parseManifestVersion(pkg, 'package-json'), v('0.0.0'));
  assert.equal(applyManifestVersion(pkg, v('0.1.0'), 'package-json'), pkg.replace('"0.0.0"', '"0.1.0"'));
  const pub = 'name: fluxo\nversion: 22.46.71+78\ndescription: x\n';
  assert.deepEqual(parseManifestVersion(pub, 'pubspec'), v('22.46.71+78'));
  assert.equal(applyManifestVersion(pub, v('23.0.0+78'), 'pubspec'), pub.replace('22.46.71+78', '23.0.0+78'));
  assert.equal(parseManifestVersion(null, 'package-json'), null);
  assert.equal(parseManifestVersion('sem versão aqui', 'pubspec'), null);
});

test('currentVersion: tag vence manifest, que vence a baseline', () => {
  assert.deepEqual(currentVersion('site', ['site@v2.0.0'], '{"version": "0.0.0"}'), v('2.0.0'));
  assert.deepEqual(currentVersion('site', [], '{"version": "0.0.0"}'), v('0.0.0'));
  assert.deepEqual(currentVersion('backend', [], null), v('0.1.0'));
});

test('commitsByLayer segue layers.json (primeiro glob que casa) e planLayer monta o plano', () => {
  const commits = [
    { subject: 'feat(site): x', files: ['ofluxo_site/src/a.ts'] },
    { subject: 'fix(backend): y', files: ['backend/src/A.cs', 'functions/src/b.ts'] },
    { subject: 'docs: z', files: ['README.md'] },
  ];
  const groups = commitsByLayer(commits);
  assert.equal(groups.get('site').length, 1);
  assert.equal(groups.get('backend').length, 1);
  assert.equal(groups.get('functions').length, 1);
  assert.equal(groups.get('docs').length, 1);
  assert.equal(groups.get('quality').length, 0);
  const row = planLayer({ layer: 'site', tagNames: [], manifestText: '{"version": "0.0.0"}', commits: groups.get('site') });
  assert.deepEqual(row, { layer: 'site', from: v('0.0.0'), to: v('0.1.0'), level: 'minor', commits: 1 });
  assert.equal(planLayer({ layer: 'ocr', tagNames: [], manifestText: null, commits: [] }), null);
});

test('versions manifest por ambiente e artefato derivado ignorado', () => {
  const tags = ['site@v0.1.0', 'flutter@v23.0.0', 'backend@v0.1.1', 'functions@v0.1.0'];
  const m = buildVersionsManifest({ tagsByEnv: { prod: tags, dev: [], hml: [] }, generatedAt: '2026-11-03T00:00:00Z' });
  assert.equal(m.schema, 1);
  assert.equal(m.generatedAt, '2026-11-03T00:00:00Z');
  assert.equal(m.environments.prod.front.web, '0.1.0');
  assert.equal(m.environments.prod.front.ios, '23.0.0');
  assert.equal(m.environments.prod.front.android, '23.0.0');
  assert.equal(m.environments.prod.backend.api, '0.1.1');
  assert.equal(m.environments.prod.backend.funcoes, '0.1.0');
  assert.equal(m.environments.prod.backend.dados, null);
  assert.equal(m.environments.dev.front.web, null);
  assert.equal(m.environments.hml.front.web, null);
  assert.deepEqual(
    stripDerivedFiles(['ofluxo_site/public/versions.json', 'ofluxo_site/src/a.ts']),
    ['ofluxo_site/src/a.ts'],
  );
});
