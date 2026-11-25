// Gate QG-027 — deploy esquecido: detector determinístico (homologação aprovada + deploy.md velho/ausente)
// e o gancho no Stop. Fixtures com timestamps fixos: AGORA é congelado para o teste ser determinístico.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deployPendente, entregasComDeployPendente } from '../../../lib/deploy-pendente.mjs';

const AGORA = Date.parse('2026-11-22T12:00:00Z');
const RAIZ = resolve(fileURLToPath(new URL('..', import.meta.url)));
const RAIZ_HARNESS = resolve(fileURLToPath(new URL('../../../..', import.meta.url)));

const backlog = (estado, aprovada_em) => ({
  homologacao: { estado, ...(aprovada_em ? { aprovada_em } : {}) },
  tasks: [{ id: 'X-001', status: 'done', done_at: aprovada_em ?? '2026-11-22T10:00:00Z' }],
});

function entrega(base, nome, bl, { deployMd } = {}) {
  const dir = path.join(base, nome);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'backlog.json'), JSON.stringify(bl));
  if (deployMd) {
    const f = path.join(dir, 'deploy.md');
    fs.writeFileSync(f, '# deploy');
    const t = deployMd === 'antes' ? AGORA - 7200_000 : AGORA + 3600_000;
    fs.utimesSync(f, new Date(t), new Date(t));
  }
  return dir;
}

test('aprovada SEM deploy.md → pendente', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'qg027-'));
  try {
    const r = deployPendente(entrega(base, 'e1', backlog('aprovada', '2026-11-22T11:00:00Z')), { agora: AGORA });
    assert.equal(r.pendente, true);
    assert.match(r.motivo, /sem deploy\.md/);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('aprovada com deploy.md DEPOIS da aprovação → ok', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'qg027-'));
  try {
    const r = deployPendente(entrega(base, 'e2', backlog('aprovada', '2026-11-22T11:00:00Z'), { deployMd: 'depois' }), { agora: AGORA });
    assert.equal(r.pendente, false);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('aprovada com deploy.md ANTES da aprovação → pendente', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'qg027-'));
  try {
    const r = deployPendente(entrega(base, 'e3', backlog('aprovada', '2026-11-22T11:00:00Z'), { deployMd: 'antes' }), { agora: AGORA });
    assert.equal(r.pendente, true);
    assert.match(r.motivo, /não foi tocado/);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('implantada e em_homologacao não são pendência; aprovação fora da janela também não', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'qg027-'));
  try {
    assert.equal(deployPendente(entrega(base, 'impl', backlog('implantada')), { agora: AGORA }).pendente, false);
    assert.equal(deployPendente(entrega(base, 'emh', backlog('em_homologacao')), { agora: AGORA }).pendente, false);
    const velha = backlog('aprovada', '2026-10-20T10:00:00Z');
    assert.equal(deployPendente(entrega(base, 'velha', velha), { agora: AGORA }).pendente, false);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('sem marca de tempo: cai no done_at mais recente da entrega', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'qg027-'));
  try {
    const r = deployPendente(entrega(base, 'sem', backlog('aprovada')), { agora: AGORA });
    assert.equal(r.pendente, true);
    assert.equal(r.stamp, Date.parse('2026-11-22T10:00:00Z'));
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('varredura: só a entrega com pendência aparece', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'qg027-'));
  try {
    entrega(base, 'pendentes-2026-11-22-x', backlog('aprovada', '2026-11-22T11:00:00Z'));
    entrega(base, 'ok-2026-11-22-y', backlog('implantada'));
    const lista = entregasComDeployPendente(base, { agora: AGORA, raizEntregas: '.' });
    assert.deepEqual(lista.map((l) => l.nome), ['pendentes-2026-11-22-x']);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('gancho no Stop: stop.mjs consulta o detector e usa a mensagem de deploy pendente', () => {
  const stop = readFileSync(path.join(RAIZ_HARNESS, 'quality', 'hooks', 'stop.mjs'), 'utf8');
  assert.match(stop, /lembretesDeDeploy/);
  const mensagens = readFileSync(path.join(RAIZ_HARNESS, 'quality', 'messages.pt-BR.json'), 'utf8');
  assert.match(mensagens, /hook\.stop\.deployPendente/);
});
