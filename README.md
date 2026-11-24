# Una web de panadería y tres agentes de IA

Hice esta prueba técnica para enseñar cómo pueden trabajar juntos tres agentes de IA. Escribes un cambio para la web de una panadería, por ejemplo «Añade una página de contacto», y ves en directo cómo se reparten el trabajo. Desde el panel puedes comparar la web original con la versión nueva y ver el código.

## Cómo funciona 

1. **Orquestador.** Lee lo que has pedido, lo divide en tareas y deja claro qué tiene que cumplirse en cada una.
2. **Develop.** Hace los cambios en una copia de la web y cuenta qué ha tocado.
3. **Testing.** Revisa todas las tareas juntas. Si algo falla, le dice a Develop qué tiene que corregir. Si una tarea sigue fallando después de tres intentos, queda marcada como bloqueada.

Con el ejemplo de contacto, Testing comprueba que la página tenga un formulario con un campo de correo, un espacio para el mensaje y un botón de envío. También revisa que el menú lleve a la nueva página y que los enlaces funcionen. La IA propone qué revisar y el programa comprueba si se cumple leyendo el código de la web.

En el panel puedes ver qué está haciendo cada agente y abrir cualquier tarea para ver qué se comprobó, qué falló y qué se corrigió en cada intento. Si cierras la pestaña, el trabajo se pausa y sigue cuando vuelves a abrirla.

## Cómo probarlo en tu ordenador

Con Node.js instalado, abre una terminal en la carpeta del proyecto y ejecuta:

~~~bash
npm install
npm run dev
~~~

Abre [http://localhost:3000](http://localhost:3000) y prueba con «Añade una página de contacto». El modo simulado funciona sin claves y reproduce ese ejemplo. En el primer intento falta el formulario, Testing lo detecta y Develop lo añade en la segunda ronda.

Para usar la IA, copia [.env.example](.env.example) como `.env.local` y pon tu clave en `GEMINI_API_KEY`. Reinicia el servidor si ya estaba abierto. También puedes configurar Groq y OpenRouter como respaldo con sus propias claves. En la portada puedes elegir un proveedor o dejar «Automático» para que el sistema pruebe el siguiente si hay un fallo temporal.

## Cómo lo hice

Usé Claude Code para pasar del enunciado a una primera versión y fui pidiendo cambios según lo que veía en pantalla. Empezamos con la API de Claude y luego pasamos a Gemini. Revisé el plan, las instrucciones de cada agente y el resultado de la web.

El panel está hecho con **Next.js**. Para guardar las peticiones, las tareas y los cambios de la web, el proyecto usa **Neon Postgres**. En local, si no configuras una base de datos, usa **PGlite** y guarda los datos en memoria.

Para publicarlo, importa el repositorio en **Vercel**, conecta una base de datos Neon y configura `DATABASE_URL` y `GEMINI_API_KEY` como variables de entorno. Si quieres activar los respaldos, añade también `GROQ_API_KEY` y `OPENROUTER_API_KEY`.

Dejé los detalles de la arquitectura, los reintentos y la estructura del código en el [README original](README.original.md).
