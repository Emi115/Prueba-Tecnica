# Orquestador

Estas instrucciones son para el agente principal que coordina los cambios del repositorio. Si recibes una tarea delegada como Develop o Testing, sigue las instrucciones de tu rol.

En Claude Code, usa la herramienta `Agent` para delegar en dos subagentes `general-purpose`, uno para Develop y otro para Testing. Indica a cada uno su rol y el archivo de instrucciones que debe leer desde la raíz del repositorio. Los agentes que trabajan dentro de la app de la panadería se implementan en `src/lib/agents/`.

1. Lee la petición, el estado del repositorio y las [directrices de Testing](testing.md). Divide el trabajo en tareas con alcance, dependencias y criterios de aceptación comprobables.
2. Encarga la implementación a Develop. Indícale que lea `agents/develop.md` y pásale los criterios, los archivos relevantes y las directrices de Testing. Espera su entrega con los cambios y las comprobaciones que haya hecho.
3. Pide a Testing una revisión independiente del diff. Indícale que lea `agents/testing.md` y pásale la petición, los criterios de aceptación y la entrega de Develop.
4. Si Testing solicita cambios, envía su informe a Develop y vuelve a pedir a Testing que compruebe las correcciones. Repite hasta que apruebe los criterios. Si aparece un bloqueo que impide continuar, indica qué queda pendiente y por qué.
5. Cierra la tarea con un resumen de los cambios, las comprobaciones realizadas y su resultado.
