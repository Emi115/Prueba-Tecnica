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
        "selector_exists: el selector CSS `selector` aparece en `file` al menos `value` veces (value numérico, '1' por defecto). " +
        "link_to: `file` tiene un <a href> a la página `value`. no_broken_links: todos los enlaces locales de `file` apuntan a ficheros existentes. labels_for_inputs: cada campo de formulario de `file` tiene su <label>.",
    ),
  file: z.string().describe("Fichero sobre el que se comprueba"),
  selector: z.string().describe("Selector CSS (solo selector_exists; si no aplica, cadena vacía)"),
  value: z.string().describe("Texto, nº mínimo o página destino según el tipo; cadena vacía si no aplica"),
  description: z.string().describe("Qué criterio de aceptación verifica, en español"),
});

const TestSchema = z.object({
  checks: z.array(CheckSchema).describe("Batería de comprobaciones automáticas para esta tarea (3-10)"),
  review: z.object({
    approved: z
      .boolean()
      .describe("true si el código cumple TODOS los criterios de aceptación de la tarea"),
    issues: z
      .array(z.string())
      .describe("Fallos concretos respecto a los criterios (vacío si approved). Nada de gustos personales."),
  }),
});

const SYSTEM = `Eres el agente TESTING de un equipo de tres agentes. Compruebas el trabajo de Develop sobre una web estática.
Haces dos cosas:
1) Escribes una batería de comprobaciones automáticas (checks) que se ejecutarán con un parser HTML real. Cúbrelas a partir de los criterios de aceptación. Usa selectores CSS estándar (p. ej. 'form', 'input[type="email"]', 'textarea', 'nav a[href="contacto.html"]').
2) Revisas el código como un QA: approved=false SOLO si algún criterio de aceptación no se cumple o algo está claramente roto. No pidas mejoras opcionales.
Responde en español.`;

export async function test(
  task: Task,
  files: Record<string, string>,
): Promise<{ checks: Check[]; review: { approved: boolean; issues: string[] }; usage: LlmUsage | null }> {
  if (isMock()) return { ...mockTest(task, files), usage: null };

  const existing = task.checks?.length
    ? `\n\nYa escribiste estas comprobaciones en la ronda anterior; se reutilizarán tal cual para que el listón no cambie entre rondas, así que devuélvelas igual y céntrate en la revisión:\n${JSON.stringify(task.checks, null, 2)}`
    : "";
  const { data, usage } = await structured({
    schema: TestSchema,
    system: SYSTEM,
    prompt: `${taskBlock(task)}${existing}\n\nFicheros de la web tras el trabajo de Develop:\n${fileTree(files, true)}`,
  });
  return { checks: data.checks, review: data.review, usage };
}

function mockTest(task: Task, files: Record<string, string>) {
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
  const hasForm = files["contacto.html"]?.includes("<form");
  const review =
    task.idx === 0 && !hasForm
      ? { approved: false, issues: ["(simulado) La página no incluye el formulario de contacto pedido."] }
      : { approved: true, issues: [] };
  return { checks: task.checks?.length ? task.checks : checks, review };
}
