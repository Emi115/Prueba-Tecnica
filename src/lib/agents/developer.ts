import "server-only";
import { z } from "zod";
import { isMock, structured, type LlmUsage } from "../llm";
import type { Task, TestReport } from "../types";
import { fileTree, taskBlock } from "./shared";

const DevSchema = z.object({
  summary: z.string().describe("Qué has cambiado y por qué, en 1-3 frases"),
  files: z
    .array(
      z.object({
        path: z.string().describe("Ruta relativa, p. ej. contacto.html"),
        content: z.string().describe("Contenido COMPLETO del fichero tras el cambio"),
      }),
    )
    .describe("Solo los ficheros nuevos o modificados"),
});
export type DevResult = z.infer<typeof DevSchema>;

const SYSTEM = `Eres el agente DEVELOP de un equipo de tres agentes. Implementas tareas sobre una web estática (HTML + CSS, sin frameworks ni build).
Reglas:
- Devuelve SOLO los ficheros nuevos o modificados, cada uno con su contenido COMPLETO (no diffs, no "...").
- Rutas relativas planas (p. ej. "contacto.html", "styles.css"). Solo .html, .css o .js.
- Reutiliza la cabecera, navegación, pie y styles.css existentes para que todo sea coherente.
- HTML semántico y accesible (label para cada campo, lang="es").
- Si recibes un informe de Testing, corrige EXACTAMENTE cada fallo indicado sin romper lo que ya funcionaba.`;

const VALID_PATH = /^[a-z0-9][a-z0-9_-]*(\/[a-z0-9_-]+)*\.(html|css|js)$/;

export async function develop(
  task: Task,
  files: Record<string, string>,
  report: TestReport | null,
): Promise<{ result: DevResult; usage: LlmUsage | null }> {
  const raw = isMock() ? mockDevelop(task, files) : null;
  let usage: LlmUsage | null = null;
  let result: DevResult;

  if (raw) {
    result = raw;
  } else {
    const feedback = report
      ? `\n\nINFORME DE TESTING (intento ${report.attempt}) — corrige estos fallos:\n${[
          ...report.checks.filter((c) => !c.passed).map((c) => `- [check ${c.type}${c.selector ? ` «${c.selector}»` : ""} en ${c.file}] ${c.description} → ${c.detail}`),
          ...report.review.issues.map((i) => `- [revisión] ${i}`),
        ].join("\n")}`
      : "";
    const r = await structured({
      schema: DevSchema,
      system: SYSTEM,
      maxTokens: 32000,
      prompt: `${taskBlock(task)}${feedback}\n\nFicheros actuales de la web:\n${fileTree(files, true)}`,
    });
    result = r.data;
    usage = r.usage;
  }

  // Saneamos rutas: los agentes no pueden escribir fuera de la web.
  result.files = result.files
    .map((f) => ({ ...f, path: f.path.trim().replace(/^\.?\//, "").toLowerCase() }))
    .filter((f) => VALID_PATH.test(f.path) && f.content.trim().length > 0);

  return { result, usage };
}

/* ---------- modo simulado: primer intento con un fallo para enseñar el bucle ---------- */
function mockDevelop(task: Task, files: Record<string, string>): DevResult {
  const navLink = `<li><a href="contacto.html">Contacto</a></li>`;
  if (task.idx === 0) {
    const page = files["nosotros.html"]
      .replace(/<title>.*<\/title>/, "<title>Contacto · Panadería La Espiga</title>")
      .replace(/ class="active"/g, "")
      .replace(/<main>[\s\S]*<\/main>/, () =>
        task.attempts === 0
          ? `<main>\n      <section class="content">\n        <h1>Contacto</h1>\n        <p>Escríbenos a hola@laespiga.es</p>\n      </section>\n    </main>`
          : `<main>
      <section class="content">
        <h1>Contacto</h1>
        <p>¿Encargos o dudas? Escríbenos y te respondemos en 24 h.</p>
        <form class="contact-form" action="#" method="post">
          <label for="nombre">Nombre</label>
          <input id="nombre" name="nombre" type="text" required />
          <label for="email">Email</label>
          <input id="email" name="email" type="email" required />
          <label for="mensaje">Mensaje</label>
          <textarea id="mensaje" name="mensaje" rows="5" required></textarea>
          <button class="button" type="submit">Enviar</button>
        </form>
      </section>
    </main>`,
      );
    const css =
      task.attempts === 0
        ? []
        : [
            {
              path: "styles.css",
              content:
                files["styles.css"] +
                `.contact-form { display: grid; gap: .5rem; max-width: 480px; }\n.contact-form input, .contact-form textarea { padding: .6rem; border: 1px solid #eadfce; border-radius: 8px; font: inherit; }\n`,
            },
          ];
    return {
      summary:
        task.attempts === 0
          ? "(simulado) Creada contacto.html con el título y un email de contacto."
          : "(simulado) Añadido el formulario con nombre, email y mensaje y sus estilos.",
      files: [{ path: "contacto.html", content: page }, ...css],
    };
  }
  const withLink = (html: string) =>
    html.includes('href="contacto.html">Contacto') ? html : html.replace("</ul>", `  ${navLink}\n      </ul>`);
  return {
    summary: "(simulado) Añadido «Contacto» a la navegación de todas las páginas.",
    files: ["index.html", "nosotros.html", "contacto.html"]
      .filter((p) => files[p])
      .map((p) => ({ path: p, content: withLink(files[p]) })),
  };
}
