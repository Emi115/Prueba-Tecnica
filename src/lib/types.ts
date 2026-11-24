export type AgentId = "orchestrator" | "developer" | "tester";

export type AgentState = "idle" | "working" | "waiting" | "done" | "error";

export interface AgentStatus {
  state: AgentState;
  detail: string;
}

export type RunStatus = "planning" | "working" | "done" | "done_with_errors" | "failed";

export type TaskStatus =
  | "pending" // creada por el orquestador, sin asignar
  | "developing" // Develop trabajando
  | "testing" // Testing comprobando
  | "changes_requested" // Testing encontró fallos → vuelve a Develop
  | "passed" // todo verde
  | "blocked"; // agotó los intentos

export interface Check {
  type: "file_exists" | "text_contains" | "selector_exists" | "link_to" | "no_broken_links" | "labels_for_inputs";
  file: string;
  selector: string;
  value: string;
  description: string;
}

export interface CheckResult extends Check {
  passed: boolean;
  detail: string;
}

export interface TestReport {
  passed: boolean;
  checks: CheckResult[];
  review: { approved: boolean; issues: string[] };
  attempt: number;
}

/** Qué IA respondió una llamada (y cuáles fallaron antes, si respondió un respaldo). */
export interface ModelInfo {
  provider: "gemini" | "groq" | "mistral";
  model: string;
  skipped?: string[];
}

/** Una ronda completa: lo que entregó Develop y lo que dijo Testing. */
export interface Attempt extends TestReport {
  dev_summary: string;
  files: string[];
  at: string;
  /** IA que respondió por Develop y por Testing en esta ronda (null en modo simulado). */
  dev_model?: ModelInfo | null;
  test_model?: ModelInfo | null;
}

/** IA elegida al crear la petición: «auto» usa la cadena con respaldo; las demás, solo esa IA. */
export type AiChoice = "auto" | "gemini" | "groq" | "mistral";
export const AI_CHOICES: AiChoice[] = ["auto", "gemini", "groq", "mistral"];

export interface Run {
  id: string;
  request: string;
  status: RunStatus;
  ai: AiChoice;
  summary: string | null;
  agents: Record<AgentId, AgentStatus>;
  locked_until: string | null;
  created_at: string;
  updated_at: string;
}

export interface Task {
  id: string;
  run_id: string;
  idx: number;
  title: string;
  description: string;
  acceptance: string[];
  status: TaskStatus;
  attempts: number;
  checks: Check[] | null;
  last_report: TestReport | null;
  history: Attempt[];
  updated_at: string;
}

export interface AgentEvent {
  id: number;
  run_id: string;
  task_id: string | null;
  agent: AgentId | "system";
  type: string;
  message: string;
  data: unknown;
  created_at: string;
}

export interface SiteFile {
  path: string;
  content: string;
  updated_at: string;
}

/** Rondas Develop → Testing por tarea antes de bloquearla. */
export const MAX_ATTEMPTS = 3;
/** 429 seguidos de Gemini antes de detener la ejecución. */
export const MAX_RATE_LIMIT_RETRIES = 3;
/** Reintentos seguidos si Gemini está saturado (5xx) o no responde, antes de detener la ejecución. */
export const MAX_BUSY_RETRIES = 5;
/** Espera entre reintentos cuando Gemini está saturado. */
export const BUSY_WAIT_MS = 15_000;
/** Espera sugerida al panel tras un 429. */
export const RATE_LIMIT_WAIT_MS = 30_000;
