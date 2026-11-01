/**
 * Cache en memoria de análisis: misma conversación → mismo resultado, sin
 * volver a pagar la llamada al LLM.
 *
 * Clave: SHA-256 del texto normalizado de la conversación (autor + texto de
 * cada turno, en orden). NO incluye el id: la misma conversación reenviada
 * con otro id es un hit, y el resultado se devuelve con el id nuevo.
 *
 * Acotado a `maxEntries` (se descarta el más antiguo) para no crecer sin
 * límite. Se pierde al reiniciar el proceso.
 */
import { createHash } from "node:crypto";
import type { Conversation } from "./schema.js";
import { normalize } from "./validateEvidence.js";

export function conversationCacheKey(conversation: Conversation): string {
  const canonical = conversation.mensajes.map((m) => `${m.de}:${normalize(m.texto)}`).join("\n");
  return createHash("sha256").update(canonical).digest("hex");
}

export class AnalysisCache<T> {
  private readonly entries = new Map<string, T>();

  constructor(private readonly maxEntries = 1_000) {}

  get(key: string): T | undefined {
    const value = this.entries.get(key);
    // Copia: quien la reciba puede mutarla sin corromper la cache.
    return value === undefined ? undefined : structuredClone(value);
  }

  set(key: string, value: T): void {
    this.entries.delete(key);
    this.entries.set(key, structuredClone(value));
    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}
