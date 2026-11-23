// Gate DV-007-CLIENT (dono: quality/test/delivery/dv-007.test.mjs). Copiado para admin-web/src/__dv007_gate_*__/
// só durante o gate. Contrato: infrastructure/factChecksApi.ts segue debatesApi.ts (DV-006): assinatura
// (ids..., body?, { idempotencyKey? }), base `${apiBaseUrl}/api/v1/admin`, Idempotency-Key em toda escrita e
// Problem Details com `code` em maiúsculas (sem achatar 409/422).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../shared/infrastructure/apiClient", () => ({
  apiBaseUrl: "https://api.test",
  buildApiHeaders: vi.fn(async () => ({ authorization: "Bearer t", accept: "application/json" })),
}));
vi.mock("../shared/infrastructure/firebase", () => ({
  auth: { currentUser: { getIdTokenResult: vi.fn(async () => ({ signInSecondFactor: "totp" })) } },
}));

import * as api from "../modules/debates/infrastructure/factChecksApi";

type Fn = (...args: unknown[]) => Promise<unknown>;
const f = (name: string) => (api as unknown as Record<string, Fn>)[name] as Fn;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/problem+json" } });
let fetchMock: ReturnType<typeof vi.fn>;
const call = (i = 0) => {
  const [url, init] = fetchMock.mock.calls[i] as [string, RequestInit];
  return { url: String(url), method: init?.method ?? "GET", headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) : undefined };
};
const settle = (p: Promise<unknown>) => p.then(() => undefined, () => undefined);

beforeEach(() => {
  fetchMock = vi.fn(async () => json({}));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const FUNCTIONS = [
  "listFactCheckQueue", "getFactCheck", "claimFactCheck", "releaseFactCheck", "getAudioClip", "createRevision",
  "validateFactCheck", "notValidateFactCheck", "createManualCheck", "requestAiRedo", "correctFactCheck",
  "unpublishFactCheck", "listCorrections", "getDebateReport",
];

describe("gate DV-007 cliente factChecksApi", () => {
  it("exporta as funções do contrato", () => {
    expect(FUNCTIONS.filter((name) => typeof (api as Record<string, unknown>)[name] !== "function")).toEqual([]);
  });

  it("validateFactCheck envia revisionId e URLs conferidas com a Idempotency-Key dada", async () => {
    const urls = ["https://www.ibge.gov.br/pnad"];
    await settle(f("validateFactCheck")("f1", { revisionId: "r2", checkedSourceUrls: urls }, { idempotencyKey: "k-1" }));
    expect(call().url).toBe("https://api.test/api/v1/admin/fact-checks/f1:validate");
    expect(call().method).toBe("POST");
    expect(call().headers.get("Idempotency-Key")).toBe("k-1");
    expect(call().body).toEqual({ revisionId: "r2", checkedSourceUrls: urls });
  });

  it("escritas sem chave explícita ainda mandam Idempotency-Key; leituras não", async () => {
    await settle(f("claimFactCheck")("f1"));
    await settle(f("notValidateFactCheck")("f1", { reasonCode: "wrong_data", reason: "Fonte errada no balão", followUp: "manual_check" }));
    await settle(f("createManualCheck")("c1", { verdict: "true", explanation: "x", normalizedClaim: "y", sources: [] }));
    await settle(f("listFactCheckQueue")({ debateId: "d1", queue: "validating" }));
    await settle(f("getAudioClip")("f1"));
    expect(call(0).url).toBe("https://api.test/api/v1/admin/fact-checks/f1:claim");
    expect(call(1).url).toBe("https://api.test/api/v1/admin/fact-checks/f1:not-validate");
    expect(call(1).body).toMatchObject({ followUp: "manual_check", reasonCode: "wrong_data" });
    expect(call(2).url).toBe("https://api.test/api/v1/admin/claims/c1/manual-checks");
    for (const i of [0, 1, 2]) expect(call(i).headers.get("Idempotency-Key")).toBeTruthy();
    const queue = new URL(call(3).url);
    expect(queue.pathname).toBe("/api/v1/admin/fact-checks");
    expect(queue.searchParams.get("debateId")).toBe("d1");
    expect(queue.searchParams.get("queue")).toBe("validating");
    expect(call(4).url).toBe("https://api.test/api/v1/admin/fact-checks/f1/audio-clip");
    for (const i of [3, 4]) {
      expect(call(i).method).toBe("GET");
      expect(call(i).headers.get("Idempotency-Key")).toBeNull();
    }
  });

  it("preserva o code de 409 e 422 em maiúsculas", async () => {
    const cases: [number, string][] = [
      [409, "stale_revision"], [409, "lock_held"], [409, "two_person_required"],
      [422, "sources_not_checked"], [422, "reason_required"], [409, "invalid_state"],
    ];
    for (const [status, code] of cases) {
      fetchMock.mockResolvedValueOnce(json({ code, title: code, status }, status));
      const error = await f("validateFactCheck")("f1", { revisionId: "r1", checkedSourceUrls: [] }).then(
        () => null, (e: unknown) => e as { code?: string });
      expect(error?.code).toBe(code.toUpperCase());
    }
  });
});
