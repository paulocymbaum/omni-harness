// Gate DV-007-RULES (dono: quality/test/delivery/dv-007.test.mjs). Copiado para admin-web/src/__dv007_gate_*__/
// só durante o gate. Contrato (specs/DV-007.md): domain/validationRules.ts e domain/changeReasons.ts.
// requiresTwoPeople(verdict, twoPersonVerdicts) recebe a lista do contrato (FactCheckDetail.twoPersonVerdicts).
import { describe, expect, it } from "vitest";
import * as rules from "../modules/debates/domain/validationRules";
import * as reasons from "../modules/debates/domain/changeReasons";

const CODES = ["wrong_data", "outdated_source", "missing_context", "misread_claim", "transcription_error", "other"];
type Fn = (...args: unknown[]) => unknown;
const fn = (name: string) => (rules as unknown as Record<string, Fn>)[name] as Fn;

describe("gate DV-007 regras puras da validação", () => {
  it("requiresChangeReason só quando o selo do formulário difere do selo da IA", () => {
    expect(fn("requiresChangeReason")("false", "false")).toBe(false);
    expect(fn("requiresChangeReason")("false", "true")).toBe(true);
    expect(fn("requiresChangeReason")("exaggerated", "inaccurate")).toBe(true);
  });

  it("requiresTwoPeople segue a lista vinda do contrato", () => {
    const list = ["false", "exaggerated"];
    expect(fn("requiresTwoPeople")("false", list)).toBe(true);
    expect(fn("requiresTwoPeople")("exaggerated", list)).toBe(true);
    expect(fn("requiresTwoPeople")("true", list)).toBe(false);
    expect(fn("requiresTwoPeople")("exaggerated", ["false"])).toBe(false);
  });

  it("explanationRemaining conta a partir de 280 e fica negativo acima do limite", () => {
    expect(fn("explanationRemaining")("")).toBe(280);
    expect(fn("explanationRemaining")("a".repeat(250))).toBe(30);
    expect(fn("explanationRemaining")("a".repeat(285)) as number).toBeLessThan(0);
  });

  it("changeReasons tem exatamente os seis códigos do contrato", () => {
    const lists = Object.values(reasons as Record<string, unknown>)
      .filter(Array.isArray)
      .map((list) => (list as unknown[]).map((x) => (typeof x === "string" ? x : (x as { code?: string; value?: string }).code ?? (x as { value?: string }).value)));
    expect(lists.some((codes) => codes.length === CODES.length && CODES.every((c) => codes.includes(c)))).toBe(true);
  });
});
