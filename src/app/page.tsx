"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { RUN_STATUS } from "@/components/ui";
import type { RunStatus } from "@/lib/types";

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
  const [request, setRequest] = useState(EXAMPLES[0]);
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
    <main className="mx-auto max-w-3xl px-4 py-12 sm:py-20">
      <p className="font-mono text-xs uppercase tracking-widest text-zinc-500">Orquestador · Develop · Testing</p>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">Un equipo de 3 agentes de IA</h1>
      <p className="mt-3 max-w-xl text-zinc-400">
        Pide un cambio para la web de ejemplo (una panadería). El <span className="text-violet-300">Orquestador</span>{" "}
        lo divide en tareas, <span className="text-sky-300">Develop</span> las programa y{" "}
        <span className="text-amber-300">Testing</span> las prueba y le devuelve lo que falla hasta que todo pasa.
      </p>

      <form onSubmit={submit} className="mt-8 rounded-2xl border border-white/10 bg-white/[0.03] p-4">
        <label htmlFor="req" className="text-sm font-medium text-zinc-300">
          Petición
        </label>
        <textarea
          id="req"
          value={request}
          onChange={(e) => setRequest(e.target.value)}
          rows={3}
          maxLength={500}
          className="mt-2 w-full resize-none rounded-xl border border-white/10 bg-black/30 p-3 text-base outline-none focus:border-violet-400/60"
        />
        <div className="mt-2 flex flex-wrap gap-2">
          {EXAMPLES.map((ex) => (
            <button
              type="button"
              key={ex}
              onClick={() => setRequest(ex)}
              className="rounded-full border border-white/10 px-3 py-1 text-xs text-zinc-400 hover:border-white/25 hover:text-zinc-200"
            >
              {ex}
            </button>
          ))}
        </div>
        <div className="mt-4 flex items-center justify-between gap-3">
          {error ? <p className="text-sm text-red-300">{error}</p> : <span />}
          <button
            disabled={busy || request.trim().length < 5}
            className="rounded-xl bg-violet-500 px-5 py-2.5 text-sm font-semibold text-white transition-[transform,opacity] active:scale-[0.97] disabled:opacity-50"
          >
            {busy ? "Creando…" : "Lanzar equipo"}
          </button>
        </div>
      </form>

      <section className="mt-12">
        <h2 className="text-sm font-medium text-zinc-400">Peticiones recientes</h2>
        <ul className="mt-3 divide-y divide-white/5 rounded-2xl border border-white/10">
          {runs === null && <li className="p-4 text-sm text-zinc-500">Cargando…</li>}
          {runs?.length === 0 && <li className="p-4 text-sm text-zinc-500">Aún no hay peticiones.</li>}
          {runs?.map((r) => (
            <li key={r.id}>
              <Link href={`/runs/${r.id}`} className="flex items-center gap-3 p-4 hover:bg-white/[0.03]">
                <span className="min-w-0 flex-1 truncate">{r.request}</span>
                <span className="font-mono text-xs text-zinc-500">
                  {r.passed}/{r.total}
                </span>
                <span className={`rounded-full px-2 py-0.5 text-xs ${RUN_STATUS[r.status].cls}`}>
                  {RUN_STATUS[r.status].label}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
