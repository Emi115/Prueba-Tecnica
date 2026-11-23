/**
 * Web de partida sobre la que trabaja el equipo de agentes.
 * Cada petición recibe su propia copia (tabla `files`) para que los cambios
 * de una ejecución no afecten a otra.
 */
const nav = (active: string) => `
    <nav class="nav">
      <a href="index.html" class="brand">La Espiga</a>
      <ul>
        <li><a href="index.html"${active === "index" ? ' class="active"' : ""}>Inicio</a></li>
        <li><a href="nosotros.html"${active === "nosotros" ? ' class="active"' : ""}>Nosotros</a></li>
      </ul>
    </nav>`;

export const BASE_SITE: Record<string, string> = {
  "index.html": `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Panadería La Espiga</title>
    <link rel="stylesheet" href="styles.css" />
  </head>
  <body>
    <header>${nav("index")}
    </header>
    <main>
      <section class="hero">
        <h1>Pan de masa madre, cada mañana</h1>
        <p>Horneamos en Valencia desde 1987 con harinas ecológicas y fermentaciones largas.</p>
        <a class="button" href="nosotros.html">Conócenos</a>
      </section>
      <section class="grid">
        <article class="card">
          <h2>Hogaza rústica</h2>
          <p>Corteza crujiente y miga alveolada. 24 horas de fermentación.</p>
        </article>
        <article class="card">
          <h2>Croissant de mantequilla</h2>
          <p>Laminado a mano con mantequilla AOP.</p>
        </article>
        <article class="card">
          <h2>Tarta de queso</h2>
          <p>Cremosa por dentro, tostada por fuera.</p>
        </article>
      </section>
    </main>
    <footer>
      <p>© Panadería La Espiga · Calle del Horno 12, Valencia</p>
    </footer>
  </body>
</html>
`,
  "nosotros.html": `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Nosotros · Panadería La Espiga</title>
    <link rel="stylesheet" href="styles.css" />
  </head>
  <body>
    <header>${nav("nosotros")}
    </header>
    <main>
      <section class="content">
        <h1>Nuestra historia</h1>
        <p>La Espiga nació como un pequeño obrador familiar. Hoy seguimos amasando a mano y apostando por el producto local.</p>
        <p>Abrimos de martes a domingo, de 7:30 a 14:30.</p>
      </section>
    </main>
    <footer>
      <p>© Panadería La Espiga · Calle del Horno 12, Valencia</p>
    </footer>
  </body>
</html>
`,
  "styles.css": `* { box-sizing: border-box; }
body { margin: 0; font-family: system-ui, sans-serif; color: #2b2118; background: #fffaf3; line-height: 1.6; }
.nav { display: flex; justify-content: space-between; align-items: center; padding: 1rem 2rem; background: #2b2118; }
.nav a { color: #fffaf3; text-decoration: none; }
.nav ul { display: flex; gap: 1.5rem; list-style: none; margin: 0; padding: 0; }
.nav a.active { border-bottom: 2px solid #e0a84f; }
.brand { font-weight: 700; font-size: 1.25rem; }
main { max-width: 960px; margin: 0 auto; padding: 2rem; }
.hero { text-align: center; padding: 3rem 1rem; }
.hero h1 { font-size: 2.25rem; margin: 0 0 .5rem; }
.button { display: inline-block; margin-top: 1rem; padding: .75rem 1.5rem; background: #e0a84f; color: #2b2118; border-radius: 999px; text-decoration: none; font-weight: 600; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1rem; }
.card { background: #fff; border: 1px solid #eadfce; border-radius: 12px; padding: 1.25rem; }
.content { max-width: 680px; }
footer { text-align: center; padding: 2rem; color: #7a6a58; font-size: .9rem; }
`,
};
