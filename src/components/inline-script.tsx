"use client";

/**
 * Script en línea que solo se ejecuta al cargar la página (HTML del servidor). En el cliente se
 * marca como text/plain para que React no avise de «script tag while rendering»; suppressHydrationWarning
 * acepta esa diferencia de type. Patrón de la guía de Next «Preventing flash before hydration».
 */
export function InlineScript({ html }: { html: string }) {
  return (
    <script
      type={typeof window === "undefined" ? "text/javascript" : "text/plain"}
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
