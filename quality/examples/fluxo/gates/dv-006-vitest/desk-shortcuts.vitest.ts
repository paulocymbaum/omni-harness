// Gate DV-006-DESK-SHORTCUTS (dono: quality/test/delivery/dv-006.test.mjs). Copiado para admin-web/src/__dv006_gate_*__/
// só durante a execução do gate. Contrato: domain/deskShortcuts.ts exporta
// shortcutAction(event, participants, focusTarget) => { kind: 'bind-speaker' | 'fix-utterance', participantId } | null.
import { describe, expect, it } from "vitest";
import { shortcutAction } from "../modules/debates/domain/deskShortcuts";

// Ordem do array propositalmente diferente de displayOrder.
const participants = [
  { id: "p-c", role: "candidate", displayOrder: 3, ballotName: "Cand C", party: "PC", tseCandidateNumber: 30, color: null, photoUrl: null },
  { id: "p-a", role: "candidate", displayOrder: 1, ballotName: "Cand A", party: "PA", tseCandidateNumber: 10, color: null, photoUrl: null },
  { id: "p-b", role: "candidate", displayOrder: 2, ballotName: "Cand B", party: "PB", tseCandidateNumber: 20, color: null, photoUrl: null },
];
const digit = (n: number, extra: KeyboardEventInit = {}) =>
  new KeyboardEvent("keydown", { key: String(n), code: `Digit${n}`, bubbles: true, ...extra });
// Shift+2 num teclado real produz key "@" e code "Digit2".
const shiftDigit2 = () => new KeyboardEvent("keydown", { key: "@", code: "Digit2", shiftKey: true, bubbles: true });
type Args = Parameters<typeof shortcutAction>;
const act = (event: KeyboardEvent, focus: Element | null) =>
  shortcutAction(event as unknown as Args[0], participants as unknown as Args[1], focus as unknown as Args[2]);

describe("gate DV-006 desk shortcuts", () => {
  it("1 a 3 seguem displayOrder, não a ordem do array", () => {
    const body = document.body;
    expect(act(digit(1), body)).toEqual({ kind: "bind-speaker", participantId: "p-a" });
    expect(act(digit(2), body)).toEqual({ kind: "bind-speaker", participantId: "p-b" });
    expect(act(digit(3), null)).toEqual({ kind: "bind-speaker", participantId: "p-c" });
  });

  it("número maior que a quantidade de participantes é ignorado", () => {
    expect(act(digit(4), document.body)).toBeNull();
    expect(act(digit(9), document.body)).toBeNull();
  });

  it("Shift + número corrige só a fala selecionada", () => {
    expect(act(shiftDigit2(), document.body)).toEqual({ kind: "fix-utterance", participantId: "p-b" });
  });

  it("Ctrl, Meta e Alt anulam o atalho", () => {
    expect(act(digit(1, { ctrlKey: true }), document.body)).toBeNull();
    expect(act(digit(1, { metaKey: true }), document.body)).toBeNull();
    expect(act(digit(1, { altKey: true }), document.body)).toBeNull();
  });

  it("foco em input, textarea, select ou contenteditable anula o atalho", () => {
    const input = document.createElement("input");
    const textarea = document.createElement("textarea");
    const select = document.createElement("select");
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    Object.defineProperty(editable, "isContentEditable", { value: true });
    const inner = document.createElement("span");
    editable.appendChild(inner);
    Object.defineProperty(inner, "isContentEditable", { value: true });
    document.body.append(input, textarea, select, editable);
    for (const el of [input, textarea, select, editable, inner]) {
      expect(act(digit(1), el)).toBeNull();
      expect(act(shiftDigit2(), el)).toBeNull();
    }
  });

  it("foco em botão comum não bloqueia o atalho", () => {
    const button = document.createElement("button");
    document.body.append(button);
    expect(act(digit(2), button)).toEqual({ kind: "bind-speaker", participantId: "p-b" });
  });
});
