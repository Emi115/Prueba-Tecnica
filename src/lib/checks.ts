import { load } from "cheerio";
import type { Check, CheckResult } from "./types";

/**
 * Ejecuta de forma determinista las comprobaciones que escribe el agente Testing.
 * El LLM decide QUÉ comprobar; este código decide si pasa o no (sin alucinaciones).
 */
const normalize = (href: string) =>
  href.trim().replace(/^\.\//, "").replace(/^\//, "").split(/[?#]/)[0].toLowerCase();

const isExternal = (href: string) =>
  /^(https?:|mailto:|tel:|#|javascript:|data:)/i.test(href.trim()) || href.trim() === "";

export function runChecks(checks: Check[], files: Record<string, string>): CheckResult[] {
  return checks.map((c) => {
    const result = (passed: boolean, detail: string): CheckResult => ({ ...c, passed, detail });
    const file = normalize(c.file);
    const content = files[file];

    if (c.type === "file_exists") {
      return content !== undefined
        ? result(true, `Existe ${file}`)
        : result(false, `No existe el fichero ${file}`);
    }
    if (content === undefined) return result(false, `No existe el fichero ${file}`);

    const $ = load(content);

    switch (c.type) {
      case "text_contains": {
        const haystack = (file.endsWith(".html") ? $("body").text() || $.text() : content)
          .replace(/\s+/g, " ")
          .toLowerCase();
        const needle = c.value.replace(/\s+/g, " ").toLowerCase().trim();
        return haystack.includes(needle)
          ? result(true, `Encontrado «${c.value}»`)
          : result(false, `No aparece el texto «${c.value}» en ${file}`);
      }
      case "selector_exists": {
        // En un .css no hay elementos que buscar: se comprueba que exista una regla con ese selector.
        if (file.endsWith(".css")) {
          const norm = (s: string) => s.replace(/\s+/g, " ").replace(/\s*([>+~,])\s*/g, "$1").trim().toLowerCase();
          const target = norm(c.selector);
          const selectors = cssSelectors(content).map(norm);
          return selectors.includes(target)
            ? result(true, `Hay una regla para «${c.selector}» en ${file}`)
            : result(false, `No hay ninguna regla CSS para «${c.selector}» en ${file}`);
        }
        let n = 0;
        try {
          n = $(c.selector).length;
        } catch {
          return result(false, `Selector CSS no válido: ${c.selector}`);
        }
        const min = Math.max(1, Number.parseInt(c.value, 10) || 1);
        return n >= min
          ? result(true, `${n} elemento(s) para «${c.selector}»`)
          : result(false, `«${c.selector}» encontrado ${n} vez/veces en ${file} (mínimo ${min})`);
      }
      case "link_to": {
        const target = normalize(c.value);
        // Cuenta enlaces <a>, hojas de estilo <link href> y scripts <script src>:
        // «index.html enlaza a styles.css» se cumple con <link rel="stylesheet" href="styles.css">.
        const hrefs = $("a[href], link[href], script[src]")
          .map((_, el) => normalize($(el).attr("href") ?? $(el).attr("src") ?? ""))
          .get();
        return hrefs.includes(target)
          ? result(true, `${file} enlaza a ${target}`)
          : result(false, `${file} no tiene ningún enlace a ${target}`);
      }
      case "no_broken_links": {
        const broken = $("a[href], link[href], script[src], img[src]")
          .map((_, el) => $(el).attr("href") ?? $(el).attr("src") ?? "")
          .get()
          .filter((h) => !isExternal(h))
          .map(normalize)
          .filter((h) => h && files[h] === undefined);
        return broken.length === 0
          ? result(true, `Sin enlaces rotos en ${file}`)
          : result(false, `Enlaces rotos en ${file}: ${[...new Set(broken)].join(", ")}`);
      }
      case "labels_for_inputs": {
        const unlabeled = $("input:not([type=hidden]):not([type=submit]):not([type=button]), textarea, select")
          .toArray()
          .filter((el) => {
            const id = $(el).attr("id");
            const wrapped = $(el).closest("label").length > 0;
            return !wrapped && !(id && $(`label[for="${id}"]`).length) && !$(el).attr("aria-label");
          })
          .map((el) => `<${el.tagName} name="${$(el).attr("name") ?? "?"}">`);
        return unlabeled.length === 0
          ? result(true, `Todos los campos de ${file} tienen <label>`)
          : result(false, `Campos sin <label> en ${file}: ${unlabeled.join(", ")}`);
      }
      default:
        return result(false, `Tipo de comprobación desconocido: ${String(c.type)}`);
    }
  });
}

/**
 * Comprobaciones fijas de la demo «página de contacto». Se añaden siempre a las
 * que escriba Testing, para que el listón no dependa del LLM.
 */
export function contactDemoChecks(task: { title: string; description: string; acceptance: string[] }): Check[] {
  const text = `${task.title} ${task.description} ${task.acceptance.join(" ")}`.toLowerCase();
  if (!text.includes("contacto")) return [];
  const c = (type: Check["type"], file: string, description: string, selector = "", value = ""): Check => ({
    type,
    file,
    selector,
    value,
    description,
  });
  const checks: Check[] = [];
  if (/formulario|<form|\bform\b/.test(text)) {
    checks.push(
      c("file_exists", "contacto.html", "[demo] Existe contacto.html"),
      c("selector_exists", "contacto.html", "[demo] Hay un <form>", "form", "1"),
      c("selector_exists", "contacto.html", "[demo] Campo de email con type=email", 'form input[type="email"]', "1"),
      c("selector_exists", "contacto.html", "[demo] Campo de mensaje <textarea>", "form textarea", "1"),
      c("selector_exists", "contacto.html", "[demo] Botón de envío", 'form button[type="submit"], form input[type="submit"]', "1"),
      c("labels_for_inputs", "contacto.html", "[demo] Cada campo tiene su <label>"),
      c("selector_exists", "contacto.html", "[demo] Usa la hoja de estilos común", 'link[href="styles.css"]', "1"),
    );
  }
  if (/naveg|enlace|enlaz|men[uú]/.test(text)) {
    checks.push(
      c("link_to", "index.html", "[demo] index.html enlaza a contacto.html", "", "contacto.html"),
      c("link_to", "nosotros.html", "[demo] nosotros.html enlaza a contacto.html", "", "contacto.html"),
      c("no_broken_links", "index.html", "[demo] Sin enlaces rotos en index.html"),
      c("no_broken_links", "contacto.html", "[demo] Sin enlaces rotos en contacto.html"),
    );
  }
  return checks;
}

/**
 * Comprobación fija: ninguna página HTML de la web puede enlazar a un fichero que no existe
 * (p. ej. un botón a noticias.html sin crear esa página). Se genera en cada ronda a partir de
 * los ficheros actuales, para cubrir también las páginas que Develop cree más tarde.
 */
export function siteLinkChecks(files: Record<string, string>): Check[] {
  return Object.keys(files)
    .filter((f) => f.endsWith(".html"))
    .sort()
    .map((file) => ({
      type: "no_broken_links" as const,
      file,
      selector: "",
      value: "",
      description: `[web] Sin enlaces a páginas o ficheros inexistentes en ${file}`,
    }));
}

export function mergeChecks(a: Check[], b: Check[]): Check[] {
  const key = (x: Check) => [x.type, x.file, x.selector, x.value].join("|").toLowerCase();
  const seen = new Set(a.map(key));
  return [...a, ...b.filter((x) => !seen.has(key(x)))];
}

/** Selectores de todas las reglas de una hoja de estilos (incluidas las de dentro de @media). */
export function cssSelectors(css: string): string[] {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: string[] = [];
  for (const m of clean.matchAll(/([^{};]+)\{/g)) {
    const group = m[1].trim();
    if (!group || group.startsWith("@")) continue;
    out.push(...group.split(",").map((s) => s.trim()).filter(Boolean));
  }
  return out;
}
