/**
 * Métricas de negocio (calculateMetrics) y de costo (CostTracker).
 */
import type { LlmCallLogEntry } from "./llm/geminiClient.js";

// ─────────────────────────────────────────────────────────────────────────────
// Métricas de negocio
// ─────────────────────────────────────────────────────────────────────────────

export interface MetricsInput {
  readonly intent: string;
  readonly priority: string;
  readonly needs_human_intervention: boolean;
  readonly confidence: number;
  readonly has_budget: boolean;
  readonly has_urgency: boolean;
}

export interface Metrics {
  readonly total: number;
  readonly by_intent: Record<string, number>;
  readonly by_priority: Record<string, number>;
  readonly actionable_rate: number;
  readonly needs_human_count: number;
  readonly fields_missing_rate: { readonly budget: number; readonly urgency: number };
  readonly avg_confidence: number;
  readonly estimated_time_saved_minutes: number;
}

/**
 * Minutos que un ejecutivo tarda en leer y clasificar una conversación a mano.
 * Supuesto de negocio (no medido): ajustarlo con datos reales del equipo.
 */
export const READING_MINUTES_PER_CONVERSATION = 3.5;

const ACTIONABLE = new Set(["alta", "media"]);

/**
 * - actionable_rate: proporción con prioridad alta o media (0–1).
 * - fields_missing_rate: proporción sin presupuesto / con urgencia desconocida,
 *   sobre el total (incluye no-leads, donde la ausencia es esperable).
 * - estimated_time_saved_minutes: 3.5 min por cada conversación NO accionable
 *   (baja o descartar), que el ejecutivo ya no necesita abrir. Las accionables
 *   no se cuentan porque el ejecutivo igual las lee antes de contactar.
 *   Criterio conservador: la variante optimista sería total × 3.5.
 *
 * Proporciones y promedios redondeados a 4 decimales; 0 si no hay resultados.
 */
export function calculateMetrics(results: readonly MetricsInput[]): Metrics {
  const total = results.length;
  const ratio = (n: number) => (total === 0 ? 0 : round(n / total, 4));
  const count = (pred: (r: MetricsInput) => boolean) => results.filter(pred).length;

  const actionable = count((r) => ACTIONABLE.has(r.priority));

  return {
    total,
    by_intent: tally(results.map((r) => r.intent)),
    by_priority: tally(results.map((r) => r.priority)),
    actionable_rate: ratio(actionable),
    needs_human_count: count((r) => r.needs_human_intervention),
    fields_missing_rate: {
      budget: ratio(count((r) => !r.has_budget)),
      urgency: ratio(count((r) => !r.has_urgency)),
    },
    avg_confidence: total === 0 ? 0 : round(results.reduce((s, r) => s + r.confidence, 0) / total, 4),
    estimated_time_saved_minutes: round((total - actionable) * READING_MINUTES_PER_CONVERSATION, 1),
  };
}

function tally(values: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}

function round(n: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

// ─────────────────────────────────────────────────────────────────────────────
// Costos (acumulado en memoria)
// ─────────────────────────────────────────────────────────────────────────────

export interface CostSnapshot {
  readonly llm_calls: number;
  readonly llm_failed_calls: number;
  readonly prompt_tokens: number;
  readonly candidate_tokens: number;
  readonly thoughts_tokens: number;
  readonly total_tokens: number;
  readonly total_latency_ms: number;
  readonly avg_latency_ms: number;
  /** Análisis resueltos sin llamar al LLM. */
  readonly cache_hits: number;
  readonly shortcuts: number;
  readonly since: string;
}

/**
 * Acumula las mismas entradas que GeminiClient loguea (vía `onCall`).
 * En memoria: se reinicia con el proceso. Suficiente para la prueba; en
 * producción esto iría a un sistema de métricas.
 */
export class CostTracker {
  private calls = 0;
  private failed = 0;
  private prompt = 0;
  private candidate = 0;
  private thoughts = 0;
  private total = 0;
  private latency = 0;
  private cacheHits = 0;
  private shortcutCount = 0;
  private readonly since = new Date().toISOString();

  readonly recordCall = (entry: LlmCallLogEntry): void => {
    this.calls++;
    if (entry.error) this.failed++;
    this.prompt += entry.promptTokens ?? 0;
    this.candidate += entry.candidateTokens ?? 0;
    this.thoughts += entry.thoughtsTokens ?? 0;
    this.total += entry.totalTokens ?? 0;
    this.latency += entry.latencyMs;
  };

  recordCacheHit(): void {
    this.cacheHits++;
  }

  recordShortcut(): void {
    this.shortcutCount++;
  }

  snapshot(): CostSnapshot {
    return {
      llm_calls: this.calls,
      llm_failed_calls: this.failed,
      prompt_tokens: this.prompt,
      candidate_tokens: this.candidate,
      thoughts_tokens: this.thoughts,
      total_tokens: this.total,
      total_latency_ms: this.latency,
      avg_latency_ms: this.calls === 0 ? 0 : Math.round(this.latency / this.calls),
      cache_hits: this.cacheHits,
      shortcuts: this.shortcutCount,
      since: this.since,
    };
  }
}
