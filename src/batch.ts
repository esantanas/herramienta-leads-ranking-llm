/**
 * Procesa un archivo de conversaciones con la pipeline completa y escribe:
 *   output/results.json  → resultados (o {conversation_id, error}) + métricas
 *   output/metrics.json  → solo métricas
 *   output/costs.json    → tokens reales (usageMetadata), latencia y costo estimado
 *
 * Uso:
 *   npm run batch                         # data/conversations.json
 *   npm run batch -- ruta/a/otro.json
 *   npm run batch -- --only conv-004,conv-006   # reprocesa solo esas y las fusiona
 *                                               # con el output/results.json anterior
 *
 * Requiere GEMINI_API_KEY y GEMINI_MODEL (en .env o en el entorno).
 *
 * DECISIÓN: ejecuta la pipeline EN PROCESO (Analyzer) en vez de llamar a
 * POST /analyze/batch. Es la opción más simple: no depende de que el servidor
 * esté levantado, no tiene timeouts HTTP para batches largos y permite
 * atribuir cada llamada a Gemini (tokens, latencia) a su conversación vía el
 * callback onCall del cliente. La lógica es exactamente la misma que usa el
 * servidor (src/pipeline.ts).
 *
 * Procesa EN SERIE por el rate limit de Gemini (ver comentario en server.ts).
 * Si una conversación falla, se registra y el batch sigue.
 */
import dotenv from "dotenv";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { pino, type Logger } from "pino";
import { z } from "zod";
import { geminiOptionsFromEnv } from "./config.js";
import {
  GeminiClient,
  LlmClientError,
  type LlmCallLogEntry,
} from "./llm/geminiClient.js";
import { calculateMetrics, type Metrics } from "./metrics.js";
import { Analyzer, toMetricsInput, type AnalysisResult } from "./pipeline.js";
import { ConversationSchema, type Conversation } from "./schema.js";

// ─────────────────────────────────────────────────────────────────────────────
// Precios
// ─────────────────────────────────────────────────────────────────────────────

export interface Pricing {
  /** USD por 1.000.000 de tokens de entrada (system prompt + conversación). */
  readonly inputPerMillion: number;
  /** USD por 1.000.000 de tokens de salida, INCLUIDOS los de thinking. */
  readonly outputPerMillion: number;
}

/** Un precio con fecha de inicio (ISO, inclusive). Sin `from` = vigente desde siempre. */
export interface PricePeriod extends Pricing {
  readonly from?: string;
}

/**
 * Precios del Gemini Developer API, tier pagado, modo Standard, entrada de
 * texto, prompts ≤ 200k tokens. Output incluye tokens de thinking.
 * Fuente: https://ai.google.dev/gemini-api/docs/pricing (consultado 2026-10-31).
 *
 * Cada modelo tiene una lista de períodos; se usa el último cuyo `from` ya
 * pasó. Así el cambio de precio del 01-01-2027 se aplica solo.
 *
 * CÓMO CAMBIAR EL PRECIO (dos opciones):
 *   1. Sin tocar código: definir en .env (ambas, con punto o coma decimal)
 *        GEMINI_PRICE_INPUT_PER_M=0.75
 *        GEMINI_PRICE_OUTPUT_PER_M=3,75
 *      Tienen prioridad sobre esta tabla. Si solo se define una, o un valor no
 *      es un número, el batch se detiene al arrancar (no se ignora en silencio).
 *   2. Editar/agregar la entrada del modelo aquí abajo. La clave se compara
 *      por prefijo (gana el más largo): "gemini-2.5-flash" cubre
 *      "gemini-2.5-flash-001", pero "gemini-2.5-flash-lite" tiene la suya.
 * Si el modelo no está en la tabla ni en el .env, el costo se informa como
 * null ("sin precio"), nunca como $0.
 */
export const MODEL_PRICING_USD_PER_MILLION: Readonly<
  Record<string, readonly PricePeriod[]>
> = Object.freeze({
  "gemini-2.5-flash": [{ inputPerMillion: 0.3, outputPerMillion: 2.5 }],
  "gemini-2.5-flash-lite": [{ inputPerMillion: 0.1, outputPerMillion: 0.4 }],
  "gemini-3-flash-preview": [{ inputPerMillion: 0.5, outputPerMillion: 3.0 }],
  // 3.6, 3.7 y 3.8 Flash: precio introductorio hasta el 31-12-2026; luego se duplica.
  "gemini-3.6-flash": INTRO_THEN_STANDARD(),
  "gemini-3.7-flash": INTRO_THEN_STANDARD(),
  "gemini-3.8-flash": INTRO_THEN_STANDARD(),
});

function INTRO_THEN_STANDARD(): readonly PricePeriod[] {
  return [
    { inputPerMillion: 0.75, outputPerMillion: 3.75 },
    { from: "2027-01-01", inputPerMillion: 1.5, outputPerMillion: 7.5 },
  ];
}

export interface ResolvedPricing extends Pricing {
  readonly source: "env" | "table" | "unknown";
  readonly matched?: string;
  /** Fecha desde la que rige el precio de la tabla (si tiene). */
  readonly effectiveFrom?: string;
}

/** "0.75", "0,75" o " 3.75 " → número. undefined si no es un número ≥ 0. */
export function parsePrice(raw: string): number | undefined {
  const value = Number(raw.trim().replace(",", "."));
  return raw.trim() !== "" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

/**
 * Precio para `model` en la fecha `now`. Lanza si las variables de entorno de
 * precio están incompletas o mal escritas (mejor fallar que calcular $0).
 */
export function resolvePricing(
  model: string,
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): ResolvedPricing {
  const rawIn = env.GEMINI_PRICE_INPUT_PER_M?.trim() ?? "";
  const rawOut = env.GEMINI_PRICE_OUTPUT_PER_M?.trim() ?? "";
  if (rawIn !== "" || rawOut !== "") {
    const input = parsePrice(rawIn);
    const output = parsePrice(rawOut);
    if (input === undefined || output === undefined) {
      throw new Error(
        `Precio inválido en .env: GEMINI_PRICE_INPUT_PER_M="${rawIn}", GEMINI_PRICE_OUTPUT_PER_M="${rawOut}". ` +
          "Define ambos como números (p. ej. 0.75 y 3.75) o deja ambos vacíos para usar la tabla.",
      );
    }
    return { inputPerMillion: input, outputPerMillion: output, source: "env" };
  }

  const matched = Object.keys(MODEL_PRICING_USD_PER_MILLION)
    .filter((key) => model === key || model.startsWith(`${key}-`))
    .sort((a, b) => b.length - a.length)[0];
  const periods = matched ? MODEL_PRICING_USD_PER_MILLION[matched] : undefined;
  if (!matched || !periods)
    return { inputPerMillion: 0, outputPerMillion: 0, source: "unknown" };

  const today = now.toISOString().slice(0, 10);
  const current =
    [...periods]
      .reverse()
      .find((p) => p.from === undefined || p.from <= today) ?? periods[0]!;
  return {
    inputPerMillion: current.inputPerMillion,
    outputPerMillion: current.outputPerMillion,
    source: "table",
    matched,
    ...(current.from && { effectiveFrom: current.from }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tipos del reporte
// ─────────────────────────────────────────────────────────────────────────────

export interface BatchError {
  readonly conversation_id: string;
  readonly error: string;
}

export type BatchEntry = AnalysisResult | BatchError;

export const isBatchError = (e: BatchEntry): e is BatchError => "error" in e;

export interface PerConversationCost {
  readonly conversation_id: string;
  /** Llamadas a Gemini (incluye reintentos). 0 = cache o shortcut. */
  readonly llmCalls: number;
  readonly promptTokens: number;
  readonly candidateTokens: number;
  readonly thoughtsTokens: number;
  readonly totalTokens: number;
  readonly latencyMs: number;
  /** null = el modelo no tiene precio configurado. */
  readonly estimatedCostUSD: number | null;
}

export interface CostReport {
  readonly model: string;
  readonly pricing: ResolvedPricing;
  readonly totalPromptTokens: number;
  readonly totalCandidateTokens: number;
  readonly totalThoughtsTokens: number;
  readonly totalTokens: number;
  /** Suma de la latencia de todas las llamadas a Gemini. */
  readonly totalLatencyMs: number;
  /** Duración real del batch, de principio a fin. */
  readonly wallClockMs: number;
  /** null = el modelo no tiene precio configurado. */
  readonly estimatedCostUSD: number | null;
  readonly perConversation: readonly PerConversationCost[];
}

export interface BatchReport {
  readonly results: {
    readonly generated_at: string;
    readonly model: string;
    readonly results: readonly BatchEntry[];
    readonly metrics: Metrics;
  };
  readonly metrics: Metrics;
  readonly costs: CostReport;
}

// ─────────────────────────────────────────────────────────────────────────────
// Batch
// ─────────────────────────────────────────────────────────────────────────────

export interface BatchDeps {
  readonly analyzer: Analyzer;
  /** Se llena con cada llamada a Gemini (GeminiClient → onCall) durante el batch. */
  readonly callLog: readonly LlmCallLogEntry[];
  readonly logger: Logger;
  readonly model: string;
  readonly pricing: ResolvedPricing;
}

export async function runBatch(
  conversations: readonly Conversation[],
  deps: BatchDeps,
): Promise<BatchReport> {
  const { analyzer, logger } = deps;
  const startedAt = performance.now();
  const entries: BatchEntry[] = [];

  // Errores que harían fallar igual al resto (cuota agotada, modelo inexistente, API key
  // inválida): se detiene el batch y las restantes se marcan sin llamar a Gemini.
  let fatalError: string | undefined;

  for (const conversation of conversations) {
    if (fatalError) {
      entries.push({
        conversation_id: conversation.id,
        error: `No procesada: ${fatalError}`,
      });
      continue;
    }
    try {
      const r = await analyzer.analyze(conversation);
      if (r.ok) {
        entries.push(r.value);
      } else if (isFatalForBatch(r.error)) {
        fatalError = shortReason(r.error);
        logger.error(
          { conversation_id: conversation.id, err: r.error.message },
          "error de configuración o cuota: se omiten las conversaciones restantes",
        );
        entries.push({
          conversation_id: conversation.id,
          error: r.error.message,
        });
      } else {
        logger.error(
          { conversation_id: conversation.id, err: r.error.message },
          "conversación falló; se continúa",
        );
        entries.push({
          conversation_id: conversation.id,
          error: r.error.message,
        });
      }
    } catch (e) {
      // analyze() no debería lanzar, pero un bug no debe abortar el batch.
      const message = e instanceof Error ? e.message : String(e);
      logger.error(
        { conversation_id: conversation.id, err: message },
        "error inesperado; se continúa",
      );
      entries.push({ conversation_id: conversation.id, error: message });
    }
  }

  const metrics = calculateMetrics(
    entries
      .filter((e) => !isBatchError(e))
      .map((e) => toMetricsInput(e as AnalysisResult)),
  );
  const costs = buildCostReport(
    conversations.map((c) => c.id),
    deps.callLog,
    deps.model,
    deps.pricing,
    Math.round(performance.now() - startedAt),
    logger,
  );

  return {
    results: {
      generated_at: new Date().toISOString(),
      model: deps.model,
      results: entries,
      metrics,
    },
    metrics,
    costs,
  };
}

/**
 * ¿El error afectaría a TODAS las conversaciones? Cuota agotada, 401/403 (sin
 * permiso), 404 (modelo no disponible para esta cuenta) o API key inválida (400).
 */
export function isFatalForBatch(error: Error): boolean {
  if (!(error instanceof LlmClientError)) return false;
  if (error.kind === "quota_exhausted") return true;
  if (error.kind !== "http") return false;
  const status = error.details.status;
  return (
    status === 401 ||
    status === 403 ||
    status === 404 ||
    (status === 400 && /api key/i.test(error.message))
  );
}

function shortReason(error: Error): string {
  if (error instanceof LlmClientError && error.kind === "quota_exhausted")
    return error.message.split(". ")[0] ?? error.message;
  const status =
    error instanceof LlmClientError ? error.details.status : undefined;
  const label =
    status === 404
      ? "modelo no disponible para esta cuenta (revisa GEMINI_MODEL)"
      : status === 401 || status === 403 || status === 400
        ? "API key inválida o sin permisos (revisa GEMINI_API_KEY)"
        : "error de configuración";
  return `Gemini HTTP ${status ?? "?"}: ${label}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Costos (tokens REALES de usageMetadata)
// ─────────────────────────────────────────────────────────────────────────────

export function buildCostReport(
  conversationIds: readonly string[],
  calls: readonly LlmCallLogEntry[],
  model: string,
  pricing: ResolvedPricing,
  wallClockMs: number,
  logger: Logger,
): CostReport {
  if (pricing.source === "unknown") {
    logger.warn(
      { model },
      "modelo sin precio configurado: estimatedCostUSD = null (agrega el modelo a MODEL_PRICING_USD_PER_MILLION o define GEMINI_PRICE_* en .env)",
    );
  }

  const perConversation = conversationIds.map((id) => {
    const own = calls.filter((c) => c.conversation_id === id);
    let prompt = 0;
    let candidate = 0;
    let thoughts = 0;
    let total = 0;
    let latency = 0;

    for (const call of own) {
      latency += call.latencyMs;
      // Un intento fallido (timeout, 429, red) no trae usageMetadata: es esperable, no se avisa.
      if (call.error) continue;

      prompt += tokenOrZero(call, "promptTokens", logger);
      candidate += tokenOrZero(call, "candidateTokens", logger);
      total += tokenOrZero(call, "totalTokens", logger);
      // thoughtsTokens solo existe en modelos con thinking; si falta, se deriva
      // de los mismos datos reales: total − prompt − candidatos.
      thoughts +=
        call.thoughtsTokens ??
        Math.max(
          0,
          (call.totalTokens ?? 0) -
            (call.promptTokens ?? 0) -
            (call.candidateTokens ?? 0),
        );
    }

    return {
      conversation_id: id,
      llmCalls: own.length,
      promptTokens: prompt,
      candidateTokens: candidate,
      thoughtsTokens: thoughts,
      totalTokens: total,
      latencyMs: latency,
      estimatedCostUSD:
        pricing.source === "unknown"
          ? null
          : costUSD(prompt, candidate + thoughts, pricing),
    };
  });

  const sum = (pick: (c: PerConversationCost) => number) =>
    perConversation.reduce((s, c) => s + pick(c), 0);
  const totalPromptTokens = sum((c) => c.promptTokens);
  const totalCandidateTokens = sum((c) => c.candidateTokens);
  const totalThoughtsTokens = sum((c) => c.thoughtsTokens);

  return {
    model,
    pricing,
    totalPromptTokens,
    totalCandidateTokens,
    totalThoughtsTokens,
    totalTokens: sum((c) => c.totalTokens),
    totalLatencyMs: sum((c) => c.latencyMs),
    wallClockMs,
    estimatedCostUSD:
      pricing.source === "unknown"
        ? null
        : costUSD(
            totalPromptTokens,
            totalCandidateTokens + totalThoughtsTokens,
            pricing,
          ),
    perConversation,
  };
}

function tokenOrZero(
  call: LlmCallLogEntry,
  field: "promptTokens" | "candidateTokens" | "totalTokens",
  logger: Logger,
): number {
  const value = call[field];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  logger.warn(
    { conversation_id: call.conversation_id, attempt: call.attempt, field },
    "usageMetadata sin el campo; se usa 0",
  );
  return 0;
}

/** Salida facturada = candidatos + thinking (Google cobra ambos a tarifa de output). */
export function costUSD(
  inputTokens: number,
  outputTokens: number,
  pricing: Pricing,
): number {
  const usd =
    (inputTokens * pricing.inputPerMillion +
      outputTokens * pricing.outputPerMillion) /
    1_000_000;
  return Math.round(usd * 1e8) / 1e8;
}

// ─────────────────────────────────────────────────────────────────────────────
// Salidas
// ─────────────────────────────────────────────────────────────────────────────

export async function writeOutputs(
  dir: string,
  report: BatchReport,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeJsonAtomic(join(dir, "results.json"), report.results);
  await writeJsonAtomic(join(dir, "metrics.json"), report.metrics);
  await writeJsonAtomic(join(dir, "costs.json"), report.costs);
}

/** .tmp + rename: nunca queda un JSON a medias (output/*.tmp está en .gitignore). */
async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}

const SUMMARY_MAX = 60;

export function truncate(text: string, max = SUMMARY_MAX): string {
  const chars = [...text.replace(/\s+/g, " ").trim()];
  return chars.length <= max
    ? chars.join("")
    : `${chars.slice(0, max - 1).join("")}…`;
}

export function formatSummaryTable(entries: readonly BatchEntry[]): string {
  const header = [
    "id",
    "intent",
    "urgency",
    "priority",
    "actionable",
    "summary",
  ];
  const rows = entries.map((e) =>
    isBatchError(e)
      ? [e.conversation_id, "ERROR", "-", "-", "-", truncate(e.error)]
      : [
          e.conversation_id,
          e.intent,
          e.urgency,
          e.priority,
          e.is_actionable ? "sí" : "no",
          truncate(e.one_line_summary),
        ],
  );

  const widths = header.map((h, i) =>
    Math.max([...h].length, ...rows.map((r) => [...r[i]!].length)),
  );
  const line = (cells: readonly string[]) =>
    cells
      .map((c, i) => c.padEnd(widths[i]!))
      .join(" | ")
      .trimEnd();
  return [
    line(header),
    widths.map((w) => "-".repeat(w)).join("-|-"),
    ...rows.map(line),
  ].join("\n");
}

export function formatTotals(costs: CostReport): string {
  return [
    `Tokens totales: ${costs.totalTokens.toLocaleString("es-CL")}`,
    costs.estimatedCostUSD === null
      ? `Costo estimado: sin precio para ${costs.model} (define GEMINI_PRICE_INPUT_PER_M y GEMINI_PRICE_OUTPUT_PER_M)`
      : `Costo estimado: $${costs.estimatedCostUSD.toFixed(6)}`,
    // Redondeo en décimas de segundo enteras: (8.45).toFixed(1) daría "8.4" por punto flotante.
    `Latencia total: ${(Math.round(costs.totalLatencyMs / 100) / 10).toFixed(1)}s`,
  ].join(" | ");
}

// ─────────────────────────────────────────────────────────────────────────────
// Reprocesar solo algunas (--only) y fusionar con la corrida anterior
// ─────────────────────────────────────────────────────────────────────────────

export interface BatchArgs {
  readonly inputPath: string;
  readonly only?: ReadonlySet<string>;
}

/** `[archivo] [--only id1,id2]` en cualquier orden. */
export function parseArgs(argv: readonly string[]): BatchArgs {
  let inputPath = "data/conversaciones.json";
  let only: Set<string> | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--only") {
      only = new Set(
        (argv[++i] ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      );
    } else if (arg.startsWith("--only=")) {
      only = new Set(
        arg
          .slice(7)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      );
    } else {
      inputPath = arg;
    }
  }
  return only && only.size > 0 ? { inputPath, only } : { inputPath };
}

async function readPreviousResults(
  path: string,
): Promise<readonly BatchEntry[]> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as {
      results?: unknown;
    };
    return Array.isArray(parsed.results)
      ? (parsed.results as BatchEntry[])
      : [];
  } catch {
    return []; // no hay corrida anterior
  }
}

/**
 * Resultados de esta corrida reemplazan a los anteriores con el mismo id; el
 * resto se conserva. Orden según el archivo de entrada. Las métricas se
 * recalculan sobre el conjunto fusionado; costs.json refleja SOLO esta corrida.
 */
export function withMergedResults(
  report: BatchReport,
  previous: readonly BatchEntry[],
  order: readonly string[],
): BatchReport {
  const byId = new Map<string, BatchEntry>(
    previous.map((e) => [e.conversation_id, e]),
  );
  for (const e of report.results.results) byId.set(e.conversation_id, e);
  const merged = order.flatMap((id) => {
    const e = byId.get(id);
    return e ? [e] : [];
  });
  const metrics = calculateMetrics(
    merged
      .filter((e) => !isBatchError(e))
      .map((e) => toMetricsInput(e as AnalysisResult)),
  );
  return {
    ...report,
    results: { ...report.results, results: merged, metrics },
    metrics,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  dotenv.config({ quiet: true });
  // Logs a stderr: stdout queda limpio para la tabla.
  const logger = pino(
    { name: "batch", level: process.env.LOG_LEVEL ?? "info" },
    pino.destination(2),
  );

  const env = z
    .object({
      GEMINI_API_KEY: z
        .string({ error: "GEMINI_API_KEY es obligatorio" })
        .trim()
        .min(1, "GEMINI_API_KEY está vacío"),
      GEMINI_MODEL: z
        .string({ error: "GEMINI_MODEL es obligatorio" })
        .trim()
        .min(1, "GEMINI_MODEL está vacío"),
    })
    .safeParse(process.env);
  if (!env.success) {
    logger.fatal(
      { issues: env.error.issues.map((i) => i.message) },
      "Configuración inválida (revisa .env)",
    );
    process.exit(1);
  }

  const args = parseArgs(process.argv.slice(2));
  const allConversations = z
    .array(ConversationSchema)
    .parse(JSON.parse(await readFile(args.inputPath, "utf8")));
  const conversations = args.only
    ? allConversations.filter((c) => args.only!.has(c.id))
    : allConversations;
  if (args.only) {
    const unknown = [...args.only].filter(
      (id) => !allConversations.some((c) => c.id === id),
    );
    if (unknown.length > 0)
      logger.warn(
        { unknown },
        "--only incluye ids que no existen en el archivo",
      );
  }
  logger.info(
    {
      inputPath: args.inputPath,
      count: conversations.length,
      only: args.only && [...args.only],
      model: env.data.GEMINI_MODEL,
    },
    "batch iniciado",
  );

  let pricing: ResolvedPricing;
  try {
    pricing = resolvePricing(env.data.GEMINI_MODEL);
  } catch (e) {
    logger.fatal(
      { err: e instanceof Error ? e.message : String(e) },
      "Configuración de precios inválida",
    );
    process.exit(1);
  }
  logger.info({ pricing }, "precio aplicado");

  const callLog: LlmCallLogEntry[] = [];
  let llm: GeminiClient;
  try {
    const geminiOpts = geminiOptionsFromEnv();
    logger.info(geminiOpts, "opciones de Gemini");
    llm = new GeminiClient(env.data.GEMINI_API_KEY, env.data.GEMINI_MODEL, {
      ...geminiOpts,
      logger,
      onCall: (entry) => void callLog.push(entry),
    });
  } catch (e) {
    logger.fatal(
      { err: e instanceof Error ? e.message : String(e) },
      "No se pudo crear el cliente de Gemini",
    );
    process.exit(1);
  }

  const report = await runBatch(conversations, {
    analyzer: new Analyzer({ llm, logger }),
    callLog,
    logger,
    model: env.data.GEMINI_MODEL,
    pricing,
  });
  // Con --only se fusiona con la corrida anterior: no hay que volver a pagar las que ya salieron bien.
  const finalReport = args.only
    ? withMergedResults(
        report,
        await readPreviousResults("output/results.json"),
        allConversations.map((c) => c.id),
      )
    : report;
  await writeOutputs("output", finalReport);

  console.log(`\n${formatSummaryTable(finalReport.results.results)}\n`);
  console.log(formatTotals(report.costs));

  const failed = finalReport.results.results.filter(isBatchError).length;
  if (failed > 0) {
    logger.warn(
      { failed },
      "hubo conversaciones con error (ver output/results.json)",
    );
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
