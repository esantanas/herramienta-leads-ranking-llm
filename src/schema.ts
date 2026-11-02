/**
 * Contratos de datos (zod). Solo estructura y coherencia interna del JSON:
 * la verificación contra el texto de la conversación vive en validateEvidence.ts
 * y la priorización en scoring.ts.
 */
import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// Primitivos
// ─────────────────────────────────────────────────────────────────────────────

/** String no vacío tras trim: impide que "" o "  " pasen por una cita o un valor. */
const NonEmptyString = z.string().trim().min(1);

/** Toda evidencia es una cita no vacía o null. */
const Evidence = NonEmptyString.nullable();

// ─────────────────────────────────────────────────────────────────────────────
// Conversación (input)
// ─────────────────────────────────────────────────────────────────────────────

export const AuthorSchema = z.enum(["lead", "asistente"]);

export const MessageSchema = z.strictObject({
  de: AuthorSchema,
  texto: z.string(),
});

export const ConversationSchema = z.strictObject({
  id: NonEmptyString,
  mensajes: z.array(MessageSchema),
});

// ─────────────────────────────────────────────────────────────────────────────
// Enums y sub-objetos
// ─────────────────────────────────────────────────────────────────────────────

export const IntentSchema = z.enum([
  "comprar",
  "invertir",
  "alquilar",
  "consulta",
  "reclamo",
  "no_lead",
  "intento_manipulacion",
  "incierto",
]);

export const UrgencySchema = z.enum(["alta", "media", "baja", "desconocida"]);

export const BudgetScopeSchema = z.enum(["total", "por_unidad"]);

export const BudgetSchema = z.strictObject({
  amount: z.number().positive(),
  currency: NonEmptyString,
  scope: BudgetScopeSchema,
});

export const DownPaymentSchema = z.strictObject({
  amount: z.number().positive(),
  currency: NonEmptyString,
});

// ─────────────────────────────────────────────────────────────────────────────
// Salida cruda del LLM
// ─────────────────────────────────────────────────────────────────────────────

/** Forma sin reglas cross-field. Base para RawLlmOutputSchema y ValidatedOutputSchema. */
export const RawLlmOutputObjectSchema = z.strictObject({
  conversation_id: NonEmptyString,

  intent: IntentSchema,
  intent_evidence: Evidence,

  urgency: UrgencySchema,
  urgency_evidence: Evidence,

  budget: BudgetSchema.nullable(),
  budget_evidence: Evidence,

  down_payment: DownPaymentSchema.nullable(),
  down_payment_evidence: Evidence,

  property_type: NonEmptyString.nullable(),
  property_type_evidence: Evidence,

  has_preapproved_credit: z.boolean(),
  has_preapproved_credit_evidence: Evidence,

  seeks_subsidy: z.boolean(),
  seeks_subsidy_evidence: Evidence,

  out_of_scope: z.boolean(),
  out_of_scope_evidence: Evidence,

  rejected_alternatives: z.boolean(),
  rejected_alternatives_evidence: Evidence,

  needs_human_intervention: z.boolean(),
  intervention_reason: NonEmptyString.nullable(),

  one_line_summary: NonEmptyString.max(200),
  confidence: z.number().min(0).max(1),
});

export const RawLlmOutputSchema = RawLlmOutputObjectSchema
  // Sin presupuesto no hay nada que citar: una cita huérfana indica que el LLM alucinó o "olvidó" el valor.
  .refine((o) => o.budget !== null || o.budget_evidence === null, {
    path: ["budget_evidence"],
    error: "budget_evidence debe ser null cuando budget es null",
  })
  // Igual que budget: un pie no informado no puede tener cita.
  .refine((o) => o.down_payment !== null || o.down_payment_evidence === null, {
    path: ["down_payment_evidence"],
    error: "down_payment_evidence debe ser null cuando down_payment es null",
  })
  // Igual que budget: si no se identificó tipo de propiedad, no puede haber cita del tipo.
  .refine(
    (o) => o.property_type !== null || o.property_type_evidence === null,
    {
      path: ["property_type_evidence"],
      error:
        "property_type_evidence debe ser null cuando property_type es null",
    },
  )
  // "desconocida" significa que el lead no dio señal de plazo; una cita contradice esa clasificación.
  .refine((o) => o.urgency !== "desconocida" || o.urgency_evidence === null, {
    path: ["urgency_evidence"],
    error: "urgency_evidence debe ser null cuando urgency es 'desconocida'",
  })
  // Crédito preaprobado es una afirmación sobre el lead que sube su prioridad: exige cita.
  .refine(
    (o) =>
      !o.has_preapproved_credit || o.has_preapproved_credit_evidence !== null,
    {
      path: ["has_preapproved_credit_evidence"],
      error:
        "has_preapproved_credit_evidence es obligatorio cuando has_preapproved_credit es true",
    },
  )
  // Buscar subsidio cambia el tipo de asesoría que necesita el lead: exige cita.
  .refine((o) => !o.seeks_subsidy || o.seeks_subsidy_evidence !== null, {
    path: ["seeks_subsidy_evidence"],
    error: "seeks_subsidy_evidence es obligatorio cuando seeks_subsidy es true",
  })
  // Marcar fuera de catálogo baja la prioridad del lead: no puede hacerse sin cita de lo que pidió.
  .refine((o) => !o.out_of_scope || o.out_of_scope_evidence !== null, {
    path: ["out_of_scope_evidence"],
    error: "out_of_scope_evidence es obligatorio cuando out_of_scope es true",
  })
  // Que el lead rechazó las alternativas puede llevar a descartarlo: exige su cita textual.
  .refine(
    (o) =>
      !o.rejected_alternatives || o.rejected_alternatives_evidence !== null,
    {
      path: ["rejected_alternatives_evidence"],
      error:
        "rejected_alternatives_evidence es obligatorio cuando rejected_alternatives es true",
    },
  );

// ─────────────────────────────────────────────────────────────────────────────
// Salida validada (input del scoring)
// ─────────────────────────────────────────────────────────────────────────────

const EVIDENCE_KEYS = {
  intent_evidence: true,
  urgency_evidence: true,
  budget_evidence: true,
  down_payment_evidence: true,
  property_type_evidence: true,
  has_preapproved_credit_evidence: true,
  seeks_subsidy_evidence: true,
  out_of_scope_evidence: true,
  rejected_alternatives_evidence: true,
} as const;

/** Igual que la salida cruda pero sin citas (ya verificadas) y con el registro de anulaciones. */
export const ValidatedOutputSchema = RawLlmOutputObjectSchema.omit(
  EVIDENCE_KEYS,
).extend({
  audit: z.array(z.string()),
});

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type Author = z.infer<typeof AuthorSchema>;
export type Message = z.infer<typeof MessageSchema>;
export type Conversation = z.infer<typeof ConversationSchema>;
export type Intent = z.infer<typeof IntentSchema>;
export type Urgency = z.infer<typeof UrgencySchema>;
export type BudgetScope = z.infer<typeof BudgetScopeSchema>;
export type Budget = z.infer<typeof BudgetSchema>;
export type DownPayment = z.infer<typeof DownPaymentSchema>;
export type RawLlmOutput = z.infer<typeof RawLlmOutputSchema>;
export type ValidatedOutput = z.infer<typeof ValidatedOutputSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Result + parseLlmJson
// ─────────────────────────────────────────────────────────────────────────────

export type Result<T, E = Error> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export type LlmParseErrorKind = "empty_input" | "invalid_json" | "schema";

export class LlmParseError extends Error {
  override readonly name = "LlmParseError";

  constructor(
    readonly kind: LlmParseErrorKind,
    message: string,
    /** Issues de zod cuando kind === "schema". */
    readonly issues: readonly z.core.$ZodIssue[] = [],
  ) {
    super(message);
  }
}

/**
 * Parsea y valida la respuesta de texto del LLM. Nunca lanza.
 *
 * Candidatos (se usa el primero que sea JSON válido):
 *   1. el texto completo;
 *   2. el contenido de un bloque ```json … ```;
 *   3. el primer {...} con llaves balanceadas (ignora llaves dentro de strings);
 *   4. regex codiciosa desde el primer "{" hasta el último "}".
 */
export function parseLlmJson(
  text: string,
): Result<RawLlmOutput, LlmParseError> {
  try {
    if (typeof text !== "string" || text.trim() === "") {
      return {
        ok: false,
        error: new LlmParseError(
          "empty_input",
          "La respuesta del LLM está vacía",
        ),
      };
    }

    const json = extractJson(text);
    if (!json.ok)
      return {
        ok: false,
        error: new LlmParseError("invalid_json", json.error),
      };

    const parsed = RawLlmOutputSchema.safeParse(json.value);
    if (!parsed.success) {
      return {
        ok: false,
        error: new LlmParseError(
          "schema",
          formatIssues(parsed.error.issues),
          parsed.error.issues,
        ),
      };
    }
    return { ok: true, value: parsed.data };
  } catch (e) {
    // Red de seguridad: el contrato es no lanzar nunca.
    return {
      ok: false,
      error: new LlmParseError(
        "invalid_json",
        e instanceof Error ? e.message : String(e),
      ),
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Internos
// ─────────────────────────────────────────────────────────────────────────────

const FENCED_BLOCK_RE = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/i;
const GREEDY_OBJECT_RE = /\{[\s\S]*\}/;

function extractJson(text: string): Result<unknown, string> {
  const trimmed = text.trim();
  const candidates = new Set<string>([trimmed]);

  const fenced = FENCED_BLOCK_RE.exec(trimmed)?.[1]?.trim();
  if (fenced) candidates.add(fenced);

  const balanced = firstBalancedObject(trimmed);
  if (balanced) candidates.add(balanced);

  const greedy = GREEDY_OBJECT_RE.exec(trimmed)?.[0];
  if (greedy) candidates.add(greedy);

  let lastError = "No se encontró ningún objeto JSON en la respuesta";
  for (const candidate of candidates) {
    try {
      return { ok: true, value: JSON.parse(candidate) };
    } catch (e) {
      lastError = `JSON inválido: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  return { ok: false, error: lastError };
}

function firstBalancedObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

function formatIssues(issues: readonly z.core.$ZodIssue[]): string {
  return issues
    .map((i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`)
    .join("; ");
}
