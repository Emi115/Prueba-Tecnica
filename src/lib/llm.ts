import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { ApiError, GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { apiMessage, finishReason, hasZeroQuota, NO_PLAN_HINT, rateLimitReason, serverErrorReason } from "./llm-errors";
import type { AiChoice } from "./types";

/* ------------------------------------------------------------------
 * Cadena de modelos con respaldo
 *   1. Gemini   (GEMINI_MODEL, por defecto gemini-3.1-flash-lite)
 *   2. Groq     (solo si hay GROQ_API_KEY; GROQ_MODEL, por defecto openai/gpt-oss-120b)
 *   3. OpenRouter (solo si hay OPENROUTER_API_KEY; OPENROUTER_MODEL, por defecto un modelo gratuito «:free»)
 * Solo se pasa al siguiente si el fallo es temporal (saturado, sin respuesta, 429 o modelo no
 * disponible). Una clave inválida detiene la ejecución: reintentar con otro modelo la ocultaría.
 * ------------------------------------------------------------------ */

export const MODEL = process.env.GEMINI_MODEL ?? "gemini-3.1-flash-lite";
const GROQ_MODEL = process.env.GROQ_MODEL ?? "openai/gpt-oss-120b";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
// Modelo gratuito («:free», sin tarjeta) que acepta salida con esquema JSON. La lista gratuita de OpenRouter
// cambia a menudo: si este desaparece (404), se cambia con OPENROUTER_MODEL sin tocar código.
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL ?? "nvidia/nemotron-3.5-super-vl:free";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

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
const openrouterKey = () => optionalKey(process.env.OPENROUTER_API_KEY);

type Provider = "gemini" | "groq" | "openrouter";
type CompatProvider = Exclude<Provider, "gemini">;

/** Proveedores con API compatible con OpenAI (chat/completions). */
const OPENAI_COMPAT = {
  groq: { name: "Groq", url: GROQ_URL, key: groqKey, env: "GROQ_API_KEY" },
  openrouter: { name: "OpenRouter", url: OPENROUTER_URL, key: openrouterKey, env: "OPENROUTER_API_KEY" },
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
 * Presupuesto de tiempo de un paso: 50 s × 2 + 35 s + 45 s ≈ 180 s en el peor caso, por debajo
 * del lock (280 s) y del maxDuration de Vercel (300 s). Además, cada slot recorta su timeout
 * al tiempo que quede del presupuesto, así nunca se corta la función a medias.
 */
const STEP_BUDGET_MS = 230_000;

/**
 * IA elegida para la petición en curso. El motor envuelve cada paso con `withAi`, así los tres
 * agentes la respetan sin tener que pasarla de función en función.
 */
const aiContext = new AsyncLocalStorage<AiChoice>();
export const withAi = <T>(choice: AiChoice, fn: () => Promise<T>) => aiContext.run(choice, fn);

/** IAs que se pueden elegir ahora mismo (Gemini siempre; Groq y OpenRouter solo si tienen clave). */
export function availableAis(): { id: Exclude<AiChoice, "auto">; name: string; model: string }[] {
  return [
    { id: "gemini" as const, name: "Gemini", model: MODEL },
    ...(groqKey() ? [{ id: "groq" as const, name: "Groq", model: GROQ_MODEL }] : []),
    ...(openrouterKey() ? [{ id: "openrouter" as const, name: "OpenRouter", model: OPENROUTER_MODEL }] : []),
  ];
}

export function modelChain(choice: AiChoice = aiContext.getStore() ?? "auto"): Slot[] {
  const chain: Slot[] = [{ provider: "gemini", model: MODEL, timeoutMs: 50_000, attempts: 2 }];
  if (groqKey()) chain.push({ provider: "groq", model: GROQ_MODEL, timeoutMs: 35_000, attempts: 1 });
  // Los modelos gratuitos de OpenRouter son más lentos: algo más de margen.
  if (openrouterKey()) chain.push({ provider: "openrouter", model: OPENROUTER_MODEL, timeoutMs: 45_000, attempts: 1 });
  // IA elegida a mano: solo esa, sin respaldo y con más margen de tiempo. Si ya no tiene clave, automático.
  const only = chain.find((s) => s.provider === choice);
  return only ? [{ ...only, timeoutMs: 50_000 }] : chain;
}

/** Nombres de los modelos de la cadena, para mostrarlos en el panel (sin claves). */
export const modelNames = (choice?: AiChoice) =>
  modelChain(choice).map((s) => (s.provider === "gemini" ? s.model : `${s.provider}:${s.model}`));

/** Todos los modelos devolvieron 429 (cuota o límite de peticiones agotado). */
export class RateLimitError extends Error {
  constructor(detail = "", chosen = false) {
    super(
      (chosen
        ? "Límite de peticiones alcanzado (429) en la IA elegida"
        : "Límite de peticiones alcanzado (429) en todos los modelos disponibles") +
        (detail ? ` (${detail})` : "") +
        (chosen
          ? ". Se reintentará solo; si sigue igual, crea la petición con otra IA o con «Automático»."
          : ". Espera un minuto y pulsa «Reanudar», o revisa la cuota en Google AI Studio / consolas de Groq y OpenRouter."),
    );
    this.name = "RateLimitError";
  }
}

/** Clave inválida o sin permisos: reintentar no sirve, el motor detiene la ejecución al momento. */
export class ConfigError extends Error {
  readonly variable: string;
  /** Resumen para la tarjeta del Orquestador («Detenido: …»). */
  readonly short: string;
  constructor(detail: string, variable = "GEMINI_API_KEY", custom?: { message: string; short: string }) {
    super(
      custom?.message ??
        `${variable} no es válida (${detail}). Revisa la variable en el servidor (Vercel → Settings → ` +
          "Environment Variables): solo la clave, sin comillas ni espacios, y vuelve a desplegar.",
    );
    this.name = "ConfigError";
    this.variable = variable;
    this.short = custom?.short ?? `${variable} no válida`;
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
/** «no_plan»: la cuenta del proveedor tiene límite 0 (plan no activado); no es temporal. */
type FailureKind = "rate_limit" | "busy" | "no_plan";

class SlotUnavailable extends Error {
  readonly kind: FailureKind;
  readonly short: string;
  constructor(kind: FailureKind, short: string) {
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
      if (err.status === 429) throw new SlotUnavailable("rate_limit", rateLimitReason(err.message));
      if (err.status === 401 || err.status === 403) throw new ConfigError(`HTTP ${err.status}`);
      if (err.status === 400 && /api key/i.test(err.message)) throw new ConfigError("Google responde «API key not valid»");
      if (err.status === 404) throw new SlotUnavailable("busy", "modelo no disponible (404)");
      if (err.status >= 500) throw new SlotUnavailable("busy", serverErrorReason(err.status, err.message));
    }
    if (isTimeout(err)) throw new SlotUnavailable("busy", `sin respuesta en ${Math.round(o.timeoutMs / 1000)} s`);
    throw err;
  }

  // Respuesta cortada o bloqueada: el mismo modelo probablemente repetiría, así que se pasa al siguiente.
  const finish = response.candidates?.[0]?.finishReason;
  if (finish && finish !== "STOP") throw new SlotUnavailable("busy", finishReason(finish));
  return {
    text: response.text ?? "",
    input_tokens: response.usageMetadata?.promptTokenCount ?? 0,
    output_tokens: response.usageMetadata?.candidatesTokenCount ?? 0,
  };
}

/* ---------------------- Groq y OpenRouter ---------------------- */

/**
 * Groq y OpenRouter exponen una API compatible con OpenAI (chat/completions): basta con fetch,
 * sin librerías, y la misma función sirve para los dos.
 * El plan gratuito de Groq limita los tokens por minuto, así que ahí la salida se acota.
 */
async function callOpenAICompat(provider: CompatProvider, model: string, o: CallOpts): Promise<RawResult> {
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
    // Solo proveedores de OpenRouter que respeten el esquema JSON (si no, ignorarían response_format).
    body.provider = { require_parameters: true };
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
    if (res.status === 429) {
      if (hasZeroQuota(res.headers)) throw new SlotUnavailable("no_plan", `429 · ${NO_PLAN_HINT[p.name]}`);
      throw new SlotUnavailable("rate_limit", rateLimitReason(detail));
    }
    if (res.status === 413) throw new SlotUnavailable("busy", "petición demasiado grande para el plan gratuito (413)");
    if (res.status === 404) throw new SlotUnavailable("busy", "modelo no disponible (404)");
    if (res.status >= 500) throw new SlotUnavailable("busy", serverErrorReason(res.status, detail));
    // 400 por esquema/JSON (p. ej. json_validate_failed): mejor dar paso a reintentar que bloquear.
    const msg = apiMessage(detail);
    throw new SlotUnavailable("busy", `respuesta no válida (HTTP ${res.status}${msg ? `: ${msg.slice(0, 120)}` : ""})`);
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string }; finish_reason?: string }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const choice = data.choices?.[0];
  if (choice?.finish_reason === "length") throw new SlotUnavailable("busy", finishReason("MAX_TOKENS"));
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
  const failures: { slot: Slot; kind: FailureKind; short: string }[] = [];

  const chain = modelChain();
  const chosen = (aiContext.getStore() ?? "auto") !== "auto" && chain.length === 1;
  for (const slot of chain) {
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
        // Plan sin peticiones en la IA elegida a mano: reintentar no sirve, se detiene con instrucciones.
        // En automático se salta esa IA y se sigue con la siguiente.
        if (err.kind === "no_plan" && chosen) {
          const p = OPENAI_COMPAT[slot.provider as CompatProvider];
          throw new ConfigError(err.short, p.env, {
            message: `${p.name} no puede responder: ${err.short.replace(/^429 · /, "")}. Mientras tanto, crea la petición con otra IA o con «Automático».`,
            short: `${p.name} sin plan activo`,
          });
        }
        failures.push({ slot, kind: err.kind, short: err.short });
        continue;
      }
      throw err;
    }

    // JSON roto o sin el formato pedido: también se pasa al siguiente modelo (reintentar con el mismo
    // suele repetir el fallo), y el motivo queda anotado para el panel.
    let json: unknown;
    try {
      json = JSON.parse(raw.text);
    } catch {
      failures.push({ slot, kind: "busy", short: raw.text.trim() ? "devolvió JSON no válido" : "respuesta vacía" });
      continue;
    }
    const parsed = opts.schema.safeParse(json);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue?.path.length ? ` en «${issue.path.join(".")}»` : "";
      failures.push({ slot, kind: "busy", short: `JSON sin el formato pedido${where}` });
      continue;
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
  if (failures.length && failures.every((f) => f.kind === "rate_limit")) throw new RateLimitError(summary, chosen);
  throw new GeminiBusyError(
    `Ninguna IA ha dado una respuesta válida ahora mismo (${summary || "sin tiempo para reintentar"}). Es temporal.`,
  );
}
