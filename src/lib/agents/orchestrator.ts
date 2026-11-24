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
          .describe(
            "Criterios de aceptación verificables mirando el HTML/CSS resultante; entre todas las tareas cubren cada cosa que pide el usuario",
          ),
      }),
    )
    .describe(
      "Entre 1 y 3 tareas, ordenadas y comprobables. Una tarea por CAMBIO, no por fichero: el mismo cambio en varias páginas es una sola tarea",
    ),
});
export type Plan = z.infer<typeof PlanSchema>;

const SYSTEM = `Eres el agente ORQUESTADOR de un equipo de tres agentes (Orquestador, Develop, Testing) que modifica una web estática (HTML + CSS, sin build).

Tu trabajo: recibir la petición del usuario, entender la web actual y dividir el trabajo en tareas pequeñas para Develop.
Reglas:
- Pocas tareas: entre 1 y 3. Cada tarea cuesta llamadas a la IA, así que agrupa por CAMBIO, no por fichero.
  Ejemplo: «añadir categorías al pie» en index.html y en nosotros.html es UNA tarea que nombra los dos ficheros, no dos.
  Separa solo cambios de naturaleza distinta (p. ej. contenido del pie / colores del pie en styles.css). Una petición sencilla = 1 tarea.
- Cada tarea debe poder hacerse y comprobarse sola, en orden.
- Nombra los ficheros exactos que hay que crear o tocar (rutas relativas, p. ej. "contacto.html").
- Los criterios de aceptación deben ser comprobables leyendo el HTML/CSS: ficheros que existen, textos visibles, elementos (form, input[type=email]...), enlaces entre páginas. Nada subjetivo.
- No pierdas nada de la petición: cada cosa que el usuario pide explícitamente (cada producto, botón, opción, estilo o dato) debe aparecer en al menos un criterio. Antes de responder, repasa la petición frase a frase y comprueba que todo está cubierto.
- Criterios concretos, sin escapatorias: nada de «X o algo relacionado» ni «si es posible». Si la petición es ambigua, elige una interpretación concreta y escríbela en el criterio (p. ej. «un desplegable con todos los productos» → «index.html tiene un <select> o un menú desplegable que lista todos los productos»).
- Es una web estática (HTML + CSS, sin servidor ni imágenes subidas): traduce lo que no puede existir a algo visible y comprobable. «Comprar X» → un botón o enlace «Comprar» junto a X; un fondo o ilustración → CSS, emojis o SVG en línea que lo representen de verdad.
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
  return { plan: { ...data, tasks: data.tasks.slice(0, 4) }, usage };
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
