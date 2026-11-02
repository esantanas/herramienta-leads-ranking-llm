import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pino } from "pino";
import { describe, expect, it } from "vitest";
import {
  buildCostReport,
  costUSD,
  formatSummaryTable,
  formatTotals,
  isBatchError,
  isFatalForBatch,
  parseArgs,
  resolvePricing,
  runBatch,
  truncate,
  withMergedResults,
  writeOutputs,
  type BatchReport,
} from "../src/batch.js";
import {
  GeminiClient,
  LlmClientError,
  type GenerateContentTransport,
  type LlmCallLogEntry,
  type UsageMetadataLike,
} from "../src/llm/geminiClient.js";
import { Analyzer } from "../src/pipeline.js";
import { conv } from "./fixtures.js";
import { IDEAL_EXTRACTIONS } from "./fixtures/ideal-extractions.js";
import { googleApiError } from "./mocks/MockLlmClient.js";

const PRICING = {
  inputPerMillion: 0.3,
  outputPerMillion: 2.5,
  source: "table" as const,
};

function memoryLogger() {
  const lines: Array<Record<string, unknown>> = [];
  return {
    logger: pino(
      { level: "info" },
      { write: (s: string) => void lines.push(JSON.parse(s)) },
    ),
    lines,
  };
}

/** Transporte que responde según el id de la conversación del request. */
function transportById(
  behavior: Record<string, { usage?: UsageMetadataLike; httpStatus?: number }>,
): GenerateContentTransport {
  return async (request) => {
    const text = (request.contents[0]?.parts?.[0] as { text: string }).text;
    const id = /\(id: ([^)]+)\)/.exec(text)?.[1] ?? "";
    const b = behavior[id] ?? {};
    if (b.httpStatus) throw googleApiError(b.httpStatus);
    return {
      text: () => JSON.stringify(IDEAL_EXTRACTIONS[id]),
      candidates: [{ finishReason: "STOP" }],
      usageMetadata: b.usage ?? {
        promptTokenCount: 1000,
        candidatesTokenCount: 200,
        totalTokenCount: 1200,
      },
    };
  };
}

async function run(
  ids: string[],
  behavior: Parameters<typeof transportById>[0] = {},
) {
  const { logger, lines } = memoryLogger();
  const callLog: LlmCallLogEntry[] = [];
  const llm = new GeminiClient("k", "gemini-2.5-flash", {
    transport: transportById(behavior),
    logger,
    sleep: async () => {},
    onCall: (e) => void callLog.push(e),
  });
  const report = await runBatch(ids.map(conv), {
    analyzer: new Analyzer({ llm, logger }),
    callLog,
    logger,
    model: "gemini-2.5-flash",
    pricing: PRICING,
  });
  return { report, lines };
}

describe("runBatch", () => {
  it("procesa las 10 conversaciones reales con las prioridades esperadas", async () => {
    const ids = Array.from(
      { length: 10 },
      (_, i) => `conv-${String(i + 1).padStart(3, "0")}`,
    );

    const { report } = await run(ids);

    const summary = report.results.results.map((r) =>
      isBatchError(r)
        ? [r.conversation_id, "ERROR"]
        : [r.conversation_id, r.priority],
    );
    expect(summary).toEqual([
      ["conv-001", "media"],
      ["conv-002", "descartar"],
      ["conv-003", "media"], // criterio 2026-10-31: urgencia desconocida + INVESTOR (ver golden.real.test.ts)
      ["conv-004", "descartar"],
      ["conv-005", "alta"],
      ["conv-006", "baja"],
      ["conv-007", "media"],
      ["conv-008", "alta"],
      ["conv-009", "descartar"],
      ["conv-010", "baja"],
    ]);
    expect(report.metrics.total).toBe(10);
    expect(report.costs.perConversation).toHaveLength(10);
  });

  it("una conversación que falla no aborta el batch: queda como {conversation_id, error}", async () => {
    const { report, lines } = await run(["conv-001", "conv-005", "conv-003"], {
      "conv-005": { httpStatus: 400 },
    });

    expect(report.results.results.map((r) => r.conversation_id)).toEqual([
      "conv-001",
      "conv-005",
      "conv-003",
    ]);
    expect(report.results.results[1]).toEqual({
      conversation_id: "conv-005",
      error: expect.stringContaining("400"),
    });
    expect(report.metrics.total).toBe(2); // las métricas cuentan solo los éxitos
    expect(
      lines.some(
        (l) =>
          l.msg === "conversación falló; se continúa" &&
          l.conversation_id === "conv-005",
      ),
    ).toBe(true);
  });

  // Previene gastar 4 min por conversación cuando la cuota diaria ya se agotó: el resto se omite sin llamar.
  it("cuota agotada: se omiten las conversaciones restantes sin llamar a Gemini", async () => {
    const { logger } = memoryLogger();
    const callLog: LlmCallLogEntry[] = [];
    let calls = 0;
    const llm = new GeminiClient("k", "gemini-2.5-flash", {
      logger,
      sleep: async () => {},
      onCall: (e) => void callLog.push(e),
      transport: async (request) => {
        calls++;
        const id =
          /\(id: ([^)]+)\)/.exec(
            (request.contents[0]?.parts?.[0] as { text: string }).text,
          )?.[1] ?? "";
        if (id === "conv-001") {
          return {
            text: () => JSON.stringify(IDEAL_EXTRACTIONS[id]),
            candidates: [{ finishReason: "STOP" }],
            usageMetadata: {
              promptTokenCount: 1,
              candidatesTokenCount: 1,
              totalTokenCount: 2,
            },
          };
        }
        throw googleApiError(
          429,
          "30775s",
          "Quota exceeded for metric: generate_content_free_tier_requests",
        );
      },
    });

    const report = await runBatch(
      ["conv-001", "conv-004", "conv-005", "conv-006"].map(conv),
      {
        analyzer: new Analyzer({ llm, logger }),
        callLog,
        logger,
        model: "gemini-2.5-flash",
        pricing: PRICING,
      },
    );

    expect(calls).toBe(2); // conv-001 ok + conv-004 (cuota) — conv-005/006 no se llaman
    const [ok1, quota, skipped1, skipped2] = report.results.results;
    expect(isBatchError(ok1!)).toBe(false);
    expect((quota as { error: string }).error).toMatch(
      /^Cuota de Gemini agotada/,
    );
    expect((skipped1 as { error: string }).error).toMatch(
      /^No procesada: Cuota de Gemini agotada/,
    );
    expect((skipped2 as { error: string }).error).toMatch(/^No procesada/);
  });

  // Previene 10 llamadas inútiles cuando el modelo no existe para la cuenta (404 "no longer available to new users").
  it("404 de modelo: se detiene en la primera y marca el resto sin llamar a Gemini", async () => {
    const { report } = await run(["conv-001", "conv-002", "conv-003"], {
      "conv-001": { httpStatus: 404 },
      "conv-002": { httpStatus: 404 },
      "conv-003": { httpStatus: 404 },
    });

    const errors = report.results.results.map(
      (r) => (r as { error: string }).error,
    );
    expect(errors[0]).toContain("404");
    expect(errors[1]).toBe(
      "No procesada: Gemini HTTP 404: modelo no disponible para esta cuenta (revisa GEMINI_MODEL)",
    );
    expect(errors[2]).toMatch(/^No procesada/);
    expect(report.costs.perConversation.map((c) => c.llmCalls)).toEqual([
      1, 0, 0,
    ]);
  });

  // Previene cortar el batch por errores que solo afectan a una conversación.
  it("isFatalForBatch: 404/401/403/API key y cuota sí; 400 genérico, 5xx, parse y timeout no", () => {
    const http = (status: number, msg = "x") =>
      new LlmClientError("http", msg, { attempts: 1, status });
    expect(isFatalForBatch(http(404))).toBe(true);
    expect(isFatalForBatch(http(403))).toBe(true);
    expect(
      isFatalForBatch(
        http(400, "API key not valid. Please pass a valid API key."),
      ),
    ).toBe(true);
    expect(isFatalForBatch(new LlmClientError("quota_exhausted", "x"))).toBe(
      true,
    );
    expect(isFatalForBatch(http(400, "Invalid JSON payload"))).toBe(false);
    expect(isFatalForBatch(http(503))).toBe(false);
    expect(isFatalForBatch(new LlmClientError("parse", "x"))).toBe(false);
    expect(isFatalForBatch(new LlmClientError("timeout", "x"))).toBe(false);
    expect(isFatalForBatch(new Error("x"))).toBe(false);
  });

  it("costos con tokens reales: suma por conversación y total; thinking se cobra como output", async () => {
    const { report } = await run(["conv-001", "conv-003"], {
      "conv-001": {
        usage: {
          promptTokenCount: 1000,
          candidatesTokenCount: 200,
          totalTokenCount: 1500,
          thoughtsTokenCount: 300,
        },
      },
      "conv-003": {
        usage: {
          promptTokenCount: 2000,
          candidatesTokenCount: 400,
          totalTokenCount: 2400,
        },
      },
    });

    const [c1, c3] = report.costs.perConversation;
    expect(c1).toMatchObject({
      promptTokens: 1000,
      candidateTokens: 200,
      thoughtsTokens: 300,
      totalTokens: 1500,
      llmCalls: 1,
    });
    expect(c1?.estimatedCostUSD).toBe(costUSD(1000, 500, PRICING)); // 0.0003 + 0.00125
    expect(c3).toMatchObject({ thoughtsTokens: 0, totalTokens: 2400 });

    expect(report.costs).toMatchObject({
      totalPromptTokens: 3000,
      totalCandidateTokens: 600,
      totalThoughtsTokens: 300,
      totalTokens: 3900,
      estimatedCostUSD: costUSD(3000, 900, PRICING),
    });
  });

  it("thinking sin thoughtsTokenCount se deriva de total − prompt − candidatos", async () => {
    const { report } = await run(["conv-001"], {
      "conv-001": {
        usage: {
          promptTokenCount: 1000,
          candidatesTokenCount: 200,
          totalTokenCount: 1700,
        },
      },
    });
    expect(report.costs.perConversation[0]?.thoughtsTokens).toBe(500);
  });

  it("campo de usage faltante → warning y 0", async () => {
    const { report, lines } = await run(["conv-001"], {
      "conv-001": { usage: { promptTokenCount: 1000, totalTokenCount: 1000 } },
    });

    expect(report.costs.perConversation[0]?.candidateTokens).toBe(0);
    expect(lines).toContainEqual(
      expect.objectContaining({
        level: 40,
        field: "candidateTokens",
        conversation_id: "conv-001",
      }),
    );
  });

  it("cache: una conversación repetida no genera llamadas ni costo", async () => {
    const { report } = await run(["conv-005", "conv-005"]);
    const [first, second] = report.costs.perConversation;
    // Mismo id en ambas entradas: las llamadas se atribuyen al id, y solo hubo 1.
    expect(first?.llmCalls).toBe(1);
    expect(second?.llmCalls).toBe(1);
    expect(report.results.results).toHaveLength(2);
  });
});

describe("--only y fusión con la corrida anterior", () => {
  // Previene errores de CLI: el archivo y --only pueden venir en cualquier orden.
  it("parseArgs", () => {
    expect(parseArgs([])).toEqual({ inputPath: "data/conversaciones.json" });
    expect(parseArgs(["--only", "conv-004, conv-006"])).toEqual({
      inputPath: "data/conversaciones.json",
      only: new Set(["conv-004", "conv-006"]),
    });
    expect(parseArgs(["otro.json", "--only=conv-001"])).toEqual({
      inputPath: "otro.json",
      only: new Set(["conv-001"]),
    });
  });

  // Previene perder resultados buenos (y volver a pagarlos) al reprocesar solo las que fallaron.
  it("withMergedResults: lo nuevo reemplaza por id, lo demás se conserva, orden del archivo", async () => {
    const { report: previous } = await run(
      ["conv-001", "conv-004", "conv-005"],
      { "conv-004": { httpStatus: 400 } },
    );
    const { report: retry } = await run(["conv-004"]);

    const merged = withMergedResults(retry, previous.results.results, [
      "conv-001",
      "conv-004",
      "conv-005",
    ]);

    expect(
      merged.results.results.map((r) => [
        r.conversation_id,
        isBatchError(r) ? "ERROR" : r.priority,
      ]),
    ).toEqual([
      ["conv-001", "media"],
      ["conv-004", "descartar"],
      ["conv-005", "alta"],
    ]);
    expect(merged.metrics.total).toBe(3);
    expect(merged.costs.perConversation.map((c) => c.conversation_id)).toEqual([
      "conv-004",
    ]); // costos: solo esta corrida
  });
});

describe("precios", () => {
  it("prefijo más largo gana; variables de entorno tienen prioridad; desconocido → 0", () => {
    expect(resolvePricing("gemini-2.5-flash-001", {})).toMatchObject({
      inputPerMillion: 0.3,
      matched: "gemini-2.5-flash",
    });
    expect(resolvePricing("gemini-2.5-flash-lite", {})).toMatchObject({
      inputPerMillion: 0.1,
      outputPerMillion: 0.4,
    });
    expect(
      resolvePricing("gemini-2.5-flash", {
        GEMINI_PRICE_INPUT_PER_M: "1",
        GEMINI_PRICE_OUTPUT_PER_M: "2",
      }),
    ).toEqual({
      inputPerMillion: 1,
      outputPerMillion: 2,
      source: "env",
    });
    expect(resolvePricing("modelo-x", {})).toEqual({
      inputPerMillion: 0,
      outputPerMillion: 0,
      source: "unknown",
    });
  });

  // Previene el $0 de la corrida real: gemini-3.6-flash no estaba en la tabla.
  it("gemini-3.6 / 3.7 / 3.8 Flash: precio introductorio en 2026 y estándar desde el 01-01-2027", () => {
    const dic2026 = new Date("2026-12-31T12:00:00Z");
    const ene2027 = new Date("2027-01-01T12:00:00Z");
    for (const model of [
      "gemini-3.6-flash",
      "gemini-3.7-flash",
      "gemini-3.8-flash",
    ]) {
      expect(resolvePricing(model, {}, dic2026)).toMatchObject({
        inputPerMillion: 0.75,
        outputPerMillion: 3.75,
        source: "table",
      });
      expect(resolvePricing(model, {}, ene2027)).toMatchObject({
        inputPerMillion: 1.5,
        outputPerMillion: 7.5,
        effectiveFrom: "2027-01-01",
      });
    }
  });

  // Previene ignorar en silencio un precio escrito con coma decimal ("0,75") → antes terminaba en $0.
  it("precios del .env aceptan coma decimal", () => {
    expect(
      resolvePricing("x", {
        GEMINI_PRICE_INPUT_PER_M: "0,75",
        GEMINI_PRICE_OUTPUT_PER_M: " 3,75 ",
      }),
    ).toEqual({
      inputPerMillion: 0.75,
      outputPerMillion: 3.75,
      source: "env",
    });
  });

  // Previene un costo falso: precio incompleto o inválido en .env es un error, no un fallback silencioso.
  it("precio incompleto o inválido en .env → error explícito", () => {
    expect(() =>
      resolvePricing("gemini-3.6-flash", { GEMINI_PRICE_INPUT_PER_M: "0.75" }),
    ).toThrow(/Precio inválido/);
    expect(() =>
      resolvePricing("gemini-3.6-flash", {
        GEMINI_PRICE_INPUT_PER_M: "abc",
        GEMINI_PRICE_OUTPUT_PER_M: "3.75",
      }),
    ).toThrow(/Precio inválido/);
    expect(() =>
      resolvePricing("gemini-3.6-flash", {
        GEMINI_PRICE_INPUT_PER_M: "-1",
        GEMINI_PRICE_OUTPUT_PER_M: "3.75",
      }),
    ).toThrow();
    // Ambos vacíos (como en .env.example) = usar la tabla.
    expect(
      resolvePricing("gemini-2.5-flash", {
        GEMINI_PRICE_INPUT_PER_M: "",
        GEMINI_PRICE_OUTPUT_PER_M: "",
      }).source,
    ).toBe("table");
  });

  // Previene mostrar "$0.000000" cuando en realidad no hay precio: con tokens reales y modelo sin precio → null.
  it("modelo sin precio: estimatedCostUSD = null y la línea de totales lo dice", async () => {
    const { report } = await run(["conv-001"]);
    const costs = buildCostReport(
      ["conv-001"],
      [
        {
          conversation_id: "conv-001",
          promptTokens: 3300,
          candidateTokens: 300,
          totalTokens: 3600,
          latencyMs: 10,
          attempt: 1,
        },
      ],
      "modelo-nuevo",
      { inputPerMillion: 0, outputPerMillion: 0, source: "unknown" },
      10,
      pino({ level: "silent" }),
    );

    expect(report.costs.estimatedCostUSD).toBeGreaterThan(0); // con precio conocido sí hay costo
    expect(costs.totalTokens).toBe(3600);
    expect(costs.estimatedCostUSD).toBeNull();
    expect(costs.perConversation[0]?.estimatedCostUSD).toBeNull();
    expect(formatTotals(costs)).toContain("sin precio para modelo-nuevo");
  });

  it("costUSD: 1M de input + 1M de output = suma de ambas tarifas", () => {
    expect(costUSD(1_000_000, 1_000_000, PRICING)).toBe(2.8);
  });
});

describe("salidas", () => {
  it("escribe results.json, metrics.json y costs.json sin dejar .tmp", async () => {
    const { report } = await run(["conv-001", "conv-005"]);
    const dir = await mkdtemp(join(tmpdir(), "batch-"));

    await writeOutputs(dir, report);

    expect((await readdir(dir)).sort()).toEqual([
      "costs.json",
      "metrics.json",
      "results.json",
    ]);
    const read = async (f: string) =>
      JSON.parse(await readFile(join(dir, f), "utf8")) as unknown;
    const results = (await read("results.json")) as BatchReport["results"];
    expect(results.results).toHaveLength(2);
    expect(await read("metrics.json")).toEqual(results.metrics);
    expect(await read("costs.json")).toMatchObject({
      model: "gemini-2.5-flash",
      totalTokens: 2400,
    });
  });

  it("tabla: columnas pedidas y summary truncado a 60 caracteres", () => {
    const table = formatSummaryTable([
      {
        conversation_id: "conv-x",
        error: "Gemini HTTP 503: " + "y".repeat(100),
      },
    ]);
    const [header, , row] = table.split("\n");
    expect(header).toMatch(
      /^id\s+\| intent \| urgency \| priority \| actionable \| summary$/,
    );
    expect([...row!.split(" | ").at(-1)!]).toHaveLength(60);
    expect(truncate("corto")).toBe("corto");
  });

  it("línea de totales con el formato pedido", () => {
    const line = formatTotals({
      totalTokens: 12345,
      estimatedCostUSD: 0.0041,
      totalLatencyMs: 8450,
    } as BatchReport["costs"]);
    expect(line).toBe(
      "Tokens totales: 12.345 | Costo estimado: $0.004100 | Latencia total: 8.5s",
    );
  });
});
