// Gate DV-008-WEB-CLIENT (spec do próprio gate): fluxoApi.getJsonConditional, aditivo em fluxo-api-client.ts.
// Copiado para ofluxo_site/src/__dv008_gate_<pid>__/ só durante o gate.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/platform/infrastructure/firebase', () => ({
  getFluxoFirebase: () => ({ auth: { currentUser: { getIdToken: async () => 'id-token-teste' } }, appCheck: null }),
}));

import { fluxoApi } from '@/platform/infrastructure/fluxo-api-client';

type Call = { url: string; init: RequestInit };
let calls: Call[] = [];

function respond(status: number, body: string, headers: Record<string, string> = {}) {
  vi.stubGlobal('fetch', vi.fn(async (url: URL | string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(status === 304 ? null : body, { status, headers });
  }));
}

function header(init: RequestInit, name: string): string | null {
  return new Headers(init.headers).get(name);
}

beforeEach(() => { calls = []; });
afterEach(() => { vi.unstubAllGlobals(); });

describe('fluxoApi.getJsonConditional', () => {
  it('envia If-None-Match, autenticação e cache no-cache', async () => {
    respond(200, '{"version":3}', { etag: 'W/"d-3"', 'content-type': 'application/json' });
    await fluxoApi.getJsonConditional<{ version: number }>('debates/exemplo/timeline', 'W/"d-2"');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toMatch(/\/debates\/exemplo\/timeline$/);
    expect(header(calls[0].init, 'if-none-match')).toBe('W/"d-2"');
    expect(header(calls[0].init, 'authorization')).toBe('Bearer id-token-teste');
    expect(calls[0].init.cache).toBe('no-cache');
  });

  it('200 devolve status, etag e corpo', async () => {
    respond(200, '{"version":3}', { etag: 'W/"d-3"', 'content-type': 'application/json' });
    const result = await fluxoApi.getJsonConditional<{ version: number }>('debates/exemplo/timeline');
    expect(result).toEqual({ status: 200, etag: 'W/"d-3"', body: { version: 3 } });
    expect(header(calls[0].init, 'if-none-match')).toBeNull();
  });

  it('304 devolve só o status', async () => {
    respond(304, '');
    const result = await fluxoApi.getJsonConditional('debates/exemplo/timeline', 'W/"d-3"');
    expect(result).toEqual({ status: 304 });
  });

  it('403 identity_verification_required preserva status e code', async () => {
    respond(403, '{"code":"identity_verification_required","message":"x"}', { 'content-type': 'application/json' });
    await expect(fluxoApi.getJsonConditional('debates/exemplo/timeline')).rejects.toMatchObject({
      status: 403, code: 'identity_verification_required',
    });
  });

  it('getJson continua devolvendo só o corpo', async () => {
    respond(200, '{"items":[]}', { 'content-type': 'application/json' });
    await expect(fluxoApi.getJson('debates')).resolves.toEqual({ items: [] });
  });
});
