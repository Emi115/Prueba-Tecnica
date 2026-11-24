import { createRun, listRuns } from "@/lib/engine";
import { q } from "@/lib/db";
import { availableAis } from "@/lib/llm";
import { AI_CHOICES, type AiChoice } from "@/lib/types";

export async function GET() {
  return Response.json(await listRuns());
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { request?: unknown; ai?: unknown };
  const request = typeof body.request === "string" ? body.request.trim() : "";
  if (request.length < 5 || request.length > 500) {
    return Response.json({ error: "La petición debe tener entre 5 y 500 caracteres" }, { status: 400 });
  }
  // IA elegida: «auto» si no se indica; una IA sin clave configurada no se acepta.
  const ai = (body.ai ?? "auto") as AiChoice;
  if (!AI_CHOICES.includes(ai) || (ai !== "auto" && !availableAis().some((a) => a.id === ai))) {
    return Response.json({ error: "Esa IA no está disponible en este servidor" }, { status: 400 });
  }
  // La URL es pública y cada ejecución gasta tokens: límite global sencillo por hora.
  const limit = Number(process.env.RUNS_PER_HOUR ?? 20);
  const [{ n }] = await q<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM runs WHERE created_at > now() - interval '1 hour'`,
  );
  if (n >= limit) {
    return Response.json({ error: `Límite de ${limit} peticiones por hora alcanzado. Prueba más tarde.` }, { status: 429 });
  }
  const id = await createRun(request, ai);
  return Response.json({ id }, { status: 201 });
}
