// Gates BIL-008-VITEST e BIL-008-CDC-TELA. Template do autor de gates, copiado para pages/billing só durante o gate. API falsa por fetch.
// Contrato que este template fixa: PlansPage, CheckoutPage e SubscriptionPortalPage exportadas por nome; aceite em checkbox.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/platform/infrastructure/firebase', () => ({
  getFluxoFirebase: () => ({ auth: { currentUser: { getIdToken: async () => 'token' } }, appCheck: null }),
}));
vi.mock('@/platform/application/auth-context', () => ({ useAuth: () => ({ user: { uid: 'u1' }, canonicalUid: 'u1', loading: false }) }));

import { CheckoutPage } from './checkout-page';
import { PlansPage } from './plans-page';
import { SubscriptionPortalPage } from './subscription-portal-page';

const PRICE = '00000000-0000-4000-8000-000000000039';
const product = (code: string, cents: number) => ({
  code, name: code === 'presenca' ? 'Presença' : 'Local', description: null, kind: 'plan', audience: 'business',
  prices: [{ id: code === 'presenca' ? 'free' : PRICE, currency: 'BRL', amountCents: cents, interval: 'month', intervalCount: 1, trialDays: 0 }],
});
const catalog = { items: [product('presenca', 0), product('local', 3900)] };
const customer = { legalName: 'Empresa Gate LTDA', taxIdMasked: '**.***.345/****-35', billingEmail: 'f@example.test', address: { street: 'Rua', number: '1', complement: null, district: 'Centro', city: 'BH', state: 'MG', postalCode: '30000000' } };
const created = { subscriptionId: 's1', invoiceId: 'i1', status: 'incomplete', amountCents: 3900, renewsAt: '2026-12-01T12:00:00Z' };
const qr = (over = {}) => ({ chargeId: 'c1', status: 'pending', brCode: '000201-copia-e-cola', qrImageDataUri: 'data:image/png;base64,R0FURQ==', amountCents: 3900, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), ...over });
const invoice = (status: string) => ({ invoice: { id: 'i1', subscriptionId: 's1', number: null, periodStart: null, periodEnd: null, subtotalCents: 3900, totalCents: 3900, status, dueDate: null, paidAt: null, createdAt: '2026-11-01T12:00:00Z' }, charges: [] });
const subscription = (over = {}) => ({ id: 's1', planCode: 'local', status: 'active', rail: 'pix_manual', quantity: 1, currentPeriodStart: '2026-11-01T12:00:00Z', currentPeriodEnd: '2026-12-01T12:00:00Z', trialEnd: null, cancelAtPeriodEnd: false, canceledAt: null, ...over });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const problem = (status: number, code: string) => json({ code, title: code }, status);
type Handler = (url: string, init?: RequestInit) => Response | undefined;
let override: Handler = () => undefined;
let invoiceStatus = 'open';
let chargeBody = qr;
const fetchMock = vi.fn<typeof fetch>();
const calls = (method: string, fragment: string) => fetchMock.mock.calls.filter(([u, i]) => (i?.method ?? 'GET') === method && String(u).includes(fragment));
const keyOf = (call: Parameters<typeof fetch>) => new Headers(call[1]?.headers).get('Idempotency-Key');

beforeEach(() => {
  override = () => undefined;
  invoiceStatus = 'open';
  chargeBody = qr;
  sessionStorage.clear();
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const special = override(url, init);
    if (special) return special;
    if (url.includes('/billing/catalog')) return json(catalog);
    if (url.includes('/charges')) return json(chargeBody(), 201);
    if (url.includes('/billing/invoices/i1')) return json(invoice(invoiceStatus));
    if (url.endsWith('/customer')) return json(customer);
    if (url.endsWith('/subscription') && method === 'POST') return json(created, 201);
    if (url.endsWith('/subscription')) return json(subscription());
    if (url.includes('/invoices')) return json({ items: [invoice('paid').invoice], limit: 20, offset: 0, hasMore: false });
    if (url.includes('/cancel')) return json(subscription({ status: 'pending_cancellation' }));
    return json({});
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});

const wrap = (url: string, path: string, element: ReactNode) => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}>
    <MemoryRouter initialEntries={[url]}><Routes><Route path={path} element={element} /></Routes></MemoryRouter>
  </QueryClientProvider>,
);
const checkout = () => wrap('/app/business/emp-1/plano/checkout/local', '/app/business/:businessId/plano/checkout/:productCode', <CheckoutPage />);
const portal = () => wrap('/app/business/emp-1/plano', '/app/business/:businessId/plano', <SubscriptionPortalPage />);
const accept = async () => { fireEvent.click(await screen.findByRole('checkbox')); };
const confirmButton = async () => screen.findByRole('button', { name: /confirmar|assinar|contratar/i });
const reachQr = async () => {
  await accept();
  fireEvent.click(await confirmButton());
  await waitFor(() => expect(document.querySelector('img[src^="data:"]')).toBeTruthy());
};
const pollCount = () => calls('GET', '/billing/invoices/i1').length;

describe('BIL-008 CDC', () => {
  it('cdc: preço, periodicidade, renovação, cancelamento e termos aparecem antes da confirmação', async () => {
    checkout();
    await confirmButton();
    const text = document.body.textContent ?? '';
    expect(text).toMatch(/R\$\s*39,00/);
    expect(text).toMatch(/mensal|por mês|\/mês|ao mês/i);
    expect(text).toMatch(/renova/i);
    expect(text).toMatch(/cancel/i);
    expect(screen.getByRole('link', { name: /termos/i })).toHaveAttribute('href', '/terms-of-service');
  });

  it('cdc: sem aceite não confirma', async () => {
    checkout();
    expect(await confirmButton()).toBeDisabled();
    expect(calls('POST', '/subscription')).toHaveLength(0);
  });
});

describe('BIL-008 fluxo', () => {
  it('duplo clique envia uma intenção, e a repetição usa a mesma chave', async () => {
    checkout();
    await accept();
    const button = await confirmButton();
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(calls('POST', '/charges').length).toBeGreaterThan(0));
    const posts = calls('POST', '/subscription');
    expect(new Set(posts.map(keyOf)).size).toBe(1);
    expect(keyOf(posts[0]!)).toBeTruthy();
    expect(posts).toHaveLength(1);
    expect(JSON.parse(String(posts[0]![1]?.body))).toMatchObject({ productCode: 'local', priceId: PRICE });
    expect(calls('POST', '/billing/invoices/i1/charges')).toHaveLength(1);
  });

  it('mostra QR, copia e cola, valor e validade', async () => {
    checkout();
    await reachQr();
    expect(document.querySelector('img[src^="data:image/png"]')).toBeTruthy();
    const brCode = screen.queryByText('000201-copia-e-cola') ?? screen.getByDisplayValue('000201-copia-e-cola');
    expect(brCode).toBeTruthy();
    expect(document.body.textContent).toMatch(/R\$\s*39,00/);
    expect(document.body.textContent).toMatch(/v[aá]lid|expira/i);
  });

  it('consulta a cada 3 s e para em paid', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    checkout();
    await reachQr();
    await act(async () => { await vi.advanceTimersByTimeAsync(3100); });
    expect(pollCount()).toBeGreaterThan(0);
    invoiceStatus = 'paid';
    await act(async () => { await vi.advanceTimersByTimeAsync(16_000); });
    const after = pollCount();
    await act(async () => { await vi.advanceTimersByTimeAsync(40_000); });
    expect(pollCount()).toBe(after);
  });

  it('recua até 15 s, sem passar disso', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    checkout();
    await reachQr();
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    const first = pollCount();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    const inMinute = pollCount() - first;
    expect(inMinute).toBeGreaterThanOrEqual(3);
    expect(inMinute).toBeLessThanOrEqual(6);
  });

  it('para com a aba oculta e retoma ao voltar', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    checkout();
    await reachQr();
    await act(async () => { await vi.advanceTimersByTimeAsync(3100); });
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); await vi.advanceTimersByTimeAsync(100); });
    const hidden = pollCount();
    await act(async () => { await vi.advanceTimersByTimeAsync(45_000); });
    expect(pollCount()).toBe(hidden);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); await vi.advanceTimersByTimeAsync(16_000); });
    expect(pollCount()).toBeGreaterThan(hidden);
  });

  it('QR expirado limpa a chave e gera outro', async () => {
    chargeBody = () => qr({ expiresAt: new Date(Date.now() - 1000).toISOString() });
    checkout();
    await accept();
    fireEvent.click(await confirmButton());
    const again = await screen.findByRole('button', { name: /gerar novo qr/i });
    const first = keyOf(calls('POST', '/charges')[0]!);
    chargeBody = qr;
    fireEvent.click(again);
    await waitFor(() => expect(calls('POST', '/charges').length).toBe(2));
    expect(keyOf(calls('POST', '/charges')[1]!)).not.toBe(first);
  });

  it('502 mantém a chave ao repetir', async () => {
    let failing = true;
    override = (url) => (url.includes('/charges') && failing ? problem(502, 'billing_psp_unavailable') : undefined);
    checkout();
    await accept();
    fireEvent.click(await confirmButton());
    const retry = await screen.findByRole('button', { name: /tentar|repetir|novamente/i });
    failing = false;
    fireEvent.click(retry);
    await waitFor(() => expect(calls('POST', '/charges').length).toBe(2));
    const [a, b] = calls('POST', '/charges');
    expect(keyOf(a!)).toBe(keyOf(b!));
  });

  it('403 explica que falta permissão', async () => {
    override = (url, init) => (url.endsWith('/subscription') && init?.method === 'POST' ? problem(403, 'business_access_denied') : undefined);
    checkout();
    await accept();
    fireEvent.click(await confirmButton());
    expect(await screen.findByText(/dono|administrador|permiss/i)).toBeTruthy();
  });

  it('dados fiscais: o documento some depois do envio e a tela mostra só a máscara', async () => {
    const document_ = '12.ABC.345/01DE-35';
    let saved = false;
    override = (url, init) => {
      if (!url.endsWith('/customer')) return undefined;
      if (init?.method === 'PUT') { saved = true; return json(customer); }
      return saved ? json(customer) : problem(404, 'billing_customer_not_found');
    };
    checkout();
    const form = (await screen.findByLabelText(/cnpj/i)).closest('form')!;
    for (const input of within(form).getAllByRole('textbox') as HTMLInputElement[]) {
      const name = `${input.name} ${input.id} ${input.getAttribute('aria-label') ?? ''} ${input.labels?.[0]?.textContent ?? ''}`.toLowerCase();
      const value = name.includes('cnpj') || name.includes('taxid') ? document_ : /mail/.test(name) ? 'f@example.test' : /cep|postal/.test(name) ? '30000000' : /uf|estado|state/.test(name) ? 'MG' : 'Gate';
      fireEvent.change(input, { target: { value } });
    }
    fireEvent.click(within(form).getByRole('button', { name: /salvar|continuar|avan/i }));
    await confirmButton();
    expect(calls('PUT', '/customer')).toHaveLength(1);
    expect(JSON.parse(String(calls('PUT', '/customer')[0]![1]?.body)).address).toMatchObject({ state: 'MG', postalCode: '30000000' });
    expect(document.documentElement.innerHTML).not.toContain(document_);
    expect(document.body.textContent).toContain('**.***.345/****-35');
  });
});

describe('BIL-008 planos e portal', () => {
  it('/planos consulta o catálogo sem autenticação e só o plano pago tem compra', async () => {
    wrap('/planos', '/planos', <PlansPage />);
    expect(await screen.findByText('Local')).toBeTruthy();
    expect(screen.getByText('Presença')).toBeTruthy();
    const [url, init] = calls('GET', '/billing/catalog')[0]!;
    expect(String(url)).toContain('audience=business');
    expect(new Headers(init?.headers).has('authorization')).toBe(false);
    expect(screen.getAllByRole('link', { name: /assinar|contratar|escolher|começar/i })).toHaveLength(1);
  });

  it('sem plano pago, mostra só Presença, sem compra', async () => {
    override = (url) => (url.includes('/billing/catalog') ? json({ items: [product('presenca', 0)] }) : undefined);
    wrap('/planos', '/planos', <PlansPage />);
    expect(await screen.findByText('Presença')).toBeTruthy();
    expect(screen.queryByRole('link', { name: /assinar|contratar|escolher|começar/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /assinar|contratar|escolher|começar/i })).toBeNull();
  });

  it('portal resolve o cancelamento no próprio botão e diferencia os dois casos', async () => {
    portal();
    const button = await screen.findByRole('button', { name: /cancelar assinatura/i });
    expect(document.querySelector('a[href^="mailto:"]')).toBeNull();
    expect(document.body.textContent).toMatch(/7 dias/);
    expect(document.body.textContent).toMatch(/reembolso/i);
    expect(document.body.textContent).toMatch(/fim do período/i);
    await userEvent.click(button);
    const confirm = screen.queryByRole('button', { name: /^confirmar/i });
    if (confirm) await userEvent.click(confirm);
    await waitFor(() => expect(calls('POST', '/billing/subscriptions/s1/cancel')).toHaveLength(1));
    expect(keyOf(calls('POST', '/billing/subscriptions/s1/cancel')[0]!)).toBeTruthy();
  });

  it('past_due mostra aviso sem cortar nada', async () => {
    override = (url, init) => (url.endsWith('/subscription') && (init?.method ?? 'GET') === 'GET' ? json(subscription({ status: 'past_due' })) : undefined);
    portal();
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('button', { name: /cancelar assinatura/i })).toBeTruthy();
  });
});
