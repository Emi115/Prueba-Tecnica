import type { Task } from "../types";

/** Representación de la web que se pasa a los agentes en el prompt. */
export function fileTree(files: Record<string, string>, withContent: boolean): string {
  return Object.entries(files)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, content]) =>
      withContent ? `<file path="${path}">\n${content}\n</file>` : `- ${path} (${content.length} bytes)`,
    )
    .join("\n\n");
}

export function taskBlock(task: Pick<Task, "title" | "description" | "acceptance">): string {
  return `Tarea: ${task.title}\nDescripción: ${task.description}\nCriterios de aceptación:\n${task.acceptance
    .map((a) => `- ${a}`)
    .join("\n")}`;
}
