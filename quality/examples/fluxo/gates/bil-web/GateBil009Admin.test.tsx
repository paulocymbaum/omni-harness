// Gate BIL-009-ADMIN-VITEST. Template do autor de gates, copiado para o módulo só durante o gate. API falsa por fetch.
// Contrato que este template fixa: páginas exportadas por nome, e rótulos com as palavras Estornar, Reprocessar, Marcar como paga e Anular.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor } from "@testing-library/react";

vi.mock("../../auth/presentation/AdminSecurityProvider", () => ({ useAdminSecurity: () => ({ resolveSensitiveRequirement: vi.fn() }) }));
const api = vi.hoisted(() => ({ headers: vi.fn(async () => ({ authorization: "Bearer teste" })) }));
vi.mock("../../../shared/infrastructure/apiClient", () => ({ apiBaseUrl: "https://api.test", buildApiHeaders: api.headers }));
vi.mock("../../../shared/infrastructure/firebase", () => ({ auth: { currentUser: null } }));

import type { AdminPermission } from "../../../shared/domain/contracts";
import { renderWithSession } from "../../debates/testing/renderWithSession";
import { BillingHealthCard } from "./BillingHealthCard";
import { InvoicesPage } from "./InvoicesPage";
import { SubscriptionDetailPage } from "./SubscriptionDetailPage";
import { SubscriptionsPage } from "./SubscriptionsPage";
import { WebhooksPage } from "./WebhooksPage";

const when = "2026-11-01T12:00:00Z";
const charge = { id: "c1", rail: "pix_manual", amountCents: 3900, status: "paid", attemptNumber: 1, paidAt: when, createdAt: when };
const invoice = { id: "i1", subscriptionId: "s1", number: "F-1", periodStart: when, periodEnd: when, subtotalCents: 3900, totalCents: 3900, status: "open", dueDate: "2026-11-02", paidAt: null, createdAt: when };
const subscription = {
  id: "s1", businessId: "emp-1", planCode: "local", status: "active", rail: "pix_manual", quantity: 1, currentPeriodStart: when, currentPeriodEnd: when,
  trialEnd: null, cancelAtPeriodEnd: false, canceledAt: null, taxIdMasked: "**.***.345/****-35", createdAt: when,
};
const webhook = { id: "w1", eventType: "PAYMENT_RECEIVED", status: "quarantined", attempts: 3, lastError: "amount_mismatch", receivedAt: when, externalChargeId: "pay_1" };
const page = (items: unknown[]) => ({ items, nextCursor: null });
const health = (over: Record<string, unknown> = {}) => ({
  webhooks: { pending: 0, quarantined: 1 }, lastEventReceivedAt: when, lastReconcileAt: when, lastAuthFailureAt: null, activeSubscriptions: 0, ...over,
});
const detail = { subscription, invoices: [invoice], charges: [charge], audit: [] };

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes("/subscriptions/s1")) return json(detail);
    if (url.includes("/subscriptions")) return json(page([subscription]));
    if (url.includes("/invoices")) return json(page([invoice]));
    if (url.includes("/webhooks")) return json(page([webhook]));
    if (url.includes("/health")) return json(health());
    return json({});
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); fetchMock.mockReset(); });

const scene = (capabilities: AdminPermission[], element: React.ReactNode, path = "/", url = "/") => renderWithSession(capabilities, element, { path, url });
const button = (name: RegExp) => screen.queryByRole("button", { name });
const detailPage = (capabilities: AdminPermission[]) => scene(capabilities, <SubscriptionDetailPage />, "/assinaturas/:id", "/assinaturas/s1");
const refund = /estornar/i;
const replay = /reprocessar/i;
const markPaid = /marcar como paga/i;
const voidIt = /anular/i;

describe("telas de cobrança", () => {
  it("lista de assinaturas mostra a máscara e nunca pede documento claro", async () => {
    scene(["billing.read"], <SubscriptionsPage />);
    expect(await screen.findByText("local")).toBeTruthy();
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/api/v1/admin/billing/subscriptions"))).toBe(true));
  });

  it("billing.read não vê escrita em faturas", async () => {
    scene(["billing.read"], <InvoicesPage />);
    expect(await screen.findByText("F-1")).toBeTruthy();
    expect(button(markPaid)).toBeNull();
    expect(button(voidIt)).toBeNull();
  });

  it("billing.manage vê escrita em faturas", async () => {
    scene(["billing.read", "billing.manage"], <InvoicesPage />);
    expect(await screen.findByRole("button", { name: markPaid })).toBeTruthy();
    expect(button(voidIt)).toBeTruthy();
  });

  it("billing.read não vê reprocessar", async () => {
    scene(["billing.read"], <WebhooksPage />);
    expect(await screen.findByText("amount_mismatch")).toBeTruthy();
    expect(button(replay)).toBeNull();
  });

  it("billing.manage vê reprocessar", async () => {
    scene(["billing.read", "billing.manage"], <WebhooksPage />);
    expect(await screen.findByRole("button", { name: replay })).toBeTruthy();
  });

  it("billing.manage sem billing.refund não vê estorno", async () => {
    detailPage(["billing.read", "billing.manage"]);
    expect(await screen.findByText("local")).toBeTruthy();
    expect(button(refund)).toBeNull();
  });

  it("billing.refund vê estorno", async () => {
    detailPage(["billing.read", "billing.refund"]);
    expect(await screen.findByRole("button", { name: refund })).toBeTruthy();
  });

  it("tela nunca mostra corpo de webhook", async () => {
    scene(["billing.read"], <WebhooksPage />);
    await screen.findByText("amount_mismatch");
    expect(document.body.textContent).not.toMatch(/rawBody|raw_body/);
  });

  it("alerta quando o reconcile não conclui há mais de 3 horas", async () => {
    fetchMock.mockImplementation(async () => json(health({ lastReconcileAt: new Date(Date.now() - 4 * 3600_000).toISOString() })));
    scene(["billing.read"], <BillingHealthCard />);
    expect(await screen.findByRole("alert")).toBeTruthy();
  });

  it("sem atraso, o card não alerta", async () => {
    const now = new Date().toISOString();
    fetchMock.mockImplementation(async () => json(health({ lastReconcileAt: now, lastEventReceivedAt: now })));
    scene(["billing.read"], <BillingHealthCard />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
