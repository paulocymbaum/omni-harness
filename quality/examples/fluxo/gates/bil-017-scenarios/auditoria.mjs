// BIL-017-AUDITORIA-SEM-APAGAR. Roda functions/scripts/audit_fluxo_empresas_ids.js de verdade no emulador.
// Contrato que este gate fixa, além da spec (mesmas opções de backfill_fluxo_empresas_menu.js: --project, --database, --report, --apply):
// relatório JSON { mode: 'dry-run'|'apply', collections: { <coleção>: { scanned, missingBusinessId, mismatchedBusinessId, filled } }, merchantsForReview: [{ merchantId, reason }] }.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, exists } from '../bil-gate-helper.mjs';
import { DATABASE, PROJECT, collector, functionsRequire, withEmulators } from '../bil-017-gate-helper.mjs';

const SCRIPT = 'functions/scripts/audit_fluxo_empresas_ids.js';
const COLLECTIONS = ['orders', 'services', 'appointments', 'service_slots'];
const PERSONAL = ['Fulana Gate', 'fulana@gate.test', '00000000000191', 'Rua Gate 123'];

async function seed(db) {
  await db.doc('merchants/m-antigo').set({ merchantId: 'm-antigo', businessId: 'biz-antiga', name: 'Loja Gate', type: 'seller', document: PERSONAL[2], address: PERSONAL[3] });
  await db.doc('merchants/m-rever-nome').set({ merchantId: 'm-rever-nome', businessId: 'm-rever-nome', name: 'Empresa', type: 'restaurant' });
  await db.doc('merchants/m-rever-tipo').set({ merchantId: 'm-rever-tipo', businessId: 'm-rever-tipo', name: 'Bar Gate', type: 'other' });
  for (const col of COLLECTIONS) {
    const pii = { customerName: PERSONAL[0], customerEmail: PERSONAL[1] };
    await db.doc(`${col}/certo`).set({ merchantId: 'biz-1', businessId: 'biz-1', ...pii });
    await db.doc(`${col}/sem-pelo-merchant`).set({ merchantId: 'm-antigo', ...pii });
    await db.doc(`${col}/sem-pelo-id`).set({ merchantId: 'biz-sem-doc', ...pii });
    await db.doc(`${col}/nulo`).set({ merchantId: 'biz-sem-doc', businessId: null, ...pii });
    await db.doc(`${col}/divergente`).set({ merchantId: 'biz-2', businessId: 'biz-3', ...pii });
  }
}

const snapshot = async (db) => {
  const state = {};
  for (const col of [...COLLECTIONS, 'merchants']) {
    for (const doc of (await db.collection(col).get()).docs) state[`${col}/${doc.id}`] = { data: doc.data(), updateTime: doc.updateTime.toMillis() };
  }
  return state;
};

function audit(hosts, dir, name, extra = []) {
  const report = path.join(dir, `${name}.json`);
  const run = spawnSync('node', [path.join(ROOT, SCRIPT), '--project', PROJECT, '--database', DATABASE, '--report', report, ...extra], {
    cwd: dir, encoding: 'utf8', timeout: 30_000, env: { ...process.env, FIRESTORE_EMULATOR_HOST: hosts.firestore, GCLOUD_PROJECT: PROJECT },
  });
  assert.equal(run.status, 0, `auditoria ${name} saiu com ${run.status}:\n${run.stdout}\n${run.stderr}`);
  const text = fs.readFileSync(report, 'utf8');
  return { text, json: JSON.parse(text), output: `${run.stdout}\n${run.stderr}` };
}

const data = (state) => Object.fromEntries(Object.entries(state).map(([key, value]) => [key, value.data]));

export async function runAuditoria() {
  assert.ok(exists(SCRIPT), `arquivo ausente: ${SCRIPT}`);
  const { check, done } = collector();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bil-017-audit-'));
  try {
    await withEmulators(['firestore'], async (hosts) => {
      process.env.FIRESTORE_EMULATOR_HOST = hosts.firestore;
      const { Firestore } = functionsRequire('@google-cloud/firestore');
      const db = new Firestore({ projectId: PROJECT, databaseId: DATABASE });
      try {
        await seed(db);
        const start = await snapshot(db);
        const dry = audit(hosts, dir, 'dry');
        check('dry-run é o padrão', dry.json.mode === 'dry-run', dry.json.mode);
        assert.deepEqual(await snapshot(db), start, 'dry-run não escreve');
        for (const col of COLLECTIONS) {
          const c = dry.json.collections?.[col] ?? {};
          check(`dry-run conta ${col}`, c.scanned === 5 && c.missingBusinessId === 3 && c.mismatchedBusinessId === 1 && c.filled === 0, JSON.stringify(c));
        }
        const review = (dry.json.merchantsForReview ?? []).map((m) => m.merchantId).sort();
        check('merchants para revisão humana', review.join() === 'm-rever-nome,m-rever-tipo', review.join());
        for (const [name, run] of [['dry', dry]]) {
          for (const secret of PERSONAL) check(`relatório ${name} sem dado pessoal`, !`${run.text}\n${run.output}`.includes(secret), secret);
        }
        const applied = audit(hosts, dir, 'apply', ['--apply']);
        for (const secret of PERSONAL) check('relatório apply sem dado pessoal', !`${applied.text}\n${applied.output}`.includes(secret), secret);
        const after = await snapshot(db);
        check('--apply não cria nem apaga documento', Object.keys(after).sort().join() === Object.keys(start).sort().join());
        for (const col of COLLECTIONS) {
          check(`${col}: preenche pelo merchant`, after[`${col}/sem-pelo-merchant`]?.data.businessId === 'biz-antiga', JSON.stringify(after[`${col}/sem-pelo-merchant`]?.data));
          check(`${col}: preenche pelo próprio merchantId`, after[`${col}/sem-pelo-id`]?.data.businessId === 'biz-sem-doc');
          check(`${col}: campo nulo conta como ausente`, after[`${col}/nulo`]?.data.businessId === 'biz-sem-doc');
          for (const id of ['certo', 'divergente']) check(`${col}/${id} intacto`, after[`${col}/${id}`]?.updateTime === start[`${col}/${id}`].updateTime);
          check(`${col}: --apply só preenche businessId`, after[`${col}/sem-pelo-id`]?.data.customerName === PERSONAL[0]);
          check(`${col}: filled = 3`, applied.json.collections?.[col]?.filled === 3, JSON.stringify(applied.json.collections?.[col]));
        }
        for (const id of ['m-antigo', 'm-rever-nome', 'm-rever-tipo']) {
          check(`merchants/${id} não é renomeado`, after[`merchants/${id}`]?.updateTime === start[`merchants/${id}`].updateTime);
        }
        const repeat = audit(hosts, dir, 'repeat', ['--apply']);
        assert.deepEqual(await snapshot(db), after, 'segundo --apply é idempotente');
        for (const col of COLLECTIONS) check(`${col}: segundo --apply não preenche nada`, repeat.json.collections?.[col]?.filled === 0);
        check('nenhum campo sumiu no --apply', Object.keys(data(start)).every((key) => Object.keys(start[key].data).every((f) => f in after[key].data)));
      } finally {
        await db.terminate();
      }
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  done();
}
