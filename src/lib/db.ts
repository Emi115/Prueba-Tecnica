import "server-only";
import { neon } from "@neondatabase/serverless";

/**
 * Capa mínima de acceso a datos.
 * - Producción (Vercel): Neon Postgres vía DATABASE_URL (driver HTTP serverless).
 * - Local sin DATABASE_URL: PGlite (Postgres en WASM, en memoria) para poder
 *   desarrollar y probar sin crear cuentas.
 */
type Row = Record<string, unknown>;
type QueryFn = (text: string, params?: unknown[]) => Promise<Row[]>;

let queryFn: QueryFn | null = null;
let schemaReady: Promise<void> | null = null;

async function getQuery(): Promise<QueryFn> {
  if (queryFn) return queryFn;
  const url = databaseUrl();
  if (url) {
    const sql = neon(url);
    queryFn = async (text, params = []) => (await sql.query(text, params)) as Row[];
  } else {
    const g = globalThis as unknown as { __pglite?: Promise<QueryFn> };
    g.__pglite ??= (async () => {
      const { PGlite } = await import("@electric-sql/pglite");
      const db = new PGlite();
      return async (text: string, params: unknown[] = []) =>
        (await db.query<Row>(text, params)).rows;
    })();
    queryFn = await g.__pglite;
  }
  return queryFn;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS runs (
     id TEXT PRIMARY KEY,
     request TEXT NOT NULL,
     status TEXT NOT NULL,
     summary TEXT,
     agents JSONB NOT NULL DEFAULT '{}'::jsonb,
     locked_until TIMESTAMPTZ,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS tasks (
     id TEXT PRIMARY KEY,
     run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
     idx INT NOT NULL,
     title TEXT NOT NULL,
     description TEXT NOT NULL,
     acceptance JSONB NOT NULL DEFAULT '[]'::jsonb,
     status TEXT NOT NULL,
     attempts INT NOT NULL DEFAULT 0,
     checks JSONB,
     last_report JSONB,
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS tasks_run_idx ON tasks(run_id, idx)`,
  // Historial de intentos (Develop entrega → Testing evalúa), uno por ronda.
  `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS history JSONB NOT NULL DEFAULT '[]'::jsonb`,
  // IA elegida al crear la petición ('auto' = cadena con respaldo). Las peticiones antiguas quedan en 'auto'.
  `ALTER TABLE runs ADD COLUMN IF NOT EXISTS ai TEXT NOT NULL DEFAULT 'auto'`,
  `CREATE TABLE IF NOT EXISTS files (
     run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
     path TEXT NOT NULL,
     content TEXT NOT NULL,
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     PRIMARY KEY (run_id, path)
   )`,
  `CREATE TABLE IF NOT EXISTS events (
     id BIGSERIAL PRIMARY KEY,
     run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
     task_id TEXT,
     agent TEXT NOT NULL,
     type TEXT NOT NULL,
     message TEXT NOT NULL,
     data JSONB,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS events_run_idx ON events(run_id, id)`,
];

export async function q<T = Row>(text: string, params: unknown[] = []): Promise<T[]> {
  const query = await getQuery();
  schemaReady ??= (async () => {
    for (const stmt of SCHEMA) await query(stmt);
  })();
  await schemaReady;
  return (await query(text, params)) as T[];
}

export const usingLocalDb = () => !databaseUrl();

/** La URL de ejemplo de .env.example (ep-ejemplo-…) cuenta como "sin base de datos" → PGlite. */
function databaseUrl() {
  const url = process.env.DATABASE_URL;
  return url && !url.includes("ep-ejemplo") ? url : undefined;
}
