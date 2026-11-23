// Testes e2e dos hooks do Gitflow contra um repositório compartilhado simulado:
// origin bare (main + develop) + clone de trabalho + avanço do remote por um "colega".
// Os hooks só decidem (não executam git); os cenários preparam o estado com git real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runScript } from './helpers.mjs';

const g = (dir, ...args) => {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} (${dir}): ${r.stderr.trim()}`);
  return r.stdout.trim();
};
const gx = (dir, ...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' }); // tolera falha (ex.: merge com conflito)

/** Repositório compartilhado: origin bare com main+develop e clone de trabalho em develop. */
function flowRepo() {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gflow-')));
  const origin = path.join(tmp, 'origin.git');
  const work = path.join(tmp, 'work');
  const mirror = path.join(tmp, 'mirror');
  g(tmp, 'init', '--bare', '-b', 'main', 'origin.git');
  spawnSync('git', ['clone', '--quiet', origin, work], { encoding: 'utf8' });
  g(work, 'config', 'user.email', 'agente@fluxo');
  g(work, 'config', 'user.name', 'Agente');
  fs.writeFileSync(path.join(work, 'README.md'), '# fluxo\n');
  g(work, 'add', '-A');
  g(work, 'commit', '-q', '-m', 'inicial');
  g(work, 'push', '-q', 'origin', 'HEAD:main');
  g(work, 'switch', '-c', 'develop');
  g(work, 'push', '-q', 'origin', 'develop');
  return {
    tmp, origin, work, mirror, dir: work,
    cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }),
    commit(file, content, msg) {
      fs.writeFileSync(path.join(work, file), content);
      g(work, 'add', '-A');
      g(work, 'commit', '-q', '-m', msg);
    },
    /** Avança origin/<branch> num clone espelho, como faria outro dev, e remove o espelho. */
    advanceRemote(branch, file, content) {
      fs.rmSync(mirror, { recursive: true, force: true });
      spawnSync('git', ['clone', '--quiet', '-o', 'origin', origin, mirror], { encoding: 'utf8' });
      g(mirror, 'config', 'user.email', 'colega@fluxo');
      g(mirror, 'config', 'user.name', 'Colega');
      g(mirror, 'switch', branch);
      fs.writeFileSync(path.join(mirror, file), content);
      g(mirror, 'add', '-A');
      g(mirror, 'commit', '-q', '-m', `remoto: ${file}`);
      g(mirror, 'push', '-q', 'origin', branch);
    },
  };
}

const pre = (r, command) => runScript(r, 'hooks/pre-bash-gitflow.mjs', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } });
const post = (r, command) => runScript(r, 'hooks/post-bash-gitflow.mjs', { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command } });
const dec = (r) => r.json?.hookSpecificOutput?.permissionDecision ?? null;
const why = (r) => r.json?.hookSpecificOutput?.permissionDecisionReason ?? '';
const allowed = (r) => { assert.equal(r.code, 0, r.stderr); assert.equal(dec(r), null, `esperado allow, veio: ${r.stdout}`); };
const denied = (r, rx) => { assert.equal(dec(r), 'deny', `esperado deny, veio: ${r.stdout}`); assert.match(why(r), rx); };

// HOOKS_PART2_MARKER

test('feat nasce de develop, recebe commit e publica; pai errada é bloqueada', () => {
  const r = flowRepo();
  try {
    allowed(pre(r, 'git switch -c feat/mapa'));
    g(r.work, 'switch', '-c', 'feat/mapa'); // o hook decide; o estado avança com git real
    allowed(pre(r, 'git commit -m "feat(mapa): x"'));
    allowed(pre(r, 'git push origin feat/mapa'));
    g(r.work, 'switch', 'main');
    denied(pre(r, 'git switch -c feat/outra'), /nasce de develop/);
    allowed(pre(r, 'git checkout -b feat/atalho origin/develop')); // startPoint explícito
  } finally { r.cleanup(); }
});

test('hotfix nasce de main; release exige versão e pai develop; taxonomia obrigatória', () => {
  const r = flowRepo();
  try {
    g(r.work, 'switch', 'develop');
    denied(pre(r, 'git switch -c hotfix/app-review'), /nasce de main/);
    denied(pre(r, 'git switch -c release/nome'), /versão semântica/);
    allowed(pre(r, 'git switch -c release/1.4.0'));
    g(r.work, 'switch', 'main');
    denied(pre(r, 'git switch -c release/1.4.0'), /nasce de develop/);
    allowed(pre(r, 'git switch -c hotfix/app-review'));
    denied(pre(r, 'git switch -c tarefa-livre'), /taxonomia/);
  } finally { r.cleanup(); }
});

test('commits diretos em main e develop são proibidos; na branch de trabalho passam', () => {
  const r = flowRepo();
  try {
    g(r.work, 'switch', 'main');
    denied(pre(r, 'git commit -m direto'), /Commit direto em main/);
    g(r.work, 'switch', 'develop');
    denied(pre(r, 'git commit -m direto'), /Commit direto em develop/);
    g(r.work, 'switch', '-c', 'chore/tarefas');
    allowed(pre(r, 'git commit -m "chore: x"'));
  } finally { r.cleanup(); }
});

test('matriz de merge: develop ⇄ trabalho; main só release/hotfix', () => {
  const r = flowRepo();
  try {
    g(r.work, 'switch', '-c', 'fix/bug');
    denied(pre(r, 'git merge main'), /branches de trabalho não se cruzam/);
    denied(pre(r, 'git merge fix/outro'), /não se cruzam/);
    allowed(pre(r, 'git merge develop'));
    g(r.work, 'switch', 'develop');
    allowed(pre(r, 'git merge fix/bug'));
    denied(pre(r, 'git merge main'), /main não flui para develop/);
    g(r.work, 'switch', 'main');
    denied(pre(r, 'git merge fix/bug'), /via release/);
    allowed(pre(r, 'git merge hotfix/algo'));
    allowed(pre(r, 'git merge release/1.4.0'));
  } finally { r.cleanup(); }
});

test('push: main e develop diretos proibidos; develop aceita merge commit', () => {
  const r = flowRepo();
  try {
    denied(pre(r, 'git push origin HEAD:main'), /Push para main/);
    denied(pre(r, 'git push origin main'), /Push para main/);
    g(r.work, 'switch', 'develop');
    r.commit('solto.txt', 'x\n', 'commit solto');
    denied(pre(r, 'git push origin develop'), /develop recebe merges/);
    g(r.work, 'reset', '-q', '--hard', 'HEAD~1'); // setup: desfaz o commit solto
    g(r.work, 'switch', '-c', 'feat/conteudo');
    r.commit('novo.txt', 'n\n', 'feat');
    g(r.work, 'switch', 'develop');
    g(r.work, 'merge', '--no-ff', '-m', 'merge feat/conteudo', 'feat/conteudo');
    allowed(pre(r, 'git push origin develop'));
  } finally { r.cleanup(); }
});

test('sync com remote: pai atrás trava criação; branch atrás/divergida trava push', () => {
  const r = flowRepo();
  try {
    r.advanceRemote('develop', 'remoto-develop.txt', 'por outro dev\n');
    denied(pre(r, 'git switch -c feat/nova'), /atrás de origin\/develop/);
    g(r.work, 'pull', '--ff-only', 'origin', 'develop'); // setup: sincroniza
    allowed(pre(r, 'git switch -c feat/nova'));
    g(r.work, 'switch', '-c', 'feat/nova');
    allowed(pre(r, 'git push origin feat/nova'));
    g(r.work, 'push', '-q', 'origin', 'feat/nova'); // publica de verdade p/ o colega avançar
    r.advanceRemote('feat/nova', 'remoto-feat.txt', 'colega empurrou\n');
    denied(pre(r, 'git push origin feat/nova'), /atrás de origin\/feat\/nova/);
    r.commit('local.txt', 'l\n', 'trabalho local'); // diverge do remoto
    denied(pre(r, 'git push origin feat/nova'), /divergiu de origin\/feat\/nova/);
    denied(pre(r, 'git push --force origin feat/nova'), /--force é proibido/);
    g(r.work, 'pull', '--rebase', '-q', 'origin', 'feat/nova'); // setup: rebase sobre o remoto
    allowed(pre(r, 'git push --force-with-lease origin feat/nova'));
    denied(pre(r, 'git push --force origin develop'), /compartilhada e protegida/);
  } finally { r.cleanup(); }
});

// HOOKS_PART3_MARKER

test('pull sem rebase é bloqueado em trabalho; rebase/reset em permanentes proibidos', () => {
  const r = flowRepo();
  try {
    g(r.work, 'switch', '-c', 'feat/linear');
    denied(pre(r, 'git pull'), /use rebase/);
    allowed(pre(r, 'git pull --rebase origin feat/linear'));
    g(r.work, 'switch', 'develop');
    denied(pre(r, 'git rebase main'), /Rebase em develop/);
    denied(pre(r, 'git reset --hard HEAD~1'), /reset --hard em develop/);
    g(r.work, 'switch', '-c', 'fix/outra');
    allowed(pre(r, 'git reset --hard HEAD~1')); // em branch de trabalho é permitido
  } finally { r.cleanup(); }
});

test('conflito para o fluxo: post bloqueia com runbook; pre só libera resolução', () => {
  const r = flowRepo();
  try {
    r.commit('shared.txt', 'base\n', 'base compartilhado');
    g(r.work, 'push', '-q', 'origin', 'develop');
    g(r.work, 'switch', '-c', 'feat/conflito');
    r.commit('shared.txt', 'lado feat\n', 'lado feat');
    r.advanceRemote('develop', 'shared.txt', 'lado develop\n'); // conflito garantido
    g(r.work, 'fetch', '-q', 'origin');
    gx(r.work, 'merge', 'origin/develop'); // conflito real

    const blocked = post(r, 'git merge develop');
    assert.equal(blocked.json.decision, 'block');
    assert.match(blocked.json.reason, /CONFLITO GIT \(merge\)/);
    assert.match(blocked.json.reason, /shared\.txt/);
    assert.match(blocked.json.reason, /git commit \(conclui o merge\)/);
    assert.match(blocked.json.reason, /git merge --abort/);
    denied(pre(r, 'git push origin feat/conflito'), /Operação git em andamento/);
    denied(pre(r, 'git stash'), /Operação git em andamento/);
    denied(pre(r, 'git commit -m fim'), /conclua com/);
    allowed(pre(r, 'git add shared.txt')); // resolução liberada
    allowed(pre(r, 'git checkout -- shared.txt'));
    // resolução de verdade + progresso sem conflito informa sem bloquear
    fs.writeFileSync(path.join(r.work, 'shared.txt'), 'resolvido\n');
    g(r.work, 'add', '-A');
    const prog = post(r, 'git status');
    assert.match(prog.json.hookSpecificOutput.additionalContext, /conclua com: git commit/);
    g(r.work, 'commit', '-q', '-m', 'merge resolvido');
    allowed(pre(r, 'git push origin feat/conflito'));
    assert.equal(post(r, 'git push origin feat/conflito').stdout.trim(), '');
  } finally { r.cleanup(); }
});

test('delete: permanentes proibidas; branch de trabalho não mesclada pede confirmação', () => {
  const r = flowRepo();
  try {
    denied(pre(r, 'git push origin --delete develop'), /Apagar develop/);
    denied(pre(r, 'git branch -D main'), /Apagar main/);
    g(r.work, 'switch', '-c', 'feat/nao-mesclada');
    r.commit('w.txt', 'w\n', 'wip');
    assert.equal(dec(pre(r, 'git push origin --delete feat/nao-mesclada')), 'ask');
  } finally { r.cleanup(); }
});

test('sem acesso ao remote: pede confirmação humana (ask) em vez de deixar passar', () => {
  const r = flowRepo();
  try {
    g(r.work, 'switch', '-c', 'feat/off');
    g(r.work, 'remote', 'remove', 'origin');
    const askPush = pre(r, 'git push origin feat/off');
    assert.equal(dec(askPush), 'ask');
    assert.match(why(askPush), /origin/);
    g(r.work, 'switch', 'develop'); // criação só é avaliada após passar pela política de pai
    assert.equal(dec(pre(r, 'git switch -c feat/off2')), 'ask');
  } finally { r.cleanup(); }
});

test('hooks não quebram com entrada vazia/inválida e ignoram comandos sem git', () => {
  const r = flowRepo();
  try {
    for (const h of ['hooks/pre-bash-gitflow.mjs', 'hooks/post-bash-gitflow.mjs']) {
      assert.equal(runScript(r, h, null).code, 0);
      assert.equal(runScript(r, h, { tool_input: { command: 'node quality/run.mjs --tier rapido' } }).stdout.trim(), '');
    }
  } finally { r.cleanup(); }
});
