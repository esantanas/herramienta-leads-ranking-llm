/**
 * Opciones opcionales de Gemini leídas del entorno (compartidas por server y batch).
 *
 *   GEMINI_MAX_RPM          Requests por minuto máximos hacia Gemini. El cliente
 *                           espacia las llamadas a 60000/RPM ms (+5%). Free tier: 5.
 *                           Vacío = sin límite.
 *   GEMINI_THINKING_LEVEL   Gemini 3.x: low | medium | high (gemini-3.8-flash no
 *                           acepta minimal). Recomendado: low para extracción.
 *   GEMINI_THINKING_BUDGET  Gemini 2.5: tokens de thinking; 0 lo apaga.
 *   GEMINI_TIMEOUT_MS       Timeout por request (default del cliente: 30000).
 *                           gemini-3.8-flash tarda 18–30 s con este prompt en free
 *                           tier: usar 120000. Un timeout NO se reintenta.
 *
 * LEVEL y BUDGET son excluyentes: definir ambos es un error de configuración
 * (la API respondería 400 en cada request).
 */
import { z } from "zod";
import { THINKING_LEVELS, type GeminiClientOptions } from "./llm/geminiClient.js";

const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optionalInt = (min: number) => z.preprocess(blankToUndefined, z.coerce.number().int().min(min).optional());

const GeminiEnvSchema = z
  .object({
    GEMINI_MAX_RPM: optionalInt(1),
    GEMINI_THINKING_BUDGET: optionalInt(0),
    GEMINI_TIMEOUT_MS: optionalInt(1_000),
    GEMINI_THINKING_LEVEL: z.preprocess(
      (v) => (typeof v === "string" ? blankToUndefined(v.trim().toLowerCase()) : v),
      z.enum(THINKING_LEVELS).optional(),
    ),
  })
  .refine((e) => e.GEMINI_THINKING_BUDGET === undefined || e.GEMINI_THINKING_LEVEL === undefined, {
    error: "GEMINI_THINKING_BUDGET (Gemini 2.5) y GEMINI_THINKING_LEVEL (Gemini 3.x) son excluyentes: deja solo uno",
  });

export type GeminiEnvOptions = Pick<GeminiClientOptions, "minIntervalMs" | "thinkingBudget" | "thinkingLevel" | "timeoutMs">;

export function geminiOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): GeminiEnvOptions {
  const parsed = GeminiEnvSchema.parse(env);
  return {
    // +5% de margen: el reloj de Google y el nuestro no están sincronizados.
    ...(parsed.GEMINI_MAX_RPM !== undefined && { minIntervalMs: Math.ceil((60_000 / parsed.GEMINI_MAX_RPM) * 1.05) }),
    ...(parsed.GEMINI_THINKING_BUDGET !== undefined && { thinkingBudget: parsed.GEMINI_THINKING_BUDGET }),
    ...(parsed.GEMINI_THINKING_LEVEL !== undefined && { thinkingLevel: parsed.GEMINI_THINKING_LEVEL }),
    ...(parsed.GEMINI_TIMEOUT_MS !== undefined && { timeoutMs: parsed.GEMINI_TIMEOUT_MS }),
  };
}
