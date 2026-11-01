/**
 * Cliente de Gemini para la extracción estructurada.
 *
 * Responsabilidades: llamar a la API (timeout + retry), registrar uso de
 * tokens por cada llamada (evidencia de costos), parsear/validar la respuesta
 * y comprobar que corresponde a la conversación pedida. Nunca lanza desde
 * analyze(): todo error vuelve como Result.
 */
import {
  GoogleGenAI,
  ThinkingLevel as SdkThinkingLevel,
  type Content,
  type GenerateContentConfig,
  type Schema,
  type ThinkingConfig as SdkThinkingConfig,
} from "@google/genai";
import { pino, type Logger } from "pino";
import { parseLlmJson, type Conversation, type RawLlmOutput, type Result } from "../schema.js";
import { RESPONSE_SCHEMA, SYSTEM_PROMPT, formatConversation, isSystemPromptConfigured } from "./prompt.js";

// ─────────────────────────────────────────────────────────────────────────────
// Contrato
// ─────────────────────────────────────────────────────────────────────────────

export interface LlmClient {
  analyze(conversation: Conversation): Promise<Result<RawLlmOutput, Error>>;
}

export type LlmErrorKind =
  | "timeout"
  | "http"
  | "network"
  | "blocked"
  | "max_tokens"
  | "empty_response"
  | "parse"
  | "conversation_id_mismatch"
  /** 429 cuya espera supera maxRetryDelayMs (p. ej. cuota diaria): reintentar es inútil. */
  | "quota_exhausted";

export class LlmClientError extends Error {
  override readonly name = "LlmClientError";

  constructor(
    readonly kind: LlmErrorKind,
    message: string,
    readonly details: { readonly attempts: number; readonly status?: number; readonly raw?: string } = { attempts: 1 },
  ) {
    super(message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Transporte (inyectable para tests)
// ─────────────────────────────────────────────────────────────────────────────

export interface UsageMetadataLike {
  readonly promptTokenCount?: number;
  readonly candidatesTokenCount?: number;
  readonly totalTokenCount?: number;
  /** Tokens de "thinking" (modelos 2.5+). */
  readonly thoughtsTokenCount?: number;
}

/**
 * Petición en formato propio, independiente del SDK. createSdkTransport la
 * traduce a @google/genai; los tests la inspeccionan directamente.
 */
export interface GeminiRequest {
  readonly systemInstruction: string;
  readonly contents: Content[];
  readonly generationConfig: GenerationConfigWithThinking;
}

/** Lo mínimo que usamos de la respuesta del SDK. */
export interface TransportResponse {
  text(): string;
  readonly candidates?: ReadonlyArray<{ readonly finishReason?: string }>;
  readonly promptFeedback?: { readonly blockReason?: string };
  readonly usageMetadata?: UsageMetadataLike;
}

export type GenerateContentTransport = (
  request: GeminiRequest,
  options: { readonly signal: AbortSignal },
) => Promise<TransportResponse>;

// ─────────────────────────────────────────────────────────────────────────────
// Configuración
// ─────────────────────────────────────────────────────────────────────────────

export interface GenerationConfig {
  readonly temperature: number;
  readonly topP: number;
  readonly maxOutputTokens: number;
  readonly responseMimeType: string;
  readonly responseSchema: Schema;
}

export const GENERATION_CONFIG: GenerationConfig = Object.freeze({
  temperature: 0.1,
  topP: 0.8,
  // 800 no alcanzaba en la corrida real con gemini-2.5-flash: el "thinking" (~770 tokens)
  // cuenta dentro de este límite y el JSON (~300 tokens) quedaba truncado.
  // En Gemini 3.x el thinking no se puede apagar (solo low/medium/high), así que se
  // deja margen amplio. Es solo un TOPE: se cobra lo que el modelo genera, no el límite.
  maxOutputTokens: 4096,
  responseMimeType: "application/json",
  responseSchema: RESPONSE_SCHEMA,
});

/** Niveles de thinking de Gemini 3.x ("minimal" no existe en gemini-3.8-flash: responde 400). */
export const THINKING_LEVELS = ["minimal", "low", "medium", "high"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** Uno u otro: la API devuelve 400 si se envían ambos. */
export type ThinkingConfig = { readonly thinkingBudget: number } | { readonly thinkingLevel: ThinkingLevel };

export type GenerationConfigWithThinking = GenerationConfig & { readonly thinkingConfig?: ThinkingConfig };

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_RETRIES = 3; // → esperas de 1s, 2s, 4s (o lo que pida Google en RetryInfo)
export const DEFAULT_BASE_DELAY_MS = 1_000;
/** Tope para la espera sugerida por Google en un 429 (RetryInfo.retryDelay). */
export const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;

/** Lo que se loguea al final de cada llamada a Gemini (evidencia de costos). */
export interface LlmCallLogEntry {
  readonly conversation_id: string;
  readonly promptTokens: number | null;
  readonly candidateTokens: number | null;
  readonly totalTokens: number | null;
  readonly thoughtsTokens?: number;
  readonly latencyMs: number;
  readonly attempt: number;
  readonly error?: LlmErrorKind;
  readonly status?: number;
}

export interface GeminiClientOptions {
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly baseDelayMs?: number;
  readonly logger?: Logger;
  /** Recibe cada entrada de log de costos (p. ej. para acumular métricas en memoria). */
  readonly onCall?: (entry: LlmCallLogEntry) => void;
  /**
   * Gemini 2.5: tokens de "thinking" permitidos; 0 lo apaga.
   * undefined = no se envía y el modelo usa su valor por defecto.
   * Excluyente con thinkingLevel.
   */
  readonly thinkingBudget?: number;
  /** Gemini 3.x: nivel de thinking (gemini-3.8-flash: low | medium | high). Excluyente con thinkingBudget. */
  readonly thinkingLevel?: ThinkingLevel;
  /**
   * Separación mínima entre requests a Gemini (incluye reintentos). Evita 429
   * en planes con límite por minuto: free tier de gemini-2.5-flash = 5 RPM → 12_000.
   */
  readonly minIntervalMs?: number;
  /** Tope para la espera que Google pide en un 429. Default 60s. */
  readonly maxRetryDelayMs?: number;
  /** Solo tests: reemplaza la llamada real al SDK. */
  readonly transport?: GenerateContentTransport;
  /** Solo tests: reemplaza la espera del backoff y del throttle. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Solo tests: reloj para el throttle. */
  readonly now?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ─────────────────────────────────────────────────────────────────────────────
// Cliente
// ─────────────────────────────────────────────────────────────────────────────

export class GeminiClient implements LlmClient {
  private readonly transport: GenerateContentTransport;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly logger: Logger;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onCall: ((entry: LlmCallLogEntry) => void) | undefined;
  private readonly thinking: ThinkingConfig | undefined;
  private readonly minIntervalMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly now: () => number;
  /** Momento a partir del cual se puede lanzar el próximo request (throttle). */
  private nextSlotAt = 0;

  constructor(apiKey: string, model: string, opts: GeminiClientOptions = {}) {
    this.onCall = opts.onCall;
    if (opts.thinkingBudget !== undefined && opts.thinkingLevel !== undefined) {
      throw new Error("thinkingBudget y thinkingLevel son excluyentes (la API responde 400 si van juntos)");
    }
    this.thinking =
      opts.thinkingLevel !== undefined
        ? { thinkingLevel: opts.thinkingLevel }
        : opts.thinkingBudget !== undefined
          ? { thinkingBudget: opts.thinkingBudget }
          : undefined;
    this.minIntervalMs = Math.max(0, opts.minIntervalMs ?? 0);
    this.maxRetryDelayMs = opts.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
    this.now = opts.now ?? Date.now;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    this.logger = opts.logger ?? pino({ name: "gemini" });
    this.sleep = opts.sleep ?? defaultSleep;
    this.transport = opts.transport ?? createSdkTransport(apiKey, model);
  }

  async analyze(conversation: Conversation): Promise<Result<RawLlmOutput, Error>> {
    const request = buildRequest(conversation, this.thinking);
    const totalAttempts = this.maxRetries + 1;

    for (let attempt = 1; ; attempt++) {
      await this.waitForSlot();
      const startedAt = performance.now();
      let response: TransportResponse;

      try {
        response = await this.callWithTimeout(request);
      } catch (e) {
        const requestedDelay = retryDelayMsOf(e);
        // Si Google pide esperar más que el tope (cuota diaria: "retry in 8h"), reintentar solo
        // quema tiempo: se falla de inmediato con un error que el batch reconoce.
        const quotaExhausted =
          statusOf(e) === 429 && requestedDelay !== undefined && requestedDelay > this.maxRetryDelayMs;
        const error = quotaExhausted
          ? new LlmClientError(
              "quota_exhausted",
              `Cuota de Gemini agotada: Google pide esperar ${formatDuration(requestedDelay)}. ${errorText(e)}`,
              { attempts: attempt, status: 429 },
            )
          : toLlmError(e, attempt, this.timeoutMs);
        this.logCall(conversation.id, attempt, startedAt, undefined, error);

        if (quotaExhausted || !isRetryable(error.details.status) || attempt >= totalAttempts) {
          return { ok: false, error };
        }
        // Backoff exponencial, pero nunca menos de lo que Google pide en RetryInfo.
        const backoff = this.baseDelayMs * 2 ** (attempt - 1);
        await this.sleep(Math.max(backoff, requestedDelay ?? 0));
        continue;
      }

      // La llamada costó tokens aunque la respuesta resulte inválida: se registra siempre.
      this.logCall(conversation.id, attempt, startedAt, response.usageMetadata);
      return interpretResponse(response, conversation, attempt);
    }
  }

  /** Reserva el próximo turno (sincrónicamente, así es seguro con llamadas concurrentes) y espera hasta él. */
  private async waitForSlot(): Promise<void> {
    if (this.minIntervalMs === 0) return;
    const now = this.now();
    const slot = Math.max(now, this.nextSlotAt);
    this.nextSlotAt = slot + this.minIntervalMs;
    if (slot > now) await this.sleep(slot - now);
  }

  private async callWithTimeout(request: GeminiRequest): Promise<TransportResponse> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new TimeoutError(this.timeoutMs));
      }, this.timeoutMs);
    });

    try {
      // race: el timeout gana aunque el transporte ignore el AbortSignal.
      return await Promise.race([this.transport(request, { signal: controller.signal }), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private logCall(
    conversationId: string,
    attempt: number,
    startedAt: number,
    usage: UsageMetadataLike | undefined,
    error?: LlmClientError,
  ): void {
    const entry: LlmCallLogEntry = {
      conversation_id: conversationId,
      promptTokens: usage?.promptTokenCount ?? null,
      candidateTokens: usage?.candidatesTokenCount ?? null,
      totalTokens: usage?.totalTokenCount ?? null,
      ...(usage?.thoughtsTokenCount !== undefined && { thoughtsTokens: usage.thoughtsTokenCount }),
      latencyMs: Math.round(performance.now() - startedAt),
      attempt,
      ...(error && { error: error.kind, ...(error.details.status !== undefined && { status: error.details.status }) }),
    };
    if (error) this.logger.warn(entry, "gemini.generateContent failed");
    else this.logger.info(entry, "gemini.generateContent");

    try {
      this.onCall?.(entry);
    } catch (e) {
      // Un fallo del acumulador de métricas no debe romper el análisis.
      this.logger.error({ err: e }, "onCall falló");
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Funciones puras (exportadas para reutilizar en mocks y tests)
// ─────────────────────────────────────────────────────────────────────────────

export function buildRequest(conversation: Conversation, thinking?: ThinkingConfig): GeminiRequest {
  const generationConfig: GenerationConfigWithThinking =
    thinking === undefined ? GENERATION_CONFIG : { ...GENERATION_CONFIG, thinkingConfig: thinking };
  return {
    systemInstruction: SYSTEM_PROMPT,
    contents: [{ role: "user", parts: [{ text: formatConversation(conversation) }] }],
    generationConfig,
  };
}

/**
 * Texto del LLM → Result validado. Comprueba esquema (parseLlmJson) y que el
 * conversation_id devuelto sea el de la conversación pedida.
 */
export function interpretLlmText(
  text: string,
  conversation: Conversation,
  attempts = 1,
): Result<RawLlmOutput, LlmClientError> {
  if (text.trim() === "") {
    return { ok: false, error: new LlmClientError("empty_response", "Gemini devolvió una respuesta vacía", { attempts }) };
  }

  const parsed = parseLlmJson(text);
  if (!parsed.ok) {
    return {
      ok: false,
      error: new LlmClientError("parse", `Respuesta inválida (${parsed.error.message}). Texto crudo: ${text}`, {
        attempts,
        raw: text,
      }),
    };
  }

  if (parsed.value.conversation_id !== conversation.id) {
    return {
      ok: false,
      error: new LlmClientError(
        "conversation_id_mismatch",
        `conversation_id esperado "${conversation.id}", recibido "${parsed.value.conversation_id}"`,
        { attempts, raw: text },
      ),
    };
  }

  return { ok: true, value: parsed.value };
}

function interpretResponse(
  response: TransportResponse,
  conversation: Conversation,
  attempts: number,
): Result<RawLlmOutput, LlmClientError> {
  const blockReason = response.promptFeedback?.blockReason;
  if (blockReason) {
    return { ok: false, error: new LlmClientError("blocked", `Prompt bloqueado por Gemini: ${blockReason}`, { attempts }) };
  }

  let text: string;
  try {
    text = response.text();
  } catch (e) {
    // El SDK lanza en text() si el candidato terminó por SAFETY/RECITATION/etc.
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: new LlmClientError("blocked", `Respuesta sin texto utilizable: ${msg}`, { attempts }) };
  }

  if (response.candidates?.[0]?.finishReason === "MAX_TOKENS") {
    return {
      ok: false,
      error: new LlmClientError(
        "max_tokens",
        `Respuesta truncada por maxOutputTokens=${GENERATION_CONFIG.maxOutputTokens}. Texto crudo: ${text}`,
        { attempts, raw: text },
      ),
    };
  }

  return interpretLlmText(text, conversation, attempts);
}

// ─────────────────────────────────────────────────────────────────────────────
// Internos
// ─────────────────────────────────────────────────────────────────────────────

class TimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Gemini no respondió en ${timeoutMs} ms`);
  }
}

/** Solo 429 y 5xx. Timeouts, errores de red y otros 4xx no se reintentan. */
function isRetryable(status: number | undefined): boolean {
  return status === 429 || (status !== undefined && status >= 500 && status <= 599);
}

/**
 * Espera que pide Google en un 429, leída de errorDetails → RetryInfo.retryDelay ("28s", "28.9s").
 * undefined si no viene.
 */
export function retryDelayMsOf(e: unknown): number | undefined {
  for (const d of errorDetailsOf(e)) {
    const type = (d as { "@type"?: unknown })?.["@type"];
    const delay = (d as { retryDelay?: unknown })?.retryDelay;
    if (typeof type === "string" && type.endsWith("RetryInfo") && typeof delay === "string") {
      const seconds = Number.parseFloat(delay);
      if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
    }
  }
  return undefined;
}

/**
 * `details` del error de Google. @google/genai (ApiError) los trae dentro de
 * `message`, que es el cuerpo JSON de la respuesta:
 *   {"error":{"code":429,"message":"...","details":[{"@type":"...RetryInfo","retryDelay":"28s"}]}}
 * Se acepta también `errorDetails` (formato del SDK anterior) por compatibilidad.
 */
function errorDetailsOf(e: unknown): readonly unknown[] {
  const legacy = (e as { errorDetails?: unknown } | null)?.errorDetails;
  if (Array.isArray(legacy)) return legacy;

  const message = (e as { message?: unknown } | null)?.message;
  if (typeof message !== "string" || !message.trimStart().startsWith("{")) return [];
  try {
    const details = (JSON.parse(message) as { error?: { details?: unknown } }).error?.details;
    return Array.isArray(details) ? details : [];
  } catch {
    return [];
  }
}

function statusOf(e: unknown): number | undefined {
  // ApiError de @google/genai expone `status`; duck typing para no depender de la clase.
  const status = (e as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : undefined;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function formatDuration(ms: number): string {
  const totalMin = Math.round(ms / 60_000);
  if (totalMin < 60) return `${Math.max(1, totalMin)} min`;
  return `${Math.floor(totalMin / 60)} h ${totalMin % 60} min`;
}

function toLlmError(e: unknown, attempt: number, timeoutMs: number): LlmClientError {
  if (e instanceof TimeoutError) {
    return new LlmClientError("timeout", e.message, { attempts: attempt });
  }
  const status = statusOf(e);
  const message = e instanceof Error ? e.message : String(e);
  return status !== undefined
    ? new LlmClientError("http", `Gemini HTTP ${status}: ${message}`, { attempts: attempt, status })
    : new LlmClientError("network", `Error llamando a Gemini (timeout ${timeoutMs} ms): ${message}`, {
        attempts: attempt,
      });
}

function createSdkTransport(apiKey: string, model: string): GenerateContentTransport {
  if (!isSystemPromptConfigured()) {
    throw new Error("SYSTEM_PROMPT no configurado: pega el prompt literal en src/llm/prompt.ts antes de llamar a Gemini.");
  }
  if (!apiKey) throw new Error("GEMINI_API_KEY vacío");
  if (!model) throw new Error("GEMINI_MODEL vacío");

  // @google/genai: un cliente por proceso; el modelo va en cada llamada.
  // La API key se envía en el header x-goog-api-key (igual que el SDK anterior).
  const ai = new GoogleGenAI({ apiKey });

  return async (request, { signal }) => {
    const { thinkingConfig, ...generation } = request.generationConfig;
    const config: GenerateContentConfig = {
      ...generation, // temperature, topP, maxOutputTokens, responseMimeType, responseSchema
      systemInstruction: request.systemInstruction,
      abortSignal: signal,
      ...(thinkingConfig && { thinkingConfig: toSdkThinkingConfig(thinkingConfig) }),
    };

    const response = await ai.models.generateContent({ model, contents: request.contents, config });

    return {
      // En @google/genai `text` es un getter (no una función) y puede ser undefined.
      text: () => response.text ?? "",
      ...(response.candidates && { candidates: response.candidates }),
      ...(response.promptFeedback && { promptFeedback: response.promptFeedback }),
      ...(response.usageMetadata && { usageMetadata: response.usageMetadata }),
    };
  };
}

/** Nuestro formato ("low") → enum del SDK ("LOW"). */
function toSdkThinkingConfig(thinking: ThinkingConfig): SdkThinkingConfig {
  return "thinkingLevel" in thinking
    ? { thinkingLevel: thinking.thinkingLevel.toUpperCase() as SdkThinkingLevel }
    : { thinkingBudget: thinking.thinkingBudget };
}
