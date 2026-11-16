# Regresión mínima — 2.1b, Bloque A

Scripts compatibles con Node 16; no requieren nuevos paquetes. No arrancan servicios,
no construyen artefactos y no ejecutan loaders. Ejecutar desde `src/`, con el baseline
ya disponible. `npm test` falla si el servicio/corpus no está disponible: no lo omite.

## Smoke de sólo lectura

```bash
npm test
# Equivalente:
npm run test:smoke
```

Sólo GET: `/`, scripts/estilos referidos en el index, `/search?task=task01`,
`/v1/flows/flow1`, `/v1/tasks/task01`, `/v1/tasks/task02`,
`/v1/forms/fetch/pretask`, `/v1/search?q=javascript&p=1` y el HTML local de `doc01`.
Comprueba tipos de respuesta, definición de flow1, preguntas resueltas, ranking,
path `/assets/documents/doc01/…` y que el documento no sea el fallback de la SPA.
No ejecuta JavaScript del navegador ni genera Actions/PageEnter.

Opciones por entorno:

| Variable | Default / uso |
|---|---|
| `REGRESSION_BASE_URL` | `http://localhost:3000` (origen sin ruta) |
| `REGRESSION_TIMEOUT_MS` | `5000`, máximo `60000` |
| `REGRESSION_FLOW` | `flow1` |
| `REGRESSION_QUERY` | `javascript`, keyword del corpus versionado |
| `REGRESSION_DOCUMENT` | `doc01`, debe aparecer en la primera página |
| `REGRESSION_DOCUMENT_PATH` | Opcional: exigir también un path exacto |

La query/path se basan en `extras/load-example-content.sh`; no certifican que ese
contenido esté cargado en una instancia concreta. El test conserva los contratos
del baseline; cambiar sus expectativas requiere una decisión explícita.

## Identidad y persistencia (separadas del smoke)

Usa Mongoose ya declarado en el proyecto, directamente con colecciones, sin importar
modelos/conexiones del servidor ni crear índices. Las conexiones Mongo deben apuntar
a las mismas dos bases que la API. Los scripts no cargan automáticamente `.env`.

Configurar en la shell (no guardar secretos en Git):

```bash
export REGRESSION_MONGO_DATA_URL='mongodb://localhost:3010/leticia-data'
export REGRESSION_MONGO_USER_URL='mongodb://localhost:3010/leticia-user'
export REGRESSION_EMAIL='regression-baseline@leticia.invalid'
# Ajustar host/puerto según el lugar desde donde se ejecuta el script.
npm run test:persistence
```

Sin flags es sólo lectura: verifica una cuenta reservada existente, User,
Credential, UserData y correspondencia del snapshot API/Mongo. Falla si no existe.

Para la primera creación, **sólo en el entorno de regresión**:

```bash
read -rs -p 'Password de prueba (mínimo 12 caracteres): ' REGRESSION_PASSWORD
export REGRESSION_PASSWORD
export REGRESSION_ALLOW_WRITES=1
npm run test:persistence -- --write --create-account
```

Para repetir las escrituras con la misma cuenta:

```bash
npm run test:persistence -- --write
```

`--create-account` sólo registra si la cuenta no existe. Sin ese flag nunca registra.
No se generan emails aleatorios: se reutiliza una cuenta. LETICIA genera su username
pseudónimo; el test no cambia esa función para imponer un prefijo. Se reconoce la
identidad por el email reservado `regression-…@leticia.invalid` y los marcadores.
No usar esta cuenta para el E2E manual ni con participantes. No ejecutar dos
instancias del script simultáneamente ni utilizar la cuenta desde otro navegador.

El modo escritura rechaza cuentas con estado/actividad experimental ajenos al test.
Verifica el vínculo API/Mongo antes de reemplazar el snapshot. No hay reintentos de
POST ni borrados automáticos: una ejecución fallida puede dejar escrituras parciales.

### Qué queda persistido

| Operación | Registros |
|---|---|
| Primera creación explícita | 1 `users`, 1 `credentials`, 1 `userdata` |
| Cada `--write` completo | Reemplaza snapshot de esa cuenta; añade 1 `answers` y 1 `actions` |
| Login de API | Cookies sólo en memoria del script; no emite UserLog del navegador |

Snapshot: `state.regression = {kind, email, runId}`. Answer: `formId=regression-form`,
`taskId=regression-task`, `questionId=regression-question`. Action:
`type=RegressionSmoke`, `source=Regression`, URL `/regression?run=…`.
Ambos incluyen `regression.kind=leticia-baseline-regression` y un `runId` UUID
impreso al comenzar. Answers/Actions se verifican por lectura directa en Mongo,
incluidos username, payload y serverTimestamp; no basta el ACK HTTP.
No se modifican TaskRequestCount, TaskRequest, corpus, schemas o cuentas reales.
No se implementa limpieza. Excluir estos marcadores/email de cualquier análisis.

## Comprobación futura de secretos en el frontend

```bash
REGRESSION_SECRET_SENTINEL='regression-only-not-a-real-key-2026' npm run test:secrets
```

Escanea un build **ya existente**, por defecto `build/frontend` (opcional:
`REGRESSION_FRONTEND_DIR`). No construye nada. Incluye binarios/sourcemaps y busca
el literal, su codificación URL y escape JSON. Falla si falta el directorio, está
vacío, tiene symlinks o contiene el sentinel. Para una futura prueba de exposición,
inyectar previamente ese mismo valor ficticio como secreto backend durante el build
autorizado. Nunca usar un secreto real ni una variable `VITE_*` para credenciales.
Pasar sin haber inyectado el sentinel sólo demuestra ausencia, no aislamiento de
configuración. No detecta todas las transformaciones posibles ni recursos remotos.

## Endpoints con efectos secundarios: excluidos del smoke

- GET `/v1/tasks/shuffle`: incrementa TaskRequestCount y crea TaskRequest.
- GET OAuth y callbacks: interacción externa y posibles escrituras de identidad.
- POST auth/register: User/Credential/UserData. Login entrega cookies.
- POST userdata/answers/actions/consent/demographic/userlog/bookmarks y buffers:
  guardan o reemplazan datos experimentales.
- POST documents/preview: escribe filesystem aunque no indexe.
- POST documents/index o reindex; POST/DELETE search y POST search/locale:
  alteran filesystem/Mongo/Solr o schema del índice.
- POST/DELETE de configuración (flows/tasks/forms/questions) y DELETE documents:
  modifican o eliminan contenido. Tampoco ejecutar scripts de limpieza/loaders.

## E2E manual por checkpoint

Usar otro email reconocible, por ejemplo `regression-e2e-cp0@leticia.invalid`,
identificar su username y anotar fecha, checkpoint, URL, navegador y resultado.
El E2E **sí** deja actividad experimental y solicita shuffle una vez al asignar;
no mezclarlo con el smoke ni tratar de reiniciar el contador global.

1. Register/Login → Home → UserHub. Password incorrecta rechazada. Registrar username.
2. Consent → Demographic → Instructions. Verificar datos requeridos y avance único.
3. Challenge: anotar el orden asignado de task01/task02 (puede ser inverso).
   Son dos tareas; no exigir siempre task01 primero ni una tercera tarea.
4. Por cada tarea: Ready → Description → Pretask → Search. Verificar pregunta/tarea
   correcta y una respuesta persistida con username/taskId/formId.
5. Query conocida → resultados → documento → volver a Search. Repetir con otro
   documento; comprobar iframe, id, URL y ausencia de fallback/otro documento.
6. Bookmark/unbookmark y mínimo actual de tres bookmarks distintos para terminar
   Search. Verificar estado del botón, FinishSearchStage y avance único a NASA-TLX.
7. NASA-TLX → Posttask. Verificar respuestas/score recibido. `completed=true`
   corresponde al Posttask guardado; Search no completa por sí mismo la tarea.
8. La siguiente tarea conserva su contexto; al terminar ambas, `/end`.
   Comprobar los dos Posttask y tareas completadas: llegar a End solo no basta.
9. Logout/Login: cuenta y UserData siguen existiendo. Anotar restauración observada;
   no asumir que logout borra todo el estado Vuex o crea una sesión nueva.
10. Comprobar en Mongo: Consent, Demographic, Answers, UserData, TaskRequest,
    Actions (PageEnter/PageExit, SearchQuery, SearchResultClick con ranking,
    FinishSearchStage), Bookmarks, UserLog y muestras de teclado/mouse/scroll.
    Esperar el intervalo del buffer o generar el siguiente envío antes de consultar;
    no exigir conteos exactos de eventos throttled ni afirmar captura sin pérdidas.

Pruebas dirigidas con otra cuenta E2E si corresponde:

- Interrupción/reanudación al comenzar challenge (`stageIndex=0`) y dentro de una
  tarea: comparar tasks, orden, índices y último snapshot antes/después.
- Search ↔ documento varias veces: timer, tarea actual, botones y trackers sin
  nuevos duplicados; recarga del documento muestra el id correcto o falla visible.
- Timer: inicio, decremento, pausa en UserHub y reanudación. Anotar tiempo esperado
  frente a observado; no cambiar límites reales para acelerar la prueba.
- Timeout **separado** del recorrido normal: registrar TimeoutTriggered y destino.
  No interpretar End por timeout como finalización normal del estudio.

## Limitaciones conocidas del baseline (no corregidas aquí)

- Instrucciones de flow1 hablan de tres tareas; el loader define dos.
- doc01 tiene metadata keydown y URL/contenido mousemove; el smoke valida identidad
  y disponibilidad local, no que esa metadata sea semánticamente correcta.
- El botón usa tres bookmarks; no prueba que SessionFlow.minDocs controle el umbral.
- `Challenge.vue` trata índice 0 como inicio; registrar una reasignación al reanudar
  como hallazgo existente, sin ocultarlo ni corregirlo desde los tests.
- No hay sessionId global ni flag explícito de estudio completado; UserData es el
  último snapshot. La guía manual no promete reconstrucción completa de telemetría.

## Verificación de este bloque (2026-11-16)

- Sintaxis de los cuatro `.mjs`: comprobada con Node 16.20.2 del baseline, sin instalar
  dependencias ni cambiar el runtime del proyecto.
- Fixtures HTTP temporales: smoke positivo; rechazo de ranking/path incorrectos,
  documento que devuelve la SPA y stylesheet con Content-Type HTML. Sólo GET.
- Helper de secretos: ausencia y detección literal/URL/JSON comprobadas en archivos
  ficticios. Guardas de persistencia rechazan escritura no autorizada/cuenta ajena.
- LETICIA, Mongo y Solr estaban detenidos. El smoke real terminó con ECONNREFUSED;
  queda pendiente ejecutar smoke contra el corpus, auth/persistencia reales,
  helper contra un build real con sentinel inyectado y E2E manual. No se arrancó
  infraestructura ni se escribieron registros de la aplicación.
