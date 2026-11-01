import { describe, expect, it } from "vitest";
import { ValidatedOutputSchema } from "../src/schema.js";
import { buildLeadText, isEvidenceValid, normalize, validateAgainstSource } from "../src/validateEvidence.js";
import { conv, rawOutput } from "./fixtures.js";

// Conversaciones reales (data/conversations.json)
const CONV_001 = conv("conv-001"); // asistente dice "desde UF 4.200"; lead da "pie para unas UF 900"
const CONV_002 = conv("conv-002"); // lead quiere arriendo y rechaza la venta
const CONV_003 = conv("conv-003"); // inversionista, "Presupuesto total hasta UF 9.000"
const CONV_005 = conv("conv-005"); // "Necesito un depto YA", "tengo preaprobado el crédito"
const CONV_007 = conv("conv-007"); // "ingresos de 1.8 millones"
const EMPTY = { id: "conv-vacia", mensajes: [] };

// ─────────────────────────────────────────────────────────────────────────────
// Piezas básicas
// ─────────────────────────────────────────────────────────────────────────────

describe("normalize", () => {
  it("minúsculas, sin tildes ni ñ, espacios colapsados y trim", () => {
    expect(normalize("  Mirador   ÑUÑOA\n crédito ")).toBe("mirador nunoa credito");
  });
});

describe("buildLeadText", () => {
  it("contiene SOLO texto del lead, ya normalizado", () => {
    const lead = buildLeadText(CONV_001);

    expect(lead).toContain("tenemos pie para unas uf 900");
    expect(lead).toContain("mirador nunoa");
    expect(lead).not.toContain("4.200"); // lo dijo el asistente
    expect(lead).not.toContain("buscas para vivir o invertir"); // pregunta del asistente
  });
});

describe("isEvidenceValid", () => {
  it("true para cita literal del lead; false para cita del asistente", () => {
    const lead = buildLeadText(CONV_001);
    expect(isEvidenceValid("pie para unas UF 900", lead)).toBe(true);
    expect(isEvidenceValid("desde UF 4.200", lead)).toBe(false);
  });

  it("false para null y para string vacío", () => {
    const lead = buildLeadText(CONV_001);
    expect(isEvidenceValid(null, lead)).toBe(false);
    expect(isEvidenceValid("", lead)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// validateAgainstSource: casos pedidos
// ─────────────────────────────────────────────────────────────────────────────

describe("validateAgainstSource", () => {
  it("1. budget con evidencia en turno del lead → se mantiene", () => {
    const raw = rawOutput({
      budget: { amount: 9000, currency: "UF", scope: "total" },
      budget_evidence: "Presupuesto total hasta UF 9.000",
    });

    const out = validateAgainstSource(raw, CONV_003);

    expect(out.budget).toEqual({ amount: 9000, currency: "UF", scope: "total" });
    expect(out.audit).toEqual([]);
  });

  it("2. ⭐ budget con evidencia que SOLO dijo el asistente ('UF 4.200') → null, audit 'pertenece al asistente'", () => {
    // Premisa: el lead nunca escribe "UF 4.200"; el asistente sí.
    expect(buildLeadText(CONV_001)).not.toContain("uf 4.200");

    const raw = rawOutput({
      budget: { amount: 4200, currency: "UF", scope: "por_unidad" },
      budget_evidence: "UF 4.200",
    });

    const out = validateAgainstSource(raw, CONV_001);

    expect(out.budget).toBeNull();
    expect(out.audit).toEqual(["budget anulado: evidencia pertenece al asistente"]);
  });

  it("3. budget con evidencia inventada (no está en ningún turno) → null", () => {
    const raw = rawOutput({
      budget: { amount: 5000, currency: "UF", scope: "total" },
      budget_evidence: "puedo pagar hasta UF 5.000",
    });

    const out = validateAgainstSource(raw, CONV_001);

    expect(out.budget).toBeNull();
    expect(out.audit).toEqual([
      "budget anulado: evidencia 'puedo pagar hasta UF 5.000' no aparece en mensajes del lead",
    ]);
  });

  it("4. down_payment 'pie para unas UF 900' (presente en el lead) → se mantiene", () => {
    const raw = rawOutput({
      down_payment: { amount: 900, currency: "UF" },
      down_payment_evidence: "pie para unas UF 900",
    });

    const out = validateAgainstSource(raw, CONV_001);

    expect(out.down_payment).toEqual({ amount: 900, currency: "UF" });
    expect(out.audit).toEqual([]);
  });

  it("5. budget_evidence 'ingresos de 1.8 millones' → PASA: el validador verifica existencia, no semántica", () => {
    // Comportamiento intencional (ver cabecera de validateEvidence.ts):
    // la cita existe literalmente en el mensaje del lead, así que es válida.
    // Que un ingreso NO sea un presupuesto de compra lo debe impedir el prompt;
    // este módulo solo garantiza que el LLM no inventó ni tomó prestada la cita.
    const raw = rawOutput({
      budget: { amount: 1_800_000, currency: "CLP", scope: "total" },
      budget_evidence: "ingresos de 1.8 millones",
    });

    const out = validateAgainstSource(raw, CONV_007);

    expect(out.budget).toEqual({ amount: 1_800_000, currency: "CLP", scope: "total" });
    expect(out.audit).toEqual([]);
  });

  it("6. evidencia de 3 caracteres → null (aunque exista en el lead)", () => {
    expect(buildLeadText(CONV_001)).toContain("pie");

    const raw = rawOutput({
      down_payment: { amount: 900, currency: "UF" },
      down_payment_evidence: "pie",
    });

    const out = validateAgainstSource(raw, CONV_001);

    expect(out.down_payment).toBeNull();
    expect(out.audit).toEqual(["down_payment anulado: evidencia 'pie' tiene menos de 4 caracteres"]);
  });

  it("7. tildes: original con tildes ('crédito', 'Ñuñoa'), evidencia sin tildes → válido", () => {
    const credit = validateAgainstSource(
      rawOutput({ has_preapproved_credit: true, has_preapproved_credit_evidence: "tengo preaprobado el credito" }),
      CONV_005,
    );
    const place = validateAgainstSource(
      rawOutput({ intent: "comprar", intent_evidence: "vi el proyecto Mirador Nunoa" }),
      CONV_001,
    );

    expect(credit.has_preapproved_credit).toBe(true);
    expect(place.intent).toBe("comprar");
    expect([...credit.audit, ...place.audit]).toEqual([]);
  });

  it("8. mayúsculas vs minúsculas → válido en ambos sentidos", () => {
    // Lead escribió "Necesito un depto YA" y "Para vivir, con mi pareja".
    const lower = validateAgainstSource(
      rawOutput({ urgency: "alta", urgency_evidence: "necesito un depto ya" }),
      CONV_005,
    );
    const upper = validateAgainstSource(
      rawOutput({ intent: "comprar", intent_evidence: "PARA VIVIR, CON MI PAREJA" }),
      CONV_001,
    );

    expect(lower.urgency).toBe("alta");
    expect(upper.intent).toBe("comprar");
  });

  it("9. intent sin evidencia → 'incierto'", () => {
    const out = validateAgainstSource(rawOutput({ intent: "comprar", intent_evidence: null }), CONV_001);

    expect(out.intent).toBe("incierto");
    expect(out.audit).toEqual(["intent anulado: sin evidencia"]);
  });

  it("10. urgency 'alta' con evidencia falsa → 'desconocida'", () => {
    const raw = rawOutput({ urgency: "alta", urgency_evidence: "necesito mudarme esta semana" });

    const out = validateAgainstSource(raw, CONV_001);

    expect(out.urgency).toBe("desconocida");
    expect(out.audit).toEqual([
      "urgency anulado: evidencia 'necesito mudarme esta semana' no aparece en mensajes del lead",
    ]);
  });

  it("11. conversación vacía → todo degradado, audit con una entrada por campo (9)", () => {
    const raw = rawOutput({
      intent: "comprar",
      intent_evidence: "Para vivir, con mi pareja",
      urgency: "media",
      urgency_evidence: "mudarnos antes de marzo",
      budget: { amount: 4200, currency: "UF", scope: "total" },
      budget_evidence: "UF 4.200",
      down_payment: { amount: 900, currency: "UF" },
      down_payment_evidence: "pie para unas UF 900",
      property_type: "departamento 2D",
      property_type_evidence: "deptos de 2 dormitorios",
      has_preapproved_credit: true,
      has_preapproved_credit_evidence: "tengo preaprobado el crédito",
      seeks_subsidy: true,
      seeks_subsidy_evidence: "acepta subsidio DS19",
      out_of_scope: true,
      out_of_scope_evidence: "locales comerciales",
      rejected_alternatives: true,
      rejected_alternatives_evidence: "solo arriendo gracias",
    });

    const out = validateAgainstSource(raw, EMPTY);

    expect(out).toMatchObject({
      intent: "incierto",
      urgency: "desconocida",
      budget: null,
      down_payment: null,
      property_type: null,
      has_preapproved_credit: false,
      seeks_subsidy: false,
      out_of_scope: false,
      rejected_alternatives: false,
    });
    expect(out.audit.length).toBeGreaterThanOrEqual(5);
    expect(out.audit).toHaveLength(9);
    expect(out.audit.every((line) => line.includes("no aparece en mensajes del lead"))).toBe(true);
  });

  it("12. has_preapproved_credit=true sin evidencia → false", () => {
    const raw = rawOutput({ has_preapproved_credit: true, has_preapproved_credit_evidence: null });

    const out = validateAgainstSource(raw, CONV_005);

    expect(out.has_preapproved_credit).toBe(false);
    expect(out.audit).toEqual(["has_preapproved_credit anulado: sin evidencia"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Casos adicionales
// ─────────────────────────────────────────────────────────────────────────────

describe("validateAgainstSource – adicionales", () => {
  it("rejected_alternatives: cita del lead se mantiene; pregunta del asistente se anula", () => {
    const fromLead = validateAgainstSource(
      rawOutput({ rejected_alternatives: true, rejected_alternatives_evidence: "no, solo arriendo gracias" }),
      CONV_002,
    );
    const fromAssistant = validateAgainstSource(
      rawOutput({ rejected_alternatives: true, rejected_alternatives_evidence: "¿Te interesa igual conocer las opciones?" }),
      CONV_002,
    );

    expect(fromLead.rejected_alternatives).toBe(true);
    expect(fromAssistant.rejected_alternatives).toBe(false);
    expect(fromAssistant.audit).toEqual(["rejected_alternatives anulado: evidencia pertenece al asistente"]);
  });

  it("una cita que aparece en lead Y asistente es válida (el lead la dijo)", () => {
    // "estudio": lead → "arriendo del estudio"; asistente → "Los estudios ..."
    const out = validateAgainstSource(
      rawOutput({ property_type: "estudio", property_type_evidence: "estudio" }),
      CONV_002,
    );

    expect(out.property_type).toBe("estudio");
    expect(out.audit).toEqual([]);
  });

  it("flags en false no se verifican ni generan audit", () => {
    const out = validateAgainstSource(rawOutput({ seeks_subsidy: false, seeks_subsidy_evidence: null }), CONV_001);

    expect(out.seeks_subsidy).toBe(false);
    expect(out.audit).toEqual([]);
  });

  it("intent ya 'incierto' no se anula ni genera audit", () => {
    expect(validateAgainstSource(rawOutput(), CONV_001).audit).toEqual([]);
  });

  it("el audit sigue el orden de los campos", () => {
    const raw = rawOutput({
      intent: "comprar",
      urgency: "alta",
      urgency_evidence: "YA",
      budget: { amount: 4200, currency: "UF", scope: "total" },
      budget_evidence: "desde UF 4.200",
      seeks_subsidy: true,
      seeks_subsidy_evidence: "subsidio DS19",
    });

    expect(validateAgainstSource(raw, CONV_001).audit).toEqual([
      "budget anulado: evidencia pertenece al asistente",
      "urgency anulado: evidencia 'YA' tiene menos de 4 caracteres",
      "intent anulado: sin evidencia",
      "seeks_subsidy anulado: evidencia 'subsidio DS19' no aparece en mensajes del lead",
    ]);
  });

  it("la salida cumple ValidatedOutputSchema y no contiene ningún *_evidence", () => {
    const out = validateAgainstSource(
      rawOutput({
        budget: { amount: 4200, currency: "UF", scope: "total" },
        budget_evidence: "UF 4.200",
        down_payment: { amount: 900, currency: "UF" },
        down_payment_evidence: "pie para unas UF 900",
      }),
      CONV_001,
    );

    expect(ValidatedOutputSchema.safeParse(out).success).toBe(true);
    expect(Object.keys(out).some((k) => k.endsWith("_evidence"))).toBe(false);
  });

  it("es pura: no muta la entrada ni comparte objetos con ella", () => {
    const raw = rawOutput({
      down_payment: { amount: 900, currency: "UF" },
      down_payment_evidence: "pie para unas UF 900",
    });
    const snapshot = structuredClone(raw);
    const convSnapshot = structuredClone(CONV_001);

    const out = validateAgainstSource(raw, CONV_001);

    expect(raw).toEqual(snapshot);
    expect(CONV_001).toEqual(convSnapshot);
    expect(out.down_payment).not.toBe(raw.down_payment);
  });
});
