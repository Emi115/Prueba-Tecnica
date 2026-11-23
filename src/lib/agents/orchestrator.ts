import "server-only";
import { z } from "zod";
import { isMock, structured, type LlmUsage } from "../llm";
import { fileTree } from "./shared";

export const PlanSchema = z.object({
  analysis: z.string().describe("Breve análisis de la petición y de la web actual (2-4 frases)"),
  tasks: z
    .array(
      z.object({
        title: z.string().describe("Título corto e imperativo"),
        description: z.string().describe("Qué debe hacer Develop, con ficheros concretos"),
        acceptance: z
          .array(z.string())
          .describe("Criterios de aceptación verificables mirando el HTML/CSS resultante"),
      }),
    )
    .describe("Entre 1 y 5 tareas, ordenadas, cada una independiente y comprobable"),
});
export type Plan = z.infer<typeof PlanSchema>;

const SYSTEM = `Eres el agente ORQUESTADOR de un equipo de tres agentes (Orquestador, Develop, Testing) que modifica una web estática (HTML + CSS, sin build).

Tu trabajo: recibir la petición del usuario, entender la web actual y dividir el trabajo en tareas pequeñas para Develop.
Reglas:
- Entre 1 y 5 tareas. Cada tarea debe poder hacerse y comprobarse sola, en orden.
- Nombra los ficheros exactos que hay que crear o tocar (rutas relativas, p. ej. "contacto.html").
- Los criterios de aceptación deben ser comprobables leyendo el HTML/CSS: ficheros que existen, textos visibles, elementos (form, input[type=email]...), enlaces entre páginas. Nada subjetivo.
- Mantén el estilo y la estructura de la web existente (misma cabecera, navegación, pie y styles.css).
- Escribe en español.`;

export async function planTasks(
  request: string,
  files: Record<string, string>,
): Promise<{ plan: Plan; usage: LlmUsage | null }> {
  if (isMock()) return { plan: mockPlan(request), usage: null };

  const { data, usage } = await structured({
    schema: PlanSchema,
    system: SYSTEM,
    prompt: `Petición del usuario:\n"""${request}"""\n\nFicheros actuales de la web:\n${fileTree(files, true)}`,
  });
  return { plan: { ...data, tasks: data.tasks.slice(0, 5) }, usage };
}

function mockPlan(request: string): Plan {
  return {
    analysis: `(modo simulado) Petición: «${request}». La web tiene index.html, nosotros.html y styles.css con una navegación común.`,
    tasks: [
      {
        title: "Crear la página de contacto",
        description:
          "Crear contacto.html con la misma cabecera y pie que el resto, un título «Contacto» y un formulario con nombre, email y mensaje.",
        acceptance: [
          "Existe contacto.html",
          "contacto.html contiene un <form> con campos nombre, email (type=email) y mensaje (textarea)",
          "contacto.html muestra el título «Contacto»",
        ],
      },
      {
        title: "Enlazar Contacto desde la navegación",
        description: "Añadir el enlace «Contacto» a la navegación de index.html, nosotros.html y contacto.html.",
        acceptance: [
          "index.html enlaza a contacto.html",
          "nosotros.html enlaza a contacto.html",
          "Ninguna página tiene enlaces rotos",
        ],
      },
    ],
  };
}
