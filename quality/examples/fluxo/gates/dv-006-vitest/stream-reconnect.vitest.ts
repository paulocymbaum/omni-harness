// Gate DV-006-STREAM-RECONNECT (dono: quality/test/delivery/dv-006.test.mjs). Copiado para admin-web/src/__dv006_gate_*__/
// só durante a execução do gate. Contrato: infrastructure/debateStream.ts exporta
// openDebateStream({ debateId, lastEventId, onEvent, onStatus, signal }) com fetch + ReadableStream,
// headers de apiClient.buildApiHeaders() e base apiClient.apiBaseUrl.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ headerCalls: 0, eventSourceCalls: 0 }));
vi.mock("../shared/infrastructure/apiClient", () => ({
  apiBaseUrl: "https://api.gate.test",
  buildApiHeaders: vi.fn(async () => {
    state.headerCalls += 1;
    return {
      authorization: `Bearer tok-${state.headerCalls}`,
      "x-firebase-appcheck": "appcheck-gate",
      accept: "application/json",
    };
  }),
  callApiAdmin: vi.fn(async () => {
    throw new Error("a mesa não usa callApiAdmin");
  }),
}));
vi.mock("../shared/infrastructure/firebase", () => ({
  auth: {
    currentUser: {
      getIdToken: vi.fn(async () => `tok-firebase-${state.headerCalls}`),
      getIdTokenResult: vi.fn(async () => ({ signInSecondFactor: "totp" })),
    },
  },
  appCheck: null,
  functions: {},
}));

import { openDebateStream } from "../modules/debates/infrastructure/debateStream";

type Call = { url: string; headers: Headers };
const enc = new TextEncoder();
const sse = (text: string, init: ResponseInit = {}) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode(text));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" }, ...init },
  );
const pending = (_url: unknown, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });

let controller: AbortController;
let fetchMock: ReturnType<typeof vi.fn>;
let handle: unknown;
const calls = (): Call[] =>
  fetchMock.mock.calls.map(([input, init]) => ({
    url: typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url,
    headers: new Headers((init as RequestInit | undefined)?.headers ?? (input instanceof Request ? input.headers : undefined)),
  }));
async function advance(ms: number) {
  for (let t = 0; t < ms; t += 100) await vi.advanceTimersByTimeAsync(100);
}
function open(extra: Record<string, unknown> = {}) {
  const onEvent = vi.fn();
  const onStatus = vi.fn();
  handle = openDebateStream({ debateId: "deb-1", onEvent, onStatus, signal: controller.signal, ...extra } as Parameters<typeof openDebateStream>[0]);
  return { onEvent, onStatus };
}

beforeEach(() => {
  vi.useFakeTimers();
  state.headerCalls = 0;
  state.eventSourceCalls = 0;
  controller = new AbortController();
  fetchMock = vi.fn(pending);
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal(
    "EventSource",
    class {
      constructor() {
        state.eventSourceCalls += 1;
        throw new Error("EventSource proibido na mesa");
      }
    },
  );
});
afterEach(async () => {
  controller.abort();
  if (typeof handle === "function") (handle as () => void)();
  else if (handle && typeof (handle as { close?: unknown }).close === "function") (handle as { close: () => void }).close();
  // Não espera a promessa do stream: uma espera pendente em timer falso não termina depois do abort.
  if (handle && typeof (handle as Promise<unknown>).then === "function") (handle as Promise<unknown>).catch(() => undefined);
  await vi.advanceTimersByTimeAsync(0);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("gate DV-006 stream reconnect", () => {
  it("primeira conexão leva Last-Event-ID inicial, headers de auth/App Check e accept text/event-stream", async () => {
    open({ lastEventId: "40" });
    await advance(300);
    const [first] = calls();
    expect(first, "openDebateStream deve chamar fetch").toBeDefined();
    expect(first.url.startsWith("https://api.gate.test/api/v1/admin/debates/deb-1/stream")).toBe(true);
    expect(first.url).not.toContain("once=1");
    expect(first.headers.get("last-event-id")).toBe("40");
    expect(first.headers.get("authorization")).toMatch(/^Bearer tok-\d+$/);
    expect(first.headers.get("x-firebase-appcheck")).toBe("appcheck-gate");
    expect(first.headers.get("accept")).toContain("text/event-stream");
  });

  it("depois que o corpo termina, reconecta com o último id recebido e token renovado", async () => {
    fetchMock.mockResolvedValueOnce(sse(": hb\n\nid: 41\nevent: utterance\ndata: {\"id\":\"u1\",\"version\":1}\n\n"));
    const { onEvent } = open();
    await advance(15_000);
    const list = calls();
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(list[0].headers.get("last-event-id")).toBeNull();
    expect(list[1].headers.get("last-event-id")).toBe("41");
    expect(list[1].url).not.toContain("once=1");
    expect(list[1].headers.get("x-firebase-appcheck")).toBe("appcheck-gate");
    expect(list[1].headers.get("authorization")).toMatch(/^Bearer tok-\d+$/);
    expect(list[1].headers.get("authorization")).not.toBe(list[0].headers.get("authorization"));
    expect(onEvent.mock.calls.some(([e]) => e?.id === "41" && e?.event === "utterance")).toBe(true);
    expect(state.eventSourceCalls).toBe(0);
  });

  it("após 3 falhas seguidas cai para polling ?once=1 com o mesmo Last-Event-ID", async () => {
    fetchMock
      .mockResolvedValueOnce(sse("id: 7\nevent: debate\ndata: {\"status\":\"live\"}\n\n"))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"));
    fetchMock.mockImplementation(async (input: unknown) => {
      const url = typeof input === "string" ? input : String((input as Request).url ?? input);
      if (url.includes("once=1")) return sse("id: 8\nevent: ingestion\ndata: {\"state\":\"running\"}\n\n");
      throw new TypeError("Failed to fetch");
    });
    const { onStatus } = open();
    await advance(60_000);
    const list = calls();
    const firstPoll = list.findIndex((c) => c.url.includes("once=1"));
    expect(firstPoll, "esperava GET …/stream?once=1 depois das falhas").toBeGreaterThanOrEqual(4);
    expect(list[firstPoll].url.startsWith("https://api.gate.test/api/v1/admin/debates/deb-1/stream")).toBe(true);
    expect(list[firstPoll].headers.get("last-event-id")).toBe("7");
    expect(list[firstPoll].headers.get("authorization")).toMatch(/^Bearer tok-\d+$/);
    expect(JSON.stringify(onStatus.mock.calls)).toContain("\"polling\"");
    expect(state.eventSourceCalls).toBe(0);
  });

  it("429 respeita Retry-After antes de tentar de novo", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 429, headers: { "Retry-After": "7" } }));
    open();
    await advance(6_800);
    expect(calls().length, "não pode reconectar antes do Retry-After").toBe(1);
    await advance(13_200);
    expect(calls().length).toBeGreaterThanOrEqual(2);
  });

  it("401 para de reconectar", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));
    open();
    await advance(60_000);
    expect(calls().length).toBe(1);
  });

  it("403 para de reconectar", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ code: "admin_access_denied" }), { status: 403 }));
    open();
    await advance(60_000);
    expect(calls().length).toBe(1);
  });
});
