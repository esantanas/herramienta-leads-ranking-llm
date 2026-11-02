import { readFileSync } from "node:fs";
import { z } from "zod";
import {
  ConversationSchema,
  type Conversation,
  type RawLlmOutput,
} from "../src/schema.js";

const conversations = z
  .array(ConversationSchema)
  .parse(
    JSON.parse(
      readFileSync(
        new URL("../data/conversaciones.json", import.meta.url),
        "utf8",
      ),
    ),
  );

/** Conversación real de data/conversations.json. */
export function conv(id: string): Conversation {
  const found = conversations.find((c) => c.id === id);
  if (!found)
    throw new Error(`Conversación ${id} no existe en data/conversaciones.json`);
  return found;
}

/**
 * Salida "en blanco": no afirma nada. Cada test sobrescribe solo los campos
 * que está probando.
 */
export function rawOutput(overrides: Partial<RawLlmOutput> = {}): RawLlmOutput {
  return {
    conversation_id: "conv-test",
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
    one_line_summary: "Resumen de prueba",
    confidence: 0.8,
    ...overrides,
  };
}
