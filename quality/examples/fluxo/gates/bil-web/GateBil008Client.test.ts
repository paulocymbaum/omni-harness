// Gate BIL-008-VITEST (cliente). Template do autor de gates. Sem idempotencyKey, a escrita leva chave própria, porque a API recusa escrita sem chave.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/platform/infrastructure/firebase', () => ({
  getFluxoFirebase: () => ({ auth: { currentUser: { getIdToken: async () => 'token' } }, appCheck: null }),
}));
import { fluxoApi } from './fluxo-api-client';

const fetchMock = vi.fn<typeof fetch>();
const sent = () => new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
type Options = { idempotencyKey?: string };

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockImplementation(async () => new Response('{}', { status: 200 }));
});
afterEach(() => { vi.unstubAllGlobals(); fetchMock.mockReset(); });

describe('Idempotency-Key no cliente', () => {
  const calls: [string, (o: Options) => Promise<unknown>][] = [
    ['postJson', (o) => fluxoApi.postJson('x', {}, o)],
    ['putJson', (o) => fluxoApi.putJson('x', {}, o)],
    ['patchJson', (o) => fluxoApi.patchJson('x', {}, o)],
    ['deleteJson', (o) => fluxoApi.deleteJson('x', o)],
  ];
  for (const [name, call] of calls) {
    it(`${name} envia a chave`, async () => {
      await call({ idempotencyKey: 'chave-1' });
      expect(sent().get('Idempotency-Key')).toBe('chave-1');
    });
    it(`${name} sem a opção gera chave própria, sem perder a autenticação`, async () => {
      await call({});
      expect(sent().get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
      expect(sent().get('authorization')).toBe('Bearer token');
    });
  }
});
