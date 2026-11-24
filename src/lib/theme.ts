export type Theme = "light" | "dark";
export const THEME_KEY = "theme";

/**
 * Se ejecuta en <head> antes de pintar: aplica el tema guardado o, si no hay, el del sistema.
 * Así no hay destello del tema equivocado al cargar.
 */
export const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem("${THEME_KEY}");if(t!=="light"&&t!=="dark")t=matchMedia("(prefers-color-scheme: light)").matches?"light":"dark";document.documentElement.setAttribute("data-theme",t)}catch(e){}})()`;
