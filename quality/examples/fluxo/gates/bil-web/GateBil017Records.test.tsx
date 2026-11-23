// Gate BIL-017-REGISTROS-VISIVEIS. Template do autor de gates, copiado para pages/ só durante o gate. Firestore e API falsos nas fronteiras, com o formato real dos documentos.
// Contrato que este template fixa, além da spec: BusinessModulePage segue exportada por domain-pages.tsx, diretamente ou por reexportação, e o erro usa ErrorState.
import { cleanup, screen } from '@testing-library/react';
import { Timestamp } from 'firebase/firestore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('firebase/firestore', async (original) => {
  const { fakeFirestore } = await import('./GateBil017Support');
  return { ...(await original<typeof import('firebase/firestore')>()), ...fakeFirestore };
});
vi.mock('@/platform/infrastructure/firebase', () => ({
  firebaseConfigurationMissing: false,
  getFluxoFirebase: () => ({ db: {}, functions: {}, auth: { currentUser: { uid: 'u1', getIdToken: async () => 'token' } }, appCheck: null }),
}));
vi.mock('@/platform/application/auth-context', () => ({ useAuth: () => ({ user: { uid: 'u1' }, canonicalUid: 'u1', loading: false }) }));

import { usePlatformStore } from '@/platform/application/platform-store';
import { mountModule, seedBusiness, store } from './GateBil017Support';
import { BusinessModulePage } from './domain-pages';

const BIZ = 'biz-1';
const ORDER_ID = 'ordabcd1234';
const when = (iso: string) => Timestamp.fromDate(new Date(iso));
const owned = { merchantId: BIZ, businessId: BIZ };
const posted: { path: string; body: unknown }[] = [];
let team: { status: number; body: unknown };
let merchantExists = true;

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function api(url: string, init?: RequestInit) {
  const { pathname } = new URL(url, 'http://gate.test');
  if (init?.method === 'POST') {
    posted.push({ path: pathname, body: JSON.parse(String(init.body)) });
    return reply({ id: BIZ, businessId: BIZ, name: 'Brasa Gate', type: 'restaurant', active: true, ownerUid: 'u1' }, 201);
  }
  if (pathname.endsWith('/team')) return reply(team.body, team.status);
  if (pathname.endsWith('/menu')) return reply([]);
  return merchantExists ? reply({ id: BIZ, businessId: BIZ, name: 'Brasa Gate', type: 'restaurant', active: true, ownerUid: 'u1' }) : reply({ error: { code: 'merchant_not_found' } }, 404);
}

async function open(module: string, type = 'FOOD_PLACE') {
  seedBusiness(BIZ, 'u1', type);
  const view = mountModule(<BusinessModulePage />, BIZ, module);
  return view;
}

const text = (container: HTMLElement) => container.textContent ?? '';

beforeEach(() => {
  store.reset();
  posted.length = 0;
  merchantExists = true;
  team = { status: 200, body: [{ uid: 'membro-1', businessId: BIZ, role: 'EDITOR', status: 'active', permissions: [], displayName: 'Marta Gate', username: null, photoUrl: null }] };
  usePlatformStore.setState({ accountKind: 'business', accountId: BIZ });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => api(String(url), init)));
  store.collections = {
    orders: [
      { id: ORDER_ID, ...owned, items: [{ name: 'Smash duplo', quantity: 2, price: 28.9 }], total: 57.8, status: 'received', paid: false, customerName: 'Cliente Gate', createdAt: when('2026-11-03T15:00:00Z') },
      { id: 'ordapagado1', ...owned, items: [{ name: 'Pedido apagado', quantity: 1, price: 1 }], total: 1, status: 'received', deleted: true, createdAt: when('2026-11-03T15:00:00Z') },
    ],
    services: [{ id: 'svc123456', ...owned, name: 'Corte Gate', durationMinutes: 45, price: 80, active: true }],
    appointments: [{ id: 'apt123456', ...owned, serviceName: 'Corte Gate', price: 80, status: 'scheduled', customerName: 'Rita Gate', startsAt: when('2026-11-03T15:00:00Z'), endsAt: when('2026-11-03T15:45:00Z') }],
    commission_ledger: [{ id: 'led123456', targetType: 'business', targetId: BIZ, amount: 12.34, sourceType: 'order', status: 'pending', updatedAt: when('2026-11-03T15:00:00Z') }],
    affiliate_links: [{ id: 'lnk123456', producerBusinessId: BIZ, externalUrl: 'https://destino.gate.test/oferta', status: 'approved', updatedAt: when('2026-11-03T15:00:00Z') }],
  };
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('registros: dados que a empresa registrou', () => {
  it('pedido mostra itens, total e status em pt-BR, nunca #id', async () => {
    const { container } = await open('operations');
    await screen.findAllByText(/Smash duplo/);
    expect(text(container)).toContain('57,80');
    expect(text(container)).toContain('Cliente Gate');
    expect(text(container)).not.toMatch(/\breceived\b/);
    expect(text(container)).not.toContain(`#${ORDER_ID.slice(0, 8)}`);
  });

  it('pedido com deleted não aparece', async () => {
    const { container } = await open('operations');
    await screen.findAllByText(/Smash duplo/);
    expect(text(container)).not.toContain('Pedido apagado');
  });

  it('agenda mostra serviço, duração e preço, e o agendamento com data e cliente', async () => {
    const { container } = await open('agenda');
    await screen.findAllByText(/Rita Gate/);
    expect(text(container)).toContain('Corte Gate');
    expect(text(container)).toMatch(/45\s*min/);
    expect(text(container)).toContain('80,00');
    expect(text(container)).toMatch(/03\/11|3 de nov/);
    expect(text(container)).not.toMatch(/\bscheduled\b/);
    expect(text(container)).not.toContain('#apt12345');
  });

  it('ledger mostra valor e origem', async () => {
    const { container } = await open('insights');
    await screen.findAllByText(/12,34/);
    expect(text(container)).not.toContain('#led12345');
    expect(text(container)).not.toMatch(/\bpending\b/);
  });

  it('link afiliado aparece pela consulta de producerBusinessId, com destino e status', async () => {
    const { container } = await open('affiliates');
    await screen.findAllByText(/destino\.gate\.test/);
    expect(text(container)).not.toMatch(/\bapproved\b/);
  });

  it('equipe vem da API, com nome, papel e status', async () => {
    store.collections.business_team_members = [{ id: 'antigo', businessId: BIZ, userId: 'velho', role: 'OPERATOR', name: 'Coleção Antiga' }];
    const { container } = await open('team');
    await screen.findAllByText(/Marta Gate/);
    expect(text(container)).toMatch(/editor/i);
    expect(text(container)).not.toContain('Coleção Antiga');
  });

  it('merchant novo nasce com nome e tipo de businessProfiles', async () => {
    merchantExists = false;
    await open('menu');
    await vi.waitFor(() => expect(posted.length).toBeGreaterThan(0));
    expect(posted[0].body).toEqual({ businessId: BIZ, name: 'Brasa Gate', type: 'restaurant' });
  });
});

describe('registros: erro aparece', () => {
  for (const [module, name] of [['operations', 'orders'], ['agenda', 'appointments'], ['agenda', 'services'], ['insights', 'commission_ledger'], ['affiliates', 'affiliate_links']] as const) {
    it(`permissão negada em ${name} não vira lista vazia`, async () => {
      store.denied.add(name);
      await open(module);
      expect((await screen.findAllByText(/Não foi possível carregar/i)).length).toBeGreaterThan(0);
      expect(screen.queryAllByText(/^Nenhum/i)).toEqual([]);
    });
  }

  it('403 da equipe aparece', async () => {
    team = { status: 403, body: { error: { code: 'business_access_denied', message: 'negado' } } };
    await open('team');
    expect((await screen.findAllByText(/Não foi possível carregar/i)).length).toBeGreaterThan(0);
  });
});

describe('registros: por tipo de empresa', () => {
  for (const type of ['FOOD_PLACE', 'SERVICE_PROVIDER', 'SELLER', 'VENUE', 'EVENT_ORGANIZER', 'DIGITAL_CREATOR', 'BRAND', 'VALOR_DESCONHECIDO']) {
    it(`${type}: pedido visível em operations`, async () => {
      const { container } = await open('operations', type);
      await screen.findAllByText(/Smash duplo/);
      expect(text(container)).toContain('57,80');
    });

    it(`${type}: agendamento registrado aparece mesmo se o tipo não tiver agenda (D3)`, async () => {
      await open('agenda', type);
      expect((await screen.findAllByText(/Rita Gate/)).length).toBeGreaterThan(0);
    });
  }
});
