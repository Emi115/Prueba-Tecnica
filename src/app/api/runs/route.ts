import { createRun, listRuns } from "@/lib/engine";
import { q } from "@/lib/db";

export async function GET() {
  return Response.json(await listRuns());
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { request?: unknown };
  const request = typeof body.request === "string" ? body.request.trim() : "";
  if (request.length < 5 || request.length > 500) {
    return Response.json({ error: "La petición debe tener entre 5 y 500 caracteres" }, { status: 400 });
  }
  // La URL es pública y cada ejecución gasta tokens: límite global sencillo por hora.
  const limit = Number(process.env.RUNS_PER_HOUR ?? 20);
  const [{ n }] = await q<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM runs WHERE created_at > now() - interval '1 hour'`,
  );
  if (n >= limit) {
    return Response.json({ error: `Límite de ${limit} peticiones por hora alcanzado. Prueba más tarde.` }, { status: 429 });
  }
  const id = await createRun(request);
  return Response.json({ id }, { status: 201 });
}
