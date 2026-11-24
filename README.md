# Equipo de 3 agentes de IA · Orquestador, Develop y Testing

Pides un cambio para una web de ejemplo (una panadería: `index.html`, `nosotros.html`, `styles.css`), por ejemplo
«añade una página de contacto a esta web», y tres agentes trabajan sobre ella mientras ves en pantalla qué hace
cada uno y en qué estado está cada tarea.

- **Demo:** _URL de Vercel aquí_
- **Stack:** Next.js 16 (App Router) · Gemini API (`@google/genai`, `gemini-3.1-flash-lite`) · Neon Postgres · Vercel

## Cómo funciona

```
Petición ──► ORQUESTADOR ──► tareas (con criterios de aceptación)
                 │
                 ▼  asigna la siguiente tarea
             DEVELOP ──► reescribe los ficheros de la web (en BD)
                 ▲              │
   informe de    │              ▼
   fallos        └──────── TESTING ──► escribe checks + revisa el código
   (máx. 3 rondas)                     ejecuta los checks con un parser HTML real
                                       ✓ todo pasa → tarea superada → siguiente tarea
```

| Agente | Qué hace | Salida (JSON validado con zod) |
|---|---|---|
| **Orquestador** | Lee la petición y la web, la divide en 1-5 tareas ordenadas con criterios de aceptación comprobables, asigna cada tarea a Develop, escala las bloqueadas y cierra la ejecución con un resumen. | `{ analysis, tasks[{title, description, acceptance[]}] }` |
| **Develop** | Implementa la tarea devolviendo los ficheros completos que crea o modifica. Si recibe un informe de Testing, corrige exactamente esos fallos. | `{ summary, files[{path, content}] }` |
| **Testing** | Escribe una batería de comprobaciones (`file_exists`, `text_contains`, `selector_exists`, `link_to`, `no_broken_links`, `labels_for_inputs`) y hace una revisión de QA. Los checks **no los evalúa el LLM**: se ejecutan con `cheerio` sobre el HTML real ([src/lib/checks.ts](src/lib/checks.ts)). La tarea pasa solo si todos los checks pasan y la revisión la aprueba. | `{ checks[], review{approved, issues[]} }` |

Los checks se fijan en la primera ronda y se reutilizan en las siguientes, para que el listón no cambie mientras
Develop corrige. Tras 3 rondas fallidas la tarea queda **bloqueada** y el Orquestador sigue con el resto.

Además, en cada ronda se añade un `no_broken_links` (marcado `[web]`) para **todas** las páginas HTML que existan
en ese momento: ninguna puede enlazar a una página o fichero que no exista (p. ej. un botón a `noticias.html` sin
haber creado esa página). Se recalcula en cada ronda para cubrir también las páginas nuevas.

### Demo «página de contacto»: Testing con Cheerio

Si la tarea habla de la página de contacto, Testing añade siempre unas comprobaciones fijas (marcadas `[demo]`)
que se ejecutan con Cheerio sobre `contacto.html`: existe el fichero, hay un `<form>`, un `input[type="email"]`,
un `<textarea>`, botón de envío, cada campo con su `<label>`, usa `styles.css`, y el menú de `index.html` y
`nosotros.html` enlaza a `contacto.html` sin enlaces rotos. Cada fallo vuelve a Develop con el tipo de check, el
selector, el fichero y el detalle exacto (p. ej. `Campos sin <label> en contacto.html: <input name="email">`).

Cada ronda queda guardada en `tasks.history` (resumen de Develop, ficheros tocados y resultado check a check), y
el panel la muestra como «Intentos #1, #2…» al pulsar la tarea.

### Gemini, IA de respaldo y los 429

- `GEMINI_API_KEY`, `GROQ_API_KEY` y `MISTRAL_API_KEY` se leen solo en el servidor ([src/lib/llm.ts](src/lib/llm.ts), módulo `server-only`); nunca llegan al navegador.
- **Cadena de respaldo.** Cada llamada prueba en orden, y solo pasa al siguiente si el fallo es temporal
  (503/saturado, sin respuesta a tiempo, 429 o modelo no disponible):
  1. `gemini-3.1-flash-lite` (`GEMINI_MODEL`), con un reintento propio.
  2. **Groq** `openai/gpt-oss-120b` (`GROQ_MODEL`), gratis y sin tarjeta, solo si hay `GROQ_API_KEY`
     (https://console.groq.com/keys). Se llama con `fetch` a su API compatible con OpenAI y el JSON se valida
     con los mismos esquemas Zod.
  3. **Mistral** `mistral-small-latest` (`MISTRAL_MODEL`), plan gratuito «Experiment» sin tarjeta, solo si hay
     `MISTRAL_API_KEY` (https://console.mistral.ai/api-keys). Misma API compatible con OpenAI y la misma función
     que Groq. Otra empresa y otra infraestructura: es poco probable que falle a la vez que Google y Groq.

  Cada mensaje del panel lleva una etiqueta con la IA que respondió (azul Gemini, naranja Groq, rosa Mistral, y «respaldo»
  si el principal falló; al pasar el ratón se ve qué falló). También en cada agente y en cada intento. La cabecera
  muestra la cadena configurada. Una clave inválida **no** pasa al siguiente: detiene la ejecución con un mensaje claro.
- Presupuesto de tiempo: toda la cadena (cuatro modelos) cabe en ~230 s, por debajo del lock (280 s) y de los 300 s de una función de Vercel.
- Si **ninguna** IA responde, el motor reintenta el paso hasta 5 veces seguidas con 15 s de espera
  («Ninguna IA ha respondido… Reintento 2/5») y solo entonces detiene la ejecución.
- Si todas devuelven 429, el panel muestra un banner «Límite de peticiones alcanzado (429)» y reintenta tras 30 s,
  como máximo 3 veces seguidas; después detiene la ejecución con un mensaje claro.

### Estados

- **Tarea:** `pending` → `developing` → `testing` → (`changes_requested` → `developing` → `testing`)* → `passed` | `blocked`
- **Agente:** `En espera` · `Trabajando` · `Esperando` · `Terminado` · `Error`
- **Petición:** `Planificando` → `En curso` → `Completada` | `Con incidencias` | `Fallida`

### Ejecución en Vercel (sin colas ni workers)

Cada llamada a `POST /api/runs/:id/step` avanza la ejecución **un paso** (como mucho una llamada a un agente), así
cada función serverless es corta. El panel llama a `/step` en bucle mientras la ejecución está viva y consulta el
estado cada 1,5 s. Un *lock* en la base de datos (`runs.locked_until`) impide que dos pestañas avancen la misma
ejecución a la vez. Si cierras la pestaña, la ejecución se pausa y continúa al volver a abrirla.

### Base de datos (Neon Postgres)

| Tabla | Contenido |
|---|---|
| `runs` | petición, estado, resumen y estado de cada agente (`agents` JSONB) |
| `tasks` | tareas, criterios, nº de rondas, checks, último informe y `history` (todos los intentos) |
| `files` | la copia de la web de cada ejecución (lo que escribe Develop) |
| `events` | registro de actividad de cada agente (lo que se ve en el panel), con uso de tokens |

El esquema se crea solo en la primera consulta ([src/lib/db.ts](src/lib/db.ts)). En local, sin `DATABASE_URL`, se
usa PGlite (Postgres en memoria) para poder probar sin crear cuentas.

### Pantalla

- Tarjetas de los 3 agentes con su estado en vivo y lo último que han hecho.
- Tablero de tareas: Pendiente · En desarrollo · En testing · Con fallos · Terminadas, con la ronda (`2/3`) y los checks que pasan.
- Al pulsar una tarea: criterios de aceptación, historial y cada intento con su resultado check a check.
- Banner de aviso si las IAs devuelven 429, y qué IA de respaldo respondió cuando la principal falla.
- Registro de actividad de todos los agentes.
- La web resultante en vivo (iframe aislado) y su código.

## Ejecutar en local

```bash
npm install
cp .env.example .env.local   # pon tu GEMINI_API_KEY (o bórrala para el modo simulado)
npm run dev
```

Sin `GEMINI_API_KEY` funciona en **modo simulado**: agentes deterministas que reproducen el ciclo completo
(Develop entrega primero una página sin formulario, Testing lo detecta y se corrige en la segunda ronda).

## Desplegar en Vercel

1. Sube el repo a GitHub e impórtalo en Vercel (o `npx vercel`).
2. En el proyecto de Vercel: **Storage → Create → Neon** (plan gratuito). Crea `DATABASE_URL` sola.
3. **Settings → Environment Variables:** `GEMINI_API_KEY` (de https://aistudio.google.com/apikey), `GROQ_API_KEY`
   y `MISTRAL_API_KEY` (opcionales, de https://console.groq.com/keys y https://console.mistral.ai/api-keys, para
   las IAs de respaldo) y, opcionales, `GEMINI_MODEL`, `GROQ_MODEL` y `MISTRAL_MODEL`.
4. Redeploy.

## Cómo usé Claude Code

Todo el proyecto se programó con **Claude Code** (app de escritorio), en una sesión conversacional:

1. **Requisitos y decisiones.** Le pasé el enunciado; Claude Code me preguntó la base de datos (Neon), el proveedor de LLM y el modelo. Empezamos con la API de Claude y después le pedí migrar a Gemini (`@google/genai`, `gemini-3.1-flash-lite`) reutilizando Neon, los esquemas Zod y el flujo de agentes.
2. **Documentación al día.** Leyó los tipos del SDK `@google/genai` instalado (salida JSON con `responseJsonSchema` generado desde Zod, `ApiError` para detectar 429, opciones de reintento) y leyó la documentación de Next.js 16 incluida en `node_modules/next/dist/docs` (el `AGENTS.md` del proyecto lo pide, porque la versión cambia APIs).
3. **Arquitectura.** Propuso el diseño "un paso por petición" para encajar en los límites de las funciones de Vercel, y separar *qué probar* (LLM) de *si pasa* (código determinista) para que Testing no alucine resultados.
4. **Verificación.** Añadió un modo simulado y PGlite para probar el flujo completo sin claves; levantó el servidor de desarrollo y comprobó en el navegador integrado el ciclo fallo → corrección → superada, el tablero y la web generada.
5. **Revisión humana.** Yo revisé el plan, los prompts de cada agente y el resultado en pantalla, y pedí los ajustes.

## Estructura

```
src/lib/agents/orchestrator.ts   prompt + esquema del Orquestador
src/lib/agents/developer.ts      prompt + esquema de Develop
src/lib/agents/tester.ts         prompt + esquema de Testing
src/lib/engine.ts                máquina de estados (un paso por llamada)
src/lib/checks.ts                ejecución determinista de los checks
src/lib/llm.ts                   cliente de IA: Gemini + respaldo (Gemini Flash, Groq, Mistral), JSON + Zod, 429
src/lib/db.ts                    Neon / PGlite + esquema
src/components/run-dashboard.tsx panel en vivo
src/app/api/runs/…               API (crear, estado, paso)
src/app/preview/[runId]/…        sirve la web generada
```
