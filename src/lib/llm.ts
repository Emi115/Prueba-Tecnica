import "server-only";
import { ApiError, GoogleGenAI } from "@google/genai";
import { z } from "zod";

/* ------------------------------------------------------------------
 * Cadena de modelos con respaldo
 *   1. Gemini principal  (GEMINI_MODEL, por defecto gemini-3.1-flash-lite)
 *   2. Gemini de respaldo (GEMINI_FALLBACK_MODEL, por defecto gemini-flash-latest; "none" lo desactiva)
 *   3. Groq               (solo si hay GROQ_API_KEY; GROQ_MODEL, por defecto openai/gpt-oss-120b)
 *   4. Mistral            (solo si hay MISTRAL_API_KEY; MISTRAL_MODEL, por defecto mistral-small-latest)
 * Solo se pasa al siguiente si el fallo es temporal (saturado, sin respuesta, 429 o modelo no
 * disponible). Una clave inválida detiene la ejecución: reintentar con otro modelo la ocultaría.
 * ------------------------------------------------------------------ */

export const MODEL = process.env.GEMINI_MODEL ?? "gemini-3.1-flash-lite";
// Alias oficial que Google mantiene apuntando al Flash estable más reciente: no caduca como
// los modelos con versión (gemini-2.5-flash-lite ya devuelve 404) y tiene capacidad aparte de Flash-Lite.
const GEMINI_FALLBACK = process.env.GEMINI_FALLBACK_MODEL ?? "gemini-flash-latest";
const GROQ_MODEL = process.env.GROQ_MODEL ?? "openai/gpt-oss-120b";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MISTRAL_MODEL = process.env.MISTRAL_MODEL ?? "mistral-small-latest";
const MISTRAL_URL = "https://api.mistral.ai/v1/chat/completions";

/** Sin clave (o con AGENTS_MOCK=1) los agentes usan respuestas simuladas deterministas. */
// El valor de ejemplo de .env.example cuenta como "sin clave".
export const isMock = () =>
  !process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY.includes("ejemplo") || process.env.AGENTS_MOCK === "1";

/** Tolera errores típicos al pegar la clave: espacios, saltos de línea y comillas. */
const cleanKey = (v: string | undefined) => v?.trim().replace(/^["']|["']$/g, "") || undefined;
const geminiKey = () => cleanKey(process.env.GEMINI_API_KEY);
/** Claves opcionales de los respaldos: vacías o con el valor de ejemplo cuentan como "sin clave". */
const optionalKey = (v: string | undefined) => {
  const k = cleanKey(v);
  return k && !k.includes("ejemplo") ? k : undefined;
};
const groqKey = () => optionalKey(process.env.GROQ_API_KEY);
const mistralKey = () => optionalKey(process.env.MISTRAL_API_KEY);

type Provider = "gemini" | "groq" | "mistral";

/** Proveedores con API compatible con OpenAI (chat/completions). */
const OPENAI_COMPAT = {
  groq: { name: "Groq", url: GROQ_URL, key: groqKey, env: "GROQ_API_KEY" },
  mistral: { name: "Mistral", url: MISTRAL_URL, key: mistralKey, env: "MISTRAL_API_KEY" },
} as const;
interface Slot {
  provider: Provider;
  model: string;
  /** Tiempo máximo por intento. */
  timeoutMs: number;
  /** Intentos dentro del propio slot (el SDK de Gemini reintenta 5xx). */
  attempts: number;
}

/**
 * Presupuesto de tiempo de un paso: 50 s × 2 + 35 s × 3 ≈ 215 s en el peor caso, por debajo
 * del lock (280 s) y del maxDuration de Vercel (300 s). Además, cada slot recorta su timeout
 * al tiempo que quede del presupuesto, así nunca se corta la función a medias.
 */
const STEP_BUDGET_MS = 230_000;

export function modelChain(): Slot[] {
  const chain: Slot[] = [{ provider: "gemini", model: MODEL, timeoutMs: 50_000, attempts: 2 }];
  if (GEMINI_FALLBACK !== "none" && GEMINI_FALLBACK !== MODEL) {
    chain.push({ provider: "gemini", model: GEMINI_FALLBACK, timeoutMs: 35_000, attempts: 1 });
  }
  if (groqKey()) chain.push({ provider: "groq", model: GROQ_MODEL, timeoutMs: 35_000, attempts: 1 });
  if (mistralKey()) chain.push({ provider: "mistral", model: MISTRAL_MODEL, timeoutMs: 35_000, attempts: 1 });
  return chain;
}

/** Nombres de los modelos de la cadena, para mostrarlos en el panel (sin claves). */
export const modelNames = () =>
  modelChain().map((s) => (s.provider === "gemini" ? s.model : `${s.provider}:${s.model}`));

/** Todos los modelos devolvieron 429 (cuota o límite de peticiones agotado). */
export class RateLimitError extends Error {
  constructor(detail = "") {
    super(
      "Límite de peticiones alcanzado (429) en todos los modelos disponibles" +
        (detail ? ` (${detail})` : "") +
        ". Espera un minuto y pulsa «Reanudar», o revisa la cuota en Google AI Studio / consolas de Groq y Mistral.",
    );
    this.name = "RateLimitError";
  }
}

/** Clave inválida o sin permisos: reintentar no sirve, el motor detiene la ejecución al momento. */
export class ConfigError extends Error {
  readonly variable: string;
  constructor(detail: string, variable = "GEMINI_API_KEY") {
    super(
      `${variable} no es válida (${detail}). Revisa la variable en el servidor (Vercel → Settings → ` +
        "Environment Variables): solo la clave, sin comillas ni espacios, y vuelve a desplegar.",
    );
    this.name = "ConfigError";
    this.variable = variable;
  }
}

/** Ninguna IA respondió (saturadas o sin respuesta a tiempo): es temporal, el motor reintenta con espera. */
export class GeminiBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeminiBusyError";
  }
}

/** Fallo temporal de un slot concreto: se pasa al siguiente modelo de la cadena. */
class SlotUnavailable extends Error {
  readonly kind: "rate_limit" | "busy";
  readonly short: string;
  constructor(kind: "rate_limit" | "busy", short: string) {
    super(short);
    this.kind = kind;
    this.short = short;
  }
}

/** Mismo esquema zod → JSON Schema para los modelos (sin la clave "$schema", que no hace falta). */
function jsonSchema(schema: z.ZodType) {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
}

export interface LlmUsage {
  input_tokens: number;
  output_tokens: number;
  model: string;
  provider: Provider;
  /** Modelos que fallaron antes de este (vacío si respondió el principal). */
  skipped?: string[];
}

interface CallOpts {
  schema: z.ZodType;
  system: string;
  prompt: string;
  maxTokens: number;
  timeoutMs: number;
}
interface RawResult {
  text: string;
  input_tokens: number;
  output_tokens: number;
}

/* ----------------------------- Gemini ----------------------------- */

const geminiClients = new Map<string, GoogleGenAI>();

function geminiClient(timeoutMs: number, attempts: number) {
  const key = `${timeoutMs}:${attempts}`;
  let c = geminiClients.get(key);
  if (!c) {
    c = new GoogleGenAI({
      apiKey: geminiKey(),
      // El SDK reintenta 429 por defecto: lo limitamos a 5xx/timeouts. Los 429 pasan al siguiente modelo.
      httpOptions: {
        timeout: timeoutMs,
        retryOptions: { attempts, initialDelay: 2, maxDelay: 8, httpStatusCodes: [408, 500, 502, 503, 504] },
      },
    });
    geminiClients.set(key, c);
  }
  return c;
}

async function callGemini(model: string, attempts: number, o: CallOpts): Promise<RawResult> {
  let response;
  try {
    response = await geminiClient(o.timeoutMs, attempts).models.generateContent({
      model,
      contents: o.prompt,
      config: {
        systemInstruction: o.system,
        responseMimeType: "application/json",
        responseJsonSchema: jsonSchema(o.schema),
        maxOutputTokens: o.maxTokens,
      },
    });
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.status === 429) throw new SlotUnavailable("rate_limit", "429");
      if (err.status === 401 || err.status === 403) throw new ConfigError(`HTTP ${err.status}`);
      if (err.status === 400 && /api key/i.test(err.message)) throw new ConfigError("Google responde «API key not valid»");
      if (err.status === 404) throw new SlotUnavailable("busy", "modelo no disponible (404)");
      if (err.status >= 500) throw new SlotUnavailable("busy", `saturado (HTTP ${err.status})`);
    }
    if (isTimeout(err)) throw new SlotUnavailable("busy", `sin respuesta en ${Math.round(o.timeoutMs / 1000)} s`);
    throw err;
  }

  const finish = response.candidates?.[0]?.finishReason;
  if (finish === "MAX_TOKENS") throw new Error("La respuesta de Gemini se cortó por longitud máxima");
  if (finish && finish !== "STOP") throw new Error(`Gemini terminó sin respuesta válida (${finish})`);
  return {
    text: response.text ?? "",
    input_tokens: response.usageMetadata?.promptTokenCount ?? 0,
    output_tokens: response.usageMetadata?.candidatesTokenCount ?? 0,
  };
}

/* ---------------------- Groq y Mistral ---------------------- */

/**
 * Groq y Mistral exponen una API compatible con OpenAI (chat/completions): basta con fetch,
 * sin librerías, y la misma función sirve para los dos.
 * El plan gratuito de Groq limita los tokens por minuto, así que ahí la salida se acota.
 */
async function callOpenAICompat(provider: "groq" | "mistral", model: string, o: CallOpts): Promise<RawResult> {
  const p = OPENAI_COMPAT[provider];
  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: o.system },
      { role: "user", content: o.prompt },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "respuesta", schema: jsonSchema(o.schema), strict: false },
    },
    temperature: 0.2,
  };
  if (provider === "groq") {
    body.max_completion_tokens = Math.min(o.maxTokens, 6000);
    if (model.startsWith("openai/gpt-oss")) body.reasoning_effort = "low";
  } else {
    body.max_tokens = o.maxTokens;
  }

  let res: Response;
  try {
    res = await fetch(p.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${p.key()}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(o.timeoutMs),
    });
  } catch (err) {
    if (isTimeout(err)) throw new SlotUnavailable("busy", `sin respuesta en ${Math.round(o.timeoutMs / 1000)} s`);
    throw new SlotUnavailable("busy", "no se pudo conectar");
  }

  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    if (res.status === 401 || res.status === 403) throw new ConfigError(`HTTP ${res.status}`, p.env);
    if (res.status === 429) throw new SlotUnavailable("rate_limit", "429");
    if (res.status === 413) throw new SlotUnavailable("busy", "petición demasiado grande para el plan gratuito (413)");
    if (res.status === 404) throw new SlotUnavailable("busy", "modelo no disponible (404)");
    if (res.status >= 500) throw new SlotUnavailable("busy", `saturado (HTTP ${res.status})`);
    // 400 por esquema/JSON (p. ej. json_validate_failed): mejor dar paso a reintentar que bloquear.
    throw new SlotUnavailable("busy", `respuesta no válida (HTTP ${res.status}${detail ? `: ${detail.slice(0, 120)}` : ""})`);
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string }; finish_reason?: string }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const choice = data.choices?.[0];
  if (choice?.finish_reason === "length") throw new SlotUnavailable("busy", "respuesta cortada por longitud");
  return {
    text: choice?.message?.content ?? "",
    input_tokens: data.usage?.prompt_tokens ?? 0,
    output_tokens: data.usage?.completion_tokens ?? 0,
  };
}

/* ----------------------------- común ------------------------------ */

function isTimeout(err: unknown) {
  const e = err as Error | undefined;
  return /abort|timed?\s?out|timeout/i.test(`${e?.name} ${e?.message}`);
}

const label = (s: Slot) => (s.provider === "gemini" ? s.model : `${OPENAI_COMPAT[s.provider].name} ${s.model}`);

/**
 * Una llamada al modelo con salida JSON validada con zod, con respaldo automático.
 * Cada agente es exactamente esto: un system prompt propio + un esquema de salida.
 * Las claves se leen aquí (módulo "server-only"), nunca llegan al navegador.
 */
export async function structured<S extends z.ZodType>(opts: {
  schema: S;
  system: string;
  prompt: string;
  maxTokens?: number;
}): Promise<{ data: z.infer<S>; usage: LlmUsage }> {
  const deadline = Date.now() + STEP_BUDGET_MS;
  const failures: { slot: Slot; kind: "rate_limit" | "busy"; short: string }[] = [];

  for (const slot of modelChain()) {
    const remaining = deadline - Date.now();
    if (remaining < 15_000) break; // no queda tiempo para otro intento útil
    const timeoutMs = Math.min(slot.timeoutMs, Math.floor(remaining / slot.attempts));
    const call: CallOpts = { ...opts, maxTokens: opts.maxTokens ?? 16000, timeoutMs };

    let raw: RawResult;
    try {
      raw =
        slot.provider === "gemini"
          ? await callGemini(slot.model, slot.attempts, call)
          : await callOpenAICompat(slot.provider, slot.model, call);
    } catch (err) {
      if (err instanceof SlotUnavailable) {
        failures.push({ slot, kind: err.kind, short: err.short });
        continue;
      }
      throw err;
    }

    let json: unknown;
    try {
      json = JSON.parse(raw.text);
    } catch {
      throw new Error(`${label(slot)} no devolvió JSON válido`);
    }
    const parsed = opts.schema.safeParse(json);
    if (!parsed.success) {
      throw new Error(`El JSON de ${label(slot)} no cumple el esquema: ${parsed.error.message.slice(0, 200)}`);
    }

    return {
      data: parsed.data,
      usage: {
        input_tokens: raw.input_tokens,
        output_tokens: raw.output_tokens,
        model: slot.model,
        provider: slot.provider,
        skipped: failures.map((f) => `${label(f.slot)}: ${f.short}`),
      },
    };
  }

  const summary = failures.map((f) => `${label(f.slot)}: ${f.short}`).join(" · ");
  if (failures.length && failures.every((f) => f.kind === "rate_limit")) throw new RateLimitError(summary);
  throw new GeminiBusyError(
    `Ninguna IA ha respondido ahora mismo (${summary || "sin tiempo para reintentar"}). Es temporal.`,
  );
}
