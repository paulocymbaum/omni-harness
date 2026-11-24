// BIL-017-REGRAS-CONSULTAS. Consultas reais do app (fluxo_empresas_repository_impl.dart) e do site (F1.5), com o firestore.rules atual, no emulador.
import fs from 'node:fs';
import { DATABASE, PROJECT, RULES, collector, functionsRequire, withEmulators } from '../bil-017-gate-helper.mjs';

const BIZ = 'biz-1';
const DAY = 86_400_000;

async function outcome(run) {
  try {
    const snap = await run();
    return { ok: true, size: snap.size };
  } catch (error) {
    return { ok: false, code: String(error?.code ?? error?.message) };
  }
}

async function seed(env) {
  const { Timestamp } = functionsRequire('firebase/firestore');
  const soon = Timestamp.fromMillis(Date.now() + DAY);
  const now = Timestamp.now();
  await env.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore({ databaseId: DATABASE });
    await db.doc(`businessProfiles/${BIZ}/members/ativo`).set({ uid: 'ativo', businessId: BIZ, role: 'ADMIN', status: 'active' });
    await db.doc(`businessProfiles/${BIZ}/members/revogado`).set({ uid: 'revogado', businessId: BIZ, role: 'ADMIN', status: 'revoked' });
    const owned = { merchantId: BIZ, businessId: BIZ };
    await db.doc('orders/o1').set({ ...owned, status: 'received', total: 42, createdAt: now });
    await db.doc('services/s1').set({ ...owned, name: 'Corte', durationMinutes: 30, price: 40, active: true });
    await db.doc('appointments/a1').set({ ...owned, serviceName: 'Corte', startsAt: soon, status: 'scheduled' });
    await db.doc('affiliate_links/l1').set({ producerBusinessId: BIZ, status: 'draft', updatedAt: now, createdAt: now });
    await db.doc('commission_ledger/c1').set({ targetType: 'business', targetId: BIZ, amount: 12, status: 'pending', updatedAt: now });
  });
}

const merchantQueries = (db, field) => {
  const { Timestamp } = functionsRequire('firebase/firestore');
  const yesterday = Timestamp.fromMillis(Date.now() - DAY);
  return field === 'merchantId'
    ? {
      'app orders merchantId+createdAt': () => db.collection('orders').where('merchantId', '==', BIZ).orderBy('createdAt', 'desc').limit(80).get(),
      'app services merchantId+name': () => db.collection('services').where('merchantId', '==', BIZ).orderBy('name').limit(80).get(),
      'app appointments merchantId+startsAt': () => db.collection('appointments').where('merchantId', '==', BIZ).where('startsAt', '>=', yesterday).orderBy('startsAt').limit(80).get(),
    }
    : {
      'site orders businessId+createdAt': () => db.collection('orders').where('businessId', '==', BIZ).orderBy('createdAt', 'desc').limit(100).get(),
      'site services businessId+name': () => db.collection('services').where('businessId', '==', BIZ).orderBy('name').limit(100).get(),
      'site appointments businessId+startsAt': () => db.collection('appointments').where('businessId', '==', BIZ).orderBy('startsAt', 'desc').limit(100).get(),
    };
};

const sharedQueries = (db) => ({
  'links producerBusinessId+status+updatedAt': () => db.collection('affiliate_links').where('producerBusinessId', '==', BIZ).where('status', '==', 'draft').orderBy('updatedAt', 'desc').limit(100).get(),
  'ledger targetType+targetId+updatedAt': () => db.collection('commission_ledger').where('targetType', '==', 'business').where('targetId', '==', BIZ).orderBy('updatedAt', 'desc').limit(100).get(),
});

export async function runRegrasConsultas() {
  const { initializeTestEnvironment } = functionsRequire('@firebase/rules-unit-testing');
  const { setLogLevel } = functionsRequire('firebase/firestore');
  setLogLevel('silent');
  const { check, done } = collector();
  await withEmulators(['firestore'], async ({ firestorePort }) => {
    const env = await initializeTestEnvironment({ projectId: PROJECT, firestore: { rules: fs.readFileSync(RULES, 'utf8'), host: '127.0.0.1', port: firestorePort } });
    try {
      await seed(env);
      const dbOf = (uid) => (uid ? env.authenticatedContext(uid) : env.unauthenticatedContext()).firestore({ databaseId: DATABASE });
      const all = (db) => ({ ...merchantQueries(db, 'merchantId'), ...merchantQueries(db, 'businessId'), ...sharedQueries(db) });
      for (const [name, run] of Object.entries(all(dbOf('ativo')))) {
        const r = await outcome(run);
        check(`membro ativo em ${name}`, r.ok && r.size === 1, r.ok ? `devolveu ${r.size} documentos` : r.code);
      }
      for (const uid of ['intruso', 'revogado', null]) {
        for (const [name, run] of Object.entries(all(dbOf(uid)))) {
          const r = await outcome(run);
          check(`${uid ?? 'anônimo'} em ${name}`, !r.ok && /permission/i.test(r.code), r.ok ? `leu ${r.size} documentos` : r.code);
        }
      }
      const db = dbOf('ativo');
      const legacy = await outcome(() => db.collection('affiliate_links').where('businessId', '==', BIZ).orderBy('createdAt', 'desc').limit(100).get());
      check('afiliados por businessId segue negado', !legacy.ok && /permission/i.test(legacy.code), JSON.stringify(legacy));
      for (const [path, data] of [['orders/o1', { total: 1 }], ['services/s1', { price: 1 }], ['appointments/a1', { status: 'paid' }], ['orders/novo', { merchantId: BIZ, businessId: BIZ }]]) {
        const set = await outcome(() => db.doc(path).set(data, { merge: true }));
        check(`escrita de cliente em ${path} segue negada`, !set.ok, 'cliente escreveu');
      }
      for (const path of ['orders/o1', 'services/s1', 'appointments/a1']) {
        const del = await outcome(() => db.doc(path).delete());
        check(`remoção de cliente em ${path} segue negada`, !del.ok, 'cliente apagou');
      }
    } finally {
      await env.cleanup();
    }
  });
  done();
}
