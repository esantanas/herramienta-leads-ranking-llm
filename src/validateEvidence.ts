/**
 * Verificación anti-alucinación: cada *_evidence debe ser una cita LITERAL
 * de lo que escribió el LEAD.
 *
 * Alcance deliberado: este módulo verifica EXISTENCIA y ORIGEN de la cita,
 * no su SIGNIFICADO. Si el LLM cita "ingresos de 1.8 millones" como evidencia
 * de presupuesto, la cita existe y es del lead, así que pasa: decidir que un
 * ingreso no es un presupuesto es trabajo del prompt (y de la revisión
 * humana), no de una comparación de strings. Mezclar heurísticas semánticas
 * aquí lo volvería frágil y difícil de razonar.
 *
 * Los mensajes del asistente NUNCA validan una cita. Solo se consultan para
 * diagnosticar, en el audit, que el LLM atribuyó al lead algo que dijo el
 * asistente (típicamente un precio de catálogo).
 *
 * Funciones puras: sin I/O, sin red, sin mutar argumentos.
 */
import type { Author, Conversation, RawLlmOutput, ValidatedOutput } from "./schema.js";

export const MIN_EVIDENCE_LENGTH = 4;

const MESSAGE_SEPARATOR = " \n ";

// ─────────────────────────────────────────────────────────────────────────────
// Normalización y texto fuente
// ─────────────────────────────────────────────────────────────────────────────

/** Minúsculas, sin tildes (NFD + marcas combinantes), espacios colapsados y trim. */
export function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function textBy(conversation: Conversation, author: Author): string {
  return normalize(
    conversation.mensajes
      .filter((m) => m.de === author)
      .map((m) => m.texto)
      .join(MESSAGE_SEPARATOR),
  );
}

/** Concatena SOLO los mensajes del lead y normaliza el resultado una vez. */
export function buildLeadText(conversation: Conversation): string {
  return textBy(conversation, "lead");
}

// ─────────────────────────────────────────────────────────────────────────────
// Verificación de una cita
// ─────────────────────────────────────────────────────────────────────────────

/** true si la cita normalizada tiene >= 4 caracteres y es substring del texto del lead. */
export function isEvidenceValid(evidence: string | null | undefined, leadTextNormalized: string): boolean {
  if (typeof evidence !== "string") return false;
  const e = normalize(evidence);
  return e.length >= MIN_EVIDENCE_LENGTH && leadTextNormalized.includes(e);
}

export type RejectionReason = "missing" | "too_short" | "from_assistant" | "not_found";

export type EvidenceVerdict = { readonly valid: true } | { readonly valid: false; readonly reason: RejectionReason };

/**
 * Igual criterio que isEvidenceValid (que decide); si la cita no es válida,
 * explica por qué. El texto del asistente solo interviene en el diagnóstico.
 */
export function checkEvidence(
  evidence: string | null | undefined,
  leadTextNormalized: string,
  assistantTextNormalized: string,
): EvidenceVerdict {
  if (isEvidenceValid(evidence, leadTextNormalized)) return { valid: true };

  if (typeof evidence !== "string" || evidence.trim() === "") return { valid: false, reason: "missing" };

  const e = normalize(evidence);
  if (e.length < MIN_EVIDENCE_LENGTH) return { valid: false, reason: "too_short" };
  if (assistantTextNormalized.includes(e)) return { valid: false, reason: "from_assistant" };
  return { valid: false, reason: "not_found" };
}

export function formatAnnulment(field: string, evidence: string | null | undefined, reason: RejectionReason): string {
  switch (reason) {
    case "missing":
      return `${field} anulado: sin evidencia`;
    case "too_short":
      return `${field} anulado: evidencia '${evidence}' tiene menos de ${MIN_EVIDENCE_LENGTH} caracteres`;
    case "from_assistant":
      return `${field} anulado: evidencia pertenece al asistente`;
    case "not_found":
      return `${field} anulado: evidencia '${evidence}' no aparece en mensajes del lead`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Validación de la salida completa
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Contrasta cada afirmación del LLM con lo que realmente escribió el lead y
 * degrada las que no tienen respaldo:
 *   budget / down_payment / property_type → null
 *   urgency → "desconocida"
 *   intent → "incierto"
 *   has_preapproved_credit / seeks_subsidy / out_of_scope / rejected_alternatives (true) → false
 * Cada degradación queda registrada en `audit`, en ese mismo orden.
 * La salida no incluye los *_evidence: ya cumplieron su función.
 */
export function validateAgainstSource(raw: RawLlmOutput, conversation: Conversation): ValidatedOutput {
  const leadText = buildLeadText(conversation);
  const assistantText = textBy(conversation, "asistente");
  const audit: string[] = [];

  /** ¿La cita respalda el campo? Si no, registra el motivo en el audit. */
  const supported = (field: string, evidence: string | null): boolean => {
    const verdict = checkEvidence(evidence, leadText, assistantText);
    if (!verdict.valid) audit.push(formatAnnulment(field, evidence, verdict.reason));
    return verdict.valid;
  };

  // Valores nullable
  const budget = raw.budget === null || supported("budget", raw.budget_evidence) ? raw.budget : null;
  const down_payment =
    raw.down_payment === null || supported("down_payment", raw.down_payment_evidence) ? raw.down_payment : null;
  const property_type =
    raw.property_type === null || supported("property_type", raw.property_type_evidence) ? raw.property_type : null;

  // Enums con valor "no sé"
  const urgency =
    raw.urgency === "desconocida" || supported("urgency", raw.urgency_evidence) ? raw.urgency : "desconocida";
  const intent = raw.intent === "incierto" || supported("intent", raw.intent_evidence) ? raw.intent : "incierto";

  // Flags afirmativos (false no necesita respaldo: el && corta antes de verificar)
  const has_preapproved_credit =
    raw.has_preapproved_credit && supported("has_preapproved_credit", raw.has_preapproved_credit_evidence);
  const seeks_subsidy = raw.seeks_subsidy && supported("seeks_subsidy", raw.seeks_subsidy_evidence);
  const out_of_scope = raw.out_of_scope && supported("out_of_scope", raw.out_of_scope_evidence);
  const rejected_alternatives =
    raw.rejected_alternatives && supported("rejected_alternatives", raw.rejected_alternatives_evidence);

  return {
    conversation_id: raw.conversation_id,
    intent,
    urgency,
    // Copias: la salida no comparte objetos con `raw`.
    budget: budget && { ...budget },
    down_payment: down_payment && { ...down_payment },
    property_type,
    has_preapproved_credit,
    seeks_subsidy,
    out_of_scope,
    rejected_alternatives,
    needs_human_intervention: raw.needs_human_intervention,
    intervention_reason: raw.intervention_reason,
    one_line_summary: raw.one_line_summary,
    confidence: raw.confidence,
    audit,
  };
}
