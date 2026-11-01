import { describe, expect, it } from "vitest";
import { parseLlmJson, type RawLlmOutput } from "../src/schema.js";

/** conv-005: lead con urgencia, presupuesto y crédito preaprobado. */
const valid: RawLlmOutput = {
  conversation_id: "conv-005",
  intent: "comprar",
  intent_evidence: "tengo preaprobado el crédito",
  urgency: "alta",
  urgency_evidence: "me tengo que salir de mi arriendo el 30",
  budget: { amount: 3500, currency: "UF", scope: "total" },
  budget_evidence: "Máximo 3.500 UF",
  down_payment: null,
  down_payment_evidence: null,
  property_type: "departamento 1D",
  property_type_evidence: "algo de 1 dormitorio",
  has_preapproved_credit: true,
  has_preapproved_credit_evidence: "tengo preaprobado el crédito",
  seeks_subsidy: false,
  seeks_subsidy_evidence: null,
  out_of_scope: false,
  out_of_scope_evidence: null,
  rejected_alternatives: false,
  rejected_alternatives_evidence: null,
  needs_human_intervention: false,
  intervention_reason: null,
  one_line_summary: "Busca 1D con entrega inmediata, máx. UF 3.500, crédito preaprobado, se muda el 30.",
  confidence: 0.9,
};

describe("parseLlmJson", () => {
  it("acepta JSON válido", () => {
    const r = parseLlmJson(JSON.stringify(valid));

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual(valid);
  });

  it("acepta JSON envuelto en ```json``` con texto alrededor", () => {
    const text = "Aquí está el análisis:\n```json\n" + JSON.stringify(valid, null, 2) + "\n```\nSaludos.";

    const r = parseLlmJson(text);

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.conversation_id).toBe("conv-005");
  });

  it("devuelve error (sin lanzar) ante JSON malformado", () => {
    const text = '{"conversation_id": "conv-005", "intent": "comprar",, }';

    const r = parseLlmJson(text);

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBeInstanceOf(Error);
      expect(r.error.kind).toBe("invalid_json");
    }
  });

  it("falla zod por cross-field: budget null con budget_evidence no-null", () => {
    const bad = { ...valid, budget: null, budget_evidence: "Máximo 3.500 UF" };

    const r = parseLlmJson(JSON.stringify(bad));

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe("schema");
      expect(r.error.issues.map((i) => i.path.join("."))).toEqual(["budget_evidence"]);
    }
  });
});
