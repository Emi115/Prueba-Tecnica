"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AGENTS, RUN_STATUS } from "@/components/ui";
import type { AgentId, AiChoice, RunStatus } from "@/lib/types";

interface AiInfo {
  mock: boolean;
  /** Cadena automática, p. ej. ["gemini-3.1-flash-lite", "groq:openai/gpt-oss-120b", …]. */
  auto: string[];
  options: { id: Exclude<AiChoice, "auto">; name: string; model: string }[];
}

/** Mismos colores que las etiquetas de IA del panel. */
const AI_DOT: Record<AiChoice, string> = {
  auto: "bg-gradient-to-br from-sky-500 via-orange-500 to-indigo-500",
  gemini: "bg-sky-500",
  groq: "bg-orange-500",
  openrouter: "bg-indigo-500",
};

/** «openrouter:nvidia/nemotron-3.5-super-vl:free» → «nemotron-3.5-super-vl» (quita proveedor, empresa y «:free»). */
const shortModel = (m: string) =>
  m
    .replace(/^[a-z]+:/, "")
    .split("/")
    .pop()!
    .replace(/:free$/, "")
    .replace(/^gemini-/, "");

/**
 * Eliminar una petición en dos pasos: el primer clic pide confirmación («¿Eliminar?») y el segundo borra.
 * Si no se confirma en 4 s, vuelve a su estado normal.
 */
function DeleteRunButton({ id, onDeleted }: { id: string; onDeleted: () => void }) {
  const [state, setState] = useState<"idle" | "confirm" | "deleting" | "error">("idle");

  useEffect(() => {
    if (state !== "confirm" && state !== "error") return;
    const t = setTimeout(() => setState("idle"), 4000);
    return () => clearTimeout(t);
  }, [state]);

  async function click() {
    if (state === "idle" || state === "error") return setState("confirm");
    if (state !== "confirm") return;
    setState("deleting");
    const res = await fetch(`/api/runs/${id}`, { method: "DELETE" }).catch(() => null);
    // 404: ya no existía (p. ej. borrada desde otra pestaña); también se quita de la lista.
    if (res && (res.ok || res.status === 404)) onDeleted();
    else setState("error");
  }

  const label =
    state === "confirm" ? "¿Eliminar?" : state === "deleting" ? "Eliminando…" : state === "error" ? "Error, reintenta" : null;

  return (
    <button
      type="button"
      onClick={click}
      disabled={state === "deleting"}
      aria-label={label ?? "Eliminar petición"}
      title="Eliminar esta petición"
      className={`mr-2 inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-lg px-2 text-xs transition-colors disabled:opacity-60 ${
        label
          ? "bg-red-600 font-medium text-white hover:bg-red-500"
          : "text-subtle hover:bg-red-500/10 hover:text-red-700 dark:hover:text-red-300"
      }`}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden>
        <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
        <path d="M10 11v6M14 11v6" />
      </svg>
      {label}
    </button>
  );
}

function AiPicker({ value, onChange, info }: { value: AiChoice; onChange: (v: AiChoice) => void; info: AiInfo | null }) {
  const options: { id: AiChoice; name: string }[] = [{ id: "auto", name: "Automático" }, ...(info?.options ?? [])];
  const chosen = info?.options.find((o) => o.id === value);
  const [first, ...rest] = (info?.auto ?? ["Gemini"]).map(shortModel);
  const hint = chosen
    ? `Solo ${chosen.name} (${shortModel(chosen.model)}), sin respaldo: si falla, se espera y se reintenta con la misma.`
    : rest.length
      ? `Empieza con ${first}; si falla, pasa a ${rest.join(" y luego a ")}.`
      : `Usa ${first} (no hay IAs de respaldo configuradas).`;
  return (
    <fieldset className="mt-4">
      <legend className="text-sm font-medium text-fg">IA</legend>
      <div className="mt-2 inline-flex flex-wrap gap-1 rounded-xl border border-line bg-bg p-1" role="radiogroup">
        {options.map((o) => (
          <label
            key={o.id}
            className={`flex cursor-pointer items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-violet-500/60 ${
              value === o.id ? "bg-surface text-fg shadow-sm" : "text-muted hover:text-fg"
            }`}
          >
            <input
              type="radio"
              name="ai"
              value={o.id}
              checked={value === o.id}
              onChange={() => onChange(o.id)}
              className="sr-only"
            />
            <span className={`h-2 w-2 rounded-full ${AI_DOT[o.id]}`} aria-hidden />
            {o.name}
          </label>
        ))}
      </div>
      <p className="mt-1.5 text-xs text-subtle">
        {hint}
        {info?.mock && " (Ahora en modo simulado: los agentes no llaman a ninguna IA.)"}
      </p>
    </fieldset>
  );
}

const EXAMPLES = [
  "Añade una página de contacto a esta web",
  "Añade una página de carta con precios de los productos",
  "Añade un pie de página con horario y redes sociales en todas las páginas",
];

interface RunRow {
  id: string;
  request: string;
  status: RunStatus;
  created_at: string;
  total: number;
  passed: number;
  /** Llamadas reales a la IA (0 en modo simulado). */
  ai_calls: number;
}

export default function Home() {
  const router = useRouter();
  // Empieza vacío: el ejemplo va como placeholder para no lanzar algo que el usuario no ha escrito.
  const [request, setRequest] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runs, setRuns] = useState<RunRow[] | null>(null);
  const [ai, setAi] = useState<AiChoice>("auto");
  const [aiInfo, setAiInfo] = useState<AiInfo | null>(null);

  useEffect(() => {
    fetch("/api/runs")
      .then((r) => (r.ok ? r.json() : []))
      .then(setRuns)
      .catch(() => setRuns([]));
    fetch("/api/ai")
      .then((r) => (r.ok ? r.json() : null))
      .then(setAiInfo)
      .catch(() => setAiInfo(null));
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request, ai }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(body.error ?? "No se pudo crear la petición");
      setBusy(false);
      return;
    }
    router.push(`/runs/${body.id}`);
  }

  return (
    <main className="mx-auto max-w-3xl px-4 py-12 sm:py-16">
      <ol className="flex flex-wrap items-center gap-x-2 gap-y-2 text-xs font-medium" aria-label="Flujo de trabajo">
        {(Object.keys(AGENTS) as AgentId[]).map((a, i) => (
          <li key={a} className="flex items-center gap-2">
            {i > 0 && <span className="text-faint" aria-hidden>→</span>}
            <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-1 shadow-sm">
              <span className={`h-2 w-2 rounded-full ${AGENTS[a].color}`} />
              <span className={AGENTS[a].text}>{AGENTS[a].name}</span>
            </span>
          </li>
        ))}
      </ol>
      <h1 className="mt-5 text-balance text-3xl font-semibold tracking-tight sm:text-5xl">Un equipo de 3 agentes de IA</h1>
      <p className="mt-3 max-w-xl text-muted">
        Pide un cambio para la web de ejemplo (una panadería). El <span className="text-violet-700 dark:text-violet-300">Orquestador</span>{" "}
        lo divide en tareas, <span className="text-sky-700 dark:text-sky-300">Develop</span> las programa y{" "}
        <span className="text-amber-700 dark:text-amber-300">Testing</span> las prueba y le devuelve lo que falla hasta que todo pasa.
      </p>
      <a
        href="/preview/original/index.html"
        target="_blank"
        rel="noopener"
        className="mt-4 inline-flex items-center gap-1.5 rounded-full border border-line-strong px-3 py-1.5 text-sm text-fg hover:bg-surface-2"
      >
        Ver la web original ↗
      </a>

      <form onSubmit={submit} className="mt-8 card rounded-2xl p-4">
        <label htmlFor="req" className="text-sm font-medium text-fg">
          Petición
        </label>
        <textarea
          id="req"
          value={request}
          onChange={(e) => setRequest(e.target.value)}
          placeholder={`Ej.: ${EXAMPLES[0]}`}
          rows={3}
          maxLength={500}
          className="mt-2 w-full resize-none rounded-xl border border-line bg-bg p-3 text-base outline-none placeholder:text-faint focus:border-violet-500/70"
        />
        <p className="mt-2 text-xs text-subtle">Ejemplos (pulsa uno para escribirlo en la petición):</p>
        <div className="mt-1.5 flex flex-wrap gap-2">
          {EXAMPLES.map((ex) => (
            <button
              type="button"
              key={ex}
              onClick={() => setRequest(ex)}
              className="rounded-full border border-line px-3 py-1 text-xs text-muted hover:border-line-strong hover:text-fg"
            >
              {ex}
            </button>
          ))}
        </div>
        <AiPicker value={ai} onChange={setAi} info={aiInfo} />
        <div className="mt-4 flex items-center justify-between gap-3">
          {error ? <p className="text-sm text-red-700 dark:text-red-300">{error}</p> : <span />}
          <button
            disabled={busy || request.trim().length < 5}
            className="rounded-xl bg-violet-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm shadow-violet-600/30 transition-[transform,opacity,background-color] hover:bg-violet-500 active:scale-[0.97] disabled:opacity-50 disabled:shadow-none"
          >
            {busy ? "Creando…" : "Lanzar equipo"}
          </button>
        </div>
      </form>

      <section className="mt-12">
        <h2 className="text-sm font-medium text-muted">Peticiones recientes</h2>
        <ul className="mt-3 card divide-y divide-line overflow-hidden rounded-2xl">
          {runs === null && <li className="p-4 text-sm text-subtle">Cargando…</li>}
          {runs?.length === 0 && <li className="p-4 text-sm text-subtle">Aún no hay peticiones.</li>}
          {runs?.map((r) => (
            <li key={r.id} className="group relative flex items-center hover:bg-surface-2">
              {/*
                En móvil la petición ocupa la primera línea (dejando hueco a la derecha para «Ver web» y eliminar,
                que pasan a la esquina superior) y los datos van debajo usando todo el ancho de la fila.
              */}
              <Link
                href={`/runs/${r.id}`}
                className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 p-4 sm:flex-nowrap"
              >
                <span className="min-w-0 flex-1 truncate max-sm:basis-full max-sm:pr-28">{r.request}</span>
                <span className="whitespace-nowrap font-mono text-xs text-subtle">
                  {r.passed}/{r.total}
                </span>
                {r.ai_calls > 0 && (
                  <span className="whitespace-nowrap text-xs text-subtle" title="Llamadas a la IA que gastó esta petición">
                    {r.ai_calls} {r.ai_calls === 1 ? "llamada" : "llamadas"}
                    <span className="sr-only"> a la IA</span>
                  </span>
                )}
                <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs ${RUN_STATUS[r.status].cls}`}>
                  {RUN_STATUS[r.status].label}
                </span>
              </Link>
              {/*
                En móvil: 32 px de alto desde top-3, centrado con la primera línea y sin pisar la segunda.
                El fondo hace que, si el botón de eliminar se ensancha («¿Eliminar?»), tape el texto en vez de solaparse.
              */}
              <div className="flex shrink-0 items-center max-sm:absolute max-sm:right-0 max-sm:top-3 max-sm:bg-surface max-sm:pl-2 max-sm:group-hover:bg-surface-2">
                <a
                  href={`/preview/${r.id}/index.html`}
                  target="_blank"
                  rel="noopener"
                  title="Ver la web resultante a pantalla completa"
                  className="shrink-0 py-4 pr-4 text-xs text-muted hover:text-fg max-sm:py-2"
                >
                  Ver web ↗
                </a>
                {/* Botón de eliminar por petición (componente DeleteRunButton, más abajo) */}
                <DeleteRunButton id={r.id} onDeleted={() => setRuns((rs) => rs?.filter((x) => x.id !== r.id) ?? rs)} />
              </div>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
