/**
 * Regresión "golden" sobre las 10 conversaciones reales.
 *
 * Simula una extracción PERFECTA del LLM (tests/fixtures/ideal-extractions.ts)
 * y comprueba que validateAgainstSource + scorePriority producen el resultado
 * de negocio esperado. Si alguien cambia pesos, umbrales, reglas o el
 * validador, aquí se ve qué conversación real cambia de prioridad.
 *
 * No llama a Gemini.
 */
import { describe, expect, test } from "vitest";
import { RawLlmOutputSchema, type ValidatedOutput } from "../src/schema.js";
import { scorePriority, type Priority } from "../src/scoring.js";
import { validateAgainstSource } from "../src/validateEvidence.js";
import { conv } from "./fixtures.js";
import { IDEAL_EXTRACTIONS } from "./fixtures/ideal-extractions.js";

// ─────────────────────────────────────────────────────────────────────────────
// Ground truth (definido por negocio). Solo se comparan los campos listados.
// ─────────────────────────────────────────────────────────────────────────────

type Expected = Partial<Pick<
  ValidatedOutput,
  "intent" | "urgency" | "budget" | "down_payment" | "property_type" | "has_preapproved_credit"
  | "seeks_subsidy" | "out_of_scope" | "rejected_alternatives" | "needs_human_intervention"
>> & { readonly priority: Priority };

const GROUND_TRUTH: ReadonlyArray<readonly [id: string, expected: Expected]> = [
  ["conv-001", {
    intent: "comprar", urgency: "media", budget: null,
    down_payment: { amount: 900, currency: "UF" },
    property_type: expect.stringContaining("2D") as unknown as string,
    needs_human_intervention: false, priority: "media",
  }],
  ["conv-002", { intent: "alquilar", out_of_scope: true, rejected_alternatives: true, priority: "descartar" }],
  // CAMBIO DE CRITERIO (2026-10-31). Antes: urgency "media", priority "alta".
  // Ahora: "idealmente entrega inmediata" describe el PRODUCTO, no un plazo del comprador
  // (regla de urgency del prompt) → urgency "desconocida". El inversionista con presupuesto
  // sigue siendo valioso: el peso INVESTOR (+1) lo mantiene accionable en "media"
  // (0 urgencia + 2 budget + 1 tipo + 1 inversionista = 4), no en "baja".
  ["conv-003", { intent: "invertir", urgency: "desconocida", budget: { amount: 9000, currency: "UF", scope: "total" }, priority: "media" }],
  ["conv-004", { intent: "no_lead", priority: "descartar" }],
  ["conv-005", {
    intent: "comprar", urgency: "alta", budget: { amount: 3500, currency: "UF", scope: "total" },
    has_preapproved_credit: true, priority: "alta",
  }],
  ["conv-006", { intent: "consulta", priority: "baja" }],
  ["conv-007", { intent: "comprar", budget: null, seeks_subsidy: true, needs_human_intervention: true, priority: "media" }],
  ["conv-008", { intent: "reclamo", needs_human_intervention: true, priority: "alta" }],
  ["conv-009", { intent: "intento_manipulacion", priority: "descartar" }],
  ["conv-010", { intent: "consulta", out_of_scope: true, rejected_alternatives: false, priority: "baja" }],
];

const isActionable = (p: Priority) => p === "alta" || p === "media";

/** Pipeline determinista: verificación de evidencias + scoring. */
function analyze(id: string) {
  const validated = validateAgainstSource(IDEAL_EXTRACTIONS[id]!, conv(id));
  return { validated, scored: scorePriority(validated) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("golden: extracción ideal de las 10 conversaciones reales", () => {
  // Previene un fixture roto: cada extracción ideal debe pasar el schema (incluidas las reglas cross-field).
  test.each(GROUND_TRUTH.map(([id]) => id))("%s: el fixture cumple RawLlmOutputSchema", (id) => {
    const parsed = RawLlmOutputSchema.safeParse(IDEAL_EXTRACTIONS[id]);
    expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues, null, 2)).toBe(true);
  });

  // Previene citas mal copiadas en el fixture: una extracción ideal no debe perder ningún campo en el validador.
  test.each(GROUND_TRUTH.map(([id]) => id))("%s: todas las citas existen en el lead (audit vacío)", (id) => {
    expect(analyze(id).validated.audit).toEqual([]);
  });

  // Previene regresiones de negocio: cambios en reglas, pesos o validador que muevan una conversación real de prioridad.
  test.each(GROUND_TRUTH.map(([id, expected]) => ({ id, expected, priority: expected.priority })))(
    "$id → $priority",
    ({ id, expected }) => {
      const { validated, scored } = analyze(id);

      // Proyección a los mismos campos del ground truth: el diff de vitest muestra solo lo relevante.
      const actual = {
        ...Object.fromEntries(
          Object.keys(expected).filter((k) => k !== "priority").map((k) => [k, validated[k as keyof ValidatedOutput]]),
        ),
        priority: scored.priority,
        is_actionable: scored.is_actionable,
      };

      // El mensaje acompaña al diff si falla: explica POR QUÉ salió esa prioridad.
      expect(actual, `${id} | razones: ${scored.reasons.join(" | ")} | audit: ${validated.audit.join(" | ") || "—"}`).toEqual({
        ...expected,
        is_actionable: isActionable(expected.priority),
      });
    },
  );

  // Previene que el set de conversaciones cambie sin actualizar el ground truth (o viceversa).
  test("el ground truth cubre exactamente los fixtures", () => {
    expect(GROUND_TRUTH.map(([id]) => id).sort()).toEqual(Object.keys(IDEAL_EXTRACTIONS).sort());
  });
});
