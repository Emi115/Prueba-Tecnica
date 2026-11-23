import "server-only";
import { ApiError, GoogleGenAI } from "@google/genai";
import { z } from "zod";

export const MODEL = process.env.GEMINI_MODEL ?? "gemini-3.1-flash-lite";

/** Sin clave (o con AGENTS_MOCK=1) los agentes usan respuestas simuladas deterministas. */
// El valor de ejemplo de .env.example cuenta como "sin clave".
export const isMock = () =>
  !process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY.includes("ejemplo") || process.env.AGENTS_MOCK === "1";

/** Gemini devolvió 429 (cuota o límite de peticiones agotado). El motor lo trata aparte. */
export class RateLimitError extends Error {
  constructor() {
    super(
      "Gemini ha devuelto 429: se ha agotado la cuota o el límite de peticiones por minuto de GEMINI_API_KEY. " +
        "Espera un minuto y pulsa «Reanudar», o revisa la cuota en Google AI Studio.",
    );
    this.name = "RateLimitError";
  }
}

/** Clave inválida o sin permisos: reintentar no sirve, el motor detiene la ejecución al momento. */
export class ConfigError extends Error {
  constructor(detail: string) {
    super(
      `GEMINI_API_KEY no es válida (${detail}). Revisa la variable en el servidor (Vercel → Settings → ` +
        "Environment Variables): solo la clave, sin comillas ni espacios, y vuelve a desplegar.",
    );
    this.name = "ConfigError";
  }
}

let client: GoogleGenAI | null = null;

/** Tolera errores típicos al pegar la clave: espacios, saltos de línea y comillas. */
const apiKey = () => process.env.GEMINI_API_KEY?.trim().replace(/^["']|["']$/g, "");

/** Mismo esquema zod → JSON Schema para Gemini (sin la clave "$schema", que la API no necesita). */
function jsonSchema(schema: z.ZodType) {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
}

export interface LlmUsage {
  input_tokens: number;
  output_tokens: number;
  model: string;
}

/**
 * Una llamada a Gemini con salida JSON validada con zod.
 * Cada agente es exactamente esto: un system prompt propio + un esquema de salida.
 * La clave se lee aquí (módulo "server-only"), nunca llega al navegador.
 */
export async function structured<S extends z.ZodType>(opts: {
  schema: S;
  system: string;
  prompt: string;
  maxTokens?: number;
}): Promise<{ data: z.infer<S>; usage: LlmUsage }> {
  client ??= new GoogleGenAI({
    apiKey: apiKey(),
    // El SDK reintenta 429 por defecto: lo limitamos a 5xx/timeouts (1 reintento).
    // Los 429 se convierten en RateLimitError y el motor decide (con tope) cuándo reintentar.
    httpOptions: {
      timeout: 240_000,
      retryOptions: { attempts: 2, initialDelay: 2, maxDelay: 8, httpStatusCodes: [408, 500, 502, 503, 504] },
    },
  });

  let response;
  try {
    response = await client.models.generateContent({
      model: MODEL,
      contents: opts.prompt,
      config: {
        systemInstruction: opts.system,
        responseMimeType: "application/json",
        responseJsonSchema: jsonSchema(opts.schema),
        maxOutputTokens: opts.maxTokens ?? 16000,
      },
    });
  } catch (err) {
    if (err instanceof ApiError && err.status === 429) throw new RateLimitError();
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
      throw new ConfigError(`HTTP ${err.status}`);
    }
    if (err instanceof ApiError && err.status === 400 && /api key/i.test(err.message)) {
      throw new ConfigError("Google responde «API key not valid»");
    }
    throw err;
  }

  const finish = response.candidates?.[0]?.finishReason;
  if (finish === "MAX_TOKENS") throw new Error("La respuesta de Gemini se cortó por longitud máxima");
  if (finish && finish !== "STOP") throw new Error(`Gemini terminó sin respuesta válida (${finish})`);

  let json: unknown;
  try {
    json = JSON.parse(response.text ?? "");
  } catch {
    throw new Error("Gemini no devolvió JSON válido");
  }
  const parsed = opts.schema.safeParse(json);
  if (!parsed.success) throw new Error(`El JSON de Gemini no cumple el esquema: ${parsed.error.message.slice(0, 200)}`);

  return {
    data: parsed.data,
    usage: {
      input_tokens: response.usageMetadata?.promptTokenCount ?? 0,
      output_tokens: response.usageMetadata?.candidatesTokenCount ?? 0,
      model: MODEL,
    },
  };
}
