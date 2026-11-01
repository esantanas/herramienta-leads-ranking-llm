/**
 * Priorización determinista de leads (sin LLM, sin red, sin I/O).
 * Recibe hechos ya verificados por validateEvidence.ts.
 */
import type { Urgency, ValidatedOutput } from "./schema.js";

// ─────────────────────────────────────────────────────────────────────────────
// Tipos
// ─────────────────────────────────────────────────────────────────────────────

/** Campos de ValidatedOutput que usa el scoring. Un ValidatedOutput completo calza directo. */
export type ScoringInput = Pick<
  ValidatedOutput,
  | "intent"
  | "urgency"
  | "budget"
  | "down_payment"
  | "property_type"
  | "has_preapproved_credit"
  | "seeks_subsidy"
  | "out_of_scope"
  | "rejected_alternatives"
  | "needs_human_intervention"
  | "confidence"
>;

export type Priority = "alta" | "media" | "baja" | "descartar";

export interface PriorityResult {
  readonly priority: Priority;
  readonly reasons: readonly string[];
  /** true solo para "alta" y "media": merece acción de un vendedor. */
  readonly is_actionable: boolean;
}

export interface Weights {
  readonly URGENCY: Readonly<Record<Urgency, number>>;
  readonly BUDGET: number;
  readonly DOWN_PAYMENT: number;
  readonly PROPERTY_TYPE: number;
  readonly PREAPPROVED: number;
  readonly SUBSIDY: number;
  readonly HUMAN: number;
  readonly INVESTOR: number;
}

export interface Thresholds {
  readonly ALTA: number;
  readonly MEDIA: number;
}

export interface ScoringConfig {
  readonly weights: Weights;
  readonly thresholds: Thresholds;
  readonly minConfidence: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constantes de calibración
// ─────────────────────────────────────────────────────────────────────────────

export const WEIGHTS: Weights = Object.freeze({
  URGENCY: Object.freeze({
    alta: 3, // Plazo concreto y cercano: el mejor predictor de cierre; la ventana se pierde si no se contacta ya.
    media: 2, // Hay plazo, pero con holgura para comparar con la competencia.
    baja: 1, // Interés real pero a largo plazo: vale nutrirlo, no correr.
    desconocida: 0, // No se premia la falta de dato.
  }),
  BUDGET: 2, // Ya hizo números y permite calzarlo con el stock disponible.
  DOWN_PAYMENT: 1, // El pie es requisito bancario, pero suele venir junto con el presupuesto: pesa menos para no contar dos veces.
  PROPERTY_TYPE: 1, // Búsqueda definida (depto/casa, dormitorios), pero es un dato fácil de dar.
  PREAPPROVED: 2, // Financiamiento resuelto: elimina la principal causa de caída de una venta.
  SUBSIDY: 1, // Intención seria y calce con proyectos con subsidio, aunque alarga el proceso (postulación).
  HUMAN: 2, // NO mide calidad: el bot está bloqueado (DS19, negociación, legal) y el lead se enfría si nadie responde pronto.
  // Un inversionista con presupuesto declarado es un lead de alto valor para una inmobiliaria
  // (suele comprar varias unidades), independientemente de su urgencia: no debe caer en "baja".
  // Con presupuesto suma ≥ 3 (2 + 1) → al menos "media". Sin presupuesto ni otras señales, el +1
  // solo no alcanza: un "soy inversionista" vacío sigue en "baja".
  INVESTOR: 1,
});

export const THRESHOLDS: Thresholds = Object.freeze({ ALTA: 5, MEDIA: 3 });

export const MIN_CONFIDENCE = 0.4;

export const DEFAULT_CONFIG: ScoringConfig = Object.freeze({
  weights: WEIGHTS,
  thresholds: THRESHOLDS,
  minConfidence: MIN_CONFIDENCE,
});

export const REASONS = Object.freeze({
  NO_LEAD: "número equivocado o sin interés real",
  MANIPULATION: "intento de manipulación del asistente",
  MANIPULATION_ACTION: "descartar para venta; revisar logs de seguridad",
  COMPLAINT: "reclamo: riesgo reputacional, requiere humano urgente",
  OUT_OF_SCOPE_REJECTED: "fuera de catálogo y rechazó alternativas",
  OUT_OF_SCOPE: "fuera de catálogo, posible reorientación",
  GENERAL_INQUIRY: "consulta general sin intención de compra",
  LOW_CONFIDENCE: "confianza insuficiente para priorizar (anti-alucinación)",
  NO_SIGNALS: "sin señales suficientes",
});

const SCORED_INTENTS: ReadonlySet<ScoringInput["intent"]> = new Set(["comprar", "invertir", "alquilar"]);

// ─────────────────────────────────────────────────────────────────────────────
// Score
// ─────────────────────────────────────────────────────────────────────────────

export interface ScoreBreakdown {
  readonly score: number;
  /** Una razón por cada ítem que sumó > 0. */
  readonly reasons: readonly string[];
}

/** Suma ponderada de señales. No mira intent, out_of_scope ni confidence. */
export function computeScore(input: ScoringInput, weights: Weights = WEIGHTS): ScoreBreakdown {
  const items: ReadonlyArray<readonly [applies: boolean, weight: number, label: string]> = [
    [true, weights.URGENCY[input.urgency], `urgencia ${input.urgency}`],
    [input.budget !== null, weights.BUDGET, "presupuesto declarado"],
    [input.down_payment !== null, weights.DOWN_PAYMENT, "pie declarado"],
    [input.property_type !== null, weights.PROPERTY_TYPE, "tipo de propiedad definido"],
    [input.has_preapproved_credit, weights.PREAPPROVED, "crédito preaprobado"],
    [input.seeks_subsidy, weights.SUBSIDY, "busca subsidio"],
    [input.needs_human_intervention, weights.HUMAN, "bot no puede resolver: requiere humano"],
    [input.intent === "invertir", weights.INVESTOR, "perfil inversionista"],
  ];

  let score = 0;
  const reasons: string[] = [];
  for (const [applies, weight, label] of items) {
    if (applies && weight > 0) {
      score += weight;
      reasons.push(`${label} (+${weight})`);
    }
  }
  return { score, reasons };
}

export function priorityFromScore(score: number, thresholds: Thresholds = THRESHOLDS): "alta" | "media" | "baja" {
  if (score >= thresholds.ALTA) return "alta";
  if (score >= thresholds.MEDIA) return "media";
  return "baja";
}

// ─────────────────────────────────────────────────────────────────────────────
// Priorización
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reglas 1–6 y 8 deciden la prioridad base (la primera que aplica gana);
 * la regla 7 (confianza) se aplica al final como tope sobre ese resultado.
 */
export function scorePriority(input: ScoringInput, config: ScoringConfig = DEFAULT_CONFIG): PriorityResult {
  const base = basePriority(input, config);
  const capped = applyConfidenceCap(base, input.confidence, config.minConfidence);
  return { ...capped, is_actionable: capped.priority === "alta" || capped.priority === "media" };
}

type BaseResult = Omit<PriorityResult, "is_actionable">;

function basePriority(input: ScoringInput, config: ScoringConfig): BaseResult {
  // 1–3: la intención decide sola.
  if (input.intent === "no_lead") return { priority: "descartar", reasons: [REASONS.NO_LEAD] };
  if (input.intent === "intento_manipulacion") {
    return { priority: "descartar", reasons: [REASONS.MANIPULATION, REASONS.MANIPULATION_ACTION] };
  }
  if (input.intent === "reclamo") return { priority: "alta", reasons: [REASONS.COMPLAINT] };

  // 4a/4b: fuera de catálogo, sea cual sea la intención de compra.
  if (input.out_of_scope) {
    return input.rejected_alternatives
      ? { priority: "descartar", reasons: [REASONS.OUT_OF_SCOPE_REJECTED] }
      : { priority: "baja", reasons: [REASONS.OUT_OF_SCOPE] };
  }

  // 5: comprar / invertir / alquilar → score.
  if (SCORED_INTENTS.has(input.intent)) {
    const { score, reasons } = computeScore(input, config.weights);
    const priority = priorityFromScore(score, config.thresholds);
    return { priority, reasons: [...reasons, `score ${score} → ${priority}`] };
  }

  // 6: consulta general.
  if (input.intent === "consulta") return { priority: "baja", reasons: [REASONS.GENERAL_INQUIRY] };

  // 8: fallback (incierto).
  return { priority: "baja", reasons: [REASONS.NO_SIGNALS] };
}

/**
 * 7: con confianza insuficiente la prioridad nunca supera "baja".
 * Es un TOPE, no un piso: "descartar" se mantiene.
 * Un confidence no finito (NaN) cuenta como insuficiente: `NaN < 0.4` es false
 * y sin este cuidado pasaría el filtro.
 */
function applyConfidenceCap(result: BaseResult, confidence: number, minConfidence: number): BaseResult {
  const confident = Number.isFinite(confidence) && confidence >= minConfidence;
  if (confident || result.priority === "descartar") return result;
  return { priority: "baja", reasons: [...result.reasons, REASONS.LOW_CONFIDENCE] };
}
