// Gate DV-006-SSE-PARSER (dono: quality/test/delivery/dv-006.test.mjs). Copiado para admin-web/src/__dv006_gate_*__/
// só durante a execução do gate. Contrato: domain/sseParser.ts exporta createSseParser() com
// push(chunk: string) => { id?, event, data }[] e os campos lastEventId / retry.
import { describe, expect, it } from "vitest";
import { createSseParser } from "../modules/debates/domain/sseParser";

type Msg = { id?: string; event: string; data: string };
const pick = (m: Msg) => ({ id: m.id, event: m.event, data: m.data });
const feed = (chunks: string[]) => {
  const parser = createSseParser();
  const out: Msg[] = [];
  for (const chunk of chunks) out.push(...parser.push(chunk));
  return { parser, out: out.map(pick) };
};

describe("gate DV-006 sse parser", () => {
  it("junta pedaços cortados no meio da linha e no meio do campo", () => {
    const { out } = feed(["id: 1\neve", "nt: utter", "ance\ndata: {\"a\"", ":1}\n", "\n"]);
    expect(out).toEqual([{ id: "1", event: "utterance", data: "{\"a\":1}" }]);
  });

  it("aceita \\r\\n, inclusive com \\r no fim de um pedaço e \\n no começo do outro", () => {
    const { out } = feed(["id: 2\r\nevent: claim\r\ndata: x\r", "\n\r", "\n"]);
    expect(out).toEqual([{ id: "2", event: "claim", data: "x" }]);
  });

  it("aceita \\r sozinho como fim de linha", () => {
    const { out } = feed(["id: 3\revent: debate\rdata: y\r\r"]);
    expect(out).toEqual([{ id: "3", event: "debate", data: "y" }]);
  });

  it("junta várias linhas data: com \\n e usa message como evento padrão", () => {
    const { out } = feed(["data: linha 1\ndata: linha 2\ndata:sem-espaco\n\n"]);
    expect(out).toEqual([{ id: undefined, event: "message", data: "linha 1\nlinha 2\nsem-espaco" }]);
  });

  it("ignora comentário de heartbeat e guarda retry sem emitir mensagem", () => {
    const { parser, out } = feed([": hb\n\n", "retry: 3000\n\n", ": hb\n\n"]);
    expect(out).toEqual([]);
    expect(parser.retry).toBe(3000);
  });

  it("guarda o último id; evento sem id (partial) não herda o id anterior", () => {
    const { parser, out } = feed(["id: 5\nevent: utterance\ndata: a\n\n", "event: partial\ndata: b\n\n"]);
    expect(out).toEqual([
      { id: "5", event: "utterance", data: "a" },
      { id: undefined, event: "partial", data: "b" },
    ]);
    expect(parser.lastEventId).toBe("5");
  });

  it("não emite bloco incompleto até a linha em branco", () => {
    const parser = createSseParser();
    expect(parser.push("id: 9\nevent: claim\ndata: z\n")).toEqual([]);
    expect(parser.push("\n").map(pick)).toEqual([{ id: "9", event: "claim", data: "z" }]);
  });
});
