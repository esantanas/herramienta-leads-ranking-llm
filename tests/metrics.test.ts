import { describe, expect, it } from "vitest";
import { conversationCacheKey } from "../src/cache.js";
import { READING_MINUTES_PER_CONVERSATION, calculateMetrics, type MetricsInput } from "../src/metrics.js";
import { preprocess } from "../src/preprocess.js";
import { conv } from "./fixtures.js";

const row = (o: Partial<MetricsInput>): MetricsInput => ({
  intent: "comprar",
  priority: "media",
  needs_human_intervention: false,
  confidence: 0.8,
  has_budget: true,
  has_urgency: true,
  ...o,
});

describe("calculateMetrics", () => {
  it("lista vacía → ceros, sin NaN", () => {
    expect(calculateMetrics([])).toEqual({
      total: 0,
      by_intent: {},
      by_priority: {},
      actionable_rate: 0,
      needs_human_count: 0,
      fields_missing_rate: { budget: 0, urgency: 0 },
      avg_confidence: 0,
      estimated_time_saved_minutes: 0,
    });
  });

  it("cuenta, tasas y tiempo ahorrado (3.5 min por conversación NO accionable)", () => {
    const m = calculateMetrics([
      row({ priority: "alta" }),
      row({ priority: "media", needs_human_intervention: true }),
      row({ intent: "consulta", priority: "baja", has_budget: false, has_urgency: false, confidence: 0.5 }),
      row({ intent: "no_lead", priority: "descartar", has_budget: false, has_urgency: false, confidence: 0.9 }),
    ]);

    expect(m).toEqual({
      total: 4,
      by_intent: { comprar: 2, consulta: 1, no_lead: 1 },
      by_priority: { alta: 1, media: 1, baja: 1, descartar: 1 },
      actionable_rate: 0.5,
      needs_human_count: 1,
      fields_missing_rate: { budget: 0.5, urgency: 0.5 },
      avg_confidence: 0.75,
      estimated_time_saved_minutes: 2 * READING_MINUTES_PER_CONVERSATION,
    });
  });
});

describe("preprocess", () => {
  it("conversación real con contenido → va al LLM", () => {
    expect(preprocess(conv("conv-004")).kind).toBe("llm"); // "Hola" es corto, pero el 2º mensaje no
  });

  it("sin mensajes → shortcut con confidence 0 e intent incierto", () => {
    const r = preprocess({ id: "vacia", mensajes: [] });
    expect(r.kind).toBe("shortcut");
    if (r.kind === "shortcut") expect(r.output).toMatchObject({ conversation_id: "vacia", intent: "incierto", confidence: 0 });
  });

  it("todos los mensajes del lead < 5 chars → shortcut, aunque el asistente escriba largo", () => {
    const r = preprocess({
      id: "c",
      mensajes: [
        { de: "lead", texto: " ok " },
        { de: "asistente", texto: "¡Hola! ¿Buscas para vivir o invertir?" },
        { de: "lead", texto: "👍👍" },
      ],
    });
    expect(r.kind).toBe("shortcut");
  });

  it("un mensaje del lead con 5 chars basta para ir al LLM", () => {
    expect(preprocess({ id: "c", mensajes: [{ de: "lead", texto: "hola!" }] }).kind).toBe("llm");
  });
});

describe("conversationCacheKey", () => {
  it("ignora id, mayúsculas, tildes y espacios; distingue autor y contenido", () => {
    const base = conv("conv-005");
    const variant = {
      id: "otro",
      mensajes: base.mensajes.map((m) => ({ ...m, texto: `  ${m.texto.toUpperCase()}  ` })),
    };
    const otherAuthor = { ...base, mensajes: base.mensajes.map((m) => ({ ...m, de: "asistente" as const })) };

    expect(conversationCacheKey(variant)).toBe(conversationCacheKey(base));
    expect(conversationCacheKey(otherAuthor)).not.toBe(conversationCacheKey(base));
    expect(conversationCacheKey(conv("conv-001"))).not.toBe(conversationCacheKey(base));
  });
});
