/**
 * Punto de entrada del servidor HTTP (npm run dev / npm start).
 * El procesamiento de archivos está en src/batch.ts (npm run batch).
 *
 * Falla rápido si falta configuración. No llama a Gemini al arrancar: el
 * servidor levanta aunque la API esté caída (solo /analyze* responde 502).
 */
import dotenv from "dotenv";
import { pino } from "pino";
import { z } from "zod";
import { geminiOptionsFromEnv } from "./config.js";
import { GeminiClient } from "./llm/geminiClient.js";
import { CostTracker } from "./metrics.js";
import { createApp } from "./server.js";

dotenv.config({ quiet: true });

const logger = pino({ name: "inmo-analyzer", level: process.env.LOG_LEVEL ?? "info" });

const required = (name: string) => z.string({ error: `${name} es obligatorio` }).trim().min(1, `${name} está vacío`);

const EnvSchema = z.object({
  GEMINI_API_KEY: required("GEMINI_API_KEY"),
  GEMINI_MODEL: required("GEMINI_MODEL"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
});

function loadEnv() {
  const env = EnvSchema.safeParse(process.env);
  if (!env.success) {
    logger.fatal({ issues: env.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, "Configuración inválida (revisa .env)");
    process.exit(1);
  }
  return env.data;
}

function main(): void {
  const env = loadEnv();
  const costs = new CostTracker();

  let llm: GeminiClient;
  try {
    llm = new GeminiClient(env.GEMINI_API_KEY, env.GEMINI_MODEL, {
      ...geminiOptionsFromEnv(),
      logger,
      onCall: costs.recordCall,
    });
  } catch (e) {
    logger.fatal({ err: e instanceof Error ? e.message : e }, "No se pudo crear el cliente de Gemini");
    process.exit(1);
  }

  const server = createApp({ llm, logger, costs }).listen(env.PORT, () => {
    logger.info({ port: env.PORT, model: env.GEMINI_MODEL }, "servidor escuchando");
  });
  server.on("error", (err) => {
    logger.fatal({ err }, "no se pudo abrir el puerto");
    process.exit(1);
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, "cerrando servidor");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main();
