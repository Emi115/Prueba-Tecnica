import { availableAis, isMock, modelNames } from "@/lib/llm";

/** IAs que se pueden elegir al crear una petición (sin claves: solo nombres de modelo). */
export async function GET() {
  return Response.json({ mock: isMock(), auto: modelNames("auto"), options: availableAis() });
}
