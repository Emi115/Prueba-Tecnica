import { deleteRun, getRun } from "@/lib/engine";
import { availableAis, isMock, modelNames } from "@/lib/llm";
import { usingLocalDb } from "@/lib/db";

export async function GET(_req: Request, ctx: RouteContext<"/api/runs/[id]">) {
  const { id } = await ctx.params;
  const data = await getRun(id);
  if (!data) return Response.json({ error: "No existe" }, { status: 404 });
  // La cadena de esta petición: la IA elegida sola, o la automática con sus respaldos.
  const ai = data.run.ai ?? "auto";
  // IA elegida que ya no existe (p. ej. Mistral, retirada) o sin clave: se muestra tal cual, sin la cadena actual,
  // que no es la que usó esa petición.
  const aiGone = ai !== "auto" && !availableAis().some((a) => a.id === ai);
  const [model, ...fallbacks] = aiGone ? [ai] : modelNames(ai);
  return Response.json({ ...data, meta: { mock: isMock(), ai, aiGone, model, fallbacks, localDb: usingLocalDb() } });
}

/** Borra la petición con sus tareas, ficheros y eventos (ON DELETE CASCADE). */
export async function DELETE(_req: Request, ctx: RouteContext<"/api/runs/[id]">) {
  const { id } = await ctx.params;
  return (await deleteRun(id))
    ? new Response(null, { status: 204 })
    : Response.json({ error: "No existe" }, { status: 404 });
}
