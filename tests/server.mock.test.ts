import { pino } from "pino";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { CostTracker } from "../src/metrics.js";
import type { RawLlmOutput } from "../src/schema.js";
import { createApp } from "../src/server.js";
import { conv, rawOutput } from "./fixtures.js";
import { MockLlmClient } from "./mocks/MockLlmClient.js";

// ─────────────────────────────────────────────────────────────────────────────
// Respuestas prefabricadas del "LLM" (citas reales de data/conversations.json)
// ─────────────────────────────────────────────────────────────────────────────

const CANNED: Record<string, RawLlmOutput> = {
  // Incluye un presupuesto alucinado ("UF 4.200" lo dijo el asistente).
  "conv-001": rawOutput({
    conversation_id: "conv-001",
    intent: "comprar",
    intent_evidence: "Para vivir, con mi pareja",
    urgency: "media",
    urgency_evidence: "Nos gustaría mudarnos antes de marzo",
    budget: { amount: 4200, currency: "UF", scope: "por_unidad" },
    budget_evidence: "UF 4.200",
    down_payment: { amount: 900, currency: "UF" },
    down_payment_evidence: "pie para unas UF 900",
    property_type: "departamento 2D",
    property_type_evidence: "deptos de 2 dormitorios",
    one_line_summary: "Pareja busca 2D para vivir antes de marzo, pie UF 900.",
    confidence: 0.85,
  }),
  "conv-005": rawOutput({
    conversation_id: "conv-005",
    intent: "comprar",
    intent_evidence: "tengo preaprobado el crédito",
    urgency: "alta",
    urgency_evidence: "me tengo que salir de mi arriendo el 30",
    budget: { amount: 3500, currency: "UF", scope: "total" },
    budget_evidence: "Máximo 3.500 UF",
    property_type: "departamento 1D",
    property_type_evidence: "algo de 1 dormitorio",
    has_preapproved_credit: true,
    has_preapproved_credit_evidence: "tengo preaprobado el crédito",
    one_line_summary: "Necesita 1D con entrega inmediata, máx. UF 3.500, crédito preaprobado.",
    confidence: 0.92,
  }),
};

/** El mock responde según el id; para ids desconocidos devuelve texto no-JSON (→ 502). */
const cannedById = (c: { id: string }) => {
  const canned = CANNED[c.id];
  return canned ? { ...canned, conversation_id: c.id } : "lo siento, no puedo";
};

function setup() {
  const llm = new MockLlmClient(cannedById);
  const costs = new CostTracker();
  const app = createApp({ llm, costs, logger: pino({ level: "silent" }) });
  return { app, llm, costs };
}

// ─────────────────────────────────────────────────────────────────────────────
// Casos pedidos
// ─────────────────────────────────────────────────────────────────────────────

describe("API con MockLlmClient", () => {
  it("POST /analyze válido → 200 con resultado verificado y priorizado", async () => {
    const { app, llm } = setup();

    const res = await request(app).post("/analyze").send({ conversation: conv("conv-001") });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      conversation_id: "conv-001",
      intent: "comprar",
      urgency: "media",
      budget: null, // anulado: lo dijo el asistente
      down_payment: { amount: 900, currency: "UF" },
      property_type: "departamento 2D",
      priority: "media",
      is_actionable: true,
      audit: ["budget anulado: evidencia pertenece al asistente"],
    });
    expect(res.body.priority_reasons).toContain("score 4 → media");
    expect(Object.keys(res.body).some((k) => k.endsWith("_evidence"))).toBe(false);
    expect(llm.calls).toHaveLength(1);
  });

  it("POST /analyze con body inválido → 400 sin llamar al LLM", async () => {
    const { app, llm } = setup();

    const res = await request(app)
      .post("/analyze")
      .send({ conversation: { id: "x", mensajes: [{ de: "bot", texto: "hola" }] } });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Body inválido");
    expect(res.body.issues.join(" ")).toContain("conversation.mensajes.0.de");
    expect(llm.calls).toHaveLength(0);
  });

  it("GET /health → 200 {status:'ok', uptime}", async () => {
    const { app } = setup();

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", uptime: expect.any(Number) });
  });

  it("POST /analyze/batch con 2 conversaciones → resultados en orden + métricas", async () => {
    const { app, llm } = setup();

    const res = await request(app)
      .post("/analyze/batch")
      .send({ conversations: [conv("conv-001"), conv("conv-005")] });

    expect(res.status).toBe(200);
    expect(res.body.errors).toEqual([]);
    expect(res.body.results.map((r: { conversation_id: string; priority: string }) => [r.conversation_id, r.priority])).toEqual([
      ["conv-001", "media"],
      ["conv-005", "alta"],
    ]);
    expect(res.body.metrics).toEqual({
      total: 2,
      by_intent: { comprar: 2 },
      by_priority: { media: 1, alta: 1 },
      actionable_rate: 1,
      needs_human_count: 0,
      fields_missing_rate: { budget: 0.5, urgency: 0 }, // conv-001 perdió el budget alucinado
      avg_confidence: 0.885,
      estimated_time_saved_minutes: 0, // ambas accionables: el ejecutivo igual las lee
    });
    expect(llm.calls.map((c) => c.id)).toEqual(["conv-001", "conv-005"]); // en serie, en orden
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Adicionales
// ─────────────────────────────────────────────────────────────────────────────

describe("API – adicionales", () => {
  it("LLM falla → 502", async () => {
    const { app } = setup();

    const res = await request(app).post("/analyze").send({ conversation: { ...conv("conv-003") } });

    expect(res.status).toBe(502);
    expect(res.body.error).toBe("El análisis con el LLM falló");
  });

  it("JSON malformado → 400 en JSON (manejador global)", async () => {
    const { app } = setup();

    const res = await request(app).post("/analyze").set("Content-Type", "application/json").send('{"conversation": ');

    expect(res.status).toBe(400);
    expect(res.type).toBe("application/json");
  });

  it("body > 1MB → 413", async () => {
    const { app } = setup();
    const huge = { conversation: { id: "big", mensajes: [{ de: "lead", texto: "x".repeat(1_100_000) }] } };

    const res = await request(app).post("/analyze").send(huge);

    expect(res.status).toBe(413);
  });

  it("cache: la misma conversación (aunque cambie el id) no vuelve a llamar al LLM", async () => {
    const { app, llm, costs } = setup();

    const first = await request(app).post("/analyze").send({ conversation: conv("conv-005") });
    const again = await request(app).post("/analyze").send({ conversation: { ...conv("conv-005"), id: "conv-005-bis" } });

    expect(llm.calls).toHaveLength(1);
    expect(again.body).toEqual({ ...first.body, conversation_id: "conv-005-bis" });
    expect(costs.snapshot().cache_hits).toBe(1);
  });

  it("cache también aplica dentro de un batch", async () => {
    const { app, llm } = setup();

    const res = await request(app)
      .post("/analyze/batch")
      .send({ conversations: [conv("conv-005"), conv("conv-005"), conv("conv-001")] });

    expect(res.body.results).toHaveLength(3);
    expect(llm.calls.map((c) => c.id)).toEqual(["conv-005", "conv-001"]);
  });

  it("shortcut: lead sin contenido → baja, sin llamar al LLM", async () => {
    const { app, llm, costs } = setup();

    const res = await request(app)
      .post("/analyze")
      .send({ conversation: { id: "conv-ok", mensajes: [{ de: "lead", texto: "ok" }, { de: "asistente", texto: "¿En qué te ayudo con el proyecto?" }] } });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ intent: "incierto", confidence: 0, priority: "baja", is_actionable: false });
    expect(llm.calls).toHaveLength(0);
    expect(costs.snapshot().shortcuts).toBe(1);
  });

  it("batch: un fallo no corta el resto; se reporta en errors", async () => {
    const { app } = setup();

    const res = await request(app)
      .post("/analyze/batch")
      .send({ conversations: [conv("conv-003"), conv("conv-005")] });

    expect(res.status).toBe(200);
    expect(res.body.results.map((r: { conversation_id: string }) => r.conversation_id)).toEqual(["conv-005"]);
    expect(res.body.errors).toEqual([{ conversation_id: "conv-003", error: expect.any(String) }]);
  });

  it("batch vacío → 400", async () => {
    const res = await request(setup().app).post("/analyze/batch").send({ conversations: [] });
    expect(res.status).toBe(400);
  });

  it("GET /metrics/cost acumula lo que reporta el cliente LLM", async () => {
    const { app, costs } = setup();
    costs.recordCall({ conversation_id: "c", promptTokens: 1000, candidateTokens: 300, totalTokens: 1300, latencyMs: 800, attempt: 1 });
    costs.recordCall({ conversation_id: "c", promptTokens: null, candidateTokens: null, totalTokens: null, latencyMs: 30000, attempt: 1, error: "timeout" });

    const res = await request(app).get("/metrics/cost");

    expect(res.body).toMatchObject({
      llm_calls: 2,
      llm_failed_calls: 1,
      prompt_tokens: 1000,
      candidate_tokens: 300,
      total_tokens: 1300,
      avg_latency_ms: 15400,
    });
  });

  it("ruta inexistente → 404 JSON", async () => {
    const res = await request(setup().app).get("/nope");
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Ruta no encontrada/);
  });
});
