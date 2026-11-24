import "server-only";
import { randomUUID } from "node:crypto";
import { q } from "./db";
import { BASE_SITE } from "./base-site";
import { contactDemoChecks, mergeChecks, runChecks, siteLinkChecks } from "./checks";
import { planTasks } from "./agents/orchestrator";
import { develop } from "./agents/developer";
import { test } from "./agents/tester";
import { ConfigError, GeminiBusyError, RateLimitError, withAi, type LlmUsage } from "./llm";
import {
  BUSY_WAIT_MS,
  MAX_ATTEMPTS,
  type ModelInfo,
  MAX_BUSY_RETRIES,
  MAX_RATE_LIMIT_RETRIES,
  RATE_LIMIT_WAIT_MS,
  type Attempt,
  type AgentEvent,
  type AgentId,
  type AgentStatus,
  type AiChoice,
  type Run,
  type SiteFile,
  type Task,
  type TestReport,
} from "./types";

/* ----------------------------- lectura ----------------------------- */

export async function getRun(id: string) {
  const [run] = await q<Run>(`SELECT * FROM runs WHERE id = $1`, [id]);
  if (!run) return null;
  const [tasks, events, files] = await Promise.all([
    q<Task>(`SELECT * FROM tasks WHERE run_id = $1 ORDER BY idx`, [id]),
    q<AgentEvent>(`SELECT * FROM events WHERE run_id = $1 ORDER BY id`, [id]),
    q<SiteFile>(`SELECT path, content, updated_at FROM files WHERE run_id = $1 ORDER BY path`, [id]),
  ]);
  return { run, tasks, events: events.map((e) => ({ ...e, id: Number(e.id) })), files };
}

export async function listRuns() {
  return q<Pick<Run, "id" | "request" | "status" | "created_at" | "ai"> & { total: number; passed: number }>(
    `SELECT r.id, r.request, r.status, r.created_at, r.ai,
            COUNT(t.id)::int AS total,
            COUNT(t.id) FILTER (WHERE t.status = 'passed')::int AS passed
       FROM runs r LEFT JOIN tasks t ON t.run_id = r.id
      GROUP BY r.id ORDER BY r.created_at DESC LIMIT 30`,
  );
}

async function loadFiles(runId: string): Promise<Record<string, string>> {
  const rows = await q<{ path: string; content: string }>(`SELECT path, content FROM files WHERE run_id = $1`, [
    runId,
  ]);
  return Object.fromEntries(rows.map((r) => [r.path, r.content]));
}

/* ----------------------------- escritura ----------------------------- */

const IDLE: Record<AgentId, AgentStatus> = {
  orchestrator: { state: "working", detail: "Analizando la petición" },
  developer: { state: "idle", detail: "Esperando tareas" },
  tester: { state: "idle", detail: "Esperando trabajo que revisar" },
};

export async function createRun(request: string, ai: AiChoice = "auto") {
  const id = randomUUID();
  await q(`INSERT INTO runs (id, request, status, agents, ai) VALUES ($1, $2, 'planning', $3, $4)`, [
    id,
    request,
    JSON.stringify(IDLE),
    ai,
  ]);
  for (const [path, content] of Object.entries(BASE_SITE)) {
    await q(`INSERT INTO files (run_id, path, content) VALUES ($1, $2, $3)`, [id, path, content]);
  }
  await log(id, null, "system", "created", `Nueva petición: «${request}»`);
  return id;
}

async function log(
  runId: string,
  taskId: string | null,
  agent: AgentId | "system",
  type: string,
  message: string,
  data?: unknown,
) {
  await q(`INSERT INTO events (run_id, task_id, agent, type, message, data) VALUES ($1,$2,$3,$4,$5,$6)`, [
    runId,
    taskId,
    agent,
    type,
    message,
    data === undefined ? null : JSON.stringify(data),
  ]);
}

async function setAgents(runId: string, patch: Partial<Record<AgentId, AgentStatus>>) {
  await q(`UPDATE runs SET agents = agents || $2::jsonb, updated_at = now() WHERE id = $1`, [
    runId,
    JSON.stringify(patch),
  ]);
}

async function setTask(taskId: string, fields: Partial<Pick<Task, "status" | "attempts" | "checks" | "last_report">>) {
  const cols = Object.keys(fields);
  const sets = cols.map((c, i) => `${c} = $${i + 2}`).join(", ");
  const values = cols.map((c) => {
    const v = fields[c as keyof typeof fields];
    return typeof v === "object" && v !== null ? JSON.stringify(v) : v;
  });
  await q(`UPDATE tasks SET ${sets}, updated_at = now() WHERE id = $1`, [taskId, ...values]);
}

// Cada evento guarda qué IA respondió (proveedor, modelo y los que fallaron antes);
// el panel lo pinta como una etiqueta junto al mensaje.
const usageNote = (u: LlmUsage | null) => (u ? { usage: u } : { usage: "simulado" });

const modelInfo = (u: unknown): ModelInfo | null => {
  const x = u as LlmUsage | null | undefined;
  return x && typeof x === "object" && x.model ? { provider: x.provider ?? "gemini", model: x.model, skipped: x.skipped } : null;
};

/* ----------------------------- motor ----------------------------- */

/**
 * Avanza la ejecución UN paso (como mucho una llamada a un agente).
 * Así cada petición HTTP es corta y cabe en los límites de Vercel; el panel
 * va llamando a /step mientras la ejecución no termina. Un "lock" en BD
 * evita que dos pestañas avancen la misma ejecución a la vez.
 */
type StepResult = { status: "advanced" | "busy" | "finished" } | { status: "rate_limited"; retryAfterMs: number };

export async function step(runId: string): Promise<StepResult> {
  const [locked] = await q<Run>(
    `UPDATE runs SET locked_until = now() + interval '280 seconds'
      WHERE id = $1 AND status IN ('planning','working')
        AND (locked_until IS NULL OR locked_until < now())
      RETURNING *`,
    [runId],
  );
  if (!locked) {
    const [r] = await q<Run>(`SELECT status FROM runs WHERE id = $1`, [runId]);
    return { status: r && (r.status === "planning" || r.status === "working") ? "busy" : "finished" };
  }

  // Tras un 429/503 el propio servidor mantiene el lock durante la espera, para que
  // ninguna pestaña (ni varias a la vez) reintente antes de tiempo.
  let holdMs = 0;
  try {
    // Todas las llamadas a la IA de este paso usan la IA elegida en la petición.
    await withAi(locked.ai ?? "auto", () => (locked.status === "planning" ? stepPlan(locked) : stepWork(locked)));
  } catch (err) {
    // 429 (cuota) y 5xx/timeouts (todas las IAs de la cadena saturadas) son temporales: no cuentan como error de código.
    // Reintentos limitados, con espera entre ellos, y mensaje claro en el panel.
    const transient =
      err instanceof RateLimitError
        ? {
            type: "rate_limit",
            max: MAX_RATE_LIMIT_RETRIES,
            wait: RATE_LIMIT_WAIT_MS,
            why: "Todas las IAs devolvieron 429 (cuota agotada) varias veces seguidas.",
            detail: "Detenido: cuota agotada (429)",
          }
        : err instanceof GeminiBusyError
          ? {
              type: "busy",
              max: MAX_BUSY_RETRIES,
              wait: BUSY_WAIT_MS,
              why: "Ninguna IA respondió (saturadas o sin respuesta) varias veces seguidas. Prueba más tarde.",
              detail: "Detenido: IAs saturadas",
            }
          : null;
    if (transient) {
      const message = (err as Error).message;
      const recent = await q<{ type: string }>(
        `SELECT type FROM events WHERE run_id = $1 AND type <> 'thinking' ORDER BY id DESC LIMIT $2`,
        [runId, transient.max - 1],
      );
      const streak = recent.findIndex((e) => e.type !== transient.type);
      const previous = streak === -1 ? recent.length : streak;
      const giveUp = previous + 1 >= transient.max;
      await log(
        runId,
        null,
        "system",
        transient.type,
        giveUp
          ? `${message} (${transient.max}/${transient.max} reintentos agotados: ejecución detenida).`
          : `${message} Reintento ${previous + 1}/${transient.max} en ${transient.wait / 1000} s.`,
      );
      if (giveUp) {
        await q(`UPDATE runs SET status = 'failed', summary = $2 WHERE id = $1`, [runId, transient.why]);
        await setAgents(runId, { orchestrator: { state: "error", detail: transient.detail } });
      }
      holdMs = giveUp ? 0 : transient.wait;
      return giveUp ? { status: "finished" } : { status: "rate_limited", retryAfterMs: transient.wait };
    }
    if (err instanceof ConfigError) {
      // Clave inválida: no tiene sentido reintentar.
      await log(runId, null, "system", "error", `${err.message} Ejecución detenida.`);
      await q(`UPDATE runs SET status = 'failed', summary = $2 WHERE id = $1`, [runId, err.message]);
      await setAgents(runId, { orchestrator: { state: "error", detail: `Detenido: ${err.variable} no válida` } });
      return { status: "finished" };
    }
    const message = err instanceof Error ? err.message : String(err);
    const recent = await q<{ type: string }>(
      `SELECT type FROM events WHERE run_id = $1 AND type <> 'thinking' ORDER BY id DESC LIMIT 2`,
      [runId],
    );
    const giveUp = recent.length === 2 && recent.every((e) => e.type === "error");
    await log(
      runId,
      null,
      "system",
      "error",
      giveUp ? `Error en el paso: ${message}. Tercer fallo seguido: ejecución detenida.` : `Error en el paso: ${message}. Se reintentará.`,
    );
    if (giveUp) {
      await q(`UPDATE runs SET status = 'failed', summary = $2 WHERE id = $1`, [runId, message]);
      await setAgents(runId, {
        orchestrator: { state: "error", detail: "Ejecución detenida por errores repetidos" },
      });
    }
  } finally {
    await q(
      `UPDATE runs SET locked_until = CASE WHEN $2::int > 0 THEN now() + make_interval(secs => $2::int / 1000.0) END,
              updated_at = now() WHERE id = $1`,
      [runId, holdMs],
    );
  }
  return { status: "advanced" };
}

async function stepPlan(run: Run) {
  const files = await loadFiles(run.id);
  await log(run.id, null, "orchestrator", "thinking", "Leyendo la web y dividiendo la petición en tareas…");
  const { plan, usage } = await planTasks(run.request, files);

  for (const [i, t] of plan.tasks.entries()) {
    await q(
      `INSERT INTO tasks (id, run_id, idx, title, description, acceptance, status) VALUES ($1,$2,$3,$4,$5,$6,'pending')`,
      [randomUUID(), run.id, i, t.title, t.description, JSON.stringify(t.acceptance)],
    );
  }
  await log(run.id, null, "orchestrator", "plan", `Plan con ${plan.tasks.length} tareas. ${plan.analysis}`, {
    tasks: plan.tasks.map((t) => t.title),
    ...usageNote(usage),
  });
  await q(`UPDATE runs SET status = 'working' WHERE id = $1`, [run.id]);
  await setAgents(run.id, {
    orchestrator: { state: "waiting", detail: `Plan listo: ${plan.tasks.length} tareas. Coordinando.` },
  });
}

async function stepWork(run: Run) {
  const tasks = await q<Task>(`SELECT * FROM tasks WHERE run_id = $1 ORDER BY idx`, [run.id]);
  const task = tasks.find((t) => t.status !== "passed" && t.status !== "blocked");

  if (!task) return finish(run, tasks);

  const label = `T${task.idx + 1} · ${task.title}`;

  // 1) Orquestador asigna la tarea a Develop
  if (task.status === "pending") {
    await setTask(task.id, { status: "developing" });
    await log(run.id, task.id, "orchestrator", "assign", `Asigna «${task.title}» a Develop`);
    await setAgents(run.id, {
      orchestrator: { state: "waiting", detail: `Supervisando ${label}` },
      developer: { state: "working", detail: `Implementando ${label}` },
      tester: { state: "idle", detail: "Esperando a Develop" },
    });
    return;
  }

  // 2) Develop implementa (o corrige tras un informe de Testing)
  if (task.status === "developing" || task.status === "changes_requested") {
    // Si un paso anterior falló a medias, el informe sigue en last_report: no se pierde.
    const isFix = task.status === "changes_requested" || (task.last_report !== null && !task.last_report.passed);
    if (task.status === "changes_requested") {
      await setTask(task.id, { status: "developing" });
      await setAgents(run.id, {
        developer: { state: "working", detail: `Corrigiendo ${label} (intento ${task.attempts + 1})` },
        tester: { state: "waiting", detail: `Esperando la corrección de ${label}` },
      });
    }
    await log(
      run.id,
      task.id,
      "developer",
      "thinking",
      isFix ? `Corrigiendo los ${failCount(task.last_report)} fallos reportados…` : "Escribiendo el código…",
    );
    const files = await loadFiles(run.id);
    const { result, usage } = await develop(task, files, isFix ? task.last_report : null);
    for (const f of result.files) {
      await q(
        `INSERT INTO files (run_id, path, content) VALUES ($1,$2,$3)
         ON CONFLICT (run_id, path) DO UPDATE SET content = EXCLUDED.content, updated_at = now()`,
        [run.id, f.path, f.content],
      );
    }
    await setTask(task.id, { status: "testing" });
    await log(run.id, task.id, "developer", "code", `${result.summary}`, {
      files: result.files.map((f) => f.path),
      ...usageNote(usage),
    });
    await setAgents(run.id, {
      developer: { state: "waiting", detail: `Entregado ${label}, esperando a Testing` },
      tester: { state: "working", detail: `Probando ${label}` },
    });
    return;
  }

  // 3) Testing comprueba
  if (task.status === "testing") {
    await log(run.id, task.id, "tester", "thinking", "Escribiendo y ejecutando las pruebas…");
    const files = await loadFiles(run.id);
    const { checks: proposed, review, usage } = await test(task, files);
    // Las de Testing se congelan tras la primera ronda; la de enlaces rotos se recalcula siempre.
    const base = task.checks?.length ? task.checks : mergeChecks(contactDemoChecks(task), proposed);
    const checks = mergeChecks(base, siteLinkChecks(files));
    const results = runChecks(checks, files);
    const attempt = task.attempts + 1;
    const passed = results.every((r) => r.passed) && review.approved;
    const report: TestReport = { passed, checks: results, review, attempt };
    const failed = results.filter((r) => !r.passed).length;
    const [delivery] = await q<{ message: string; data: { files?: string[]; usage?: unknown } | null }>(
      `SELECT message, data FROM events WHERE task_id = $1 AND type = 'code' ORDER BY id DESC LIMIT 1`,
      [task.id],
    );
    const entry: Attempt = {
      ...report,
      dev_summary: delivery?.message ?? "",
      files: delivery?.data?.files ?? [],
      dev_model: modelInfo(delivery?.data?.usage),
      test_model: modelInfo(usage),
      at: new Date().toISOString(),
    };
    await q(`UPDATE tasks SET history = history || $2::jsonb WHERE id = $1`, [task.id, JSON.stringify([entry])]);

    if (passed) {
      await setTask(task.id, { status: "passed", attempts: attempt, checks, last_report: report });
      await log(run.id, task.id, "tester", "pass", `✅ ${results.length}/${results.length} pruebas OK y revisión aprobada`, {
        report,
        ...usageNote(usage),
      });
      await setAgents(run.id, {
        tester: { state: "idle", detail: `${label} superada` },
        developer: { state: "idle", detail: "Esperando la siguiente tarea" },
      });
    } else {
      const blocked = attempt >= MAX_ATTEMPTS;
      await setTask(task.id, {
        status: blocked ? "blocked" : "changes_requested",
        attempts: attempt,
        checks,
        last_report: report,
      });
      const issues = [
        failed ? `${failed} prueba(s) fallan` : null,
        review.approved ? null : `${review.issues.length} problema(s) en la revisión`,
      ]
        .filter(Boolean)
        .join(" y ");
      await log(
        run.id,
        task.id,
        "tester",
        "fail",
        blocked
          ? `❌ ${issues}. Se agotaron los ${MAX_ATTEMPTS} intentos: tarea bloqueada.`
          : `❌ ${issues}. Devuelvo la tarea a Develop.`,
        { report, ...usageNote(usage) },
      );
      await setAgents(run.id, {
        tester: { state: blocked ? "idle" : "waiting", detail: blocked ? `${label} bloqueada` : `Fallos reportados en ${label}` },
        developer: blocked
          ? { state: "idle", detail: "Esperando la siguiente tarea" }
          : { state: "working", detail: `Debe corregir ${label}` },
      });
      if (blocked) {
        await log(run.id, task.id, "orchestrator", "escalate", `«${task.title}» queda bloqueada; continúo con el resto.`);
      }
    }
  }
}

async function finish(run: Run, tasks: Task[]) {
  const passed = tasks.filter((t) => t.status === "passed").length;
  const blocked = tasks.length - passed;
  const status = blocked === 0 ? "done" : "done_with_errors";
  const totalAttempts = tasks.reduce((n, t) => n + t.attempts, 0);
  const summary =
    blocked === 0
      ? `Petición completada: ${passed}/${tasks.length} tareas superadas en ${totalAttempts} rondas de testing.`
      : `Terminado con incidencias: ${passed}/${tasks.length} tareas superadas, ${blocked} bloqueadas.`;
  await q(`UPDATE runs SET status = $2, summary = $3 WHERE id = $1`, [run.id, status, summary]);
  await log(run.id, null, "orchestrator", "done", summary);
  await setAgents(run.id, {
    orchestrator: { state: "done", detail: summary },
    developer: { state: "done", detail: "Sin tareas pendientes" },
    tester: { state: "done", detail: "Sin trabajo pendiente" },
  });
}

const failCount = (r: TestReport | null) =>
  r ? r.checks.filter((c) => !c.passed).length + (r.review.approved ? 0 : r.review.issues.length) : 0;
