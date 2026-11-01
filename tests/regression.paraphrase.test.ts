/**
 * Errores típicos del LLM sobre conversaciones reales y cómo los maneja la
 * pipeline determinista (validateAgainstSource + scorePriority).
 *
 * Cada caso parte de la extracción ideal y le inyecta UN error. Los tests
 * fijan el comportamiento actual, incluidos sus límites conocidos.
 * No llama a Gemini.
 */
import { describe, expect, test } from "vitest";
import type { RawLlmOutput } from "../src/schema.js";
import { scorePriority } from "../src/scoring.js";
import { buildLeadText, validateAgainstSource } from "../src/validateEvidence.js";
import { conv } from "./fixtures.js";
import { IDEAL_EXTRACTIONS } from "./fixtures/ideal-extractions.js";

/** Extracción ideal de `id` con un error inyectado. */
function withError(id: string, patch: Partial<RawLlmOutput>) {
  const raw: RawLlmOutput = { ...IDEAL_EXTRACTIONS[id]!, ...patch };
  const validated = validateAgainstSource(raw, conv(id));
  return { validated, scored: scorePriority(validated) };
}

const baseline = (id: string) => withError(id, {});

describe("regresión: paráfrasis y errores típicos del LLM", () => {
  /**
   * TRADE-OFF ACEPTADO — falso negativo antes que falso positivo.
   * El lead escribió "pie para unas UF 900"; si el LLM resume la cita como
   * "pie UF 900", no es literal y el validador anula el pie aunque el dato
   * sea cierto. Preferimos perder un dato real (el ejecutivo lo ve al leer)
   * a aceptar citas "parecidas", que abrirían la puerta a datos inventados.
   * El prompt debe exigir copia textual. Aquí el lead cae de 4 a 3 puntos:
   * sigue en media, pero justo en el umbral.
   */
  // Previene que el validador acepte citas parafraseadas (relajar el matching literal rompería este test).
  test("conv-001: down_payment_evidence parafraseada 'pie UF 900' → pie anulado, prioridad media en el borde", () => {
    expect(buildLeadText(conv("conv-001"))).toContain("pie para unas uf 900");

    const { validated, scored } = withError("conv-001", { down_payment_evidence: "pie UF 900" });

    expect(validated.down_payment).toBeNull();
    expect(validated.audit).toEqual(["down_payment anulado: evidencia 'pie UF 900' no aparece en mensajes del lead"]);
    expect(scored.reasons).not.toContain("pie declarado (+1)");
    expect(scored.reasons.at(-1)).toBe("score 3 → media");
    expect(["baja", "media"]).toContain(scored.priority);
    expect(scored.priority).toBe("media");
  });

  // Previene que una cita reordenada ("UF 3.500" vs "3.500 UF") pase, y documenta que el lead sigue alta por sus otras señales.
  test("conv-005: budget_evidence reordenada 'Máximo UF 3.500' → budget anulado, sigue alta", () => {
    const { validated, scored } = withError("conv-005", { budget_evidence: "Máximo UF 3.500" });

    expect(validated.budget).toBeNull();
    expect(validated.audit).toEqual(["budget anulado: evidencia 'Máximo UF 3.500' no aparece en mensajes del lead"]);
    expect(scored.priority).toBe("alta");
    expect(scored.reasons.at(-1)).toBe("score 6 → alta"); // 3 urgencia + 1 tipo + 2 crédito (sin los +2 del budget)
  });

  // Previene la alucinación central: atribuir al lead un precio de catálogo que dijo el asistente.
  test("conv-001: budget sacado de 'UF 4.200' (asistente) → anulado, audit 'pertenece al asistente'", () => {
    const { validated, scored } = withError("conv-001", {
      budget: { amount: 4200, currency: "UF", scope: "por_unidad" },
      budget_evidence: "desde UF 4.200",
    });

    expect(validated.budget).toBeNull();
    expect(validated.audit).toEqual(["budget anulado: evidencia pertenece al asistente"]);
    expect(scored).toEqual(baseline("conv-001").scored); // mismo resultado que sin el error
  });

  /**
   * LÍMITE CONOCIDO DEL VALIDADOR: la semántica la garantiza el LLM, no el código.
   * "ingresos de 1.8 millones" existe literalmente en el mensaje del lead,
   * así que el validador (que solo verifica existencia y origen) lo acepta
   * como evidencia de presupuesto. Consecuencia real: +2 puntos y el lead
   * sube de media a ALTA con un dato que no es un presupuesto de compra.
   * La defensa es el prompt (definir budget como monto de compra, no
   * ingreso) y la revisión humana. Este test fija el comportamiento actual:
   * si algún día se agrega una regla semántica, este test fallará y habrá
   * que actualizarlo a propósito.
   */
  // Previene olvidar este hueco: deja explícito que el código NO atrapa un ingreso citado como presupuesto.
  test("conv-007: budget = ingresos (1.8M) con cita literal → el validador lo deja pasar (límite conocido)", () => {
    const { validated, scored } = withError("conv-007", {
      budget: { amount: 1_800_000, currency: "CLP", scope: "total" },
      budget_evidence: "ingresos de 1.8 millones",
    });

    expect(validated.budget).toEqual({ amount: 1_800_000, currency: "CLP", scope: "total" });
    expect(validated.audit).toEqual([]);
    expect(baseline("conv-007").scored.priority).toBe("media");
    expect(scored.priority).toBe("alta"); // inflado: así se ve el costo de este límite
  });
});
