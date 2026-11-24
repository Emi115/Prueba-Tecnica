import { getRun } from "@/lib/engine";
import { isMock, modelNames } from "@/lib/llm";
import { usingLocalDb } from "@/lib/db";

export async function GET(_req: Request, ctx: RouteContext<"/api/runs/[id]">) {
  const { id } = await ctx.params;
  const data = await getRun(id);
  if (!data) return Response.json({ error: "No existe" }, { status: 404 });
  // La cadena de esta petición: la IA elegida sola, o la automática con sus respaldos.
  const ai = data.run.ai ?? "auto";
  const [model, ...fallbacks] = modelNames(ai);
  return Response.json({ ...data, meta: { mock: isMock(), ai, model, fallbacks, localDb: usingLocalDb() } });
}
