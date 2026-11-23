// Gate BIL-017-MODULOS-SITE. Template do autor de gates, copiado para pages/ só durante o gate. Cada ação chama o callable ou endpoint do app, com os campos do app.
// Contrato que este template fixa, além da spec (nomes iguais aos de fluxo_empresas_repository_impl.dart): fluxoEmpresasRepository.createOrder, updateOrder, createService, updateService,
// createAppointment, updateAppointment, inviteTeamMember(businessId, userUid, role), updateTeamMember(businessId, userUid, { role, status }) e createAffiliateLink(businessId, draft).
// startsAt entra como Date e sai como ISO. O botão de avanço de status tem nome acessível com "Avançar". O painel fica na rota business/:businessId, para onde vai módulo oculto sem dados.
import fs from 'node:fs';
import path from 'node:path';

import { cleanup, fireEvent, screen } from '@testing-library/react';
import { Timestamp } from 'firebase/firestore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const calls: { name: string; data: unknown }[] = [];

vi.mock('firebase/firestore', async (original) => {
  const { fakeFirestore } = await import('./GateBil017Support');
  return { ...(await original<typeof import('firebase/firestore')>()), ...fakeFirestore };
});
vi.mock('firebase/functions', async (original) => ({
  ...(await original<typeof import('firebase/functions')>()),
  httpsCallable: (_functions: unknown, name: string) => async (data: unknown) => { calls.push({ name, data }); return { data: { order: { id: 'o' }, service: { id: 's' }, appointment: { id: 'a' }, ok: true } }; },
}));
vi.mock('@/platform/infrastructure/firebase', () => ({
  firebaseConfigurationMissing: false,
  getFluxoFirebase: () => ({ db: {}, functions: {}, auth: { currentUser: { uid: 'u1', getIdToken: async () => 'token' } }, appCheck: null }),
}));
vi.mock('@/platform/application/auth-context', () => ({ useAuth: () => ({ user: { uid: 'u1' }, canonicalUid: 'u1', loading: false }) }));

import { usePlatformStore } from '@/platform/application/platform-store';
import { fluxoEmpresasRepository } from '@/platform/infrastructure/repositories';
import { mountModule, seedBusiness, store } from './GateBil017Support';
import { BusinessModulePage } from './domain-pages';

const BIZ = 'biz-1';
const http: { method: string; path: string; body: unknown }[] = [];
const repo = fluxoEmpresasRepository as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
const CUBIT = path.resolve(process.cwd(), '../lib/features/fluxo_empresas/presentation/bloc/fluxo_empresas_cubit.dart');

// Caminho variável: arquivo ausente falha só nestes testes, e os demais continuam mostrando o próprio motivo.
const OPERATIONS = '../../domain/business-operations';
const operations = () => import(/* @vite-ignore */ OPERATIONS) as Promise<{ nextOrderStatus: (s: string) => string; nextAppointmentStatus: (s: string) => string }>;

function transitions(method: string) {
  const source = fs.readFileSync(CUBIT, 'utf8');
  const start = source.indexOf(`Future<void> ${method}(`);
  const block = source.slice(start, source.indexOf('_ =>', start));
  return Object.fromEntries([...block.matchAll(/'(\w+)' => '(\w+)'/g)].map((m) => [m[1], m[2]]));
}

beforeEach(() => {
  store.reset();
  calls.length = 0;
  http.length = 0;
  usePlatformStore.setState({ accountKind: 'business', accountId: BIZ });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    http.push({ method: init?.method ?? 'GET', path: new URL(String(url), 'http://gate.test').pathname, body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify({ id: BIZ, businessId: BIZ, name: 'Brasa', type: 'other', active: true, ownerUid: 'u1' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('módulos: callables', () => {
  it('pedido', async () => {
    const items = [{ name: 'Smash', quantity: 2, price: 21 }];
    await repo.createOrder({ merchantId: BIZ, items, total: 42, customerName: 'Rita', notes: 'sem cebola' });
    await repo.updateOrder({ orderId: 'o1', status: 'preparing' });
    await repo.updateOrder({ orderId: 'o1', paid: true });
    expect(calls).toEqual([
      { name: 'empresasV1CreateOrder', data: { merchantId: BIZ, items, total: 42, customerName: 'Rita', notes: 'sem cebola' } },
      { name: 'empresasV1UpdateOrder', data: { orderId: 'o1', status: 'preparing' } },
      { name: 'empresasV1UpdateOrder', data: { orderId: 'o1', paid: true } },
    ]);
  });

  it('serviço', async () => {
    await repo.createService({ merchantId: BIZ, name: 'Corte', durationMinutes: 45, price: 80 });
    await repo.updateService({ serviceId: 's1', active: false });
    expect(calls).toEqual([
      { name: 'empresasV1CreateService', data: { merchantId: BIZ, name: 'Corte', durationMinutes: 45, price: 80 } },
      { name: 'empresasV1UpdateService', data: { serviceId: 's1', active: false } },
    ]);
  });

  it('agendamento', async () => {
    const startsAt = new Date('2026-11-03T15:00:00.000Z');
    await repo.createAppointment({ merchantId: BIZ, serviceId: 's1', startsAt, customerName: 'Rita' });
    await repo.updateAppointment({ appointmentId: 'a1', status: 'in_service' });
    expect(calls).toEqual([
      { name: 'empresasV1CreateAppointment', data: { merchantId: BIZ, serviceId: 's1', startsAt: startsAt.toISOString(), customerName: 'Rita' } },
      { name: 'empresasV1UpdateAppointment', data: { appointmentId: 'a1', status: 'in_service' } },
    ]);
  });

  it('link afiliado', async () => {
    await repo.createAffiliateLink(BIZ, { eventId: 'e1', externalUrl: 'https://destino.gate.test' });
    expect(calls).toEqual([{ name: 'createAffiliateLink', data: { businessId: BIZ, eventId: 'e1', externalUrl: 'https://destino.gate.test' } }]);
  });
});

describe('módulos: equipe pela API', () => {
  it('convite e alteração de papel', async () => {
    await repo.inviteTeamMember(BIZ, 'u9', 'EDITOR');
    await repo.updateTeamMember(BIZ, 'u9', { role: 'VIEWER', status: 'active' });
    expect(http.filter((r) => r.method !== 'GET').map((r) => ({ ...r, path: r.path.replace(/^.*\/businesses/, '/businesses') }))).toEqual([
      { method: 'PUT', path: `/businesses/${BIZ}/team/u9`, body: { role: 'EDITOR' } },
      { method: 'PATCH', path: `/businesses/${BIZ}/team/u9`, body: { role: 'VIEWER', status: 'active' } },
    ]);
  });
});

describe('módulos: transições iguais às do cubit', () => {
  it('pedido', async () => {
    const { nextOrderStatus } = await operations();
    const expected = transitions('advanceOrder');
    expect(Object.keys(expected).length).toBe(4);
    for (const [from, to] of Object.entries(expected)) expect(nextOrderStatus(from)).toBe(to);
    expect(nextOrderStatus('paid')).toBe('paid');
    expect(nextOrderStatus('canceled')).toBe('canceled');
  });

  it('agendamento', async () => {
    const { nextAppointmentStatus } = await operations();
    const expected = transitions('advanceAppointment');
    expect(Object.keys(expected).length).toBe(3);
    for (const [from, to] of Object.entries(expected)) expect(nextAppointmentStatus(from)).toBe(to);
    expect(nextAppointmentStatus('canceled')).toBe('canceled');
  });

  it('avançar pela tela usa a regra e marca pago como o cubit', async () => {
    seedBusiness(BIZ, 'u1', 'FOOD_PLACE');
    store.collections.orders = [{ id: 'o1', merchantId: BIZ, businessId: BIZ, items: [{ name: 'Smash', quantity: 1, price: 10 }], total: 10, status: 'delivered', paid: false, createdAt: Timestamp.now() }];
    mountModule(<BusinessModulePage />, BIZ, 'operations');
    fireEvent.click(await screen.findByRole('button', { name: /Avançar/i }));
    await vi.waitFor(() => expect(calls).toEqual([{ name: 'empresasV1UpdateOrder', data: { orderId: 'o1', status: 'paid', paid: true } }]));
  });
});

describe('módulos: navegação por tipo', () => {
  it('módulo oculto sem dados vai para o painel, como a primeira aba do app', async () => {
    seedBusiness(BIZ, 'u1', 'SELLER');
    mountModule(<BusinessModulePage />, BIZ, 'agenda');
    await vi.waitFor(() => expect(screen.getByTestId('location').textContent).toBe(`/app/business/${BIZ}`));
  });

  it('módulo visível no tipo não redireciona', async () => {
    seedBusiness(BIZ, 'u1', 'SELLER');
    mountModule(<BusinessModulePage />, BIZ, 'operations');
    await new Promise((resolve) => { setTimeout(resolve, 50); });
    expect(screen.getByTestId('location').textContent).toBe(`/app/business/${BIZ}/operations`);
  });

  it('plano e insights valem para todos os tipos', async () => {
    seedBusiness(BIZ, 'u1', 'SELLER');
    mountModule(<BusinessModulePage />, BIZ, 'insights');
    await new Promise((resolve) => { setTimeout(resolve, 50); });
    expect(screen.getByTestId('location').textContent).toBe(`/app/business/${BIZ}/insights`);
  });
});
