"use client";

import { useSyncExternalStore } from "react";
import { THEME_KEY, type Theme } from "@/lib/theme";

const read = (): Theme => (document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark");

function subscribe(onChange: () => void) {
  const obs = new MutationObserver(onChange);
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => obs.disconnect();
}

export function ThemeToggle() {
  // En el servidor no se sabe el tema: hasta hidratar se pinta un botón neutro (null).
  const theme = useSyncExternalStore<Theme | null>(subscribe, read, () => null);
  const next: Theme = theme === "light" ? "dark" : "light";

  function toggle() {
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {}
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={theme ? `Cambiar a modo ${next === "light" ? "claro" : "oscuro"}` : "Cambiar tema"}
      title={theme ? `Modo ${next === "light" ? "claro" : "oscuro"}` : undefined}
      className="inline-flex h-9 items-center gap-2 rounded-full border border-line bg-surface px-3 text-sm text-muted transition-[color,background-color,transform] hover:bg-surface-2 hover:text-fg active:scale-[0.96]"
    >
      <span className="relative h-4 w-4" aria-hidden>
        <SunIcon className={`absolute inset-0 transition-[opacity,transform] duration-200 ${theme === "light" ? "opacity-100" : "scale-50 rotate-90 opacity-0"}`} />
        <MoonIcon className={`absolute inset-0 transition-[opacity,transform] duration-200 ${theme === "dark" ? "opacity-100" : "scale-50 -rotate-90 opacity-0"}`} />
      </span>
      <span className="hidden min-w-[3.25rem] text-left sm:inline">{theme === "light" ? "Claro" : theme === "dark" ? "Oscuro" : ""}</span>
    </button>
  );
}

function SunIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className={className}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}

function MoonIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </svg>
  );
}
