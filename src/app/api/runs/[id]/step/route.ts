import { step } from "@/lib/engine";

// Un paso = como mucho una llamada a un agente. 300 s es el máximo del plan Hobby con Fluid compute.
export const maxDuration = 300;

export async function POST(_req: Request, ctx: RouteContext<"/api/runs/[id]/step">) {
  const { id } = await ctx.params;
  const result = await step(id);
  return Response.json(result, { status: result.status === "busy" ? 409 : 200 });
}
