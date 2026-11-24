/**
 * Motivos legibles de por qué un modelo no respondió y se pasó al siguiente de la cadena.
 * Se guardan en `usage.skipped` de cada evento y el panel los muestra bajo la actividad.
 * (Módulo sin "server-only" para poder probarlo aparte; no lee claves.)
 */

/** Saca el `message` de un error JSON de la API (Gemini y Groq lo devuelven así); si no, el texto tal cual. */
export function apiMessage(raw: string | undefined): string {
  const text = raw ?? "";
  try {
    const parsed = JSON.parse(text.slice(text.indexOf("{")));
    const m = parsed?.error?.message ?? parsed?.message;
    if (typeof m === "string") return m;
  } catch {}
  return text;
}

const short = (s: string, max = 90) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

/** 429: distingue cuota diaria de límite por minuto y, si la API lo dice, cuándo reintentar. */
export function rateLimitReason(raw: string | undefined): string {
  const t = raw ?? "";
  const scope = /per ?day|PerDay|\bRPD\b|\bTPD\b|daily/i.test(t)
    ? "cuota diaria agotada"
    : /per ?minute|PerMinute|\bRPM\b|\bTPM\b/i.test(t)
      ? "límite por minuto"
      : "límite de peticiones";
  const retry = t.match(/(?:retry|try again)\s+(?:in|after)\s+([\d.]+)\s*(ms|s|m)?/i);
  const wait = retry ? `, reintentar en ${Math.ceil(Number(retry[1]))} ${retry[2] ?? "s"}` : "";
  return `429 · ${scope}${wait}`;
}

/** 5xx: el código y, traducido si es el caso típico, el motivo que da la API. */
export function serverErrorReason(status: number, raw: string | undefined): string {
  const m = apiMessage(raw);
  const why = /overload|high demand|unavailable|capacity/i.test(m)
    ? "modelo sobrecargado"
    : /internal/i.test(m)
      ? "error interno del proveedor"
      : /deadline|timeout/i.test(m)
        ? "tardó demasiado en el proveedor"
        : short(m, 70);
  return `saturado (HTTP ${status}${why ? `: ${why}` : ""})`;
}

/** Gemini terminó la respuesta por un motivo que no es STOP. */
export function finishReason(finish: string): string {
  const map: Record<string, string> = {
    MAX_TOKENS: "respuesta cortada por longitud máxima",
    SAFETY: "bloqueada por el filtro de seguridad",
    RECITATION: "bloqueada por posible texto con copyright",
    PROHIBITED_CONTENT: "bloqueada por contenido prohibido",
    MALFORMED_FUNCTION_CALL: "respuesta mal formada",
  };
  return map[finish] ?? `terminó sin respuesta válida (${finish})`;
}

/** Separa «modelo: motivo» (formato de `usage.skipped`) para pintarlo en el panel. */
export function splitSkipped(entry: string): { model: string; reason: string } {
  const i = entry.indexOf(": ");
  return i === -1 ? { model: entry, reason: "" } : { model: entry.slice(0, i), reason: entry.slice(i + 2) };
}
