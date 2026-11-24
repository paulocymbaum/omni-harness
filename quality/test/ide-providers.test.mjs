// Gate R-PROVEDORES — verifica, provedor a provedor, que as IDEs/agentes suportados ficam
// FUNCIONAIS após o `harness-init`: estrutura instalada + ponto de entrada respondendo.
//   hooks nativos  → Claude Code (.claude) e Cline (.clinerules/hooks): o hook responde JSON;
//   carriers       → VS Code/Copilot (.github), Antigravity (.antigravity/rules), Kiro (.kiro/steering)
//                    e Codex (AGENTS.md da raiz): conteúdo aponta AGENTS.md + motor via CLI.
// Registro dos hosts: quality/lib/hosts.mjs. Decisões: docs/parking-lot/harness-agnostico.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { repoRoot } from '../lib/util.mjs';
import { HOSTS } from '../lib/hosts.mjs';

const ROOT = repoRoot();
const INIT = path.join(ROOT, 'scripts', 'harness-init.mjs');
const BIN = path.join(ROOT, 'bin', 'omni-harness.mjs');

function initHost(dest, hostId) {
  const r = spawnSync(process.execPath, [INIT, dest, '--nome', `prov-${hostId}`, '--hosts', hostId], { encoding: 'utf8', timeout: 90_000 });
  assert.equal(r.status, 0, `init --hosts ${hostId} falhou: ${r.stderr}`);
}

/** Roda um hook do hospedeiro (node <script>) com stdin JSON e devolve { code, json, stderr }. */
function runHook(dest, scriptRel, payload) {
  const r = spawnSync(process.execPath, [path.join(dest, scriptRel)], {
    input: JSON.stringify(payload), encoding: 'utf8', timeout: 60_000,
  });
  let json = null;
  try { json = r.stdout?.trim() ? JSON.parse(r.stdout) : null; } catch { /* saída textual */ }
  return { code: r.status, json, stderr: r.stderr };
}

test('registro de provedores: hooks nativos × carriers × AGENTS.md', () => {
  const by = Object.fromEntries(HOSTS.map((h) => [h.id, h]));
  assert.equal(by['claude-code'].carrier, undefined, 'claude-code usa hooks nativos');
  assert.ok(by['claude-code'].integration.includes('.claude/settings.json'));
  assert.equal(by['cline'].carrier, undefined, 'cline usa hooks nativos');
  assert.ok(by['cline'].integration.length >= 5, '5 pontos de integração do Cline');
  assert.equal(by.codex.integration.length, 0, 'codex usa só AGENTS.md da raiz');
  assert.equal(by.vscode.carrier?.path, '.github/copilot-instructions.md');
  assert.equal(by.antigravity.carrier?.path, '.antigravity/rules/omni-harness.md');
  assert.equal(by.kiro.carrier?.path, '.kiro/steering/omni-harness.md');
  assert.ok(by.opencode.integration.includes('.opencode/plugin/omni-harness.js'), 'opencode recebe o plugin de hooks');
  assert.equal(by.opencode.carrier, undefined, 'opencode lê AGENTS.md da raiz');
  assert.equal(by.kimicode.integration.length, 0, 'kimicode usa AGENTS.md da raiz (hooks nativos ainda sem formato público)');
  assert.equal(by.kimicode.carrier, undefined, 'kimicode lê AGENTS.md nativo');
});

// ── Provedor: Claude Code ──────────────────────────────────────────────────────
test('provedor claude-code: settings de hooks + regras de domínio bloqueiam (exit 2)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-cc-'));
  try {
    initHost(tmp, 'claude-code');
    assert.ok(fs.existsSync(path.join(tmp, '.claude', 'settings.json')), 'settings.json instalado');
    assert.ok(fs.existsSync(path.join(tmp, '.claude', 'hooks', 'regras-de-dominio.mjs')), 'hooks .claude instalados');
    const ss = runHook(tmp, path.join('quality', 'hooks', 'session-start.mjs'), {});
    assert.equal(ss.code, 0, ss.stderr);
    assert.equal(ss.json?.hookSpecificOutput?.hookEventName, 'SessionStart');
    assert.match(ss.json?.hookSpecificOutput?.additionalContext ?? '', /Gates de qualidade/, 'contexto de abertura');
    // Ponto de entrada funcional do host: regras de domínio bloqueiam CPF literal (exit 2).
    const cpf = spawnSync(process.execPath, [path.join(tmp, '.claude', 'hooks', 'regras-de-dominio.mjs')], {
      input: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: 'lib/x.dart', content: "const doc = '123.456.789-09';" } }),
      encoding: 'utf8', timeout: 60_000,
    });
    assert.equal(cpf.status, 2, 'regra de domínio deve bloquear com exit 2');
    assert.match(cpf.stderr, /REPROVADO/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}, { timeout: 120_000 });

// ── Provedor: Cline ────────────────────────────────────────────────────────────
test('provedor cline: hooks finos respondem JSON válido (Pre/Post/TaskStart)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-cline-'));
  try {
    initHost(tmp, 'cline');
    const pre = runHook(tmp, path.join('.clinerules', 'hooks', 'PreToolUse'), {
      preToolUse: { toolName: 'execute_command', parameters: { command: 'grep -rn Splash .' } },
    });
    assert.equal(pre.code, 0, pre.stderr);
    assert.equal(pre.json?.cancel, false, 'Cline nunca cancela a tarefa');
    const post = runHook(tmp, path.join('.clinerules', 'hooks', 'PostToolUse'), {
      postToolUse: { toolName: 'editor', parameters: { command: 'create', path: 'src/x.ts', file_text: 'export const x = 1;\n' }, success: true },
    });
    assert.equal(post.code, 0, post.stderr);
    assert.ok(post.json && typeof post.json === 'object', 'PostToolUse responde JSON');
    const start = runHook(tmp, path.join('.clinerules', 'hooks', 'TaskStart'), { taskId: 't1' });
    assert.equal(start.code, 0, start.stderr);
    assert.match(start.json?.context ?? '', /Gates de qualidade/, 'contexto de abertura');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}, { timeout: 120_000 });

// ── Provedores com carrier de instruções ──────────────────────────────────────
for (const host of HOSTS.filter((h) => h.carrier)) {
  test(`provedor ${host.id}: carrier aponta AGENTS.md e o motor via CLI`, () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `prov-${host.id}-`));
    try {
      initHost(tmp, host.id);
      const carrierRel = host.carrier.path;
      assert.ok(fs.existsSync(path.join(tmp, carrierRel)), `carrier ausente: ${carrierRel}`);
      const content = fs.readFileSync(path.join(tmp, carrierRel), 'utf8');
      assert.match(content, /AGENTS\.md/, `${host.id}: carrier aponta o prompt núcleo`);
      assert.match(content, /quality\/run\.mjs --tier rapido/, `${host.id}: carrier ensina rodar o motor via CLI`);
      // AGENTS.md da raiz acompanha TODOS os hosts (padrão cross-tool, ex.: Codex/Antigravity).
      assert.match(fs.readFileSync(path.join(tmp, 'AGENTS.md'), 'utf8'), /quality\/profile/, 'AGENTS.md aponta o perfil');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, { timeout: 90_000 });
}

// ── Provedor: Codex ────────────────────────────────────────────────────────────
test('provedor codex: AGENTS.md da raiz é o transporte (sem hooks, motor via CLI)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-codex-'));
  try {
    initHost(tmp, 'codex');
    const agents = fs.readFileSync(path.join(tmp, 'AGENTS.md'), 'utf8');
    assert.match(agents, /quality\/profile/, 'AGENTS.md aponta o perfil do hospedeiro');
    assert.match(agents, /node quality\/run\.mjs/, 'AGENTS.md ensina rodar o motor');
    assert.equal(fs.existsSync(path.join(tmp, '.clinerules', 'hooks', 'PreToolUse')), false, 'codex não recebe hooks de outro host');
    const motor = spawnSync(process.execPath, [path.join(tmp, 'quality', 'run.mjs'), '--tier', 'rapido'], { cwd: tmp, encoding: 'utf8', timeout: 120_000 });
    // Host novo sem git: o motor sinaliza com exit e mensagem clara — nunca crash nem silêncio.
    assert.ok(motor.status === 0 || motor.status === 2, `motor no hospedeiro codex falhou inesperadamente: ${motor.stdout}\n${motor.stderr}`);
    assert.match(motor.stdout + motor.stderr, /APROVADO|nenhum arquivo alterado para avaliar|não é um repositório git/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}, { timeout: 150_000 });

// ── Doctor enxerga o provedor instalado, provedor a provedor ──────────────────
for (const host of HOSTS) {
  test(`doctor reconhece o provedor ${host.id} instalado`, () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `prov-doc-${host.id}-`));
    try {
      initHost(tmp, host.id);
      const d = spawnSync(process.execPath, [BIN, 'doctor'], { cwd: tmp, encoding: 'utf8', timeout: 60_000 });
      assert.equal(d.status, 0, d.stderr);
      assert.match(d.stdout, new RegExp(`\\(${host.id}\\)`), `doctor deve listar o provedor ${host.id}`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, { timeout: 90_000 });
}

// ── Provedor: OpenCode ────────────────────────────────────────────────────────
// O plugin é carregado PELO OpenCode (descoberto em .opencode/plugins); aqui validamos que o
// módulo carrega em Node e que os hooks bash passam pelo pre-bash do harness (negação real).
test('provedor opencode: plugin instalado, carregável, e bash passa pelo pre-bash', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-opencode-'));
  try {
    initHost(tmp, 'opencode');
    const pluginRel = path.join('.opencode', 'plugin', 'omni-harness.js');
    assert.ok(fs.existsSync(path.join(tmp, pluginRel)), 'plugin instalado');
    assert.match(fs.readFileSync(path.join(tmp, pluginRel), 'utf8'), /pre-bash\.mjs/, 'plugin fala com o pre-bash');
    assert.match(fs.readFileSync(path.join(tmp, 'AGENTS.md'), 'utf8'), /quality\/profile/, 'AGENTS.md aponta o perfil');
    // OpenCode carrega .js como ESM com seu loader; para o Node puro do teste, o tmp vira ESM.
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ type: 'module' }));
    const mod = await import(path.join(tmp, pluginRel));
    assert.equal(typeof mod.OmniHarness, 'function', 'plugin exporta a factory OmniHarness');
    const hooks = await mod.OmniHarness({ directory: tmp });
    assert.equal(typeof hooks['tool.execute.before'], 'function');
    assert.equal(typeof hooks['tool.execute.after'], 'function');
    assert.match(fs.readFileSync(path.join(tmp, 'AGENTS.md'), 'utf8'), /quality\/profile/, 'AGENTS.md aponta o perfil');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}, { timeout: 120_000 });

test('opencode: before(bash) roda pre-bash e propaga negação; after(edit) roda post-edit e anexa veredito', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-opencode-'));
  try {
    initHost(tmp, 'opencode');
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ type: 'module' }));
    const chamadas = [];
    // cópia em .mjs garante ESM no Node puro (o OpenCode usa o próprio loader para .js)
    const copia = path.join(tmp, 'plugin-under-test.mjs');
    fs.copyFileSync(path.join(tmp, '.opencode', 'plugin', 'omni-harness.js'), copia);
    const mod = await import(copia);
    const hooks = await mod.OmniHarness({
      directory: tmp,
      deps: {
        rodar: (script, payload) => {
          chamadas.push({ script, payload });
          return script.endsWith('pre-bash.mjs')
            ? { code: 2, stderr: 'REPROVADO: commit exige evidência', json: null }
            : { code: 0, stdout: JSON.stringify({ systemMessage: 'tier rápido ok' }), json: { systemMessage: 'tier rápido ok' } };
        },
      },
    });
    // before(bash): pre-bash nega → a tool FALHA com o motivo (throw).
    let falhou = null;
    try {
      await hooks['tool.execute.before']({ tool: 'bash' }, { args: { command: 'git commit -m x' } });
    } catch (erro) {
      falhou = erro.message;
    }
    assert.match(falhou ?? '', /REPROVADO: commit exige evidência/);
    assert.ok(chamadas[0].script.endsWith('pre-bash.mjs'));
    assert.equal(chamadas[0].payload.tool_name, 'Bash');
    // after(edit): post-edit roda e o veredito vai para o metadata da tool.
    const output = { args: { filePath: 'src/x.ts' }, metadata: {} };
    await hooks['tool.execute.after']({ tool: 'edit' }, output);
    assert.ok(chamadas.some((c) => c.script.endsWith('post-edit.mjs')));
    assert.match(output.metadata.harness, /tier rápido ok/);
    // fora das stacks do harness: nada roda.
    chamadas.length = 0;
    await hooks['tool.execute.before']({ tool: 'read' }, { args: {} });
    assert.equal(chamadas.length, 0, 'read não passa pelo harness');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}, { timeout: 120_000 });

// ── Provedor: Kimi Code CLI ───────────────────────────────────────────────────
test('provedor kimicode: AGENTS.md da raiz é o transporte (sem hooks nativos instalados)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-kimicode-'));
  try {
    initHost(tmp, 'kimicode');
    const agents = fs.readFileSync(path.join(tmp, 'AGENTS.md'), 'utf8');
    assert.match(agents, /quality\/profile/, 'AGENTS.md aponta o perfil do hospedeiro');
    assert.match(agents, /node quality\/run\.mjs/, 'AGENTS.md ensina rodar o motor');
    assert.equal(fs.existsSync(path.join(tmp, '.kimi')), false, 'nada instalado em .kimi enquanto o formato de hooks não é público');
    const motor = spawnSync(process.execPath, [path.join(tmp, 'quality', 'run.mjs'), '--tier', 'rapido'], { cwd: tmp, encoding: 'utf8', timeout: 120_000 });
    assert.ok(motor.status === 0 || motor.status === 2, `motor no hospedeiro kimicode falhou inesperadamente: ${motor.stdout}\n${motor.stderr}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}, { timeout: 150_000 });
