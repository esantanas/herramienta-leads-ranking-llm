/**
 * Dobles de prueba sin red.
 *
 * - MockLlmClient: implementa LlmClient con una respuesta prefabricada. Para
 *   tests de pipeline/servidor que no deben depender de Gemini.
 * - scriptedTransport: reemplaza la llamada HTTP dentro de GeminiClient para
 *   probar timeout, retry y logging con la lógica real del cliente.
 */
import { ApiError } from "@google/genai";
import {
  interpretLlmText,
  type GeminiRequest,
  type GenerateContentTransport,
  type LlmClient,
  type TransportResponse,
  type UsageMetadataLike,
} from "../../src/llm/geminiClient.js";
import type { Conversation, RawLlmOutput, Result } from "../../src/schema.js";

// ─────────────────────────────────────────────────────────────────────────────
// MockLlmClient
// ─────────────────────────────────────────────────────────────────────────────

type CannedResponse = string | RawLlmOutput | ((conversation: Conversation) => string | RawLlmOutput);

export class MockLlmClient implements LlmClient {
  /** Conversaciones recibidas, en orden. */
  readonly calls: Conversation[] = [];

  constructor(
    private readonly response: CannedResponse,
    private readonly opts: { readonly delayMs?: number } = {},
  ) {}

  async analyze(conversation: Conversation): Promise<Result<RawLlmOutput, Error>> {
    this.calls.push(conversation);
    if (this.opts.delayMs) await new Promise((r) => setTimeout(r, this.opts.delayMs));

    const canned = typeof this.response === "function" ? this.response(conversation) : this.response;
    const text = typeof canned === "string" ? canned : JSON.stringify(canned);
    // Mismo camino de validación que GeminiClient (schema + conversation_id).
    return interpretLlmText(text, conversation);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// scriptedTransport
// ─────────────────────────────────────────────────────────────────────────────

export type TransportStep =
  | { readonly kind: "ok"; readonly text: string; readonly usage?: UsageMetadataLike; readonly finishReason?: string }
  | { readonly kind: "http_error"; readonly status: number; readonly retryDelay?: string }
  | { readonly kind: "slow"; readonly delayMs: number };

export const DEFAULT_USAGE: UsageMetadataLike = { promptTokenCount: 1200, candidatesTokenCount: 350, totalTokenCount: 1550 };

/** Transporte que ejecuta un paso del guion por llamada. */
export function scriptedTransport(steps: readonly TransportStep[]) {
  const requests: GeminiRequest[] = [];
  const signals: AbortSignal[] = [];

  const transport: GenerateContentTransport = async (request, { signal }) => {
    requests.push(request);
    signals.push(signal);
    const step = steps[requests.length - 1];
    if (!step) throw new Error(`scriptedTransport: llamada #${requests.length} no está en el guion`);

    switch (step.kind) {
      case "ok":
        return okResponse(step.text, step.usage ?? DEFAULT_USAGE, step.finishReason ?? "STOP");
      case "http_error":
        // Misma clase de error que lanza el SDK real.
        throw googleApiError(step.status, step.retryDelay);
      case "slow":
        // Respeta el AbortSignal para no dejar timers vivos tras el timeout.
        return new Promise<never>((_, reject) => {
          const timer = setTimeout(() => reject(new Error("slow step terminó sin abort")), step.delayMs);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("aborted"));
          });
        });
    }
  };

  return { transport, requests, signals };
}

function okResponse(text: string, usage: UsageMetadataLike, finishReason: string): TransportResponse {
  return { text: () => text, candidates: [{ finishReason }], usageMetadata: usage };
}

/**
 * Error con el mismo formato que lanza @google/genai: ApiError con `status`
 * y el cuerpo JSON de Google en `message` (incluido RetryInfo si aplica).
 */
export function googleApiError(status: number, retryDelay?: string, message = "scripted"): ApiError {
  const body = {
    error: {
      code: status,
      message,
      status: status === 429 ? "RESOURCE_EXHAUSTED" : "ERROR",
      ...(retryDelay && { details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay }] }),
    },
  };
  return new ApiError({ message: JSON.stringify(body), status });
}
