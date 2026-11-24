// BIL-017-MERCHANT-SO-POSTGRES. Handlers reais no emulador, sem merchants/{id}: desde o corte o merchant nasce só no PostgreSQL.
import { codeOf, collector, compileFunctions, loadHandlers, withEmulators } from '../bil-017-gate-helper.mjs';

const BIZ = 'biz-so-postgres';
const members = { dono: 'OWNER', admin: 'ADMIN', editor: 'EDITOR', operador: 'OPERATOR', leitor: 'VIEWER' };

export async function runMerchantSoPostgres() {
  const { check, done } = collector();
  const { lib, cleanup } = compileFunctions();
  try {
    await withEmulators(['firestore'], async (hosts) => {
      const { db, call } = loadHandlers(lib, hosts);
      try {
        await Promise.all(Object.entries(members).map(([uid, role]) =>
          db.doc(`businessProfiles/${BIZ}/members/${uid}`).set({ uid, businessId: BIZ, role, status: 'active' })));
        const order = { merchantId: BIZ, items: [{ name: 'Smash', quantity: 1, price: 20 }], total: 20, customerName: 'Cliente' };
        const service = { merchantId: BIZ, name: 'Corte', durationMinutes: 30, price: 40 };
        const created = { order: null, service: null };
        for (const uid of ['dono', 'admin', 'editor', 'operador']) {
          try {
            created.order = (await call('empresasV1CreateOrder', uid, order)).order;
            created.service = (await call('empresasV1CreateService', uid, service)).service;
            const startsAt = new Date(Date.now() + 86_400_000 + Object.keys(members).indexOf(uid) * 7_200_000).toISOString();
            const appointment = (await call('empresasV1CreateAppointment', uid, { merchantId: BIZ, serviceId: created.service.id, startsAt })).appointment;
            for (const [name, doc] of [['pedido', created.order], ['serviço', created.service], ['agendamento', appointment]]) {
              check(`${name} de ${uid} grava os dois campos`, doc.businessId === BIZ && doc.merchantId === BIZ, JSON.stringify({ businessId: doc.businessId, merchantId: doc.merchantId }));
            }
          } catch (error) {
            check(`${uid} cria pedido, serviço e agendamento sem merchants/{id}`, false, `${error.code}: ${error.message}`);
          }
        }
        const before = (await db.collection('orders').get()).size;
        for (const [uid, label] of [['estranho', 'não membro'], ['leitor', 'VIEWER']]) {
          check(`${label} segue negado em pedido`, await codeOf(call('empresasV1CreateOrder', uid, order)) === 'permission-denied');
          check(`${label} segue negado em serviço`, await codeOf(call('empresasV1CreateService', uid, service)) === 'permission-denied');
        }
        check('nada foi gravado pelos negados', (await db.collection('orders').get()).size === before);
        const update = await codeOf(call('empresasV1UpdateMerchant', 'admin', { merchantId: BIZ, name: 'Novo nome' }));
        check('empresasV1UpdateMerchant segue falhando sem documento', update === 'failed-precondition', update);
        check('nenhum merchants/{id} nasceu pelo caminho', !(await db.doc(`merchants/${BIZ}`).get()).exists);
        await db.doc('merchants/antigo').set({ merchantId: 'antigo', businessId: BIZ, name: 'Antigo' });
        const legacy = await call('empresasV1CreateOrder', 'admin', { ...order, merchantId: 'antigo' }).catch((error) => ({ order: { failed: error.message } }));
        check('merchant antigo com ID diferente usa o businessId do documento', legacy.order.businessId === BIZ && legacy.order.merchantId === 'antigo', JSON.stringify(legacy.order));
      } finally {
        await db.terminate();
      }
    });
  } finally {
    cleanup();
  }
  done();
}
