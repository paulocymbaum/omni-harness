// Gate DV-006-ENUM-PARITY (dono: quality/test/delivery/dv-006.test.mjs). Copiado para admin-web/src/__dv006_gate_*__/
// só durante a execução do gate; __EXPECTED_ENUMS__ é trocado pelos valores wire lidos de DebateEnums.cs.
// Aceita cada enum exportado como array, objeto `as const` ou z.enum (lê `.options`).
import { describe, expect, it } from "vitest";
import * as enums from "../modules/debates/domain/enums";

const expected: Record<string, string[]> = __EXPECTED_ENUMS__;
// Exigidos pela spec DV-006 (domain/enums.ts). PublicMode aceita os dois nomes.
const required = [
  "DebateStatus", "ParticipantRole", "UtteranceOrigin", "ClaimType", "Verdict", "FactCheckState",
  "AnswerStatus", "TimelineEventType", "AudioSourceKind", "IngestionState",
];
const exported = enums as Record<string, unknown>;

function valuesOf(value: unknown): string[] | null {
  if (Array.isArray(value)) return value.map(String);
  if (value && typeof value === "object") {
    const options = (value as { options?: unknown }).options;
    if (Array.isArray(options)) return options.map(String);
    const vals = Object.values(value as Record<string, unknown>);
    if (vals.length && vals.every((v) => typeof v === "string")) return vals as string[];
  }
  return null;
}
const sorted = (xs: string[]) => [...new Set(xs)].sort();

describe("gate DV-006 enum parity", () => {
  it("exporta cada enum exigido com os mesmos valores wire do C#", () => {
    for (const name of required) {
      const got = valuesOf(exported[name]);
      expect(got, `enums.ts deve exportar ${name}`).not.toBeNull();
      expect(sorted(got ?? []), name).toEqual(sorted(expected[name]));
    }
  });

  it("modo público (DebatePublicMode ou PublicMode) igual ao C#", () => {
    const got = valuesOf(exported.DebatePublicMode ?? exported.PublicMode);
    expect(got, "enums.ts deve exportar DebatePublicMode ou PublicMode").not.toBeNull();
    expect(sorted(got ?? [])).toEqual(sorted(expected.DebatePublicMode));
  });

  it("todo export com nome de enum do C# (e o schema z.enum correspondente) tem os mesmos valores", () => {
    let checked = 0;
    for (const [name, values] of Object.entries(expected)) {
      for (const candidate of [name, `${name[0].toLowerCase()}${name.slice(1)}Schema`]) {
        if (!(candidate in exported)) continue;
        const got = valuesOf(exported[candidate]);
        expect(got, `${candidate} não é enum legível`).not.toBeNull();
        expect(sorted(got ?? []), candidate).toEqual(sorted(values));
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(required.length + 1);
  });
});
