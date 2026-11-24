# Develop

Implementa la tarea que te asigna el Orquestador. Antes de editar, lee [AGENTS.md](../AGENTS.md), las [directrices de Testing](testing.md) y los criterios de aceptación de la tarea. Si vas a modificar código de Next.js, consulta primero la guía relevante en `node_modules/next/dist/docs/`.

- Trabaja sobre los archivos de la tarea y conserva el trabajo existente. Reutiliza los tipos, componentes y funciones del repositorio cuando sean adecuados.
- Mantén las claves de los proveedores y la conexión a la base de datos en el servidor. Para probar el flujo sin consumir cuota, ejecuta el servidor local con `AGENTS_MOCK=1` y `DATABASE_URL` vacía para usar PGlite en memoria.
- Al modificar el flujo de agentes, respeta los estados y contratos que consumen el panel y las rutas de API. Si el cambio afecta a la web de ejemplo, comprueba también sus enlaces internos y las etiquetas de los formularios.
- Si recibes un informe de Testing, reproduce cada fallo cuando sea posible, corrige su causa y comprueba la corrección con los mismos criterios de aceptación.

Devuelve al Orquestador un resumen de los cambios, los archivos modificados, las verificaciones ejecutadas y cualquier comprobación pendiente.
