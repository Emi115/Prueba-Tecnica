"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentEvent, AgentId, Run, SiteFile, Task, TaskStatus } from "@/lib/types";
import { MAX_ATTEMPTS } from "@/lib/types";
import { AGENT_STATE, AGENTS, isActive, RUN_STATUS, TASK_STATUS, time } from "./ui";

interface RunData {
  run: Run;
  tasks: Task[];
  events: AgentEvent[];
  files: SiteFile[];
  meta: { mock: boolean; model: string; localDb: boolean };
}

const COLUMNS: { title: string; statuses: TaskStatus[] }[] = [
  { title: "Pendiente", statuses: ["pending"] },
  { title: "En desarrollo", statuses: ["developing"] },
  { title: "En testing", statuses: ["testing"] },
  { title: "Con fallos", statuses: ["changes_requested"] },
  { title: "Terminadas", statuses: ["passed", "blocked"] },
];

export function RunDashboard({ id }: { id: string }) {
  const [data, setData] = useState<RunData | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [autoRun, setAutoRun] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    // Si el servidor se reinicia o se cae la red, no rompemos: el siguiente sondeo lo reintenta.
    const res = await fetch(`/api/runs/${id}`, { cache: "no-store" }).catch(() => null);
    if (!res) return;
    if (res.status === 404) return setNotFound(true);
    if (res.ok) setData(await res.json().catch(() => null));
  }, [id]);

  // Sondeo del estado para pintar en vivo lo que hace cada agente.
  // Se detiene si la petición no existe (p. ej. BD en memoria tras reiniciar en local).
  useEffect(() => {
    if (notFound) return;
    refresh();
    const t = setInterval(refresh, 1500);
    return () => clearInterval(t);
  }, [refresh, notFound]);

  // Bucle que hace avanzar la ejecución paso a paso mientras esta pestaña esté abierta.
  const active = data ? isActive(data.run.status) : false;
  // (Si hubiera dos bucles a la vez, el lock en BD hace que uno reciba 409 y espere.)
  useEffect(() => {
    if (!active || !autoRun) return;
    let cancelled = false;
    (async () => {
      while (!cancelled) {
        const res = await fetch(`/api/runs/${id}/step`, { method: "POST" }).catch(() => null);
        await refresh();
        const body = res ? await res.json().catch(() => null) : null;
        if (body?.status === "finished") break;
        const wait =
          body?.status === "rate_limited" ? body.retryAfterMs : res?.status === 409 || !res ? 3000 : 400;
        await new Promise((r) => setTimeout(r, wait));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [active, autoRun, id, refresh]);

  if (notFound) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-20">
        <p>Esta petición no existe.</p>
        <p className="mt-2 text-sm text-zinc-500">
          Si estás en local sin DATABASE_URL, las peticiones se guardan en memoria y se pierden al reiniciar el
          servidor.
        </p>
        <Link href="/" className="text-violet-300 underline">
          Volver
        </Link>
      </main>
    );
  }
  if (!data) return <main className="p-8 text-zinc-500">Cargando…</main>;

  const { run, tasks, events, files, meta } = data;
  const selectedTask = tasks.find((t) => t.id === selected) ?? null;
  const passed = tasks.filter((t) => t.status === "passed").length;
  const lastEvent = [...events].reverse().find((e) => e.type !== "thinking");
  const rateLimited = lastEvent?.type === "rate_limit" ? lastEvent : null;

  return (
    <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      {/* Cabecera */}
      <header className="flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-1">
          <Link href="/" className="text-sm text-zinc-500 hover:text-zinc-300">
            ← Nueva petición
          </Link>
          <h1 className="mt-1 text-xl font-semibold tracking-tight sm:text-2xl">«{run.request}»</h1>
          {run.summary && <p className="mt-1 text-sm text-zinc-400">{run.summary}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className={`rounded-full px-2.5 py-1 ${RUN_STATUS[run.status].cls}`}>{RUN_STATUS[run.status].label}</span>
          <span className="rounded-full border border-white/10 px-2.5 py-1 font-mono text-zinc-400">
            {meta.mock ? "modo simulado" : meta.model}
          </span>
          {tasks.length > 0 && (
            <span className="rounded-full border border-white/10 px-2.5 py-1 font-mono text-zinc-400">
              {passed}/{tasks.length} tareas
            </span>
          )}
          {active && (
            <button
              onClick={() => setAutoRun((v) => !v)}
              className="rounded-full border border-white/15 px-2.5 py-1 text-zinc-300 hover:bg-white/5"
            >
              {autoRun ? "Pausar" : "Reanudar"}
            </button>
          )}
        </div>
      </header>

      {rateLimited && (
        <div role="alert" className="mt-4 rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-100">
          <p className="font-semibold">Límite de Gemini alcanzado (429)</p>
          <p className="mt-1 text-amber-200/90">{rateLimited.message}</p>
        </div>
      )}

      {/* Agentes */}
      <section className="mt-6 grid gap-3 md:grid-cols-3">
        {(Object.keys(AGENTS) as AgentId[]).map((a) => {
          const st = run.agents[a];
          const last = [...events].reverse().find((e) => e.agent === a);
          const working = st.state === "working" && active;
          return (
            <div key={a} className={`rounded-2xl border bg-white/[0.02] p-4 ${working ? AGENTS[a].ring : "border-white/10"}`}>
              <div className="flex items-center gap-2">
                <span className={`h-2.5 w-2.5 rounded-full ${AGENTS[a].color} ${working ? "pulse-dot" : "opacity-60"}`} />
                <h2 className="font-semibold">{AGENTS[a].name}</h2>
                <span className={`ml-auto rounded-full px-2 py-0.5 text-xs ${AGENT_STATE[st.state].cls}`}>
                  {AGENT_STATE[st.state].label}
                </span>
              </div>
              <p className="mt-1 text-xs text-zinc-500">{AGENTS[a].role}</p>
              <p className="mt-3 text-sm text-zinc-200">{st.detail}</p>
              {last && (
                <p className="mt-2 line-clamp-2 text-xs text-zinc-500">
                  <span className="font-mono">{time(last.created_at)}</span> · {last.message}
                </p>
              )}
            </div>
          );
        })}
      </section>

      {/* Tablero de tareas */}
      <section className="mt-6">
        <h2 className="text-sm font-medium text-zinc-400">Tareas</h2>
        {tasks.length === 0 ? (
          <p className="mt-2 rounded-2xl border border-dashed border-white/10 p-6 text-sm text-zinc-500">
            El Orquestador está dividiendo la petición en tareas…
          </p>
        ) : (
          <div className="mt-2 grid gap-3 overflow-x-auto sm:grid-cols-2 lg:grid-cols-5">
            {COLUMNS.map((col) => {
              const items = tasks.filter((t) => col.statuses.includes(t.status));
              return (
                <div key={col.title} className="min-h-28 rounded-2xl border border-white/10 bg-white/[0.02] p-2">
                  <p className="px-1 pb-2 text-xs text-zinc-500">
                    {col.title} <span className="font-mono">{items.length}</span>
                  </p>
                  <div className="space-y-2">
                    {items.map((t) => (
                      <button
                        key={t.id}
                        onClick={() => setSelected(t.id === selected ? null : t.id)}
                        className={`w-full rounded-xl border p-3 text-left transition-colors hover:bg-white/[0.04] ${
                          t.id === selected ? "border-violet-400/60" : "border-white/10"
                        }`}
                      >
                        <p className="text-sm leading-snug">
                          <span className="font-mono text-zinc-500">T{t.idx + 1}</span> {t.title}
                        </p>
                        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
                          <span className={`rounded-full px-2 py-0.5 ${TASK_STATUS[t.status].cls}`}>
                            {TASK_STATUS[t.status].label}
                          </span>
                          {t.attempts > 0 && (
                            <span className="font-mono text-zinc-500">
                              ronda {t.attempts}/{MAX_ATTEMPTS}
                            </span>
                          )}
                          {t.last_report && (
                            <span className="font-mono text-zinc-500">
                              {t.last_report.checks.filter((c) => c.passed).length}/{t.last_report.checks.length} ✓
                            </span>
                          )}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {selectedTask && <TaskDetail task={selectedTask} events={events} />}
      </section>

      {/* Actividad + web */}
      <section className="mt-6 grid gap-4 lg:grid-cols-2">
        <ActivityLog events={events} tasks={tasks} />
        <SitePreview runId={run.id} files={files} version={events.length} />
      </section>

      {meta.mock && (
        <p className="mt-6 text-xs text-zinc-500">
          Modo simulado: no hay GEMINI_API_KEY configurada, los agentes responden con datos de ejemplo
          {meta.localDb ? " y la base de datos es local en memoria" : ""}.
        </p>
      )}
    </main>
  );
}

function TaskDetail({ task, events }: { task: Task; events: AgentEvent[] }) {
  const r = task.last_report;
  const history = events.filter((e) => e.task_id === task.id && e.type !== "thinking");
  return (
    <div className="mt-3 grid gap-4 rounded-2xl border border-violet-400/30 bg-white/[0.02] p-4 md:grid-cols-2">
      <div>
        <p className="font-semibold">
          T{task.idx + 1} · {task.title}
        </p>
        <p className="mt-1 text-sm text-zinc-400">{task.description}</p>
        <p className="mt-3 text-xs font-medium text-zinc-500">Criterios de aceptación</p>
        <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-zinc-300">
          {task.acceptance.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ul>
        <p className="mt-3 text-xs font-medium text-zinc-500">Historial</p>
        <ol className="mt-1 space-y-1 text-xs text-zinc-400">
          {history.map((e) => (
            <li key={e.id}>
              <span className={AGENTS[e.agent as AgentId]?.text}>{AGENTS[e.agent as AgentId]?.name}</span> · {e.message}
            </li>
          ))}
        </ol>
      </div>
      <div>
        <p className="text-xs font-medium text-zinc-500">
          {task.history?.length ? `Intentos (${task.history.length}/${MAX_ATTEMPTS})` : "Aún sin informe de Testing"}
        </p>
        <div className="mt-2 space-y-2">
          {(task.history ?? []).map((h) => (
            <details key={h.attempt} open={h.attempt === r?.attempt} className="rounded-xl border border-white/10 p-3">
              <summary className="flex cursor-pointer items-center gap-2 text-sm">
                <span className="font-mono text-zinc-500">#{h.attempt}</span>
                <span className={h.passed ? "text-emerald-300" : "text-red-300"}>
                  {h.passed ? "Superado" : "Con fallos"}
                </span>
                <span className="ml-auto font-mono text-[11px] text-zinc-500">
                  {h.checks.filter((c) => c.passed).length}/{h.checks.length} ✓ · {time(h.at)}
                </span>
              </summary>
              <p className="mt-2 text-xs text-sky-300/90">Develop: {h.dev_summary}</p>
              {h.files.length > 0 && <p className="font-mono text-[11px] text-zinc-500">✎ {h.files.join(", ")}</p>}
              <ul className="mt-2 space-y-1.5">
                {h.checks.map((c, i) => (
                <li key={i} className="flex gap-2 text-sm">
                  <span className={c.passed ? "text-emerald-400" : "text-red-400"}>{c.passed ? "✓" : "✗"}</span>
                  <span className="min-w-0">
                    <span className="text-zinc-200">{c.description}</span>
                    <span className="block font-mono text-[11px] text-zinc-500">
                      {c.type} · {c.detail}
                    </span>
                  </span>
                </li>
              ))}
              </ul>
              <p className="mt-2 text-xs text-zinc-500">
                Revisión de código: {h.review.approved ? "aprobada" : "rechazada"}
              </p>
              {h.review.issues.length > 0 && (
                <ul className="mt-1 list-disc pl-5 text-sm text-red-300">
                  {h.review.issues.map((i) => (
                    <li key={i}>{i}</li>
                  ))}
                </ul>
              )}
            </details>
          ))}
        </div>
      </div>
    </div>
  );
}

function ActivityLog({ events, tasks }: { events: AgentEvent[]; tasks: Task[] }) {
  const ref = useRef<HTMLOListElement>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [events.length]);
  const taskLabel = (id: string | null) => {
    const t = tasks.find((x) => x.id === id);
    return t ? `T${t.idx + 1}` : null;
  };
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.02]">
      <p className="border-b border-white/10 px-4 py-2.5 text-sm font-medium text-zinc-400">Actividad de los agentes</p>
      <ol ref={ref} className="max-h-[480px] space-y-2 overflow-y-auto p-4">
        {events.map((e) => {
          const a = AGENTS[e.agent as AgentId];
          const label = taskLabel(e.task_id);
          return (
            <li key={e.id} className="flex gap-3 text-sm">
              <span className="w-16 shrink-0 font-mono text-[11px] leading-5 text-zinc-600">{time(e.created_at)}</span>
              <span className="min-w-0">
                <span className={`font-medium ${a?.text ?? (e.type === "error" ? "text-red-300" : "text-zinc-400")}`}>
                  {a?.name ?? "Sistema"}
                </span>
                {label && <span className="ml-1.5 font-mono text-[11px] text-zinc-500">{label}</span>}
                <span className={`ml-2 ${e.type === "thinking" ? "italic text-zinc-500" : "text-zinc-300"}`}>{e.message}</span>
                <EventExtra e={e} />
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function EventExtra({ e }: { e: AgentEvent }) {
  const d = e.data as { files?: string[]; tasks?: string[] } | null;
  if (!d) return null;
  if (d.files?.length)
    return <span className="mt-0.5 block font-mono text-[11px] text-zinc-500">✎ {d.files.join(", ")}</span>;
  if (d.tasks?.length)
    return (
      <ol className="mt-1 list-decimal pl-5 text-xs text-zinc-400">
        {d.tasks.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ol>
    );
  return null;
}

function SitePreview({ runId, files, version }: { runId: string; files: SiteFile[]; version: number }) {
  const pages = files.filter((f) => f.path.endsWith(".html")).map((f) => f.path);
  const [page, setPage] = useState("index.html");
  const [view, setView] = useState<"web" | "code">("web");
  const [codeFile, setCodeFile] = useState("index.html");
  const code = files.find((f) => f.path === codeFile);

  return (
    <div className="flex min-h-[480px] flex-col rounded-2xl border border-white/10 bg-white/[0.02]">
      <div className="flex flex-wrap items-center gap-2 border-b border-white/10 px-4 py-2">
        <p className="mr-auto text-sm font-medium text-zinc-400">Web resultante</p>
        <div className="flex rounded-lg border border-white/10 p-0.5 text-xs">
          {(["web", "code"] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`rounded-md px-2.5 py-1 ${view === v ? "bg-white/10 text-zinc-100" : "text-zinc-400"}`}
            >
              {v === "web" ? "Vista" : "Código"}
            </button>
          ))}
        </div>
        <a
          href={`/preview/${runId}/${page}`}
          target="_blank"
          className="text-xs text-zinc-400 underline-offset-2 hover:underline"
        >
          Abrir ↗
        </a>
      </div>
      <div className="flex flex-wrap gap-1 px-3 pt-2">
        {(view === "web" ? pages : files.map((f) => f.path)).map((p) => {
          const current = view === "web" ? page : codeFile;
          return (
            <button
              key={p}
              onClick={() => (view === "web" ? setPage(p) : setCodeFile(p))}
              className={`rounded-md px-2 py-0.5 font-mono text-xs ${
                current === p ? "bg-white/10 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {p}
            </button>
          );
        })}
      </div>
      <div className="flex-1 p-3">
        {view === "web" ? (
          <iframe
            key={`${page}-${version}`}
            src={`/preview/${runId}/${page}`}
            sandbox=""
            title="Vista previa de la web"
            className="h-full min-h-[400px] w-full rounded-lg bg-white"
          />
        ) : (
          <pre className="h-full max-h-[440px] overflow-auto rounded-lg bg-black/40 p-3 font-mono text-[12px] leading-relaxed text-zinc-300">
            {code?.content ?? "—"}
          </pre>
        )}
      </div>
    </div>
  );
}
