// Gate BIL-016-CATALOGO-SEM-PROMESSA, parte do site. Template do autor de gates, copiado para pages/billing só durante o gate. API falsa por fetch.
// A tela mostra o que `features` traz, com rótulo centralizado: o texto muda com a feature, e chave crua ou desconhecida nunca aparece.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/platform/infrastructure/firebase', () => ({
  getFluxoFirebase: () => ({ auth: { currentUser: { getIdToken: async () => 'token' } }, appCheck: null }),
}));
vi.mock('@/platform/application/auth-context', () => ({ useAuth: () => ({ user: { uid: 'u1' }, canonicalUid: 'u1', loading: false }) }));

import { PlansPage } from './plans-page';

const local = (features: unknown[]) => ({
  code: 'local', name: 'Local', description: null, kind: 'plan', audience: 'business', features,
  prices: [{ id: 'p1', currency: 'BRL', amountCents: 3900, interval: 'month', intervalCount: 1, trialDays: 0 }],
});

async function shown(features: unknown[]) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [local(features)] }), { status: 200, headers: { 'content-type': 'application/json' } })));
  const view = render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}>
      <MemoryRouter><PlansPage /></MemoryRouter>
    </QueryClientProvider>,
  );
  await screen.findByText('Local');
  const text = view.container.textContent ?? '';
  cleanup();
  vi.unstubAllGlobals();
  return text;
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('planos: só o que features traz', () => {
  it('a feature aplicada aparece com rótulo, e não como chave', async () => {
    const without = await shown([]);
    const withFeature = await shown([{ key: 'integracao_psp.enabled', value: true }]);
    expect(withFeature).not.toBe(without);
    expect(withFeature).not.toContain('integracao_psp');
  });

  it('feature desligada não é prometida', async () => {
    expect(await shown([{ key: 'integracao_psp.enabled', value: false }])).toBe(await shown([]));
  });

  it('chave desconhecida não aparece nem cru nem com rótulo inventado', async () => {
    const text = await shown([{ key: 'gate.desconhecida', value: true }]);
    expect(text).not.toContain('gate.desconhecida');
    expect(text).toBe(await shown([]));
  });

  it('sem features a tela não promete recurso existente como limite do plano', async () => {
    expect(await shown([])).not.toMatch(/cardápio|pedidos|agenda|itens/i);
  });
});
