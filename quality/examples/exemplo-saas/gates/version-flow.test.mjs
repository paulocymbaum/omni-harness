// Testes e2e do versionamento por camada: repositório temporário com origin bare, develop
// e release/1.0.0; commits convencionais por camada; --apply cria commits de manifest e
// tags; os merges propagam as tags para main e develop; --check reprova antes e aprova
// depois (a tag precisa estar alcançável nas três branches).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runScript } from '../../../test/helpers.mjs';

const g = (dir, ...args) => {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} (${dir}): ${r.stderr.trim()}`);
  return r.stdout.trim();
};

function versionRepo() {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gver-')));
  const origin = path.join(tmp, 'origin.git');
  const work = path.join(tmp, 'work');
  g(tmp, 'init', '--bare', '-b', 'main', 'origin.git');
  spawnSync('git', ['clone', '--quiet', origin, work], { encoding: 'utf8' });
  g(work, 'config', 'user.email', 'agente@fluxo');
  g(work, 'config', 'user.name', 'Agente');
  const write = (file, content) => {
    fs.mkdirSync(path.dirname(path.join(work, file)), { recursive: true });
    fs.writeFileSync(path.join(work, file), content);
  };
  write('ofluxo_site/package.json', '{\n  "name": "ofluxo_site",\n  "version": "0.0.0",\n  "type": "module"\n}\n');
  write('pubspec.yaml', 'name: fluxo\nversion: 22.46.71+78\ndescription: x\n');
  write('backend/src/A.cs', 'class A {}\n');
  write('backend/Directory.Build.props', '<Project>\n  <PropertyGroup>\n    <Version>0.1.0</Version>\n  </PropertyGroup>\n</Project>\n');
  write('functions/src/index.ts', 'export {};\n');
  write('README.md', '# fluxo\n');
  g(work, 'add', '-A');
  g(work, 'commit', '-q', '-m', 'chore: base inicial');
  g(work, 'push', '-q', 'origin', 'HEAD:main');
  g(work, 'switch', '-c', 'develop');
  g(work, 'push', '-q', 'origin', 'develop');
  g(work, 'switch', '-c', 'release/1.0.0');
  const commit = (file, content, msg) => { write(file, content); g(work, 'add', '-A'); g(work, 'commit', '-q', '-m', msg); };
  commit('ofluxo_site/src/x.ts', 'export const x = 1;\n', 'feat(site): mapa do pulso');
  commit('backend/src/B.cs', 'class B {}\n', 'fix(backend): outbox');
  commit('lib/features/map/a.dart', 'class A {}\n', 'feat(mapa)!: motor novo do mapa');
  commit('README.md', '# fluxo\n\natualizado\n', 'docs: guia do mapa');
  return { tmp, origin, work, dir: work, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

const bump = (r, args = []) => runScript(r, 'version/bump.mjs', null, args);

test('plano por camada: baseline do manifest, breaking major, patch e docs', () => {
  const r = versionRepo();
  try {
    const plan = bump(r, ['--json']);
    assert.equal(plan.code, 0, plan.stderr);
    const fmt = (x) => `${x.major}.${x.minor}.${x.patch}${x.build == null ? '' : `+${x.build}`}`;
    const by = Object.fromEntries(plan.json.rows.map((x) => [x.layer, x]));
    assert.deepEqual(plan.json.rows.map((x) => x.layer), ['flutter', 'backend', 'site', 'docs']);
    assert.equal(fmt(by.site.from), '0.0.0');
    assert.equal(fmt(by.site.to), '0.1.0');
    assert.equal(by.site.level, 'minor');
    assert.equal(fmt(by.backend.from), '0.1.0');
    assert.equal(fmt(by.backend.to), '0.1.1');
    assert.equal(fmt(by.flutter.from), '22.46.71+78');
    assert.equal(fmt(by.flutter.to), '23.0.0+78');
    assert.equal(by.flutter.level, 'major');
    assert.equal(fmt(by.docs.to), '0.1.1');
    assert.equal(by.site.manifest, 'ofluxo_site/package.json');
    assert.equal(by.backend.manifest, 'backend/Directory.Build.props');
  } finally { r.cleanup(); }
});

// PART2_MARKER

test('--apply: recusa fora da release e árvore suja; cria commits de manifest e tags', () => {
  const r = versionRepo();
  try {
    g(r.work, 'switch', 'develop');
    const refused = bump(r, ['--apply']);
    assert.ok(refused.code !== 0);
    assert.match(refused.stderr, /release\//);
    g(r.work, 'switch', 'release/1.0.0');
    fs.writeFileSync(path.join(r.work, 'README.md'), '# suja\n');
    const dirty = bump(r, ['--apply']);
    assert.ok(dirty.code !== 0);
    assert.match(dirty.stderr, /não está limpa/);
    g(r.work, 'checkout', '--', 'README.md');

    const applied = bump(r, ['--apply']);
    assert.equal(applied.code, 0, applied.stderr);
    assert.match(applied.stdout, /Tag criada: flutter@v23\.0\.0/);
    assert.match(applied.stdout, /Tag criada: site@v0\.1\.0/);
    assert.deepEqual(g(r.work, 'tag').split('\n').sort(), ['backend@v0.1.1', 'docs@v0.1.1', 'flutter@v23.0.0', 'site@v0.1.0']);
    const sitePkg = fs.readFileSync(path.join(r.work, 'ofluxo_site/package.json'), 'utf8');
    assert.match(sitePkg, /"version": "0\.1\.0"/);
    const pubspec = fs.readFileSync(path.join(r.work, 'pubspec.yaml'), 'utf8');
    assert.match(pubspec, /version: 23\.0\.0\+78/);
    assert.match(fs.readFileSync(path.join(r.work, 'backend/Directory.Build.props'), 'utf8'), /<Version>0\.1\.1<\/Version>/);

    // versions.json por ambiente (derivado das tags e commitado pelo apply)
    const versions = JSON.parse(fs.readFileSync(path.join(r.work, 'ofluxo_site/public/versions.json'), 'utf8'));
    assert.equal(versions.environments.prod.front.ios, '23.0.0');
    assert.equal(versions.environments.prod.front.web, '0.1.0');
    assert.equal(versions.environments.prod.backend.api, '0.1.1');
    assert.equal(versions.environments.prod.backend.dados, null);
    assert.equal(versions.environments.dev.backend.api, '0.1.1');
    assert.equal(versions.environments.hml.front.web, null); // fixture não tem origin/RELEASE
    assert.equal(g(r.work, 'status', '--porcelain'), ''); // apply termina com a árvore limpa

    // idempotente: com as tags no lugar, nada mais precisa de bump
    const empty = bump(r, ['--json']);
    assert.equal(empty.code, 0, empty.stderr);
    assert.deepEqual(empty.json.rows, []);

    // artefato derivado (versions.json) nunca entra no range de bump
    fs.writeFileSync(path.join(r.work, 'ofluxo_site/public/versions.json'), '{"schema":1}\n');
    g(r.work, 'add', '-A');
    g(r.work, 'commit', '-qm', 'chore(site): versions.json');
    const still = bump(r, ['--json']);
    assert.deepEqual(still.json.rows, []);
  } finally { r.cleanup(); }
});

test('--check: reprova antes dos merges (tag fora de main/develop) e aprova depois', () => {
  const r = versionRepo();
  try {
    g(r.work, 'switch', 'release/1.0.0');
    assert.match(bump(r, ['--apply']).stdout, /Bump aplicado/);
    const before = bump(r, ['--check']);
    assert.equal(before.code, 2, before.stdout);
    assert.match(before.stdout, /não alcançada em main/);
    assert.match(before.stdout, /não alcançada em develop/);

    g(r.work, 'switch', 'main');
    g(r.work, 'merge', '--no-ff', '-m', 'merge release/1.0.0', 'release/1.0.0');
    g(r.work, 'switch', 'develop');
    g(r.work, 'merge', '--no-ff', '-m', 'backmerge release/1.0.0', 'release/1.0.0');
    const after = bump(r, ['--check']);
    assert.equal(after.code, 0, after.stdout);
    assert.match(after.stdout, /Todas as 4 tag\(s\)/);
  } finally { r.cleanup(); }
});

test('sem tags e opção inválida: mensagens claras e exit codes', () => {
  const r = versionRepo();
  try {
    const none = bump(r, ['--check']);
    assert.equal(none.code, 2);
    assert.match(none.stdout, /Nenhuma tag de versão/);
    const unknown = bump(r, ['--layer', 'nao-existe']);
    assert.ok(unknown.code !== 0);
    assert.match(unknown.stderr, /Camada desconhecida/);
  } finally { r.cleanup(); }
});

test('regressão: depois da primeira tag o sufixo +build do pubspec é preservado', () => {
  const r = versionRepo();
  try {
    g(r.work, 'switch', 'release/1.0.0');
    assert.equal(bump(r, ['--apply']).code, 0);
    const commit = (file, content, msg) => {
      fs.writeFileSync(path.join(r.work, file), content);
      g(r.work, 'add', '-A');
      g(r.work, 'commit', '-q', '-m', msg);
    };
    commit('lib/features/map/b.dart', 'class B {}\n', 'fix(mapa): ajuste');
    const second = bump(r, ['--apply']);
    assert.equal(second.code, 0, second.stderr);
    const pubspec = fs.readFileSync(path.join(r.work, 'pubspec.yaml'), 'utf8');
    assert.match(pubspec, /version: 23\.0\.1\+78/); // antes da correção virava 23.0.1 (build zerado)
  } finally { r.cleanup(); }
});

test('--apply e --init aceitam a branch longa RELEASE (deploy) e recusam develop', () => {
  const r = versionRepo();
  try {
    g(r.work, 'switch', '-c', 'RELEASE');
    const init = bump(r, ['--init']);
    assert.equal(init.code, 0, init.stderr);
    assert.match(init.stdout, /Tag criada: flutter@v22\.46\.71/);
    assert.match(init.stdout, /Tag criada: backend@v0\.1\.0/);
    assert.ok(g(r.work, 'tag').split('\n').includes('site@v0.0.0'));
    // --init é idempotente: camadas já tagueadas não ganham tag nova
    assert.doesNotMatch(bump(r, ['--init']).stdout, /Tag criada/);
    assert.equal(g(r.work, 'status', '--porcelain'), ''); // init commita o versions.json
    assert.ok(bump(r, ['--apply']).code !== 0); // sem commits novos desde a baseline, nada a versionar
    fs.writeFileSync(path.join(r.work, 'ofluxo_site/src/y.ts'), 'export const y = 1;\n');
    g(r.work, 'add', '-A');
    g(r.work, 'commit', '-qm', 'feat(site): rodapé com versão');
    const applied = bump(r, ['--apply']);
    assert.equal(applied.code, 0, applied.stderr);
    g(r.work, 'switch', 'develop');
    const refused = bump(r, ['--init']);
    assert.ok(refused.code !== 0);
    assert.match(refused.stderr, /RELEASE/);
  } finally { r.cleanup(); }
});

test('--next imprime a versão que a camada terá no apply (e a atual sem commits novos)', () => {
  const r = versionRepo();
  try {
    assert.equal(bump(r, ['--next', 'site']).stdout.trim(), '0.1.0');
    assert.equal(bump(r, ['--next', 'flutter']).stdout.trim(), '23.0.0+78');
    assert.equal(bump(r, ['--apply']).code, 0);
    assert.equal(bump(r, ['--next', 'site']).stdout.trim(), '0.1.0'); // sem commits novos: versão atual
    assert.ok(bump(r, ['--next', 'nao-existe']).code !== 0);
  } finally { r.cleanup(); }
});

test('--next --tagged-only: vazio sem tag (a UI não inventa versão) e a versão depois do --init', () => {
  const r = versionRepo();
  try {
    assert.equal(bump(r, ['--next', 'site', '--tagged-only']).stdout.trim(), '');
    assert.equal(bump(r, ['--next', 'site']).stdout.trim(), '0.1.0'); // sem a flag segue imprimindo a versão planejada
    g(r.work, 'switch', '-c', 'RELEASE');
    assert.equal(bump(r, ['--init']).code, 0);
    assert.equal(bump(r, ['--next', 'site', '--tagged-only']).stdout.trim(), '0.0.0');
  } finally { r.cleanup(); }
});
