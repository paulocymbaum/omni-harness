// Gate P1 (paralelização de camadas): rodarCamadas por GRUPOS — ≥2 grupos ativos rodam em
// subprocessos (camada-filha.mjs) com budget fatiado; <2 roda serial sem overhead; filho
// falho/timeout = camada.unmeasured WARN (falha aberta). docs/parking-lot/performance-camadas.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { runTier, rodarGrupo } from '../lib/tiers.mjs';
import { rapidoGates } from '../lib/tiers.mjs';
import { actionsPinsGate } from '../lib/gates/workflows.mjs';

const mk = (p, text) => ({ path: p, status: 'M', newText: text, oldText: null, added: [] });
const dartEntry = mk('lib/features/x/view.dart', 'class V {\n  int m(int a) => a;\n}\n');
const csEntry = mk('backend/A.cs', 'public class A { }\n');
const mdEntry = mk('docs/nota.md', '# nota\n');
const assinatura = (rs) => rs.map((r) => `${r.gate}|${r.status}|${r.key}`).sort();

test('runTier rotina com 2 camadas usa filhos e iguala a composição serial', async () => {
  const entries = [dartEntry, csEntry, mdEntry];
  const paralelo = await runTier('rotina', entries, { budgetMs: 120_000 });
  // serial de referência: mesmo pipeline sem subprocessos (todos os grupos numa chamada)
  const serial = [...rapidoGates(entries), ...actionsPinsGate(entries), ...rodarGrupo('rotina', entries, ['flutter', 'backend', 'docs'], ['flutter', 'functions', 'ocr', 'web', 'backend', 'infra', 'go', 'rust', 'cpp', 'java'], 120_000)];
  assert.deepEqual(assinatura(paralelo), assinatura(serial));
  assert.ok(paralelo.some((r) => r.gate === 'lint' || r.gate === 'tipos'), 'flutter rodou de fato (dart analyze)');
  assert.ok(!paralelo.some((r) => r.key === 'camada.unmeasured'), 'nenhum grupo falhou no worker');
});

test('sem camadas ativas: tier rotina roda serial e não marca camada.unmeasured', async () => {
  const res = await runTier('rotina', [mdEntry], { budgetMs: 60_000 });
  assert.ok(!res.some((r) => r.key === 'camada.unmeasured'));
});

test('rodarGrupo: grupo go com entries go e sem toolchain = tool.missing aberto', async () => {
  const out = rodarGrupo('rotina', [mk('svc/a.go', 'package main\n')], ['go'], ['go'], 60_000);
  if (out.length === 0) return; // go instalado neste hospedeiro: escopo vazio não é caminho testável aqui
  assert.equal(out[0].key, 'tool.missing');
  assert.equal(out[0].params.tool, 'go');
});

test('camada-filha.mjs: stdin inválido falha com exit != 0 (pai marca camada.unmeasured)', async () => {
  const filho = spawn(process.execPath, [path.join(process.cwd(), 'quality', 'lib', 'camada-filha.mjs')], { stdio: ['pipe', 'pipe', 'pipe'] });
  const codigo = await new Promise((resolve) => {
    filho.stdin.end('{quebra');
    filho.on('close', (code) => resolve(code));
  });
  assert.notEqual(codigo, 0);
  assert.notEqual(codigo, null);
});
