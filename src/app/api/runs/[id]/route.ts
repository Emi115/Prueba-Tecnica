import { getRun } from "@/lib/engine";
import { isMock, MODEL } from "@/lib/llm";
import { usingLocalDb } from "@/lib/db";

export async function GET(_req: Request, ctx: RouteContext<"/api/runs/[id]">) {
  const { id } = await ctx.params;
  const data = await getRun(id);
  if (!data) return Response.json({ error: "No existe" }, { status: 404 });
  return Response.json({ ...data, meta: { mock: isMock(), model: MODEL, localDb: usingLocalDb() } });
}
