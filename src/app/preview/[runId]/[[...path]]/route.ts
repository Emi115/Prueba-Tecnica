import { q } from "@/lib/db";

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
};

/** Sirve la web generada por los agentes (desde la BD) para verla en un iframe. */
export async function GET(_req: Request, ctx: RouteContext<"/preview/[runId]/[[...path]]">) {
  const { runId, path } = await ctx.params;
  const file = path?.length ? path.join("/").toLowerCase() : "index.html";
  const [row] = await q<{ content: string }>(`SELECT content FROM files WHERE run_id = $1 AND path = $2`, [
    runId,
    file,
  ]);
  if (!row) return new Response(`404 · ${file} no existe (todavía)`, { status: 404 });
  const ext = file.split(".").pop() ?? "";
  return new Response(row.content, {
    headers: {
      "content-type": TYPES[ext] ?? "text/plain; charset=utf-8",
      "cache-control": "no-store",
      // El HTML lo escribe un LLM: lo aislamos (sin scripts ni acceso al origen del panel).
      "content-security-policy": "sandbox allow-same-origin; script-src 'none'",
    },
  });
}
