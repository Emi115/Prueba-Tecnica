import "server-only";
import { z } from "zod";
import { isMock, structured, type LlmUsage } from "../llm";
import type { Check, Task } from "../types";
import { fileTree, taskBlock } from "./shared";

const CheckSchema = z.object({
  type: z
    .enum(["file_exists", "text_contains", "selector_exists", "link_to", "no_broken_links", "labels_for_inputs"])
    .describe(
      "file_exists: el fichero existe. text_contains: el texto visible de `file` contiene `value`. " +
        "selector_exists: en un .html, el selector CSS `selector` aparece en `file` al menos `value` veces (value numérico, '1' por defecto; :hover, ::before y similares se ignoran porque en HTML estático no existen); en un .css, existe una regla para el selector (con una lista separada por comas, una regla para cada uno). " +
        "link_to: `file` tiene un <a href> a la página `value`. no_broken_links: todos los enlaces locales de `file` apuntan a ficheros existentes. labels_for_inputs: cada campo de formulario de `file` tiene su <label>. " +
        "text_contains en un .css ignora espacios y mayúsculas ('color: #FFF' = 'color:#fff'), pero no equivalencias de color (#0ff ≠ cyan): para comprobar un color, usa el valor exacto que pide el criterio.",
    ),
  file: z.string().describe("Fichero sobre el que se comprueba"),
  selector: z.string().describe("Selector CSS (solo selector_exists; si no aplica, cadena vacía)"),
  value: z.string().describe("Texto, nº mínimo o página destino según el tipo; cadena vacía si no aplica"),
  description: z.string().describe("Qué criterio de aceptación verifica, en español"),
});

const ReviewSchema = z.object({
  approved: z.boolean().describe("true si el código cumple TODOS los criterios de aceptación de esa tarea"),
  issues: z
    .array(z.string())
    .describe("Fallos concretos respecto a los criterios (vacío si approved). Nada de gustos personales."),
});
export type Review = z.infer<typeof ReviewSchema>;

/** Una sola llamada prueba todas las tareas que Develop ha terminado (ahorra llamadas a la API). */
const BatchSchema = z.object({
  results: z
    .array(
      z.object({
        task: z.number().int().describe("Número de la tarea, tal como aparece en su cabecera (T1 → 1)"),
        checks: z
          .array(CheckSchema)
          .describe("Comprobaciones automáticas de esa tarea (3-10); vacío si la tarea ya las tiene escritas"),
        review: ReviewSchema,
      }),
    )
    .describe("Un resultado por cada tarea recibida"),
});

const SYSTEM = `Eres el agente TESTING de un equipo de tres agentes. Compruebas el trabajo de Develop sobre una web estática.
Recibes a la vez TODAS las tareas que Develop ha terminado; devuelve un resultado por tarea, con su número.
Para cada tarea haces dos cosas:
1) Escribes una batería de comprobaciones automáticas (checks) que se ejecutarán con un parser HTML real. Cúbrelas a partir de los criterios de aceptación de ESA tarea. Usa selectores CSS estándar (p. ej. 'form', 'input[type="email"]', 'textarea', 'nav a[href="contacto.html"]'). Si la tarea indica que ya tiene comprobaciones escritas, devuelve checks vacío: se reutilizan tal cual para que el listón no cambie entre rondas.
2) Revisas el código como un QA, solo frente a los criterios de esa tarea: approved=false SOLO si alguno no se cumple o algo está claramente roto. No pidas mejoras opcionales.
Responde en español.`;

export interface TaskTest {
  checks: Check[];
  review: Review;
}

/**
 * Prueba varias tareas con UNA llamada a la IA. Devuelve los resultados por idx de tarea;
 * si la IA se deja alguna, no aparece en el mapa (el motor la vuelve a probar en el siguiente paso).
 */
export async function test(
  tasks: Task[],
  files: Record<string, string>,
): Promise<{ results: Map<number, TaskTest>; usage: LlmUsage | null }> {
  if (isMock()) return { results: new Map(tasks.map((t) => [t.idx, mockTest(t)])), usage: null };

  const blocks = tasks
    .map((t) => {
      const frozen = t.checks?.length
        ? `\n(Ya tiene comprobaciones escritas de la ronda anterior: devuelve checks vacío y céntrate en la revisión.)`
        : "";
      return `### T${t.idx + 1}\n${taskBlock(t)}${frozen}`;
    })
    .join("\n\n");
  const { data, usage } = await structured({
    schema: BatchSchema,
    system: SYSTEM,
    prompt: `Tareas que Develop ha terminado (${tasks.length}):\n\n${blocks}\n\nFicheros de la web tras el trabajo de Develop:\n${fileTree(files, true)}`,
  });
  const byIdx = new Map<number, TaskTest>();
  for (const r of data.results) {
    const task = tasks.find((t) => t.idx === r.task - 1);
    if (task && !byIdx.has(task.idx)) byIdx.set(task.idx, { checks: r.checks, review: r.review });
  }
  return { results: byIdx, usage };
}

function mockTest(task: Task): TaskTest {
  const c = (type: Check["type"], file: string, value: string, description: string, selector = ""): Check => ({
    type,
    file,
    selector,
    value,
    description,
  });
  const checks =
    task.idx === 0
      ? [
          c("file_exists", "contacto.html", "", "Existe contacto.html"),
          c("text_contains", "contacto.html", "Contacto", "Muestra el título Contacto"),
          c("selector_exists", "contacto.html", "1", "Hay un formulario", "form"),
          c("selector_exists", "contacto.html", "1", "Campo email de tipo email", 'input[type="email"]'),
          c("selector_exists", "contacto.html", "1", "Campo de mensaje", "textarea"),
        ]
      : [
          c("link_to", "index.html", "contacto.html", "index.html enlaza a contacto"),
          c("link_to", "nosotros.html", "contacto.html", "nosotros.html enlaza a contacto"),
          c("no_broken_links", "index.html", "", "Sin enlaces rotos en index.html"),
          c("no_broken_links", "contacto.html", "", "Sin enlaces rotos en contacto.html"),
        ];
  // La revisión simulada aprueba: el formulario que falta lo detectan los checks de Cheerio, y así la
  // segunda ronda muestra la re-prueba sin IA (checks ya escritos + revisión aprobada).
  const review = { approved: true, issues: [] as string[] };
  return { checks: task.checks?.length ? task.checks : checks, review };
}
