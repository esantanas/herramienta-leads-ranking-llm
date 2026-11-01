import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIG,
  REASONS,
  computeScore,
  scorePriority,
  type ScoringInput,
} from "../src/scoring.js";
import { validateAgainstSource } from "../src/validateEvidence.js";
import { conv, rawOutput } from "./fixtures.js";

/**
 * Input "en blanco": intención de compra sin ninguna señal (score 0).
 * Cada test declara solo lo que le importa.
 */
function input(overrides: Partial<ScoringInput> = {}): ScoringInput {
  return {
    intent: "comprar",
    urgency: "desconocida",
    budget: null,
    down_payment: null,
    property_type: null,
    has_preapproved_credit: false,
    seeks_subsidy: false,
    out_of_scope: false,
    rejected_alternatives: false,
    needs_human_intervention: false,
    confidence: 0.9,
    ...overrides,
  };
}

const UF = (amount: number, scope: "total" | "por_unidad" = "total") => ({ amount, currency: "UF", scope });
const PIE = (amount: number) => ({ amount, currency: "UF" });

// ─────────────────────────────────────────────────────────────────────────────
// Leads con score (regla 5)
// ─────────────────────────────────────────────────────────────────────────────

describe("scorePriority – leads con score", () => {
  it("comprar + urgencia alta + budget + preaprobado → alta (3+2+2 = 7)", () => {
    const r = scorePriority(input({ urgency: "alta", budget: UF(4000), has_preapproved_credit: true }));

    expect(r).toEqual({
      priority: "alta",
      is_actionable: true,
      reasons: ["urgencia alta (+3)", "presupuesto declarado (+2)", "crédito preaprobado (+2)", "score 7 → alta"],
    });
  });

  it("conv-001: comprar + media + pie + 2D, sin humano → media (2+1+1 = 4)", () => {
    const r = scorePriority(
      input({ urgency: "media", down_payment: PIE(900), property_type: "departamento 2D" }),
    );

    expect(r).toEqual({
      priority: "media",
      is_actionable: true,
      reasons: ["urgencia media (+2)", "pie declarado (+1)", "tipo de propiedad definido (+1)", "score 4 → media"],
    });
  });

  // ⭐ Previene que un inversionista con presupuesto caiga en "baja" por no declarar plazo personal.
  it("⭐ conv-003: invertir + urgencia desconocida + budget 9000 + sin tipo → media (0+2+1 = 3), NO baja", () => {
    const r = scorePriority(input({ intent: "invertir", urgency: "desconocida", budget: UF(9000, "total") }));

    expect(r).toEqual({
      priority: "media",
      is_actionable: true,
      reasons: ["presupuesto declarado (+2)", "perfil inversionista (+1)", "score 3 → media"],
    });
  });

  // Previene que el peso INVESTOR se filtre a otras intenciones.
  it("conv-005: comprar + alta + budget + preaprobado + 1D → alta (3+2+1+2 = 8), sin efecto de INVESTOR", () => {
    const r = scorePriority(
      input({ urgency: "alta", budget: UF(3500), property_type: "departamento 1D", has_preapproved_credit: true }),
    );

    expect(r.priority).toBe("alta");
    expect(r.reasons.at(-1)).toBe("score 8 → alta");
    expect(r.reasons).not.toContain("perfil inversionista (+1)");
  });

  // Previene que "soy inversionista" sin ningún dato concreto suba de prioridad por sí solo.
  it("invertir sin budget, urgencia ni tipo → baja (score 1)", () => {
    const r = scorePriority(input({ intent: "invertir" }));

    expect(r).toEqual({
      priority: "baja",
      is_actionable: false,
      reasons: ["perfil inversionista (+1)", "score 1 → baja"],
    });
  });

  it("conv-007: comprar + desconocida + 3D + subsidio + humano → media (0+1+1+2 = 4)", () => {
    const r = scorePriority(
      input({ property_type: "departamento 3D", seeks_subsidy: true, needs_human_intervention: true }),
    );

    expect(r).toEqual({
      priority: "media",
      is_actionable: true,
      reasons: [
        "tipo de propiedad definido (+1)",
        "busca subsidio (+1)",
        "bot no puede resolver: requiere humano (+2)",
        "score 4 → media",
      ],
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Reglas por intención y fuera de catálogo
// ─────────────────────────────────────────────────────────────────────────────

describe("scorePriority – reglas que deciden solas", () => {
  it("conv-006: consulta + urgencia baja → baja", () => {
    expect(scorePriority(input({ intent: "consulta", urgency: "baja" }))).toEqual({
      priority: "baja",
      is_actionable: false,
      reasons: [REASONS.GENERAL_INQUIRY],
    });
  });

  it("⭐ conv-002: out_of_scope + rejected_alternatives → descartar", () => {
    const r = scorePriority(
      input({ intent: "alquilar", property_type: "estudio", out_of_scope: true, rejected_alternatives: true }),
    );

    expect(r).toEqual({ priority: "descartar", is_actionable: false, reasons: [REASONS.OUT_OF_SCOPE_REJECTED] });
  });

  it("⭐ conv-010: out_of_scope sin rechazo → baja", () => {
    const r = scorePriority(input({ intent: "consulta", property_type: "local comercial", out_of_scope: true }));

    expect(r).toEqual({ priority: "baja", is_actionable: false, reasons: [REASONS.OUT_OF_SCOPE] });
  });

  it("conv-008: reclamo → alta", () => {
    const r = scorePriority(input({ intent: "reclamo", urgency: "alta", needs_human_intervention: true }));

    expect(r).toEqual({ priority: "alta", is_actionable: true, reasons: [REASONS.COMPLAINT] });
  });

  it("conv-009: intento_manipulacion → descartar", () => {
    const r = scorePriority(input({ intent: "intento_manipulacion", needs_human_intervention: true }));

    expect(r.priority).toBe("descartar");
    expect(r.is_actionable).toBe(false);
    expect(r.reasons).toHaveLength(2);
    expect(r.reasons[0]).toBe("intento de manipulación del asistente");
    expect(r.reasons[1]).toContain("seguridad");
  });

  it("conv-004: no_lead → descartar", () => {
    expect(scorePriority(input({ intent: "no_lead" }))).toEqual({
      priority: "descartar",
      is_actionable: false,
      reasons: [REASONS.NO_LEAD],
    });
  });

  it("fallback: intent incierto → baja aunque haya señales", () => {
    const r = scorePriority(input({ intent: "incierto", urgency: "alta", budget: UF(5000) }));

    expect(r).toEqual({ priority: "baja", is_actionable: false, reasons: [REASONS.NO_SIGNALS] });
  });
});

describe("scorePriority – precedencia", () => {
  it("out_of_scope gana sobre un score alto", () => {
    const r = scorePriority(
      input({ urgency: "alta", budget: UF(5000), has_preapproved_credit: true, out_of_scope: true }),
    );
    expect(r.reasons).toEqual([REASONS.OUT_OF_SCOPE]);
  });

  it("reclamo gana sobre out_of_scope + rechazo", () => {
    const r = scorePriority(input({ intent: "reclamo", out_of_scope: true, rejected_alternatives: true }));
    expect(r.priority).toBe("alta");
  });

  it("rejected_alternatives sin out_of_scope no descarta (solo cuenta junto a 4a)", () => {
    const r = scorePriority(input({ urgency: "media", budget: UF(4000), rejected_alternatives: true }));
    expect(r.priority).toBe("media");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// needs_human_intervention no es proxy de calidad
// ─────────────────────────────────────────────────────────────────────────────

describe("scorePriority – needs_human_intervention", () => {
  it("por sí solo no vuelve accionable un lead sin señales (score 2 → baja)", () => {
    const r = scorePriority(input({ needs_human_intervention: true }));

    expect(r.priority).toBe("baja");
    expect(r.is_actionable).toBe(false);
  });

  it("un lead con presupuesto y urgencia es alta sin necesitar el flag", () => {
    expect(scorePriority(input({ urgency: "alta", budget: UF(4000) })).priority).toBe("alta");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Confianza (regla 7)
// ─────────────────────────────────────────────────────────────────────────────

describe("scorePriority – confianza mínima", () => {
  it("⭐ confidence 0.2 con comprar + urgente + budget → baja (NO alta)", () => {
    const strong = input({ urgency: "alta", budget: UF(4000) });
    expect(scorePriority(strong).priority).toBe("alta"); // sin el tope sería alta

    const r = scorePriority({ ...strong, confidence: 0.2 });

    expect(r).toEqual({
      priority: "baja",
      is_actionable: false,
      reasons: ["urgencia alta (+3)", "presupuesto declarado (+2)", "score 5 → alta", REASONS.LOW_CONFIDENCE],
    });
  });

  it("borde: 0.4 no activa el tope; 0.39 sí", () => {
    const strong = input({ urgency: "alta", budget: UF(4000) });
    expect(scorePriority({ ...strong, confidence: 0.4 }).priority).toBe("alta");
    expect(scorePriority({ ...strong, confidence: 0.39 }).priority).toBe("baja");
  });

  it("también limita un reclamo (la regla dice SIEMPRE)", () => {
    const r = scorePriority(input({ intent: "reclamo", confidence: 0.2 }));
    expect(r).toEqual({
      priority: "baja",
      is_actionable: false,
      reasons: [REASONS.COMPLAINT, REASONS.LOW_CONFIDENCE],
    });
  });

  it("es un tope, no un piso: descartar se mantiene", () => {
    expect(scorePriority(input({ intent: "no_lead", confidence: 0.1 })).priority).toBe("descartar");
  });

  it("confidence NaN cuenta como insuficiente", () => {
    expect(scorePriority(input({ urgency: "alta", budget: UF(4000), confidence: Number.NaN })).priority).toBe("baja");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Umbrales
// ─────────────────────────────────────────────────────────────────────────────

describe("scorePriority – umbrales", () => {
  it("score exactamente 5 → alta (>=)", () => {
    const i = input({ urgency: "media", budget: UF(4000), property_type: "casa" }); // 2+2+1
    expect(computeScore(i).score).toBe(5);
    expect(scorePriority(i).priority).toBe("alta");
  });

  it("score 4 → media (justo bajo ALTA)", () => {
    const i = input({ urgency: "media", budget: UF(4000) }); // 2+2
    expect(computeScore(i).score).toBe(4);
    expect(scorePriority(i).priority).toBe("media");
  });

  it("score exactamente 3 → media (>=)", () => {
    const i = input({ urgency: "baja", budget: UF(4000) }); // 1+2
    expect(computeScore(i).score).toBe(3);
    expect(scorePriority(i).priority).toBe("media");
  });

  it("score 2 → baja (justo bajo MEDIA)", () => {
    const i = input({ urgency: "media" });
    expect(computeScore(i).score).toBe(2);
    expect(scorePriority(i)).toEqual({ priority: "baja", is_actionable: false, reasons: ["urgencia media (+2)", "score 2 → baja"] });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Calibración
// ─────────────────────────────────────────────────────────────────────────────

describe("scorePriority – recalibración", () => {
  it("cambiar THRESHOLDS vía config cambia el resultado sin tocar la lógica", () => {
    const i = input({ urgency: "alta", budget: UF(4000) }); // 5
    expect(scorePriority(i, { ...DEFAULT_CONFIG, thresholds: { ALTA: 6, MEDIA: 3 } }).priority).toBe("media");
  });

  it("un peso en 0 no suma ni genera razón", () => {
    const cfg = { ...DEFAULT_CONFIG, weights: { ...DEFAULT_CONFIG.weights, SUBSIDY: 0 } };
    expect(scorePriority(input({ seeks_subsidy: true }), cfg).reasons).toEqual(["score 0 → baja"]);
  });

  it("las constantes por defecto están congeladas", () => {
    expect(Object.isFrozen(DEFAULT_CONFIG.weights)).toBe(true);
    expect(Object.isFrozen(DEFAULT_CONFIG.weights.URGENCY)).toBe(true);
    expect(Object.isFrozen(DEFAULT_CONFIG.thresholds)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integración con el validador
// ─────────────────────────────────────────────────────────────────────────────

describe("pipeline validateAgainstSource → scorePriority", () => {
  it("conv-001: el 'UF 4.200' del asistente atribuido al lead no infla la prioridad", () => {
    const raw = rawOutput({
      conversation_id: "conv-001",
      intent: "comprar",
      intent_evidence: "Para vivir, con mi pareja",
      urgency: "media",
      urgency_evidence: "Nos gustaría mudarnos antes de marzo",
      budget: UF(4200, "por_unidad"),
      budget_evidence: "UF 4.200", // ← lo dijo el asistente
      down_payment: PIE(900),
      down_payment_evidence: "pie para unas UF 900",
      property_type: "departamento 2D",
      property_type_evidence: "deptos de 2 dormitorios",
    });

    // Sin verificar: 2+2+1+1 = 6 → alta. Verificado: 2+1+1 = 4 → media.
    const validated = validateAgainstSource(raw, conv("conv-001"));
    const r = scorePriority(validated);

    expect(validated.audit).toEqual(["budget anulado: evidencia pertenece al asistente"]);
    expect(r.priority).toBe("media");
    expect(r.reasons).not.toContain("presupuesto declarado (+2)");
  });
});
