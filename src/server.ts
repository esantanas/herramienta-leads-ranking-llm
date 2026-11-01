/**
 * API HTTP. `createApp` no abre puertos ni toca la red por sí mismo: recibe
 * el cliente LLM ya construido, así los tests lo reemplazan por un mock y el
 * servidor arranca aunque Gemini esté caído (solo /analyze* responde 502).
 */
import express, { type NextFunction, type Request, type Response } from "express";
import type { Logger } from "pino";
import { z } from "zod";
import { AnalysisCache } from "./cache.js";
import type { LlmClient } from "./llm/geminiClient.js";
import { CostTracker, calculateMetrics } from "./metrics.js";
import { Analyzer, toMetricsInput, type AnalysisResult } from "./pipeline.js";
import { ConversationSchema } from "./schema.js";

/** Máximo de conversaciones por request batch: se procesan en serie, y un batch enorme excedería cualquier timeout HTTP. */
export const MAX_BATCH_SIZE = 100;

const AnalyzeBodySchema = z.object({ conversation: ConversationSchema });
const BatchBodySchema = z.object({ conversations: z.array(ConversationSchema).min(1).max(MAX_BATCH_SIZE) });

export interface AppDeps {
  readonly llm: LlmClient;
  readonly logger: Logger;
  readonly costs?: CostTracker;
  readonly cache?: AnalysisCache<AnalysisResult>;
}

export function createApp(deps: AppDeps): express.Express {
  const { logger } = deps;
  const costs = deps.costs ?? new CostTracker();
  const analyzer = new Analyzer({ llm: deps.llm, logger, costs, ...(deps.cache && { cache: deps.cache }) });
  const startedAt = Date.now();

  const app = express();
  app.disable("x-powered-by");

  // Log de cada request: método, ruta, status y latencia.
  app.use((req, res, next) => {
    const start = process.hrtime.bigint();
    res.on("finish", () => {
      logger.info(
        {
          method: req.method,
          path: req.originalUrl,
          status: res.statusCode,
          latencyMs: Math.round(Number(process.hrtime.bigint() - start) / 1e6),
        },
        "request",
      );
    });
    next();
  });

  app.use(express.json({ limit: "1mb" }));

  // ── Rutas ──────────────────────────────────────────────────────────────────

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", uptime: Math.round((Date.now() - startedAt) / 1000) });
  });

  app.get("/metrics/cost", (_req, res) => {
    res.json(costs.snapshot());
  });

  app.post("/analyze", async (req, res) => {
    const body = AnalyzeBodySchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "Body inválido", issues: formatIssues(body.error) });
      return;
    }

    const result = await analyzer.analyze(body.data.conversation);
    if (!result.ok) {
      res.status(502).json({ error: "El análisis con el LLM falló", detail: result.error.message });
      return;
    }
    res.json(result.value);
  });

  app.post("/analyze/batch", async (req, res) => {
    const body = BatchBodySchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "Body inválido", issues: formatIssues(body.error) });
      return;
    }

    const results: AnalysisResult[] = [];
    const errors: Array<{ conversation_id: string; error: string }> = [];

    // EN SERIE a propósito: en paralelo, un batch dispararía N requests
    // simultáneos a Gemini y chocaría con el rate limit (429), lo que además
    // activaría los reintentos de todos a la vez. Una a la vez es más lento
    // pero predecible; con cache, las repetidas dentro del batch no se pagan.
    for (const conversation of body.data.conversations) {
      const r = await analyzer.analyze(conversation);
      if (r.ok) results.push(r.value);
      else errors.push({ conversation_id: conversation.id, error: r.error.message });
    }

    res.json({ results, errors, metrics: calculateMetrics(results.map(toMetricsInput)) });
  });

  // ── Errores ────────────────────────────────────────────────────────────────

  app.use((req, res) => {
    res.status(404).json({ error: `Ruta no encontrada: ${req.method} ${req.path}` });
  });

  // Express 5 propaga aquí también los rechazos de handlers async.
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const status = httpStatusOf(err);
    if (status >= 500) logger.error({ err, path: req.originalUrl }, "error no controlado");
    else logger.warn({ err: errorMessage(err), path: req.originalUrl }, "request rechazado");

    if (res.headersSent) return;
    res.status(status).json({ error: status >= 500 ? "Error interno" : errorMessage(err) });
  });

  return app;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((i) => `${i.path.join(".") || "(body)"}: ${i.message}`);
}

/** Errores de body-parser traen `status` (400 JSON malformado, 413 demasiado grande). */
function httpStatusOf(err: unknown): number {
  const status = (err as { status?: unknown; statusCode?: unknown } | null)?.status;
  return typeof status === "number" && status >= 400 && status < 600 ? status : 500;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
