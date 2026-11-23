// WP3: grafo ausente ou velho. Dica no SessionStart, atualização com debounce depois de editar
// código, e armazenamento do grafo fora da árvore (symlink) para sobreviver a git clean/checkpoints.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { QUALITY_DIR, tempRepo, runScript } from './helpers.mjs';
import { graphReady, graphStatus } from '../lib/search-guard.mjs';
import { graphHint } from '../lib/search-message.mjs';
import { planUpdate, DEBOUNCE_MS } from '../hooks/post-edit-graphify.mjs';
import { ensureGraphLink, graphStorageDir } from '../agents/graphify-build.mjs';

const fakeCli = () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'gbin-'));
  fs.writeFileSync(path.join(bin, 'graphify'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return { bin, graphify: path.join(bin, 'graphify'), cleanup: () => fs.rmSync(bin, { recursive: true, force: true }) };
};
const withGraph = (repo, ageMs = 0) => {
  fs.mkdirSync(path.join(repo.dir, 'graphify-out'), { recursive: true });
  const file = path.join(repo.dir, 'graphify-out', 'graph.json');
  fs.writeFileSync(file, '{}');
  const when = new Date(Date.now() - ageMs);
  fs.utimesSync(file, when, when);
};

test('graphStatus: ausente, ok e velho (código novo depois do grafo)', () => {
  const repo = tempRepo({ 'README.md': '# x\n' });
  try {
    assert.equal(graphStatus(repo.dir).state, 'ausente');
    withGraph(repo, 3600_000);
    assert.equal(graphStatus(repo.dir).state, 'ok');
    repo.write('lib/nova.dart', 'class Nova {}\n');
    const s = graphStatus(repo.dir);
    assert.equal(s.state, 'velho');
    assert.deepEqual(s.stale, ['lib/nova.dart']);
    repo.write('docs/nota.md', '# nota\n'); // não é código: não envelhece o grafo
    assert.deepEqual(graphStatus(repo.dir).stale, ['lib/nova.dart']);
    assert.match(graphHint(s), /desatualizado \(1 arquivo/);
    assert.match(graphHint({ state: 'ausente', stale: [] }), /graphify-build\.mjs/);
    assert.equal(graphHint({ state: 'ok', stale: [] }), null);
  } finally { repo.cleanup(); }
});

test('SessionStart avisa grafo ausente ou velho, e só com a CLI instalada e a guarda ligada', () => {
  const repo = tempRepo({ 'README.md': '# x\n' });
  const cli = fakeCli();
  try {
    const ctx = (env = {}) => runScript(repo, 'hooks/session-start.mjs', {}, [], { GRAPHIFY_BIN: cli.graphify, GRAPHIFY_HOOK_STRICT: '', ...env }).json?.hookSpecificOutput?.additionalContext ?? '';
    assert.match(ctx(), /Grafo do graphify ausente/);
    assert.doesNotMatch(ctx({ GRAPHIFY_HOOK_STRICT: '0' }), /graphify/); // guarda desligada: sem dica
    assert.doesNotMatch(ctx({ GRAPHIFY_BIN: '/nao/existe/graphify' }), /Grafo do graphify/); // sem a CLI: sem dica
    withGraph(repo, 3600_000);
    assert.doesNotMatch(ctx(), /Grafo do graphify/);
    repo.write('lib/nova.dart', 'class Nova {}\n');
    assert.match(ctx(), /Grafo do graphify desatualizado \(1 arquivo/);
  } finally { cli.cleanup(); repo.cleanup(); }
});

test('planUpdate: só código fora de docs/assets, com grafo, CLI e sem lock recente', () => {
  const repo = tempRepo({ 'README.md': '# x\n' });
  const cli = fakeCli();
  try {
    const env = { GRAPHIFY_BIN: cli.graphify };
    const plan = (rel, extra = {}, now = Date.now()) => planUpdate({ root: repo.dir, rel, env: { ...env, ...extra }, now });
    assert.equal(plan('lib/a.dart').action, 'no-graph'); // grafo ainda não existe: não dispara build completo
    withGraph(repo);
    assert.equal(plan('lib/a.dart').action, 'update');
    for (const rel of ['docs/x.ts', 'assets/a.js', 'README.md', 'lib/a.arb', '../fora/a.dart', '']) assert.equal(plan(rel).action, 'ignore', rel);
    assert.equal(plan('lib/a.dart', { FLUXO_GRAPH_AUTOUPDATE: '0' }).action, 'off');
    assert.equal(plan('lib/a.dart', { GRAPHIFY_HOOK_STRICT: '0' }).action, 'off');
    assert.equal(plan('lib/a.dart', { GRAPHIFY_BIN: '/nao/existe' }).action, 'no-graph');
    const lock = plan('lib/a.dart').lock;
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, '1');
    assert.equal(plan('lib/a.dart').action, 'debounced');
    assert.equal(plan('lib/a.dart', {}, Date.now() + DEBOUNCE_MS + 1000).action, 'update'); // lock expirou
  } finally { cli.cleanup(); repo.cleanup(); }
});

test('hook de atualização: grava lock e log e não bloqueia (spawn do build isolado no repo de teste)', () => {
  const repo = tempRepo({ 'README.md': '# x\n' });
  const cli = fakeCli();
  try {
    withGraph(repo);
    const r = runScript(repo, 'hooks/post-edit-graphify.mjs', { tool_input: { file_path: path.join(repo.dir, 'lib/a.dart') } }, [], { GRAPHIFY_BIN: cli.graphify });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, '');
    assert.ok(fs.existsSync(path.join(repo.dir, '.claude', '.state', 'graphify-update.lock')));
    assert.ok(fs.existsSync(path.join(repo.dir, '.claude', '.state', 'graphify-update.log')));
    fs.rmSync(path.join(repo.dir, '.claude', '.state', 'graphify-update.lock'));
    const off = runScript(repo, 'hooks/post-edit-graphify.mjs', { tool_input: { file_path: path.join(repo.dir, 'lib/a.dart') } }, [], { GRAPHIFY_BIN: cli.graphify, FLUXO_GRAPH_AUTOUPDATE: '0' });
    assert.equal(off.code, 0);
    assert.ok(!fs.existsSync(path.join(repo.dir, '.claude', '.state', 'graphify-update.lock')), 'desligado não dispara');
  } finally { cli.cleanup(); repo.cleanup(); }
});

test('armazenamento externo: symlink graphify-out, idempotente, restaura e respeita diretório legado', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gstore-root-'));
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'gstore-cache-'));
  const env = { FLUXO_GRAPH_DIR: store };
  try {
    const target = graphStorageDir(root, env);
    assert.ok(target.startsWith(store) && target.endsWith('graphify-out'));
    assert.notEqual(graphStorageDir(root, env), graphStorageDir(`${root}-outro`, env), 'um grafo por repositório');

    const first = ensureGraphLink(root, env);
    assert.deepEqual([first.mode, first.created], ['link', true]);
    assert.ok(fs.lstatSync(path.join(root, 'graphify-out')).isSymbolicLink());
    fs.writeFileSync(path.join(root, 'graphify-out', 'graph.json'), '{}'); // grava através do symlink
    assert.ok(fs.existsSync(path.join(target, 'graph.json')));
    assert.equal(graphReady(root, { GRAPHIFY_BIN: process.execPath }), true);

    assert.equal(ensureGraphLink(root, env).created, false); // idempotente
    // `git clean` / checkpoint apaga só o symlink: o grafo continua no armazenamento e o link volta
    fs.unlinkSync(path.join(root, 'graphify-out'));
    assert.equal(ensureGraphLink(root, env).created, true);
    assert.ok(fs.existsSync(path.join(root, 'graphify-out', 'graph.json')), 'grafo sobreviveu à remoção do link');
    // armazenamento apagado: o link fica pendurado, a guarda falha aberta e o ensure recria o destino
    fs.rmSync(target, { recursive: true });
    assert.equal(graphReady(root, { GRAPHIFY_BIN: process.execPath }), false);
    ensureGraphLink(root, env);
    assert.ok(fs.existsSync(target));
    // symlink apontando para outro lugar é corrigido
    fs.unlinkSync(path.join(root, 'graphify-out'));
    fs.symlinkSync(os.tmpdir(), path.join(root, 'graphify-out'), 'dir');
    assert.equal(ensureGraphLink(root, env).created, true);
    assert.equal(fs.readlinkSync(path.join(root, 'graphify-out')), target);
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(store, { recursive: true, force: true }); }
});

test('diretório graphify-out real (legado) e o modo in-tree não viram symlink', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gstore-root-'));
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'gstore-cache-'));
  try {
    fs.mkdirSync(path.join(root, 'graphify-out'));
    fs.writeFileSync(path.join(root, 'graphify-out', 'graph.json'), '{}');
    assert.equal(ensureGraphLink(root, { FLUXO_GRAPH_DIR: store }).mode, 'in-tree');
    assert.ok(!fs.lstatSync(path.join(root, 'graphify-out')).isSymbolicLink());
    fs.rmSync(path.join(root, 'graphify-out'), { recursive: true });
    assert.equal(ensureGraphLink(root, { FLUXO_GRAPH_DIR: 'in-tree' }).mode, 'in-tree');
    assert.ok(!fs.existsSync(path.join(root, 'graphify-out')), 'in-tree explícito não cria nada');
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(store, { recursive: true, force: true }); }
});

test('settings.json registra o registro pós-consulta e a atualização do grafo; .gitignore cobre o symlink', () => {
  const root = path.dirname(QUALITY_DIR);
  const post = JSON.parse(fs.readFileSync(path.join(root, '.claude/settings.json'), 'utf8')).hooks.PostToolUse;
  const commands = (matcher) => post.find((e) => e.matcher === matcher).hooks.map((h) => h.command).join('\n');
  assert.match(commands('Bash'), /post-search-graphify\.mjs/);
  assert.match(commands('Edit|Write|MultiEdit|NotebookEdit'), /post-edit-graphify\.mjs/);
  const ignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8').split('\n');
  assert.ok(ignore.includes('graphify-out'), 'sem barra final: `graphify-out/` só casa diretório, não o symlink');
});

test('autorreparo: o link sumiu (git clean, checkpoint do Cline) mas o grafo está no cache → volta sozinho', async () => {
  const { healGraphLink } = await import('../lib/graph-storage.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'heal-root-'));
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'heal-cache-'));
  const env = { FLUXO_GRAPH_DIR: store, GRAPHIFY_BIN: process.execPath };
  try {
    assert.equal(healGraphLink(root, env), false, 'sem grafo no cache: não cria nada');
    assert.ok(!fs.existsSync(path.join(root, 'graphify-out')) && !fs.existsSync(graphStorageDir(root, env)));
    ensureGraphLink(root, env);
    fs.writeFileSync(path.join(root, 'graphify-out', 'graph.json'), '{}');
    fs.unlinkSync(path.join(root, 'graphify-out')); // o restore do Cline apaga o atalho
    assert.equal(graphReady(root, env), true, 'a própria guarda repara antes de decidir');
    assert.ok(fs.lstatSync(path.join(root, 'graphify-out')).isSymbolicLink());
    assert.equal(healGraphLink(root, env), false, 'já existe: nada a fazer');
    // SessionStart e o hook de atualização também reparam (e então enxergam o grafo)
    fs.unlinkSync(path.join(root, 'graphify-out'));
    assert.equal(planUpdate({ root, rel: 'lib/a.dart', env }).action, 'update');
    fs.unlinkSync(path.join(root, 'graphify-out'));
    assert.equal(healGraphLink(root, { ...env, FLUXO_GRAPH_DIR: 'in-tree' }), false, 'in-tree nunca cria link');
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(store, { recursive: true, force: true }); }
});
