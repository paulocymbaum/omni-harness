// Testes ponta a ponta dos hooks, cada um num repositório git temporário (QUALITY_ROOT).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { which } from '../lib/tools.mjs';
import { tempRepo, runScript } from './helpers.mjs';

// Os cenários críticos de backend usam um repo temporário SEM a solution real: são
// herméticos apenas sem SDK dotnet (aí o runner delega o build com um alerta). Em
// máquinas com dotnet (ex.: runner do GitHub) o build real rodaria contra o fixture
// e falharia com MSB1009 — o build verdadeiro do backend é responsabilidade do
// backend-ci.yml. Mesmo padrão do skip por ausência de dart em gates.test.mjs.
const SKIP_BACKEND = which('dotnet')
  ? 'cenário de backend é hermético só sem SDK dotnet (presente nesta máquina; o build real fica no backend-ci.yml)'
  : false;

const FILES = {
  'README.md': '# teste\n',
  'lib/features/feed/domain/post.dart': 'class Post {}\n',
  'lib/features/feed/data/feed_repository.dart': 'class FeedRepository {}\n',
  'lib/features/feed/presentation/feed_page.dart': 'class FeedPage {}\n',
  'functions/src/index.ts': "export * from './features/posts';\nexport const b = 1;\n",
  'functions/src/features/posts.ts': 'export const posts = 1;\n',
  'backend/src/Fluxo.Api/Infrastructure/Idempotency/Filter.cs': 'namespace X;\npublic class Filter {}\n',
};

const edit = (repo, rel, session = 's1') => runScript(repo, 'hooks/post-edit.mjs', {
  session_id: session, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(repo.dir, rel) },
});
const bash = (repo, command, session = 's1') => runScript(repo, 'hooks/pre-bash.mjs', {
  session_id: session, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command },
});
const stop = (repo, session = 's1', active = false) => runScript(repo, 'hooks/stop.mjs', { session_id: session, hook_event_name: 'Stop', stop_hook_active: active });
const decisionOf = (r) => r.json?.hookSpecificOutput?.permissionDecision ?? null;

test('session-start: devolve contexto pt-BR em JSON válido', () => {
  const repo = tempRepo(FILES);
  try {
    const r = runScript(repo, 'hooks/session-start.mjs', { session_id: 's0', source: 'startup' });
    assert.equal(r.code, 0);
    assert.match(r.json.hookSpecificOutput.additionalContext, /Gates de qualidade ativos/);
  } finally { repo.cleanup(); }
});

test('post-edit: edição limpa aprova em pt-BR; import proibido reprova com exit 2', () => {
  const repo = tempRepo(FILES);
  try {
    repo.write('lib/features/feed/presentation/feed_page.dart', 'class FeedPage {\n  final int a = 1;\n}\n');
    const ok = edit(repo, 'lib/features/feed/presentation/feed_page.dart');
    assert.equal(ok.code, 0, ok.stderr);
    assert.match(ok.json.hookSpecificOutput.additionalContext, /^APROVADO — Qualidade \(nível rápido\)/);

    repo.write('lib/features/feed/domain/post.dart', "import 'package:cloud_firestore/cloud_firestore.dart';\n\nclass Post {}\n");
    const bad = edit(repo, 'lib/features/feed/domain/post.dart');
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /REPROVADO/);
    assert.match(bad.stderr, /Importação proibida em lib\/features\/feed\/domain\/post\.dart:1/);
  } finally { repo.cleanup(); }
});

test('post-edit: arquivo fora do repo, arquivo gerado e Markdown não geram ruído', () => {
  const repo = tempRepo(FILES);
  try {
    const outside = runScript(repo, 'hooks/post-edit.mjs', { session_id: 's1', tool_input: { file_path: '/tmp/fora-do-repo.dart' } });
    assert.equal(outside.code, 0);
    assert.equal(outside.stdout, '');
    repo.write('lib/l10n/app_localizations.dart', 'x'.repeat(10) + '\n');
    assert.equal(edit(repo, 'lib/l10n/app_localizations.dart').stdout, '');
    repo.write('README.md', '# mudou\n');
    assert.equal(edit(repo, 'README.md').stdout, '');
  } finally { repo.cleanup(); }
});

test('post-edit: avisa quando o risco da sessão sobe', () => {
  const repo = tempRepo(FILES);
  try {
    repo.write('backend/src/Fluxo.Api/Infrastructure/Idempotency/Filter.cs', 'namespace X;\npublic class Filter { }\n');
    const r = edit(repo, 'backend/src/Fluxo.Api/Infrastructure/Idempotency/Filter.cs');
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.json.hookSpecificOutput.additionalContext, /Risco da alteração subiu para CRÍTICO/);
    // Segunda edição no mesmo nível não repete o aviso.
    const again = edit(repo, 'backend/src/Fluxo.Api/Infrastructure/Idempotency/Filter.cs');
    assert.doesNotMatch(again.stdout, /subiu para/);
  } finally { repo.cleanup(); }
});

test('pre-bash: comandos comuns e strings não disparam', () => {
  const repo = tempRepo(FILES);
  try {
    repo.write('functions/src/features/posts.ts', 'export const posts = 2;\n');
    for (const cmd of ['git status', 'ls -la', 'echo "git commit -m x"', 'grep -rn "firebase deploy" .', 'git log -3']) {
      const r = bash(repo, cmd);
      assert.equal(r.code, 0);
      assert.equal(r.stdout, '', cmd);
    }
  } finally { repo.cleanup(); }
});

test('pre-bash: commit de risco médio exige rotina; evidência libera; nova edição invalida', () => {
  const repo = tempRepo(FILES);
  try {
    repo.write('functions/src/features/posts.ts', 'export const posts = 2;\n');
    const denied = bash(repo, 'git commit -am "feat: posts"');
    assert.equal(decisionOf(denied), 'deny');
    assert.match(denied.json.hookSpecificOutput.permissionDecisionReason, /Commit bloqueado: risco MÉDIO exige o nível rotina.*--tier rotina/);

    const run = runScript(repo, 'run.mjs', null, ['--tier', 'rotina']);
    assert.equal(run.code, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /Evidência registrada: nível rotina, escopo worktree/);
    assert.equal(bash(repo, 'git commit -am "feat: posts"').stdout, '');

    repo.write('functions/src/features/posts.ts', 'export const posts = 3;\n');
    assert.equal(decisionOf(bash(repo, 'git commit -am "feat: posts"')), 'deny');
  } finally { repo.cleanup(); }
});

test('pre-bash: evidência só dos arquivos da sessão não libera commit da árvore inteira', () => {
  const repo = tempRepo(FILES);
  try {
    repo.write('functions/src/features/posts.ts', 'export const posts = 2;\n');
    edit(repo, 'functions/src/features/posts.ts');
    const run = runScript(repo, 'run.mjs', null, ['--tier', 'rotina', '--session', 's1']);
    assert.match(run.stdout, /escopo session/);
    assert.equal(decisionOf(bash(repo, 'git commit -am x')), 'deny');
  } finally { repo.cleanup(); }
});

test('pre-bash: execução reprovada do nível mantém o bloqueio com mensagem específica', () => {
  const repo = tempRepo(FILES);
  try {
    repo.write('lib/features/feed/data/feed_repository.dart', "class FeedRepository { void a() { print('API fallback to Firestore'); } }\n");
    const run = runScript(repo, 'run.mjs', null, ['--tier', 'rotina']);
    assert.equal(run.code, 1);
    assert.match(run.stdout, /REPROVADO/);
    const r = bash(repo, 'git commit -am x');
    assert.equal(decisionOf(r), 'deny');
    assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /foi REPROVADA/);
  } finally { repo.cleanup(); }
});

test('pre-bash: risco crítico com evidência completa pede confirmação (ask); deploy com flag de custo também', { skip: SKIP_BACKEND }, () => {
  const repo = tempRepo(FILES);
  try {
    repo.write('backend/src/Fluxo.Api/Infrastructure/Idempotency/Filter.cs', 'namespace X;\npublic class Filter { }\n');
    assert.equal(decisionOf(bash(repo, 'git commit -am x')), 'deny');
    const run = runScript(repo, 'run.mjs', null, ['--tier', 'completo']);
    assert.equal(run.code, 0, run.stdout);
    const ask = bash(repo, 'git commit -am x');
    assert.equal(decisionOf(ask), 'ask');
    assert.match(ask.json.hookSpecificOutput.permissionDecisionReason, /Commit com risco CRÍTICO/);
  } finally { repo.cleanup(); }

  const clean = tempRepo(FILES);
  try {
    const r = bash(clean, 'gcloud run services update api --min-instances=3');
    assert.equal(decisionOf(r), 'ask');
    assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /--min-instances/);
    assert.equal(bash(clean, 'gcloud run deploy api --image x').stdout, '');
  } finally { clean.cleanup(); }
});

test('stop: risco baixo nunca bloqueia; sessão sem edições não faz nada', () => {
  const repo = tempRepo(FILES);
  try {
    assert.equal(stop(repo, 'vazia').stdout, '');
    repo.write('lib/features/feed/presentation/feed_page.dart', 'class FeedPage {\n  final int a = 1;\n}\n');
    edit(repo, 'lib/features/feed/presentation/feed_page.dart');
    const r = stop(repo);
    assert.equal(r.json.decision, undefined);
    assert.match(r.json.systemMessage, /Gates de qualidade aprovados ao encerrar \(nível rápido, risco BAIXO\)/);
  } finally { repo.cleanup(); }
});

test('stop: reprovação bloqueia no máximo 2 vezes por estado e depois libera com aviso (anti-loop)', () => {
  const repo = tempRepo(FILES);
  try {
    repo.write('lib/features/feed/data/feed_repository.dart', "class FeedRepository {\n  void a() {\n    print('API fallback to Firestore');\n  }\n}\n");
    edit(repo, 'lib/features/feed/data/feed_repository.dart');
    const first = stop(repo);
    assert.equal(first.json.decision, 'block');
    assert.match(first.json.reason, /Não encerre ainda: 1 gate\(s\) reprovado\(s\) no nível rápido \(risco MÉDIO\)/);
    assert.equal(stop(repo, 's1', true).json.decision, 'block');
    const third = stop(repo, 's1', true);
    assert.equal(third.json.decision, undefined);
    assert.match(third.json.systemMessage, /Intervenção humana necessária/);
  } finally { repo.cleanup(); }
});

test('stop: risco crítico exige o nível completo antes de encerrar; com evidência, libera', { skip: SKIP_BACKEND }, () => {
  const repo = tempRepo(FILES);
  try {
    repo.write('backend/src/Fluxo.Api/Infrastructure/Idempotency/Filter.cs', 'namespace X;\npublic class Filter { }\n');
    edit(repo, 'backend/src/Fluxo.Api/Infrastructure/Idempotency/Filter.cs');
    const blocked = stop(repo);
    assert.equal(blocked.json.decision, 'block');
    assert.match(blocked.json.reason, /Risco CRÍTICO: rode o nível completo/);
    runScript(repo, 'run.mjs', null, ['--tier', 'completo', '--session', 's1']);
    const ok = stop(repo, 's1', true);
    assert.equal(ok.json.decision, undefined, ok.stdout);
  } finally { repo.cleanup(); }
});

test('hooks nunca quebram com entrada inválida (falha segura: exit 0)', () => {
  const repo = tempRepo(FILES);
  try {
    for (const h of ['hooks/post-edit.mjs', 'hooks/pre-bash.mjs', 'hooks/stop.mjs', 'hooks/session-start.mjs']) {
      const r = runScript(repo, h, null);
      assert.equal(r.code, 0, `${h}: ${r.stderr}`);
    }
  } finally { repo.cleanup(); }
});

test('node_modules não rastreado (ex.: symlink) não entra no diff nem no risco', () => {
  const repo = tempRepo(FILES);
  try {
    repo.write('OCR_webscraper_crawler/packages/cache/node_modules/x/index.js', 'module.exports = 1;\n');
    const r = runScript(repo, 'run.mjs', null, ['--risk', '--json']);
    assert.deepEqual(r.json.files, []);
    assert.equal(r.json.risk.level, 'baixo');
  } finally { repo.cleanup(); }
});
