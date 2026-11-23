// Grafo de deploy (comandos-curtos/deploy): ordem topológica respeita deps, mermaid
// traz todos os nós e o passo com gate humano fica visível no plano.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { STEPS, FEITOS, topoOrdem, mermaid, planoTexto } from '../../scripts/deploy/grafo.mjs';

test('ordem topológica: nenhum passo antes das deps; todos presentes; validação primeiro', () => {
  const ordem = topoOrdem();
  const pos = new Map(ordem.map((s, i) => [s.id, i]));
  for (const s of ordem) {
    for (const d of s.deps) assert.ok(pos.get(d) < pos.get(s.id), `${d} deve vir antes de ${s.id}`);
  }
  assert.equal(ordem.length, STEPS.length);
  assert.equal(ordem[0].id, 'validacao');
});

test('mermaid: liga push → seguranca → release-tag e traz os nós do épico', () => {
  const g = mermaid();
  assert.match(g, /push na RELEASE.*seguranca|seguranca.*push/s);
  for (const no of ['Release Tag', 'Cloud Run', 'GHCR', 'Production', 'Done']) assert.match(g, new RegExp(no));
});

test('plano: passos FEITOS sem gate humano; passo opcional marcado', () => {
  const plano = planoTexto(STEPS, {}).join('\n');
  // deploy-web está em FEITOS (deploy local concluído): o gate humano (secrets do Environment prod)
  // deixou de ser relevante e o plano não o marca mais.
  assert.doesNotMatch(plano, /GATE HUMANO/);
  assert.match(plano, /\(opcional\)/);
  assert.match(plano, /✓ feito/);
});

test('FEITOS: produção, seguranca, main-merge, deploy-api, deploy-worker e deploy-web registrados', () => {
  assert.equal(FEITOS.length, 6);
  for (const id of ['jira-production', 'seguranca', 'main-merge', 'deploy-api', 'deploy-worker', 'deploy-web']) {
    assert.ok(FEITOS.some((f) => f.id === id), `${id} deve estar em FEITOS`);
  }
});

test('modo local: passos de deploy têm variante local com prereq; worker usa o namespace correto do ghcr', () => {
  const porId = new Map(STEPS.map((s) => [s.id, s]));
  for (const id of ['deploy-api', 'deploy-worker', 'deploy-web', 'deploy-admin']) {
    const s = porId.get(id);
    assert.ok(s?.local?.cmd, `${id} deve ter local.cmd para Actions sem minutos`);
    assert.ok(s.local.requer, `${id} deve declarar o prereq do modo local`);
  }
  assert.match(porId.get('deploy-worker').local.cmd, /southamerica-east1-docker\.pkg\.dev\/fluxo-ath\/fluxo\/fluxo-creator-worker/);
  assert.match(porId.get('deploy-api').local.cmd, /scripts\/deploy\/local\/deploy-api\.sh/);
  assert.ok(existsSync(new URL('../../scripts/deploy/local/deploy-api.sh', import.meta.url)),
    'script de replicação da API deve existir');
});

test('versionar e main-merge têm variante local que usa o script de bump (sem Actions)', () => {
  for (const id of ['versionar', 'main-merge']) {
    const step = STEPS.find((s) => s.id === id);
    assert.ok(step?.local, `${id} precisa de variante local`);
    assert.match(step.local.cmd, /scripts\/deploy\/local\/release-bump\.mjs/);
    assert.ok(step.local.requer, `${id}: prereqs explícitos`);
  }
});

test('versionar não usa && num cli (o executor quebra por espaço e ignoraria o segundo comando)', () => {
  const versionar = STEPS.find((s) => s.id === 'versionar');
  assert.equal(versionar.executar.tipo, 'cli');
  assert.doesNotMatch(versionar.executar.cmd, /&&|;|\|/);
  assert.doesNotMatch(versionar.executar.cmd, /git push origin RELEASE/, 'nada de push direto na RELEASE');
});
