// Gate R-HOSTS — o instalador semeia a integração CERTA por host de agente:
//   hooks nativos → Claude Code (.claude) e Cline (.clinerules/hooks);
//   carriers de instruções → VS Code/Copilot (.github), Antigravity (.antigravity/rules), Kiro (.kiro/steering);
//   Codex → AGENTS.md da raiz (sem hook de repo). Registro: quality/lib/hosts.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { repoRoot } from '../lib/util.mjs';
import { HOSTS, ALL_IDS, DEFAULT_HOSTS, parseHosts, carrierFor, carrierContent, resolveHosts } from '../lib/hosts.mjs';

const ROOT = repoRoot();
const INIT = path.join(ROOT, 'scripts', 'harness-init.mjs');

function init(dest, hostsSpec) {
  const args = [INIT, dest, '--nome', 'fixture-hosts'];
  if (hostsSpec) args.push('--hosts', hostsSpec);
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 90_000 });
  assert.equal(r.status, 0, `init --hosts ${hostsSpec ?? '(default)'} falhou: ${r.stderr}`);
}

test('registro: 6 hosts com ids únicos; default = claude-code + cline', () => {
  assert.deepEqual(ALL_IDS.sort(), ['antigravity', 'claude-code', 'cline', 'codex', 'kiro', 'vscode'].sort());
  assert.deepEqual(DEFAULT_HOSTS, ['claude-code', 'cline']);
  for (const h of HOSTS) assert.ok(h.nome && h.nota, `host ${h.id} sem nome/nota`);
});

test('parseHosts: all, lista, erro de id desconhecido e default', () => {
  assert.deepEqual(parseHosts('all').ids, ALL_IDS);
  assert.deepEqual(parseHosts('kiro,vscode').ids, ['kiro', 'vscode']);
  const ruim = parseHosts('cursor');
  assert.equal(ruim.ids.length, 0);
  assert.match(ruim.erros[0], /cursor/);
  assert.deepEqual(parseHosts(undefined).ids, DEFAULT_HOSTS);
});

test('carriers: caminhos por host e conteúdo apontando AGENTS.md + motor', () => {
  assert.equal(carrierFor('codex', 'x'), null, 'codex usa AGENTS.md, sem carrier');
  const kiro = carrierFor('kiro', 'fixture');
  assert.equal(kiro.relPath, '.kiro/steering/omni-harness.md');
  assert.match(kiro.content, /AGENTS\.md/);
  assert.match(kiro.content, /quality\/run\.mjs --tier rapido/);
  assert.match(carrierContent('qualquer').split('\n')[0], /Omni Harness/);
});

test('init --hosts all: integração de TODOS os hosts no fixture', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hosts-all-'));
  try {
    init(tmp, 'all');
    for (const p of [
      '.claude/settings.json',
      '.clinerules/hooks/PreToolUse',
      '.github/copilot-instructions.md',
      '.antigravity/rules/omni-harness.md',
      '.kiro/steering/omni-harness.md',
      'AGENTS.md',
      'quality/profile/fixture-hosts.json',
    ]) {
      assert.ok(fs.existsSync(path.join(tmp, p)), `faltando após --hosts all: ${p}`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}, { timeout: 120_000 });

test('init --hosts vscode: só carrier de instruções (sem hooks de nenhum tipo)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hosts-vscode-'));
  try {
    init(tmp, 'vscode');
    assert.ok(fs.existsSync(path.join(tmp, '.github', 'copilot-instructions.md')));
    assert.equal(fs.existsSync(path.join(tmp, '.claude', 'settings.json')), false, 'claude-code não foi pedido');
    assert.equal(fs.existsSync(path.join(tmp, '.clinerules', 'hooks', 'PreToolUse')), false, 'cline não foi pedido');
    const carrier = fs.readFileSync(path.join(tmp, '.github', 'copilot-instructions.md'), 'utf8');
    assert.match(carrier, /Omni Harness/);
    assert.match(carrier, /quality\/run\.mjs/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}, { timeout: 90_000 });

test('init default (sem --hosts) = claude-code + cline, sem carriers', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hosts-default-'));
  try {
    init(tmp);
    assert.ok(fs.existsSync(path.join(tmp, '.claude', 'settings.json')));
    assert.ok(fs.existsSync(path.join(tmp, '.clinerules', 'hooks', 'TaskComplete')));
    assert.equal(fs.existsSync(path.join(tmp, '.github', 'copilot-instructions.md')), false);
    assert.equal(fs.existsSync(path.join(tmp, '.kiro')), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}, { timeout: 90_000 });

test('resolveHosts: defaults sem override; override do hospedeiro troca carrier/integration', () => {
  const sem = resolveHosts(os.tmpdir());
  const vscode = sem.hosts.find((h) => h.id === 'vscode');
  assert.equal(vscode.carrier.path, '.github/copilot-instructions.md', 'default do núcleo');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hosts-override-'));
  try {
    fs.mkdirSync(path.join(root, 'quality'), { recursive: true });
    fs.writeFileSync(path.join(root, 'quality', 'hosts.json'), JSON.stringify({
      hosts: {
        kiro: { carrier: '.agentrules/omni-harness.md' },
        vscode: { integration: ['.github/instructions/omni-harness.instructions.md'] },
      },
    }));
    const r = resolveHosts(root);
    assert.deepEqual(r.erros, []);
    const kiro = r.hosts.find((h) => h.id === 'kiro');
    assert.equal(kiro.carrier.path, '.agentrules/omni-harness.md');
    assert.equal(kiro.integration.some((x) => x.includes('.agentrules')), false, 'carrier é gerado, não copiado do núcleo');
    const vs = r.hosts.find((h) => h.id === 'vscode');
    assert.deepEqual(vs.integration, ['.github/instructions/omni-harness.instructions.md']);
    assert.equal(r.hosts.find((h) => h.id === 'claude-code').integration.includes('.claude/settings.json'), true, 'sem override não muda');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolveHosts: JSON inválido reporta erro sem derrubar; host desconhecido é citado', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hosts-invalido-'));
  try {
    fs.mkdirSync(path.join(root, 'quality'), { recursive: true });
    fs.writeFileSync(path.join(root, 'quality', 'hosts.json'), '{"hosts": {');
    const r = resolveHosts(root);
    assert.ok(r.erros.some((e) => e.includes('hosts.json')), r.erros.join('; '));
    assert.equal(r.hosts.length, ALL_IDS.length, 'defaults prevalecem');
    fs.writeFileSync(path.join(root, 'quality', 'hosts.json'), '{"hosts": { "cursor": { "carrier": "x" } }}');
    const r2 = resolveHosts(root);
    assert.ok(r2.erros.some((e) => e.includes('cursor')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('init e2e com override do hospedeiro: kiro instala no caminho sobrescrito (.agentrules)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hosts-override-e2e-'));
  try {
    fs.mkdirSync(path.join(tmp, 'quality'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'quality', 'hosts.json'), JSON.stringify({
      hosts: { kiro: { carrier: '.agentrules/omni-harness.md' } },
    }));
    const r = spawnSync(process.execPath, [INIT, tmp, '--nome', 'fixture-hosts', '--hosts', 'kiro'], { encoding: 'utf8', timeout: 90_000 });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(path.join(tmp, '.agentrules', 'omni-harness.md')), 'carrier no caminho sobrescrito');
    assert.equal(fs.existsSync(path.join(tmp, '.kiro')), false, 'default não deve existir com override');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}, { timeout: 120_000 });

test('init --hosts inválido: falha citando os ids válidos', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hosts-inv-'));
  try {
    const r = spawnSync(process.execPath, [INIT, tmp, '--hosts', 'cursor,warp'], { encoding: 'utf8', timeout: 30_000 });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /cursor/);
    assert.match(r.stderr, /warp/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
