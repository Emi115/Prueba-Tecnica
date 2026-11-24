"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentEvent, AgentId, ModelInfo, Run, SiteFile, Task, TaskStatus } from "@/lib/types";
import { MAX_ATTEMPTS } from "@/lib/types";
import { BASE_SITE } from "@/lib/base-site";
import { splitSkipped } from "@/lib/llm-errors";
import { AGENT_STATE, AGENTS, isActive, RUN_STATUS, TASK_STATUS, time } from "./ui";

interface RunData {
  run: Run;
  tasks: Task[];
  events: AgentEvent[];
  files: SiteFile[];
  meta: { mock: boolean; model: string; fallbacks: string[]; localDb: boolean };
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
        <p className="mt-2 text-sm text-subtle">
          Si estás en local sin DATABASE_URL, las peticiones se guardan en memoria y se pierden al reiniciar el
          servidor.
        </p>
        <Link href="/" className="text-violet-700 dark:text-violet-300 underline">
          Volver
        </Link>
      </main>
    );
  }
  if (!data) return <main className="p-8 text-subtle">Cargando…</main>;

  const { run, tasks, events, files, meta } = data;
  const selectedTask = tasks.find((t) => t.id === selected) ?? null;
  const passed = tasks.filter((t) => t.status === "passed").length;
  const lastEvent = [...events].reverse().find((e) => e.type !== "thinking");
  const rateLimited = lastEvent?.type === "rate_limit" ? lastEvent : null;

  return (
    <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      {/* Cabecera */}
      <header className="flex flex-wrap items-start gap-x-6 gap-y-3">
        {/* Base de 24rem: si las etiquetas no caben al lado, bajan a otra línea en vez de aplastar el título. */}
        <div className="min-w-0 flex-[1_1_24rem]">
          <Link href="/" className="text-sm whitespace-nowrap text-subtle hover:text-fg">
            ← Nueva petición
          </Link>
          <h1 className="mt-1 text-xl font-semibold tracking-tight text-pretty break-words sm:text-2xl">«{run.request}»</h1>
          {run.summary && <p className="mt-1 text-sm text-muted">{run.summary}</p>}
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
          <span className={`rounded-full px-2.5 py-1 ${RUN_STATUS[run.status].cls}`}>{RUN_STATUS[run.status].label}</span>
          <span className="rounded-full border border-line px-2.5 py-1 font-mono text-muted">
            {meta.mock ? "modo simulado" : meta.model}
          </span>
          {!meta.mock && meta.fallbacks?.length > 0 && (
            <span
              className="max-w-full truncate rounded-full border border-line px-2.5 py-1 font-mono text-subtle"
              title={`Si ${meta.model} falla (saturado, 429 o sin respuesta), se prueba en orden: ${meta.fallbacks.join(" → ")}`}
            >
              respaldo: {meta.fallbacks.join(" → ")}
            </span>
          )}
          {tasks.length > 0 && (
            <span className="rounded-full border border-line px-2.5 py-1 font-mono text-muted">
              {passed}/{tasks.length} tareas
            </span>
          )}
          {active && (
            <button
              onClick={() => setAutoRun((v) => !v)}
              className="rounded-full border border-line-strong px-2.5 py-1 text-fg hover:bg-surface-2"
            >
              {autoRun ? "Pausar" : "Reanudar"}
            </button>
          )}
          <a
            href={`/preview/${run.id}/index.html`}
            target="_blank"
            rel="noopener"
            className="rounded-full bg-fg px-2.5 py-1 font-medium text-bg hover:opacity-85"
          >
            {active ? "Ver cómo va ↗" : "Ver resultado ↗"}
          </a>
        </div>
      </header>

      {rateLimited && (
        <div role="alert" className="mt-4 rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-900 dark:text-amber-100">
          <p className="font-semibold">Límite de peticiones alcanzado (429)</p>
          <p className="mt-1 text-amber-800 dark:text-amber-200/90">{rateLimited.message}</p>
        </div>
      )}

      {/* Agentes */}
      <section className="mt-6 grid gap-3 md:grid-cols-3">
        {(Object.keys(AGENTS) as AgentId[]).map((a) => {
          const st = run.agents[a];
          const last = [...events].reverse().find((e) => e.agent === a);
          const lastModel = modelOf([...events].reverse().find((e) => e.agent === a && modelOf(e)));
          const working = st.state === "working" && active;
          return (
            <div key={a} className={`card rounded-2xl p-4 ${working ? AGENTS[a].ring : ""}`}>
              <div className="flex items-center gap-2">
                <span className={`h-2.5 w-2.5 rounded-full ${AGENTS[a].color} ${working ? "pulse-dot" : "opacity-60"}`} />
                <h2 className="font-semibold">{AGENTS[a].name}</h2>
                <span className={`ml-auto rounded-full px-2 py-0.5 text-xs ${AGENT_STATE[st.state].cls}`}>
                  {AGENT_STATE[st.state].label}
                </span>
              </div>
              <p className="mt-1 text-xs text-subtle">{AGENTS[a].role}</p>
              {lastModel && (
                <p className="mt-1.5 text-xs text-subtle">
                  Última respuesta de
                  <ModelBadge info={lastModel} />
                </p>
              )}
              <p className="mt-3 text-sm text-fg">{st.detail}</p>
              {last && (
                <p className="mt-2 line-clamp-2 text-xs text-subtle">
                  <span className="font-mono">{time(last.created_at)}</span> · {last.message}
                </p>
              )}
            </div>
          );
        })}
      </section>

      {/* Tablero de tareas */}
      <section className="mt-6">
        <h2 className="text-sm font-medium text-muted">Tareas</h2>
        {tasks.length === 0 ? (
          <p className="mt-2 rounded-2xl border border-dashed border-line p-6 text-sm text-subtle">
            El Orquestador está dividiendo la petición en tareas…
          </p>
        ) : (
          <div className="mt-2 grid gap-3 overflow-x-auto sm:grid-cols-2 lg:grid-cols-5">
            {COLUMNS.map((col) => {
              const items = tasks.filter((t) => col.statuses.includes(t.status));
              return (
                <div key={col.title} className="min-h-28 card rounded-2xl p-2">
                  <p className="px-1 pb-2 text-xs text-subtle">
                    {col.title} <span className="font-mono">{items.length}</span>
                  </p>
                  <div className="space-y-2">
                    {items.map((t) => (
                      <button
                        key={t.id}
                        onClick={() => setSelected(t.id === selected ? null : t.id)}
                        className={`w-full rounded-xl border p-3 text-left transition-colors hover:bg-surface-2 ${
                          t.id === selected ? "border-violet-500/70" : "border-line"
                        }`}
                      >
                        <p className="text-sm leading-snug">
                          <span className="font-mono text-subtle">T{t.idx + 1}</span> {t.title}
                        </p>
                        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
                          <span className={`rounded-full px-2 py-0.5 ${TASK_STATUS[t.status].cls}`}>
                            {TASK_STATUS[t.status].label}
                          </span>
                          {t.attempts > 0 && (
                            <span className="font-mono text-subtle">
                              ronda {t.attempts}/{MAX_ATTEMPTS}
                            </span>
                          )}
                          {t.last_report && (
                            <span className="font-mono text-subtle">
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
        <p className="mt-6 text-xs text-subtle">
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
    <div className="mt-3 grid gap-4 card rounded-2xl border-violet-500/40 p-4 md:grid-cols-2">
      <div>
        <p className="font-semibold">
          T{task.idx + 1} · {task.title}
        </p>
        <p className="mt-1 text-sm text-muted">{task.description}</p>
        <p className="mt-3 text-xs font-medium text-subtle">Criterios de aceptación</p>
        <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-fg">
          {task.acceptance.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ul>
        <p className="mt-3 text-xs font-medium text-subtle">Historial</p>
        <ol className="mt-1 space-y-1 text-xs text-muted">
          {history.map((e) => (
            <li key={e.id}>
              <span className={AGENTS[e.agent as AgentId]?.text}>{AGENTS[e.agent as AgentId]?.name}</span>
              <ModelBadge info={modelOf(e)} /> · {e.message}
            </li>
          ))}
        </ol>
      </div>
      <div>
        <p className="text-xs font-medium text-subtle">
          {task.history?.length ? `Intentos (${task.history.length}/${MAX_ATTEMPTS})` : "Aún sin informe de Testing"}
        </p>
        <div className="mt-2 space-y-2">
          {(task.history ?? []).map((h) => (
            <details key={h.attempt} open={h.attempt === r?.attempt} className="rounded-xl border border-line p-3">
              <summary className="flex cursor-pointer items-center gap-2 text-sm">
                <span className="font-mono text-subtle">#{h.attempt}</span>
                <span className={h.passed ? "text-emerald-700 dark:text-emerald-300" : "text-red-700 dark:text-red-300"}>
                  {h.passed ? "Superado" : "Con fallos"}
                </span>
                <span className="ml-auto font-mono text-[11px] text-subtle">
                  {h.checks.filter((c) => c.passed).length}/{h.checks.length} ✓ · {time(h.at)}
                </span>
              </summary>
              <p className="mt-2 text-xs text-sky-700 dark:text-sky-300">
                Develop
                <ModelBadge info={h.dev_model} />: {h.dev_summary}
              </p>
              <FallbackNote info={h.dev_model} />
              {h.files.length > 0 && <p className="font-mono text-[11px] text-subtle">✎ {h.files.join(", ")}</p>}
              <ul className="mt-2 space-y-1.5">
                {h.checks.map((c, i) => (
                <li key={i} className="flex gap-2 text-sm">
                  <span className={c.passed ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}>{c.passed ? "✓" : "✗"}</span>
                  <span className="min-w-0">
                    <span className="text-fg">{c.description}</span>
                    <span className="block font-mono text-[11px] text-subtle">
                      {c.type} · {c.detail}
                    </span>
                  </span>
                </li>
              ))}
              </ul>
              <p className="mt-2 text-xs text-subtle">
                Revisión de código: {h.review.approved ? "aprobada" : "rechazada"} · Testing
                <ModelBadge info={h.test_model} />
              </p>
              <FallbackNote info={h.test_model} />
              {h.review.issues.length > 0 && (
                <ul className="mt-1 list-disc pl-5 text-sm text-red-700 dark:text-red-300">
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
    <div className="card rounded-2xl">
      <p className="border-b border-line px-4 py-2.5 text-sm font-medium text-muted">Actividad de los agentes</p>
      <ol ref={ref} className="max-h-[480px] space-y-2 overflow-y-auto p-4">
        {events.map((e) => {
          const a = AGENTS[e.agent as AgentId];
          const label = taskLabel(e.task_id);
          return (
            <li key={e.id} className="flex gap-3 text-sm">
              <span className="w-16 shrink-0 font-mono text-[11px] leading-5 text-faint">{time(e.created_at)}</span>
              <span className="min-w-0">
                <span className={`font-medium ${a?.text ?? (e.type === "error" ? "text-red-700 dark:text-red-300" : "text-muted")}`}>
                  {a?.name ?? "Sistema"}
                </span>
                {label && <span className="ml-1.5 font-mono text-[11px] text-subtle">{label}</span>}
                <ModelBadge info={modelOf(e)} />
                <span className={`ml-2 ${e.type === "thinking" ? "italic text-subtle" : "text-fg"}`}>{e.message}</span>
                <EventExtra e={e} />
                <FallbackNote info={modelOf(e)} />
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** Qué IA respondió, leído de `data.usage` del evento (null en modo simulado o eventos sin llamada). */
function modelOf(e: AgentEvent | undefined): ModelInfo | null {
  const u = (e?.data as { usage?: unknown } | null)?.usage as Partial<ModelInfo> | undefined;
  return u && typeof u === "object" && u.model ? { provider: u.provider ?? "gemini", model: u.model, skipped: u.skipped } : null;
}

const PROVIDER_BADGE: Record<ModelInfo["provider"], { name: string; cls: string }> = {
  gemini: { name: "Gemini", cls: "bg-sky-500/15 text-sky-700 dark:text-sky-300" },
  groq: { name: "Groq", cls: "bg-orange-500/15 text-orange-700 dark:text-orange-300" },
  mistral: { name: "Mistral", cls: "bg-rose-500/15 text-rose-700 dark:text-rose-300" },
};

function ModelBadge({ info }: { info: ModelInfo | null | undefined }) {
  if (!info) return null;
  const style = PROVIDER_BADGE[info.provider] ?? PROVIDER_BADGE.gemini;
  const name = `${style.name} · ${info.model.split("/").pop()!.replace(/^gemini-/, "")}`;
  const backup = (info.skipped?.length ?? 0) > 0;
  return (
    <span
      title={
        backup
          ? `Respondió ${info.model} como respaldo. Fallaron antes: ${info.skipped!.join(" · ")}`
          : `Respondió ${info.model} (modelo principal)`
      }
      className={`ml-1.5 inline-flex items-center gap-1 whitespace-nowrap rounded-full px-1.5 py-px align-middle font-mono text-[10px] ${
        style.cls
      }`}
    >
      {name}
      {backup && <span className="rounded-full bg-amber-400/20 px-1 text-amber-200">respaldo</span>}
    </span>
  );
}

/** Por qué no respondió cada modelo anterior de la cadena (429, saturado, sin respuesta, JSON no válido…). */
function FallbackNote({ info }: { info: ModelInfo | null | undefined }) {
  if (!info?.skipped?.length) return null;
  return (
    <ul className="mt-1 space-y-0.5 border-l-2 border-amber-500/40 pl-2 text-[11px] text-subtle">
      {info.skipped.map((s, i) => {
        const { model, reason } = splitSkipped(s);
        return (
          <li key={i}>
            <span className="font-mono">{model.replace(/^gemini-/, "")}</span> no respondió
            {reason && (
              <>
                : <span className="text-amber-800 dark:text-amber-300">{reason}</span>
              </>
            )}
          </li>
        );
      })}
      <li>
        → respondió <span className="font-mono">{info.model.split("/").pop()!.replace(/^gemini-/, "")}</span>
      </li>
    </ul>
  );
}

function EventExtra({ e }: { e: AgentEvent }) {
  const d = e.data as { files?: string[]; tasks?: string[] } | null;
  if (!d) return null;
  if (d.files?.length)
    return <span className="mt-0.5 block font-mono text-[11px] text-subtle">✎ {d.files.join(", ")}</span>;
  if (d.tasks?.length)
    return (
      <ol className="mt-1 list-decimal pl-5 text-xs text-muted">
        {d.tasks.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ol>
    );
  return null;
}

type PreviewMode = "after" | "before" | "compare" | "code";
type Change = "new" | "modified" | "same";

const MODES: { id: PreviewMode; label: string }[] = [
  { id: "before", label: "Antes" },
  { id: "after", label: "Después" },
  { id: "compare", label: "Comparar" },
  { id: "code", label: "Código" },
];

const CHANGE_BADGE: Record<Change, { label: string; cls: string } | null> = {
  new: { label: "nueva", cls: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" },
  modified: { label: "cambiada", cls: "bg-sky-500/15 text-sky-700 dark:text-sky-300" },
  same: null,
};

/** Compara cada fichero de la ejecución con la web de partida. */
function changeOf(f: SiteFile): Change {
  const before = BASE_SITE[f.path];
  if (before === undefined) return "new";
  return before === f.content ? "same" : "modified";
}

function SitePreview({ runId, files, version }: { runId: string; files: SiteFile[]; version: number }) {
  const [mode, setMode] = useState<PreviewMode>("after");
  const [page, setPage] = useState("index.html");
  const [codeFile, setCodeFile] = useState("index.html");

  const changes = new Map(files.map((f) => [f.path, changeOf(f)]));
  const pages = files.filter((f) => f.path.endsWith(".html")).map((f) => f.path);
  const tabs = mode === "code" ? files.map((f) => f.path) : pages;
  const current = mode === "code" ? codeFile : page;
  const code = files.find((f) => f.path === codeFile);
  const changedCount = [...changes.values()].filter((c) => c !== "same").length;

  const frame = (src: string | null, label: string, emptyText: string) => (
    <div className="flex min-w-0 flex-1 flex-col">
      <p className="mb-1 text-[11px] font-medium uppercase tracking-wider text-subtle">{label}</p>
      {src ? (
        <iframe
          key={`${src}-${version}`}
          src={src}
          sandbox=""
          title={`${label}: ${page}`}
          className="h-full min-h-[400px] w-full rounded-lg bg-white"
        />
      ) : (
        <div className="flex min-h-[400px] flex-1 items-center justify-center rounded-lg border border-dashed border-line-strong p-6 text-center text-sm text-subtle">
          {emptyText}
        </div>
      )}
    </div>
  );

  const beforeSrc = BASE_SITE[page] !== undefined ? `/preview/original/${page}` : null;
  const afterSrc = `/preview/${runId}/${page}`;
  const newPageText = `${page} no existía antes: es una página nueva creada por los agentes.`;

  return (
    <div
      className={`flex min-h-[480px] flex-col card rounded-2xl ${
        mode === "compare" ? "lg:col-span-2" : ""
      }`}
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2">
        <p className="mr-auto text-sm font-medium text-muted">
          Web <span className="text-faint">·</span>{" "}
          <span className="text-xs text-subtle">
            {changedCount === 0 ? "sin cambios todavía" : `${changedCount} fichero(s) nuevos o cambiados`}
          </span>
        </p>
        <div className="flex rounded-lg border border-line p-0.5 text-xs" role="tablist">
          {MODES.map((m) => (
            <button
              key={m.id}
              role="tab"
              aria-selected={mode === m.id}
              onClick={() => setMode(m.id)}
              className={`rounded-md px-2.5 py-1 ${mode === m.id ? "bg-surface-2 text-fg shadow-sm" : "text-muted hover:text-fg"}`}
            >
              {m.label}
            </button>
          ))}
        </div>
        {mode !== "code" && (
          <span className="flex gap-3 text-xs text-muted">
            {beforeSrc && (
              <a href={beforeSrc} target="_blank" rel="noopener" className="underline-offset-2 hover:underline">
                Abrir antes ↗
              </a>
            )}
            <a href={afterSrc} target="_blank" rel="noopener" className="underline-offset-2 hover:underline">
              Abrir después ↗
            </a>
          </span>
        )}
      </div>

      <div className="flex flex-wrap gap-1 px-3 pt-2">
        {tabs.map((p) => {
          const badge = CHANGE_BADGE[changes.get(p) ?? "same"];
          return (
            <button
              key={p}
              onClick={() => (mode === "code" ? setCodeFile(p) : setPage(p))}
              className={`flex items-center gap-1.5 rounded-md px-2 py-0.5 font-mono text-xs ${
                current === p ? "bg-surface-2 text-fg" : "text-subtle hover:text-fg"
              }`}
            >
              {p}
              {badge && <span className={`rounded px-1 font-sans text-[10px] ${badge.cls}`}>{badge.label}</span>}
            </button>
          );
        })}
      </div>

      <div className="flex flex-1 gap-3 p-3">
        {mode === "before" && frame(beforeSrc, "Antes", newPageText)}
        {mode === "after" && frame(afterSrc, "Después", "")}
        {mode === "compare" && (
          <div className="flex flex-1 flex-col gap-3 md:flex-row">
            {frame(beforeSrc, "Antes", newPageText)}
            {frame(afterSrc, "Después", "")}
          </div>
        )}
        {mode === "code" && (
          <pre className="h-full max-h-[440px] w-full overflow-auto rounded-lg bg-surface-2 p-3 font-mono text-[12px] leading-relaxed text-fg">
            {code?.content ?? "—"}
          </pre>
        )}
      </div>
    </div>
  );
}
