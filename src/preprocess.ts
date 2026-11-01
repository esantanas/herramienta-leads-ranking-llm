/**
 * Filtro previo al LLM.
 *
 * Si la conversación no tiene contenido analizable del lead, se devuelve un
 * resultado fijo ("shortcut") SIN llamar a Gemini: ahorra los tokens del
 * system prompt + conversación en casos donde el LLM no podría aportar nada.
 *
 * Criterio: no hay mensajes del lead, o todos los mensajes del lead tienen
 * menos de 5 caracteres útiles ("ok", "hola", "?", "👍").
 * Se mira solo al lead (no al asistente) porque las evidencias solo pueden
 * citarse de mensajes del lead (ver validateEvidence.ts): si el lead no dijo
 * nada sustantivo, cualquier campo que el LLM extrajera sería anulado igual.
 */
import type { Conversation, RawLlmOutput } from "./schema.js";

export const MIN_MEANINGFUL_CHARS = 5;

export type PreprocessResult =
  | { readonly kind: "llm"; readonly conversation: Conversation }
  | { readonly kind: "shortcut"; readonly reason: string; readonly output: RawLlmOutput };

export function preprocess(conversation: Conversation): PreprocessResult {
  const leadTexts = conversation.mensajes.filter((m) => m.de === "lead").map((m) => m.texto.trim());

  if (leadTexts.length === 0) {
    return shortcut(conversation.id, "sin mensajes del lead");
  }
  if (leadTexts.every((t) => [...t].length < MIN_MEANINGFUL_CHARS)) {
    return shortcut(conversation.id, `todos los mensajes del lead tienen menos de ${MIN_MEANINGFUL_CHARS} caracteres`);
  }
  return { kind: "llm", conversation };
}

function shortcut(conversationId: string, reason: string): PreprocessResult {
  return {
    kind: "shortcut",
    reason,
    output: {
      conversation_id: conversationId,
      intent: "incierto",
      intent_evidence: null,
      urgency: "desconocida",
      urgency_evidence: null,
      budget: null,
      budget_evidence: null,
      down_payment: null,
      down_payment_evidence: null,
      property_type: null,
      property_type_evidence: null,
      has_preapproved_credit: false,
      has_preapproved_credit_evidence: null,
      seeks_subsidy: false,
      seeks_subsidy_evidence: null,
      out_of_scope: false,
      out_of_scope_evidence: null,
      rejected_alternatives: false,
      rejected_alternatives_evidence: null,
      needs_human_intervention: false,
      intervention_reason: null,
      one_line_summary: `Sin contenido analizable (${reason}); no se llamó al LLM.`,
      confidence: 0,
    },
  };
}
