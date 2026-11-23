// Workflows de versão e release (WP6). O GitHub Actions não roda aqui, então: (1) o trecho de shell
// que resolve a versão do app é EXECUTADO de verdade com um `node` falso; (2) a semântica do push
// atômico é provada num git real (origin bare); (3) o texto dos workflows é conferido.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { QUALITY_DIR } from './helpers.mjs';

const ROOT = path.dirname(QUALITY_DIR);
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** Corpo (`run: |`) do passo cujo `name:` contém o trecho dado. */
function stepScript(yaml, namePart) {
  const lines = yaml.split('\n');
  const start = lines.findIndex((l) => l.includes('- name:') && l.includes(namePart));
  assert.ok(start >= 0, `passo "${namePart}" não encontrado`);
  const run = lines.findIndex((l, i) => i > start && /^\s+run: \|\s*$/.test(l));
  const indent = lines[run + 1].match(/^\s*/)[0].length;
  const body = [];
  for (let i = run + 1; i < lines.length && (lines[i].trim() === '' || lines[i].match(/^\s*/)[0].length >= indent); i++) body.push(lines[i].slice(indent));
  return body.join('\n');
}

function resolveVersion(printed) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-'));
  try {
    fs.mkdirSync(path.join(dir, 'bin'));
    fs.mkdirSync(path.join(dir, 'quality/version'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'bin', 'node'), `#!/bin/sh\necho '${printed}'\n`, { mode: 0o755 });
    const envFile = path.join(dir, 'github_env');
    fs.writeFileSync(envFile, '');
    const script = stepScript(read('.github/workflows/mobile-builds.yml'), 'Resolver versao do app');
    const r = spawnSync('bash', ['-c', script], { cwd: dir, encoding: 'utf8', env: { PATH: `${path.join(dir, 'bin')}:/usr/bin:/bin`, GITHUB_ENV: envFile } });
    assert.equal(r.status, 0, r.stderr);
    return Object.fromEntries(fs.readFileSync(envFile, 'utf8').trim().split('\n').map((l) => l.split('=')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('mobile-builds: BUILD_NAME e BUILD_NUMBER saem de X.Y.Z+B (e build 1 quando não há sufixo)', () => {
  assert.deepEqual(resolveVersion('23.47.75+81'), { BUILD_NAME: '23.47.75', BUILD_NUMBER: '81' });
  assert.deepEqual(resolveVersion('24.0.0+7'), { BUILD_NAME: '24.0.0', BUILD_NUMBER: '7' });
  assert.deepEqual(resolveVersion('1.2.3'), { BUILD_NAME: '1.2.3', BUILD_NUMBER: '1' });
});

test('mobile-builds: os dois jobs buscam histórico e tags e passam a versão ao flutter build', () => {
  const yaml = read('.github/workflows/mobile-builds.yml');
  assert.equal((yaml.match(/fetch-depth: 0/g) ?? []).length, 2);
  assert.equal((yaml.match(/fetch-tags: true/g) ?? []).length, 2);
  assert.match(yaml, /flutter build apk --debug --build-name "\$BUILD_NAME" --build-number "\$BUILD_NUMBER"/);
  assert.match(yaml, /flutter build ios --debug --no-codesign --build-name "\$BUILD_NAME" --build-number "\$BUILD_NUMBER"/);
});

test('release-tag: push atômico, tags filtradas, Release só de produto e sem "Latest" por acaso', () => {
  const yaml = read('.github/workflows/release-tag.yml');
  assert.match(yaml, /git push --atomic origin HEAD:RELEASE "\$\{refs\[@\]\}"/);
  assert.doesNotMatch(yaml, /xargs -a \/tmp\/tags-new/);
  assert.match(yaml, /git tag --list '\*@v\*' > \/tmp\/tags-before\.txt/);
  assert.match(yaml, /git tag --list '\*@v\*' > \/tmp\/tags-after\.txt/);
  assert.match(yaml, /product='\^\(site\|admin-web\|flutter\|backend\|functions\)@v'/);
  assert.match(yaml, /--latest=false/);
  assert.doesNotMatch(yaml, /gh release create "\$tag" --title "\$tag" --generate-notes --verify-tag\n/); // sem a forma antiga
});

test('deploys de site e admin usam --tagged-only (sem tag, a UI não inventa v0.0.0)', () => {
  assert.match(read('.github/workflows/fluxo-web-deploy.yml'), /--next site --tagged-only/);
  assert.match(read('.github/workflows/fluxo-admin-deploy.yml'), /--next admin-web --tagged-only/);
  assert.match(read('.github/workflows/backend-deploy.yml'), /--next backend\)/); // backend precisa de versão sempre
});

// ---- git real: o push atômico não deixa tag órfã -----------------------------------------------

function gitRepos() {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-')));
  const git = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8' }); assert.equal(r.status, 0, `git ${a.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
  git(tmp, 'init', '--bare', '-b', 'RELEASE', 'origin.git');
  const make = (name) => {
    spawnSync('git', ['clone', '--quiet', path.join(tmp, 'origin.git'), name], { cwd: tmp });
    git(path.join(tmp, name), 'config', 'user.email', 'a@exemplo.test');
    git(path.join(tmp, name), 'config', 'user.name', 'A');
    git(path.join(tmp, name), 'config', 'commit.gpgsign', 'false');
    return path.join(tmp, name);
  };
  const a = make('a');
  fs.writeFileSync(path.join(a, 'f'), '1');
  git(a, 'add', '-A'); git(a, 'commit', '-qm', 'base'); git(a, 'push', '-q', 'origin', 'HEAD:RELEASE');
  return { tmp, git, a, b: make('b'), origin: path.join(tmp, 'origin.git'), cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

test('git: push --atomic com origin à frente recusa TUDO (nenhuma tag chega); sem conflito, tudo chega', () => {
  const g = gitRepos();
  try {
    const commitTag = (dir, tag) => {
      fs.writeFileSync(path.join(dir, tag.replace(/\W/g, '_')), tag); // um arquivo por tag: sem conflito de rebase
      g.git(dir, 'add', '-A'); g.git(dir, 'commit', '-qm', `chore(release): ${tag}`); g.git(dir, 'tag', '-a', tag, '-m', tag);
    };
    // b publica primeiro; a fica para trás (RELEASE avançou durante o workflow)
    g.git(g.b, 'pull', '-q', 'origin', 'RELEASE');
    commitTag(g.b, 'outro@v0.1.0'); g.git(g.b, 'push', '-q', 'origin', 'HEAD:RELEASE');
    commitTag(g.a, 'site@v0.1.0'); g.git(g.a, 'tag', '-a', 'flutter@v1.0.0', '-m', 'x');
    const refused = spawnSync('git', ['push', '--atomic', 'origin', 'HEAD:RELEASE', 'refs/tags/site@v0.1.0', 'refs/tags/flutter@v1.0.0'], { cwd: g.a, encoding: 'utf8' });
    assert.notEqual(refused.status, 0);
    const remoteTags = g.git(g.origin, 'tag', '--list');
    assert.ok(!remoteTags.includes('site@v0.1.0') && !remoteTags.includes('flutter@v1.0.0'), `tag órfã na origem: ${remoteTags}`);
    // sem o --atomic, a mesma situação deixaria as tags subirem sozinhas: é isso que o fluxo antigo arriscava
    spawnSync('git', ['push', 'origin', 'HEAD:RELEASE'], { cwd: g.a }); // recusado (não fast-forward)
    const old = spawnSync('git', ['push', 'origin', 'refs/tags/site@v0.1.0'], { cwd: g.a, encoding: 'utf8' });
    assert.equal(old.status, 0, 'o push de tag isolado passa: tag sem o commit que ela versiona');
    g.git(g.origin, 'tag', '-d', 'site@v0.1.0');
    // reconcilia e repete: agora tudo chega junto
    g.git(g.a, 'pull', '-q', '--rebase', 'origin', 'RELEASE');
    g.git(g.a, 'tag', '-f', '-a', 'site@v0.1.0', '-m', 'x');
    const ok = spawnSync('git', ['push', '--atomic', 'origin', 'HEAD:RELEASE', 'refs/tags/site@v0.1.0', 'refs/tags/flutter@v1.0.0'], { cwd: g.a, encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(g.git(g.origin, 'tag', '--list'), /site@v0\.1\.0[\s\S]*flutter@v1\.0\.0|flutter@v1\.0\.0[\s\S]*site@v0\.1\.0/);
  } finally { g.cleanup(); }
});
