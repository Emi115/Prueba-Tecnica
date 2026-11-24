"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AGENTS, RUN_STATUS } from "@/components/ui";
import type { AgentId, RunStatus } from "@/lib/types";

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
}

export default function Home() {
  const router = useRouter();
  // Empieza vacío: el ejemplo va como placeholder para no lanzar algo que el usuario no ha escrito.
  const [request, setRequest] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runs, setRuns] = useState<RunRow[] | null>(null);

  useEffect(() => {
    fetch("/api/runs")
      .then((r) => (r.ok ? r.json() : []))
      .then(setRuns)
      .catch(() => setRuns([]));
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request }),
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
            <li key={r.id} className="flex items-center hover:bg-surface-2">
              <Link href={`/runs/${r.id}`} className="flex min-w-0 flex-1 items-center gap-3 p-4">
                <span className="min-w-0 flex-1 truncate">{r.request}</span>
                <span className="font-mono text-xs text-subtle">
                  {r.passed}/{r.total}
                </span>
                <span className={`rounded-full px-2 py-0.5 text-xs ${RUN_STATUS[r.status].cls}`}>
                  {RUN_STATUS[r.status].label}
                </span>
              </Link>
              <a
                href={`/preview/${r.id}/index.html`}
                target="_blank"
                rel="noopener"
                title="Ver la web resultante a pantalla completa"
                className="shrink-0 py-4 pr-4 text-xs text-muted hover:text-fg"
              >
                Ver web ↗
              </a>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
