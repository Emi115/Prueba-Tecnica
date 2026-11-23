import type { AgentId, AgentState, RunStatus, TaskStatus } from "@/lib/types";

export const AGENTS: Record<AgentId, { name: string; role: string; color: string; ring: string; text: string }> = {
  orchestrator: {
    name: "Orquestador",
    role: "Divide la petición en tareas y las reparte",
    color: "bg-violet-500",
    ring: "border-violet-500/40",
    text: "text-violet-300",
  },
  developer: {
    name: "Develop",
    role: "Escribe el código de cada tarea",
    color: "bg-sky-500",
    ring: "border-sky-500/40",
    text: "text-sky-300",
  },
  tester: {
    name: "Testing",
    role: "Escribe y ejecuta pruebas, devuelve lo que falla",
    color: "bg-amber-500",
    ring: "border-amber-500/40",
    text: "text-amber-300",
  },
};

export const AGENT_STATE: Record<AgentState, { label: string; cls: string }> = {
  idle: { label: "En espera", cls: "bg-zinc-700/60 text-zinc-300" },
  working: { label: "Trabajando", cls: "bg-emerald-500/15 text-emerald-300" },
  waiting: { label: "Esperando", cls: "bg-zinc-600/40 text-zinc-200" },
  done: { label: "Terminado", cls: "bg-zinc-700/60 text-zinc-300" },
  error: { label: "Error", cls: "bg-red-500/15 text-red-300" },
};

export const TASK_STATUS: Record<TaskStatus, { label: string; cls: string }> = {
  pending: { label: "Pendiente", cls: "bg-zinc-700/60 text-zinc-300" },
  developing: { label: "En desarrollo", cls: "bg-sky-500/15 text-sky-300" },
  testing: { label: "En testing", cls: "bg-amber-500/15 text-amber-300" },
  changes_requested: { label: "Con fallos", cls: "bg-red-500/15 text-red-300" },
  passed: { label: "Superada", cls: "bg-emerald-500/15 text-emerald-300" },
  blocked: { label: "Bloqueada", cls: "bg-red-600/25 text-red-200" },
};

export const RUN_STATUS: Record<RunStatus, { label: string; cls: string }> = {
  planning: { label: "Planificando", cls: "bg-violet-500/15 text-violet-300" },
  working: { label: "En curso", cls: "bg-sky-500/15 text-sky-300" },
  done: { label: "Completada", cls: "bg-emerald-500/15 text-emerald-300" },
  done_with_errors: { label: "Con incidencias", cls: "bg-amber-500/15 text-amber-300" },
  failed: { label: "Fallida", cls: "bg-red-500/15 text-red-300" },
};

export const isActive = (s: RunStatus) => s === "planning" || s === "working";

export const time = (iso: string) =>
  new Date(iso).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
