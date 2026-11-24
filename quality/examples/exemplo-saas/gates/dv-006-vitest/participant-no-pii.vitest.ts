// Gate DV-006-PARTICIPANT-NO-PII (dono: quality/test/delivery/dv-006.test.mjs). Copiado para admin-web/src/__dv006_gate_*__/
// só durante a execução do gate. Contrato: domain/debate.ts exporta debateParticipantSchema e tseCandidateSchema
// (Zod, .strict()). Base do participante = DebateParticipantView de backend/.../DebateContracts.cs.
import { describe, expect, it } from "vitest";
import { debateParticipantSchema, tseCandidateSchema } from "../modules/debates/domain/debate";

const participant = {
  id: "8d6f2a1e-5b7c-4f7e-9a51-0c2b9f3e1a11",
  role: "candidate",
  displayOrder: 1,
  ballotName: "Candidata Exemplo",
  party: "PEX",
  tseCandidateNumber: 45,
  color: "#38bdf8",
  photoUrl: "https://example.org/foto.jpg",
};
const candidate = { tseCandidateNumber: 45, ballotName: "Candidata Exemplo", party: "PEX", alreadyImported: false };
const pii = { cpf: "00000000000", titulo: "000000000000", birthDate: "1970-01-01" } as const;

describe("gate DV-006 participant no pii", () => {
  it("participante e candidato do snapshot válidos passam no parse", () => {
    expect(debateParticipantSchema.safeParse(participant).success).toBe(true);
    expect(tseCandidateSchema.safeParse(candidate).success).toBe(true);
  });

  it("participante com cpf, titulo ou birthDate falha no parse", () => {
    for (const [key, value] of Object.entries(pii)) {
      expect(debateParticipantSchema.safeParse({ ...participant, [key]: value }).success, key).toBe(false);
    }
  });

  it("candidato do snapshot com cpf, titulo ou birthDate falha no parse", () => {
    for (const [key, value] of Object.entries(pii)) {
      expect(tseCandidateSchema.safeParse({ ...candidate, [key]: value }).success, key).toBe(false);
    }
  });

  it("qualquer campo fora do contrato falha (strict)", () => {
    expect(debateParticipantSchema.safeParse({ ...participant, email: "x@example.org" }).success).toBe(false);
    expect(tseCandidateSchema.safeParse({ ...candidate, motherName: "X" }).success).toBe(false);
  });
});
