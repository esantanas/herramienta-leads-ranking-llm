/**
 * Pipeline completo de una conversación, compartido por el servidor y el
 * modo batch de la CLI:
 *
 *   preprocess → (cache) → LLM → validateAgainstSource → scorePriority
 */
import type { Logger } from "pino";
import { AnalysisCache, conversationCacheKey } from "./cache.js";
import type { LlmClient } from "./llm/geminiClient.js";
import type { CostTracker, MetricsInput } from "./metrics.js";
import { preprocess } from "./preprocess.js";
import type { Conversation, RawLlmOutput, Result, ValidatedOutput } from "./schema.js";
import { scorePriority, type Priority } from "./scoring.js";
import { validateAgainstSource } from "./validateEvidence.js";

export interface AnalysisResult extends ValidatedOutput {
  readonly priority: Priority;
  readonly priority_reasons: readonly string[];
  readonly is_actionable: boolean;
}

export interface AnalyzerDeps {
  readonly llm: LlmClient;
  readonly logger: Logger;
  readonly cache?: AnalysisCache<AnalysisResult>;
  readonly costs?: CostTracker;
}

export class Analyzer {
  private readonly cache: AnalysisCache<AnalysisResult>;

  constructor(private readonly deps: AnalyzerDeps) {
    this.cache = deps.cache ?? new AnalysisCache<AnalysisResult>();
  }

  async analyze(conversation: Conversation): Promise<Result<AnalysisResult, Error>> {
    const { logger, costs, llm } = this.deps;

    const pre = preprocess(conversation);
    if (pre.kind === "shortcut") {
      costs?.recordShortcut();
      logger.info({ conversation_id: conversation.id, shortcut: pre.reason }, "análisis sin LLM (shortcut)");
      return { ok: true, value: finalize(pre.output, conversation) };
    }

    const key = conversationCacheKey(conversation);
    const cached = this.cache.get(key);
    if (cached) {
      costs?.recordCacheHit();
      logger.info({ conversation_id: conversation.id, fromCache: true }, "análisis desde cache");
      return { ok: true, value: { ...cached, conversation_id: conversation.id } };
    }

    const llmResult = await llm.analyze(pre.conversation);
    if (!llmResult.ok) {
      logger.warn({ conversation_id: conversation.id, err: llmResult.error.message }, "falló el análisis LLM");
      return llmResult;
    }

    const result = finalize(llmResult.value, conversation);
    this.cache.set(key, result); // solo se cachean éxitos
    logger.info(
      { conversation_id: conversation.id, fromCache: false, priority: result.priority, audit: result.audit.length },
      "análisis completado",
    );
    return { ok: true, value: result };
  }
}

/** Verificación de evidencias + scoring sobre una salida cruda. Pura. */
export function finalize(raw: RawLlmOutput, conversation: Conversation): AnalysisResult {
  const validated = validateAgainstSource(raw, conversation);
  const { priority, reasons, is_actionable } = scorePriority(validated);
  return { ...validated, priority, priority_reasons: [...reasons], is_actionable };
}

export function toMetricsInput(r: AnalysisResult): MetricsInput {
  return {
    intent: r.intent,
    priority: r.priority,
    needs_human_intervention: r.needs_human_intervention,
    confidence: r.confidence,
    has_budget: r.budget !== null,
    has_urgency: r.urgency !== "desconocida",
  };
}
