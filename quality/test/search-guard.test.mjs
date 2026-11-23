// Testes da guarda de busca (graphify primeiro), do wrapper do rtk e da paridade com o Cline:
// política pura, hooks de ponta a ponta com `graphify`/`rtk` falsos no PATH, registro em
// settings.json e espelho .clinerules sem divergência.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { QUALITY_DIR, tempRepo, runScript } from './helpers.mjs';
import { classifyCall, decide, guardMode, WINDOW_MS, bashSearch, commandsOf } from '../lib/search-guard.mjs';
import { mapCommands } from '../lib/rtk-rewrite.mjs';
import { classifyCommand } from '../lib/shell.mjs';
import { parseGitOps } from '../lib/gitflow.mjs';
import { sync, MIRRORS } from '../agents/sync-clinerules.mjs';

const ROOT = path.dirname(QUALITY_DIR);
const kindOf = (cmd) => classifyCall('claude', 'Bash', { command: cmd }).kind;

test('Bash: busca bruta no repo é reconhecida; filtro de stdin, arquivo único e comandos comuns passam', () => {
  const searches = ['grep -rn foo .', 'grep -R foo lib/', 'rg foo', 'rtk rg foo', 'rtk grep -r x lib', 'find . -name "*.dart"',
    'git grep foo', 'ag foo', 'fd splash', 'cd x && rg Foo'];
  for (const cmd of searches) assert.equal(kindOf(cmd), 'search', cmd);
  const others = ['git log | rg x', 'cat a.txt | grep foo', 'grep foo file.txt', 'rg foo src/a.ts', 'find . -maxdepth 1 -name x',
    'ls -la', 'node quality/run.mjs', 'git status', 'echo "grep -r nao e busca"', 'find . -type d'];
  for (const cmd of others) assert.equal(kindOf(cmd), 'other', cmd);
  assert.equal(bashSearch(''), null);
});

test('busca fora do repositório (outro projeto, ~) não é guardada; dentro continua', () => {
  const root = '/work/fluxo';
  const k = (cmd) => classifyCall('claude', 'Bash', { command: cmd }, root).kind;
  assert.equal(k('grep -rn hooks /home/u/other/src'), 'other');
  assert.equal(k('rg PreToolUse ~/Documents/cline-fork'), 'other');
  assert.equal(k('find /home/u/other -name "*.ts"'), 'other');
  assert.equal(k('grep -rn x /work/fluxo/lib'), 'search');
  assert.equal(k('grep -rn x /work/fluxo'), 'search');
  assert.equal(k('grep -rn x /work/fluxo-outro'), 'other'); // prefixo de nome não é dentro do repo
  assert.equal(k('find /home/u/other /work/fluxo -name x'), 'search'); // mistura: pelo menos um alvo no repo
  assert.equal(k('grep -rn x .'), 'search');
  assert.equal(classifyCall('claude', 'Grep', { pattern: 'x', path: '/home/u/other' }, root).kind, 'other');
  assert.equal(classifyCall('claude', 'Grep', { pattern: 'x', path: '/work/fluxo/lib' }, root).kind, 'search');
  assert.equal(classifyCall('claude', 'Glob', { pattern: '**/*.ts', path: '/home/u/other' }, root).kind, 'other');
  assert.equal(classifyCall('cline', 'search_files', { regex: 'x', path: '/home/u/other' }, root).kind, 'other');
});

test('consulta ao grafo é reconhecida, inclusive com prefixo rtk ou em pipeline', () => {
  for (const cmd of ['graphify query "SplashScreen"', 'graphify explain X', 'graphify path A B', 'graphify affected X',
    'graphify god-nodes', 'cd /x && graphify query Y --budget 300', 'rtk proxy graphify query Z']) {
    assert.equal(kindOf(cmd), 'query', cmd);
  }
  assert.equal(kindOf('graphify update .'), 'other'); // manter o grafo não conta como consulta
});

test('Grep/Glob do Claude e search_files/list_files do Cline: amplo é busca, estreito passa', () => {
  assert.equal(classifyCall('claude', 'Grep', { pattern: 'x' }).kind, 'search');
  assert.equal(classifyCall('claude', 'Grep', { pattern: 'x', path: 'lib/splash/splash_screen.dart' }).kind, 'other');
  assert.equal(classifyCall('claude', 'Glob', { pattern: '**/*.dart' }).kind, 'search');
  assert.equal(classifyCall('claude', 'Glob', { pattern: 'lib/splash/*.dart' }).kind, 'other');
  assert.equal(classifyCall('claude', 'Read', { file_path: 'a' }).kind, 'other');
  assert.equal(classifyCall('cline', 'search_files', { regex: 'x', path: '.' }).kind, 'search');
  assert.equal(classifyCall('cline', 'search_files', { regex: 'x', path: 'src/a.ts' }).kind, 'other');
  assert.equal(classifyCall('cline', 'list_files', { path: '.', recursive: true }).kind, 'search');
  assert.equal(classifyCall('cline', 'list_files', { path: '.', recursive: 'false' }).kind, 'other');
  assert.equal(classifyCall('cline', 'read_file', { path: 'a' }).kind, 'other');
  assert.equal(classifyCall('cline', 'execute_command', { command: 'rg foo' }).kind, 'search');
  assert.equal(classifyCall('cline', 'Grep', { pattern: 'x' }).kind, 'other'); // nome de outro host não vale
});

test('decide: strict nega; soft dá UMA dica por janela; consulta recente libera; sem grafo nada acontece', () => {
  const now = 10_000_000;
  assert.equal(decide({ kind: 'search', ready: true, mode: 'strict', now }).action, 'deny');
  assert.equal(decide({ kind: 'search', ready: true, mode: 'strict', lastQueryAt: now - WINDOW_MS + 1, now }).action, 'allow');
  assert.equal(decide({ kind: 'search', ready: true, mode: 'strict', lastQueryAt: now - WINDOW_MS - 1, now }).action, 'deny');
  assert.equal(decide({ kind: 'search', ready: true, now }).action, 'nudge');
  assert.equal(decide({ kind: 'search', ready: true, lastNudgeAt: now - 1000, now }).action, 'allow');
  assert.equal(decide({ kind: 'search', ready: true, lastNudgeAt: now - WINDOW_MS - 1, now }).action, 'nudge');
  assert.equal(decide({ kind: 'search', ready: true, lastQueryAt: now - 1000, now }).action, 'allow');
  for (const mode of ['soft', 'strict']) {
    assert.equal(decide({ kind: 'search', ready: false, mode, now }).action, 'allow');
    assert.equal(decide({ kind: 'other', ready: true, mode, now }).action, 'allow');
  }
});

test('guardMode: padrão soft; strict e off por variável (GRAPHIFY_HOOK_MODE ou o antigo GRAPHIFY_HOOK_STRICT)', () => {
  assert.equal(guardMode({}), 'soft');
  assert.equal(guardMode({ GRAPHIFY_HOOK_MODE: 'strict' }), 'strict');
  assert.equal(guardMode({ GRAPHIFY_HOOK_STRICT: '1' }), 'strict');
  assert.equal(guardMode({ GRAPHIFY_HOOK_MODE: 'off' }), 'off');
  assert.equal(guardMode({ GRAPHIFY_HOOK_STRICT: '0', GRAPHIFY_HOOK_MODE: 'strict' }), 'off');
  assert.equal(guardMode({ GRAPHIFY_HOOK_MODE: 'qualquer-coisa' }), 'soft');
});

// ---- hooks de ponta a ponta -------------------------------------------------------------

function graphRepo({ graph = true } = {}) {
  const repo = tempRepo({ 'README.md': '# x\n' });
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'gbin-'));
  const fake = path.join(bin, 'graphify');
  fs.writeFileSync(fake, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  if (graph) {
    fs.mkdirSync(path.join(repo.dir, 'graphify-out'));
    fs.writeFileSync(path.join(repo.dir, 'graphify-out', 'graph.json'), '{}');
  }
  const env = { GRAPHIFY_BIN: fake, GRAPHIFY_HOOK_STRICT: '', GRAPHIFY_HOOK_MODE: 'strict' }; // os testes de bloqueio usam strict; o padrão real é soft
  const cleanup = () => { repo.cleanup(); fs.rmSync(bin, { recursive: true, force: true }); };
  return { repo, env, cleanup };
}

const claude = (g, tool, input, session = 's1', env = {}) =>
  runScript(g.repo, 'hooks/pre-search-graphify.mjs', { tool_name: tool, tool_input: input, session_id: session }, [], { ...g.env, ...env });

const NODES = "Traversal: BFS depth=2 | Start: ['SplashScreen'] | 41 nodes found\n\nNODE SplashScreen [src=lib/splash/splash_screen.dart loc=None community=47]\n";
const claudePost = (g, input, stdout, session = 's1', extra = {}) =>
  runScript(g.repo, 'hooks/post-search-graphify.mjs', { tool_name: 'Bash', tool_input: input, tool_response: { stdout, stderr: '', interrupted: false, ...extra }, session_id: session }, [], { ...g.env });
const denied = (r) => r.json?.hookSpecificOutput?.permissionDecision === 'deny';

test('hook Claude: nega a primeira busca bruta, só uma consulta BEM-SUCEDIDA libera, isola sessões', () => {
  const g = graphRepo();
  try {
    const first = claude(g, 'Bash', { command: 'grep -rn Splash .' });
    assert.equal(first.code, 0);
    assert.equal(first.json.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(first.json.hookSpecificOutput.permissionDecisionReason, /graphify query/);
    assert.match(first.json.hookSpecificOutput.permissionDecisionReason, /30 min/);
    assert.match(first.json.hookSpecificOutput.permissionDecisionReason, /chamada separada/);
    assert.match(first.json.hookSpecificOutput.permissionDecisionReason, /antes de abrir o agente/);
    assert.doesNotMatch(first.json.hookSpecificOutput.permissionDecisionReason, /nesta sessão/); // o agente não consegue desligar no meio da sessão
    assert.equal(claude(g, 'Grep', { pattern: 'Splash' }).json.hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(claude(g, 'Glob', { pattern: '**/*.dart' }).json.hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(claude(g, 'Read', { file_path: 'a.dart' }).stdout, ''); // Read nunca é bloqueado

    // a consulta em si passa no PreToolUse, mas NÃO abre a janela: antes de rodar não se sabe se deu certo
    assert.equal(claude(g, 'Bash', { command: 'graphify query "SplashScreen"' }).stdout, '');
    assert.ok(denied(claude(g, 'Bash', { command: 'grep -rn Splash .' })), 'consulta ainda não executada não libera');
    // falha, resultado vazio, interrompida e comando que só MENCIONA a consulta não abrem a janela
    claudePost(g, { command: 'graphify query "Nada"' }, 'No matching nodes found.');
    claudePost(g, { command: 'graphify query "X"' }, 'error: graph file not found: /x/graphify-out/graph.json');
    claudePost(g, { command: 'graphify query "X"' }, '');
    claudePost(g, { command: 'graphify query "X"' }, NODES, 's1', { interrupted: true });
    claudePost(g, { command: 'echo graphify query x' }, NODES);
    claudePost(g, { command: 'ls' }, NODES);
    assert.ok(denied(claude(g, 'Grep', { pattern: 'Splash' })), 'nada disso pode abrir a janela');
    // consulta que terminou com resultado abre a janela
    claudePost(g, { command: 'graphify query "SplashScreen"' }, NODES);
    assert.equal(claude(g, 'Bash', { command: 'grep -rn Splash .' }).stdout, '');
    assert.equal(claude(g, 'Grep', { pattern: 'Splash' }).stdout, '');
    assert.ok(denied(claude(g, 'Grep', { pattern: 'Splash' }, 'outra-sessao')), 'janela é por sessão');
  } finally { g.cleanup(); }
});

test('hook Claude: falha aberta sem grafo, sem a CLI, com escape ou com entrada inválida', () => {
  const noGraph = graphRepo({ graph: false });
  const g = graphRepo();
  try {
    assert.equal(claude(noGraph, 'Bash', { command: 'rg Splash' }).stdout, '');
    assert.equal(claude(g, 'Bash', { command: 'rg Splash' }, 's2', { GRAPHIFY_HOOK_STRICT: '0' }).stdout, '');
    assert.equal(claude(g, 'Bash', { command: 'rg Splash' }, 's3', { GRAPHIFY_BIN: '/nao/existe/graphify' }).stdout, '');
    const garbage = spawnSync(process.execPath, [path.join(QUALITY_DIR, 'hooks/pre-search-graphify.mjs')], { input: 'não é json', encoding: 'utf8' });
    assert.equal(garbage.status, 0);
    assert.equal(garbage.stdout, '');
  } finally { noGraph.cleanup(); g.cleanup(); }
});

// ---- Cline -------------------------------------------------------------------------------

const CLINE_HOOK = path.join(ROOT, '.clinerules', 'hooks', 'PreToolUse');
/** O Cline NUNCA cancela (cancel para a tarefa inteira): a guarda age só por `context`. */
const nudged = (out) => typeof out.context === 'string' && /graphify query/.test(out.context) && out.context === out.contextModification && out.cancel === false;

function cline(g, payload, env = {}) {
  const r = spawnSync(CLINE_HOOK, [], {
    input: JSON.stringify({ clineVersion: '3.40.0', hookName: 'PreToolUse', taskId: 't1', ...payload }),
    encoding: 'utf8',
    env: { ...process.env, QUALITY_ROOT: g.repo.dir, QUALITY_STATE_DIR: path.join(g.repo.dir, 'quality/.state'), ...g.env, ...env },
    timeout: 30_000,
  });
  return { code: r.status, out: JSON.parse(r.stdout), stderr: r.stderr };
}

test('hook Cline: arquivo existe, é executável e tem o nome exato exigido pelo Cline', () => {
  assert.ok(fs.existsSync(CLINE_HOOK));
  assert.ok((fs.statSync(CLINE_HOOK).mode & 0o111) !== 0, 'PreToolUse precisa de bit de execução');
  assert.match(fs.readFileSync(CLINE_HOOK, 'utf8'), /^#!\/usr\/bin\/env node/);
});

test('hook Cline: cancela busca bruta com mensagem pt-BR, libera após graphify query, aceita variações de schema', () => {
  const g = graphRepo();
  try {
    const exec = (command) => ({ preToolUse: { toolName: 'execute_command', parameters: { command } } });
    const denied = cline(g, exec('grep -rn Splash .'));
    assert.equal(denied.code, 0, denied.stderr);
    assert.ok(nudged(denied.out));
    assert.match(denied.out.context, /graphify query/);
    assert.equal(denied.out.errorMessage, undefined, 'sem errorMessage: nada aqui cancela');
    assert.ok(nudged(cline(g, { preToolUse: { toolName: 'search_files', parameters: { regex: 'x', path: '.' } } }).out));
    assert.ok(nudged(cline(g, { preToolUse: { toolName: 'list_files', parameters: { path: '.', recursive: true } } }).out));
    assert.ok(!nudged(cline(g, { preToolUse: { toolName: 'read_file', parameters: { path: 'a.dart' } } }).out));
    // schema alternativo (campos soltos)
    assert.ok(nudged(cline(g, { toolName: 'execute_command', parameters: { command: 'rg Splash' } }).out));

    assert.ok(!nudged(cline(g, exec('graphify query "SplashScreen"')).out));
    assert.ok(nudged(cline(g, exec('grep -rn Splash .')).out), 'consulta ainda não concluída não libera');
    // PostToolUse: falha ou resultado vazio não abrem; consulta com resultado abre, por tarefa
    assert.deepEqual(clinePost(g, extPost('graphify query "X"', NODES, false)).out, {});
    clinePost(g, extPost('graphify query "X"', 'No matching nodes found.'));
    clinePost(g, extPost('echo graphify query x', NODES));
    assert.ok(nudged(cline(g, exec('grep -rn Splash .')).out));
    assert.equal(clinePost(g, extPost('graphify query "SplashScreen"', NODES)).code, 0);
    assert.ok(!nudged(cline(g, exec('grep -rn Splash .')).out));
    assert.ok(nudged(cline(g, { taskId: 'outra', ...exec('grep -rn Splash .') }).out));
  } finally { g.cleanup(); }
});

test('hook Cline: falha aberta (sem grafo, escape, entrada vazia ou desconhecida)', () => {
  const noGraph = graphRepo({ graph: false });
  const g = graphRepo();
  try {
    const search = { preToolUse: { toolName: 'execute_command', parameters: { command: 'rg Splash' } } };
    assert.deepEqual(cline(noGraph, search).out, { cancel: false });
    assert.deepEqual(cline(g, search, { GRAPHIFY_HOOK_STRICT: '0' }).out, { cancel: false });
    assert.deepEqual(cline(g, {}).out, { cancel: false });
    assert.deepEqual(cline(g, { preToolUse: { toolName: 'ferramenta_nova', parameters: {} } }).out, { cancel: false });
    const empty = spawnSync(CLINE_HOOK, [], { input: '', encoding: 'utf8' });
    assert.deepEqual(JSON.parse(empty.stdout), { cancel: false });
  } finally { noGraph.cleanup(); g.cleanup(); }
});

const CLINE_POST = path.join(ROOT, '.clinerules', 'hooks', 'PostToolUse');

function clinePost(g, payload, env = {}) {
  const r = spawnSync(CLINE_POST, [], {
    input: JSON.stringify({ clineVersion: '3.40.0', hookName: 'PostToolUse', taskId: 't1', ...payload }),
    encoding: 'utf8',
    env: { ...process.env, QUALITY_ROOT: g.repo.dir, QUALITY_STATE_DIR: path.join(g.repo.dir, 'quality/.state'), ...g.env, ...env },
    timeout: 30_000,
  });
  return { code: r.status, out: JSON.parse(r.stdout), stderr: r.stderr };
}
const extPost = (command, result, success = true) => ({ postToolUse: { toolName: 'execute_command', parameters: { command }, result, success, executionTimeMs: 5 } });

// Contrato verificado no código-fonte do Cline SDK (sdk/packages/core/src/hooks): payload
// { tool_call: { name, input } }, saída { cancel, errorMessage, overrideInput }.
const sdkCall = (name, input) => ({ tool_call: { id: 'c1', name, input }, preToolUse: { toolName: name, parameters: {} } });

test('hook Cline (CLI/SDK): run_commands e search_codebase são guardados; read_files/editor passam', () => {
  const g = graphRepo();
  try {
    assert.ok(nudged(cline(g, sdkCall('run_commands', 'rg Splash')).out));
    assert.ok(nudged(cline(g, sdkCall('run_commands', ['ls', 'grep -rn Splash .'])).out));
    assert.ok(nudged(cline(g, sdkCall('run_commands', { commands: ['git status', 'find . -name "*.dart"'] })).out));
    assert.ok(nudged(cline(g, sdkCall('run_commands', { command: 'rg Splash' })).out));
    assert.ok(nudged(cline(g, sdkCall('search_codebase', { queries: ['Splash'] })).out));
    assert.ok(!nudged(cline(g, sdkCall('read_files', { files: [{ path: 'a.dart' }] })).out));
    assert.ok(!nudged(cline(g, sdkCall('editor', { path: 'a.dart', new_text: 'x' })).out));
    assert.ok(!nudged(cline(g, sdkCall('run_commands', ['ls', 'git status'])).out));

    assert.ok(!nudged(cline(g, sdkCall('run_commands', { commands: ['graphify query "SplashScreen"'] })).out));
    assert.ok(nudged(cline(g, sdkCall('search_codebase', { queries: ['Splash'] })).out), 'ainda sem resultado registrado');
    // PostToolUse do SDK: parâmetros como mapa de strings (commands vem serializado em JSON)
    const sdkPost = { tool_result: { name: 'run_commands' }, postToolUse: { toolName: 'run_commands', parameters: { commands: '["graphify query \\"SplashScreen\\""]' }, result: NODES, success: true, executionTimeMs: 9 } };
    assert.equal(clinePost(g, sdkPost).code, 0);
    assert.ok(!nudged(cline(g, sdkCall('search_codebase', { queries: ['Splash'] })).out)); // janela aberta
  } finally { g.cleanup(); }
});

test('hook Cline (extensão VS Code): parâmetros em JSON string e nomes clássicos', () => {
  const g = graphRepo();
  try {
    const ext = (toolName, parameters) => ({ preToolUse: { toolName, parameters } });
    assert.ok(nudged(cline(g, ext('list_files', { path: '.', recursive: 'true' })).out));
    assert.ok(!nudged(cline(g, ext('list_files', { path: '.', recursive: 'false' })).out));
    assert.ok(nudged(cline(g, ext('execute_command', { command: 'rg Splash', requires_approval: 'false' })).out));
    assert.deepEqual(commandsOf('["rg a","ls"]'), ['rg a', 'ls']); // lista serializada como string
  } finally { g.cleanup(); }
});

test('rtk no Cline CLI/SDK: overrideInput reescreve preservando o formato; extensão e guarda não reescrevem', () => {
  const g = graphRepo();
  const rtkDir = fakeRtk('[ "$1 $2" = "hook check" ] || exit 2; case "$3" in "git status") echo "rtk git status";; *) echo "No rewrite for: $3"; exit 1;; esac');
  const env = { PATH: `${rtkDir}${path.delimiter}${process.env.PATH}` };
  try {
    const out = (input, e = env) => cline(g, sdkCall('run_commands', input), e).out;
    assert.deepEqual(out('git status').overrideInput, 'rtk git status');
    assert.deepEqual(out(['git status', 'ls']).overrideInput, ['rtk git status', 'ls']);
    assert.deepEqual(out({ commands: ['git status', 'ls'] }).overrideInput, { commands: ['rtk git status', 'ls'] });
    assert.deepEqual(out({ command: 'git status' }).overrideInput, { command: 'rtk git status' });
    assert.equal(out({ command: 'git', args: ['status'] }).overrideInput, undefined); // estruturado: não toca
    assert.equal(out('ls').overrideInput, undefined); // rtk sem reescrita
    assert.equal(out('git status', { ...env, RTK_DISABLED: '1' }).overrideInput, undefined);
    const nodeOnly = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeonly-'));
    fs.symlinkSync(process.execPath, path.join(nodeOnly, 'node'));
    try { assert.equal(out('git status', { PATH: nodeOnly }).overrideInput, undefined); } // sem rtk no PATH
    finally { fs.rmSync(nodeOnly, { recursive: true, force: true }); }
    // extensão VS Code não aceita reescrita: só orientação em regra
    assert.equal(cline(g, { preToolUse: { toolName: 'execute_command', parameters: { command: 'git status' } } }, env).out.overrideInput, undefined);
    // busca com dica: nada cancela
    const denied = out('rg Splash');
    assert.equal(denied.cancel, false);
    assert.ok(/graphify query/.test(denied.context), 'dica, não cancelamento');
    assert.equal(denied.overrideInput, undefined); // o fake do rtk só reescreve `git status`
  } finally { g.cleanup(); fs.rmSync(rtkDir, { recursive: true, force: true }); }
});

test('mapCommands preserva formato e só reescreve strings', () => {
  const up = (c) => (c === 'a' ? 'A' : null);
  assert.deepEqual(mapCommands('a', up), { changed: true, input: 'A' });
  assert.deepEqual(mapCommands(['b', 'a'], up), { changed: true, input: ['b', 'A'] });
  assert.deepEqual(mapCommands({ commands: ['a'], extra: 1 }, up), { changed: true, input: { commands: ['A'], extra: 1 } });
  assert.deepEqual(mapCommands({ cmd: 'a' }, up), { changed: true, input: { cmd: 'A' } });
  assert.deepEqual(mapCommands(['b'], up), { changed: false, input: ['b'] });
  assert.deepEqual(mapCommands(null, up), { changed: false, input: null });
});

// ---- rtk ---------------------------------------------------------------------------------

function fakeRtk(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtkbin-'));
  fs.writeFileSync(path.join(dir, 'rtk'), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return dir;
}
const rtkHook = (input, env) => spawnSync(process.execPath, [path.join(QUALITY_DIR, 'hooks/pre-bash-rtk.mjs')], {
  input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, ...env },
});
const bashInput = (command) => ({ tool_name: 'Bash', tool_input: { command } });

test('wrapper rtk: repassa a reescrita do `rtk hook claude`; sem rtk ou desligado não faz nada', () => {
  const rewrite = '{"hookSpecificOutput":{"hookEventName":"PreToolUse","updatedInput":{"command":"rtk git status"}}}';
  const dir = fakeRtk(`cat >/dev/null; echo '${rewrite}'`);
  try {
    const r = rtkHook(bashInput('git status'), { PATH: `${dir}${path.delimiter}${process.env.PATH}` });
    assert.equal(r.status, 0);
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.updatedInput.command, 'rtk git status');
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, undefined); // nunca aprova sozinho
    assert.equal(rtkHook(bashInput('git status'), { PATH: `${dir}${path.delimiter}${process.env.PATH}`, RTK_DISABLED: '1' }).stdout, '');
    assert.equal(rtkHook(bashInput('git status'), { PATH: '/nao/existe' }).stdout, '');
    const broken = fakeRtk('exit 3');
    try { assert.equal(rtkHook(bashInput('git status'), { PATH: `${broken}${path.delimiter}${process.env.PATH}` }).stdout, ''); }
    finally { fs.rmSync(broken, { recursive: true, force: true }); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('rtk real (quando instalado): reescreve git status e deixa node quality/run.mjs em paz', { skip: spawnSync('rtk', ['--version']).status !== 0 }, () => {
  const git = JSON.parse(rtkHook(bashInput('git status'), {}).stdout);
  assert.equal(git.hookSpecificOutput.updatedInput.command, 'rtk git status');
  assert.equal(rtkHook(bashInput('node quality/run.mjs'), {}).stdout, '');
});

test('gitflow continua vendo commit/push com o prefixo rtk que o hook injeta', () => {
  assert.deepEqual(classifyCommand('rtk git push origin develop').map((c) => c.type), ['push']);
  assert.deepEqual(classifyCommand('rtk git commit -m x').map((c) => c.type), ['commit']);
  assert.deepEqual(classifyCommand('rtk git status'), []);
  assert.deepEqual(parseGitOps('rtk git switch -c feat/x develop').map((o) => o.op), parseGitOps('git switch -c feat/x develop').map((o) => o.op));
  assert.ok(parseGitOps('rtk git push origin develop').length > 0);
});

// ---- registro e espelho --------------------------------------------------------------------

test('settings.json: o despachante único cobre rtk, guarda, evidência e gitflow (testes dedicados em pre-bash-dispatch.test.mjs)', () => {
  const pre = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude/settings.json'), 'utf8')).hooks.PreToolUse;
  const search = pre.filter((e) => /Bash/.test(e.matcher));
  assert.equal(search.length, 1);
  for (const h of search.flatMap((e) => e.hooks)) assert.ok(fs.existsSync(path.join(ROOT, h.command.match(/quality\/hooks\/[\w.-]+/)[0])), h.command);
});

test('.clinerules espelha .claude/rules sem divergência; --check detecta deriva', () => {
  assert.deepEqual(sync(ROOT, { check: true }), []);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cline-'));
  try {
    fs.mkdirSync(path.join(tmp, '.claude/rules'), { recursive: true });
    for (const m of MIRRORS) fs.writeFileSync(path.join(tmp, '.claude/rules', m.source), '# regra\n');
    assert.equal(sync(tmp, { check: true }).length, MIRRORS.length); // nada gerado ainda
    sync(tmp);
    assert.deepEqual(sync(tmp, { check: true }), []);
    fs.appendFileSync(path.join(tmp, '.clinerules', MIRRORS[0].target), 'edição manual\n');
    assert.equal(sync(tmp, { check: true }).length, 1);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('regra de economia de tokens cobre graphify, rtk e modo conciso; skills e AGENTS.md apontam para ela', () => {
  const rule = fs.readFileSync(path.join(ROOT, '.claude/rules/economia-de-tokens.md'), 'utf8');
  for (const word of ['graphify query', 'rtk', 'caveman', 'modo-conciso', 'GRAPHIFY_HOOK_MODE', 'não bloqueia', 'aborta a tarefa']) assert.match(rule, new RegExp(word), word);
  for (const skill of ['busca-de-codigo', 'modo-conciso']) {
    const text = fs.readFileSync(path.join(ROOT, `.claude/skills/${skill}/SKILL.md`), 'utf8');
    assert.match(text, new RegExp(`^---\\nname: ${skill}\\n`));
    assert.ok(/description: .{40,}/.test(text), skill);
    assert.match(fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8'), new RegExp(`skills/${skill}/SKILL\\.md`), `AGENTS.md → ${skill}`);
  }
  assert.match(fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8'), /@\.claude\/rules\/economia-de-tokens\.md/);
  assert.match(fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8'), /pre-bash-dispatch\.mjs/);
  assert.match(fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8'), /Cline nunca cancela/);
});

// ---- analisador de shell (falsos positivos e negativos que o review reproduziu) -------------

test('analisador: heredoc, --version, cd para fora e subshell/bash -c/xargs', () => {
  const root = '/extra/paulo-yapper/Projects/fluxo';
  const kind = (command) => classifyCall('claude', 'Bash', { command }, root).kind;
  const cases = [
    // antes eram bloqueios indevidos
    ['cat > /tmp/x.sh <<"EOF"\nrg foo .\ngrep -rn bar lib\nEOF', 'other'],
    ['python3 - <<"EOF"\nprint("find . -name x")\nEOF', 'other'],
    ['rg --version', 'other'],
    ['grep --help', 'other'],
    ['cd /tmp && rg foo', 'other'],
    ['cd ~ && grep -rn x .', 'other'],
    // antes passavam
    ['x=$(rg Foo lib) && echo $x', 'search'],
    ['echo `rg Foo lib`', 'search'],
    ['bash -c "rg Foo lib"', 'search'],
    ["sh -c 'grep -rn Foo .'", 'search'],
    ['git ls-files | xargs grep -l Foo', 'search'],
    ['find lib -type f | xargs rg Foo', 'search'],
    ['cd /tmp && cd /extra/paulo-yapper/Projects/fluxo && rg foo', 'search'],
    // uma consulta só vale se for o COMANDO; mencioná-la não conta
    ['echo graphify query x', 'other'],
    ['echo graphify query x && rg Foo .', 'search'],
    ["rg 'graphify query' lib", 'search'],
    ['graphify query "X" && ls', 'query'],
    ['rtk proxy graphify explain X', 'query'],
    ['graphify update .', 'other'],
  ];
  for (const [command, expected] of cases) assert.equal(kind(command), expected, command);
});

test('grafo velho: a mensagem de bloqueio avisa quando código mudou depois da geração', () => {
  const g = graphRepo();
  try {
    const graph = path.join(g.repo.dir, 'graphify-out', 'graph.json');
    const old = new Date(Date.now() - 3600_000);
    fs.utimesSync(graph, old, old);
    g.repo.write('lib/nova_tela.dart', 'class NovaTela {}\n'); // arquivo de código criado depois do grafo
    const stale = claude(g, 'Bash', { command: 'rg NovaTela lib' });
    assert.match(stale.json.hookSpecificOutput.permissionDecisionReason, /desatualizado \(1 arquivo/);
    assert.match(stale.json.hookSpecificOutput.permissionDecisionReason, /graphify-build\.mjs --update/);
    const fresh = new Date(Date.now() + 60_000);
    fs.utimesSync(graph, fresh, fresh); // grafo regenerado depois da edição
    const ok = claude(g, 'Bash', { command: 'rg NovaTela lib' }, 's-fresco');
    assert.doesNotMatch(ok.json.hookSpecificOutput.permissionDecisionReason, /desatualizado/);
  } finally { g.cleanup(); }
});

// ---- modo suave (padrão), isenções e "o Cline nunca cancela" ---------------------------------------

test('buscas fora do código não entram na guarda: docs/, *.md, *.json, --include de texto', () => {
  const root = '/extra/paulo-yapper/Projects/fluxo';
  const kind = (command) => classifyCall('claude', 'Bash', { command }, root).kind;
  for (const command of ['grep -rn Splash docs', 'rg Foo docs/entregas', 'rg Foo config.json', 'grep -rn x . --include=*.md', 'find docs -name "*.md"', 'grep -rn x .github']) {
    assert.equal(kind(command), 'other', command);
  }
  for (const command of ['rg Foo lib', 'grep -rn x . --include=*.dart', 'find lib -name "*.dart"']) assert.equal(kind(command), 'search', command);
  assert.equal(classifyCall('claude', 'Grep', { pattern: 'x', path: 'docs' }, root).kind, 'other');
  assert.equal(classifyCall('claude', 'Grep', { pattern: 'x', glob: '*.md' }, root).kind, 'other');
  assert.equal(classifyCall('claude', 'Grep', { pattern: 'x', glob: '*.dart' }, root).kind, 'search');
  assert.equal(classifyCall('claude', 'Glob', { pattern: 'docs/**/*.md' }, root).kind, 'other');
  assert.equal(classifyCall('cline', 'search_files', { regex: 'x', path: '.', file_pattern: '*.json' }, root).kind, 'other');
  assert.equal(classifyCall('cline', 'list_files', { path: 'docs', recursive: true }, root).kind, 'other');
});

test('Claude no modo suave (padrão): nunca nega; dica por additionalContext UMA vez por janela', () => {
  const g = graphRepo();
  try {
    const soft = { GRAPHIFY_HOOK_MODE: 'soft' };
    const first = claude(g, 'Bash', { command: 'rg Splash lib' }, 's1', soft);
    assert.equal(first.code, 0);
    assert.equal(first.json.hookSpecificOutput.permissionDecision, undefined, 'sem decisão: o fluxo normal de permissão segue');
    assert.match(first.json.hookSpecificOutput.additionalContext, /não bloqueia nada/);
    assert.match(first.json.hookSpecificOutput.additionalContext, /graphify query/);
    assert.equal(claude(g, 'Bash', { command: 'rg Outra lib' }, 's1', soft).stdout, '');
    assert.equal(claude(g, 'Grep', { pattern: 'x' }, 's1', soft).stdout, '');
    assert.match(claude(g, 'Grep', { pattern: 'x' }, 's2', soft).json.hookSpecificOutput.additionalContext, /graphify query/);
    assert.equal(claude(g, 'Bash', { command: 'rg Foo docs' }, 's3', soft).stdout, '');
    const defaults = claude(g, 'Bash', { command: 'rg Splash lib' }, 's4', { GRAPHIFY_HOOK_MODE: '' });
    assert.equal(defaults.json.hookSpecificOutput.permissionDecision, undefined);
    assert.ok(defaults.json.hookSpecificOutput.additionalContext);
  } finally { g.cleanup(); }
});

test('Cline: NUNCA cancela, em nenhum modo (cancel aborta a tarefa inteira); a guarda só anexa contexto', () => {
  const g = graphRepo();
  try {
    const searches = [
      { preToolUse: { toolName: 'execute_command', parameters: { command: 'rg Splash lib' } } },
      { preToolUse: { toolName: 'search_files', parameters: { regex: 'x', path: '.' } } },
      sdkCall('run_commands', 'grep -rn Splash .'),
      sdkCall('search_codebase', { queries: ['Splash'] }),
    ];
    for (const mode of ['strict', 'soft', 'off']) {
      for (const [i, payload] of searches.entries()) {
        const out = cline(g, { taskId: `${mode}-${i}`, ...payload }, { GRAPHIFY_HOOK_MODE: mode, GRAPHIFY_HOOK_STRICT: '' }).out;
        assert.equal(out.cancel, false, `${mode}: cancelou ${JSON.stringify(payload).slice(0, 50)}`);
        assert.equal(out.errorMessage, undefined);
      }
    }
    const soft = { GRAPHIFY_HOOK_MODE: 'soft', GRAPHIFY_HOOK_STRICT: '' };
    assert.ok(nudged(cline(g, searches[0], soft).out), 'primeira busca recebe a dica');
    assert.ok(!nudged(cline(g, searches[1], soft).out), 'segunda busca da mesma tarefa não repete');
    assert.ok(nudged(cline(g, { taskId: 'outra', ...searches[0] }, soft).out), 'outra tarefa recebe a sua');
    assert.ok(!nudged(cline(g, { taskId: 'off', ...searches[0] }, { GRAPHIFY_HOOK_MODE: 'off', GRAPHIFY_HOOK_STRICT: '' }).out));
    assert.ok(nudged(cline(g, { taskId: 'est', ...searches[0] }, { GRAPHIFY_HOOK_MODE: 'strict', GRAPHIFY_HOOK_STRICT: '' }).out));
    assert.ok(nudged(cline(g, { taskId: 'est', ...searches[1] }, { GRAPHIFY_HOOK_MODE: 'strict', GRAPHIFY_HOOK_STRICT: '' }).out), 'strict repete a dica');
    assert.doesNotMatch(fs.readFileSync(path.join(QUALITY_DIR, 'hooks/cline-pre-tool-use.mjs'), 'utf8').replace(/\/\/.*$/gm, ''), /cancel:\s*true/);
  } finally { g.cleanup(); }
});
