import { load, type CheerioAPI } from "cheerio";
import type { Check, CheckResult } from "./types";

/**
 * Ejecuta de forma determinista las comprobaciones que escribe el agente Testing.
 * El LLM decide QUÉ comprobar; este código decide si pasa o no (sin alucinaciones).
 *
 * Regla de diseño: una comprobación solo debe fallar si la web está mal de verdad. Si falla por
 * cómo está escrita (espacios, comillas, mayúsculas, pseudoclases…), Develop no puede arreglarla y la
 * tarea acaba bloqueada. Por eso todo se normaliza antes de comparar.
 */

/** Ruta local comparable: sin ./ ni / iniciales, sin ?query ni #ancla, decodificada y en minúsculas. */
const normalize = (href: string) => {
  let h = href.trim().split(/[?#]/)[0];
  try {
    h = decodeURIComponent(h);
  } catch {}
  return h.replace(/^(\.\/)+/, "").replace(/^\/+/, "").toLowerCase();
};

/** «noticias/» o «/» apuntan al index.html de esa carpeta. */
const resolvePage = (h: string) => (h === "" || h.endsWith("/") ? `${h}index.html` : h);

/** Cualquier esquema (https:, mailto:, tel:, data:…), URLs que empiezan por // y anclas no son ficheros locales. */
const isExternal = (href: string) => {
  const h = href.trim();
  return h === "" || h.startsWith("#") || h.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(h);
};

/** Texto comparable: minúsculas, comillas tipográficas unificadas y espacios colapsados. */
const normText = (s: string) =>
  s
    .normalize("NFC")
    .replace(/[‘’´`]/g, "'")
    .replace(/[“”«»]/g, '"')
    .replace(/\s+/g, " ")
    .toLowerCase()
    .trim();

/** CSS comparable: sin comentarios ni espacios alrededor de : ; , { } ( ) > + ~ («color: red» = «color:red»). */
const normCss = (s: string) =>
  normText(s.replace(/\/\*[\s\S]*?\*\//g, ""))
    .replace(/\s*([:;,{}()>+~])\s*/g, "$1")
    .replace(/;}/g, "}")
    .replace(/;$/, "");

/** Selector comparable dentro de un .css: espacios, comillas y «::before» = «:before». */
const normSelector = (s: string) =>
  s
    .replace(/\s+/g, " ")
    .replace(/\s*([>+~])\s*/g, "$1")
    .replace(/'/g, '"')
    .replace(/::(before|after|first-line|first-letter)\b/gi, ":$1")
    .trim()
    .toLowerCase();

/**
 * Pseudoclases y pseudoelementos que dependen del usuario o del navegador (:hover, ::before…):
 * en un HTML estático no hay nada que contar, así que se quitan y se comprueba el elemento base.
 */
const DYNAMIC_PSEUDO =
  /::?(hover|focus|focus-visible|focus-within|active|visited|link|any-link|target|checked|disabled|enabled|before|after|placeholder|selection|marker|first-line|first-letter)\b/gi;
const staticSelector = (s: string) =>
  s
    .split(",")
    .map((p) => p.replace(DYNAMIC_PSEUDO, "").trim() || "*")
    .join(", ");

const BLOCK_TAGS =
  "address,article,aside,blockquote,dd,div,dl,dt,fieldset,figcaption,figure,footer,form,h1,h2,h3,h4,h5,h6,header,hr,li,main,nav,ol,p,pre,section,table,td,th,tr,ul,label,button,option";
const TEXT_ATTRS = ["alt", "placeholder", "aria-label", "title", "value"];

/** Texto que ve el usuario: <title>, cuerpo (separando bloques) y atributos visibles (alt, placeholder…). */
function visibleText($: CheerioAPI) {
  const title = $("title").text();
  const attrs = $(TEXT_ATTRS.map((a) => `[${a}]`).join(","))
    .map((_, el) => TEXT_ATTRS.map((a) => $(el).attr(a) ?? "").join(" "))
    .get()
    .join(" ");
  $("script, style, noscript, template, head").remove();
  $("br").replaceWith(" ");
  // Sin esto, «<h1>Horario</h1><p>Lunes</p>» se leería «HorarioLunes».
  $(BLOCK_TAGS).each((_, el) => {
    $(el).prepend(" ").append(" ");
  });
  return `${title} ${$.root().text()} ${attrs}`;
}

export function runChecks(checks: Check[], files: Record<string, string>): CheckResult[] {
  // Búsqueda de ficheros sin distinguir mayúsculas: «Noticias.html» = «noticias.html».
  const byName = new Map(Object.entries(files).map(([path, content]) => [normalize(path), content]));

  return checks.map((c) => {
    const result = (passed: boolean, detail: string): CheckResult => ({ ...c, passed, detail });
    const file = normalize(c.file);
    const content = byName.get(file);

    if (c.type === "file_exists") {
      return content !== undefined
        ? result(true, `Existe ${file}`)
        : result(false, `No existe el fichero ${file}`);
    }
    if (content === undefined) return result(false, `No existe el fichero ${file}`);

    const isCss = file.endsWith(".css");
    const isHtml = /\.html?$/.test(file);
    const $ = load(content);

    switch (c.type) {
      case "text_contains": {
        const [haystack, needle] = isCss
          ? [normCss(content), normCss(c.value)]
          : [normText(isHtml ? visibleText($) : content), normText(c.value)];
        return haystack.includes(needle)
          ? result(true, `Encontrado «${c.value}»`)
          : result(false, `No aparece el texto «${c.value}» en ${file}`);
      }
      case "selector_exists": {
        // En un .css no hay elementos que buscar: se comprueba que exista una regla con ese selector.
        if (isCss) {
          // «footer, .nav a.active» es una lista: cada selector debe tener su regla (juntos o por separado),
          // igual que las reglas del CSS se trocean por comas en cssSelectors.
          const targets = c.selector.split(",").map(normSelector).filter(Boolean);
          const selectors = new Set(cssSelectors(content).map(normSelector));
          const missing = targets.filter((t) => !selectors.has(t));
          return missing.length === 0
            ? result(true, `Hay una regla para «${c.selector}» en ${file}`)
            : result(
                false,
                targets.length > 1
                  ? `No hay ninguna regla CSS para ${missing.map((m) => `«${m}»`).join(", ")} en ${file} (de «${c.selector}»)`
                  : `No hay ninguna regla CSS para «${c.selector}» en ${file}`,
              );
        }
        const selector = staticSelector(c.selector);
        let n = 0;
        try {
          n = $(selector).length;
        } catch {
          return result(false, `Selector CSS no válido: ${c.selector}`);
        }
        const min = Math.max(1, Number.parseInt(c.value, 10) || 1);
        const shown = selector === c.selector ? `«${c.selector}»` : `«${c.selector}» (como «${selector}»)`;
        return n >= min
          ? result(true, `${n} elemento(s) para ${shown}`)
          : result(false, `${shown} encontrado ${n} vez/veces en ${file} (mínimo ${min})`);
      }
      case "link_to": {
        const target = resolvePage(normalize(c.value));
        // Cuenta enlaces <a>, hojas de estilo <link href> y scripts <script src>:
        // «index.html enlaza a styles.css» se cumple con <link rel="stylesheet" href="styles.css">.
        const hrefs = $("a[href], link[href], script[src]")
          .map((_, el) => $(el).attr("href") ?? $(el).attr("src") ?? "")
          .get()
          .filter((h) => !isExternal(h))
          .map((h) => resolvePage(normalize(h)));
        // «contacto» como destino también vale para «contacto.html».
        return hrefs.some((h) => h === target || h === `${target}.html`)
          ? result(true, `${file} enlaza a ${target}`)
          : result(false, `${file} no tiene ningún enlace a ${target}`);
      }
      case "no_broken_links": {
        const broken = $("a[href], link[href], script[src], img[src], source[src]")
          .map((_, el) => $(el).attr("href") ?? $(el).attr("src") ?? "")
          .get()
          .filter((h) => !isExternal(h))
          .map((h) => resolvePage(normalize(h)))
          .filter((h) => !byName.has(h));
        return broken.length === 0
          ? result(true, `Sin enlaces rotos en ${file}`)
          : result(false, `Enlaces rotos en ${file}: ${[...new Set(broken)].join(", ")}`);
      }
      case "labels_for_inputs": {
        const forIds = new Set($("label[for]").map((_, l) => $(l).attr("for")).get());
        const unlabeled = $("input, textarea, select")
          .toArray()
          .filter((el) => !/^(hidden|submit|button|reset|image)$/i.test($(el).attr("type") ?? ""))
          .filter((el) => {
            const id = $(el).attr("id");
            const wrapped = $(el).closest("label").length > 0;
            return !wrapped && !(id && forIds.has(id)) && !$(el).attr("aria-label") && !$(el).attr("aria-labelledby");
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
