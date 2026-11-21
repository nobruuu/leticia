# Workspace reproducible con Node 24

Este procedimiento utiliza el checkout seleccionado y el volumen existente
`leticia-5c-work:/work`. Usa Node 24.22.3 y npm 11.19.1 (incluido en sus imágenes),
sin cambiar Mongo, Solr ni versiones de dependencias del lockfile. No ejecuta loaders.

Requisitos: Bash, Git, Python 3 estándar y Docker CLI en el host. Deben existir
`leticia-webapp`, su volumen y las imágenes locales `node:24.22.3-bookworm` y
`node:24.22.3-bookworm-slim`. Obtenerlas explícitamente con `docker pull` antes de
preparar. El builder completo aporta el compilador requerido por `iconv`; la webapp
usa la imagen slim de la misma versión. Se usan IDs de imagen resueltos y
`--pull=never`: no se descarga una imagen nueva silenciosamente.

## Preparar e instalar/construir

Desde la raíz del repositorio:

```bash
bash src/scripts/workspace.sh build \
  --build-env "$HOME/projects/leticia-setup/leticia-build.env"
```

Si se pretende construir los cambios locales sin commit, añadir `--allow-dirty`.
Se registran tanto esa condición como los archivos y hashes exactos del snapshot.
No se ejecuta `git add` ni ninguna operación Git de escritura.

El comando imprime un `BUILD_ID` y deja un candidato nuevo bajo
`/work/.reproducible/releases/BUILD_ID`. No arranca ni detiene la aplicación anterior;
también puede prepararse con la webapp detenida.
El candidato incluye sólo archivos versionados/no ignorados de `src/`: sin
node_modules, build previo, corpus, archivos dotenv privados ni fuentes de otro
directorio. Los borrados locales se respetan. Los symlinks fuente se rechazan.

Se ejecuta, con Node 24.22.3 y npm 11.19.1:

```text
npm ci --include=dev --no-audit --no-fund
npm run build
```

`npm ci` recibe el lockfile del snapshot y compila módulos nativos con los headers
del mismo Node (`npm_config_nodedir=/usr/local`). No se reutilizan node_modules.
Si falla, el candidato no obtiene BUILD_INFO válido y no puede activarse. No se
actualizan paquetes para resolverlo automáticamente. La instalación necesita red
hacia los registros/URLs del lockfile y puede emitir avisos de paquetes antiguos.

Los scripts existentes generan: `build-server` → backend en `build/`;
`build-client` → `build/frontend`; `build-assets` → `build/assets` desde
`server/assets`. Estos scripts no descargan ni regeneran documentos del corpus.
No se utiliza `npm start`, `clean`, `prod` ni `leticia-build.sh` en este flujo.

## Activar y ejecutar

```bash
bash src/scripts/workspace.sh start BUILD_ID
bash src/scripts/workspace.sh verify
```

Antes de detener la webapp se verifica el candidato. Después se detiene únicamente
esa webapp, se copia/verifica `build/assets` en almacenamiento del mismo volumen,
y se conserva el workspace anterior completo. Sólo entonces se publica el nuevo
checkout/dependencias/build en la raíz `/work`. Se restauran los assets existentes
y se verifica su identidad por archivo. Mongo/Solr permanecen en funcionamiento.

Rutas recuperables, que no se borran automáticamente:

- `/work/.reproducible/backups/BUILD_ID`: workspace anterior completo.
- `/work/.reproducible/corpus/BUILD_ID/assets`: copia verificada de assets.
- `/work/.reproducible/corpus/BUILD_ID/manifest.json`: hashes del corpus/assets.
- `/work/.reproducible/releases/BUILD_ID`: candidato preparado.
- `/work/.reproducible/active.json`: activación vigente.

Si la publicación falla, se intenta restaurar el workspace anterior. Un fallo de
restauración mantiene la webapp detenida y muestra la ruta recuperable; no continuar
con una activación parcial. Las copias comparten volumen: protegen la reconstrucción,
pero no sustituyen un backup externo ante pérdida del volumen/Docker Desktop.

Antes de iniciar, se verifica también con la imagen runtime objetivo. Si su ID
difiere del contenedor existente, `runtime-container.py` conserva ese contenedor
detenido con nombre `leticia-webapp-runtime-backup-ID` y crea únicamente la webapp
con la imagen nueva. Conserva volumen, usuario, directorio, comando, puertos,
redes/aliases, variables personalizadas y política de reinicio del baseline.
Los defaults de imagen NODE_VERSION/YARN_VERSION proceden de la imagen nueva.
No muestra secretos: utiliza un env-file temporal con permisos 0600 que se elimina.
Mongo y Solr no se recrean. Un fallo al crear el contenedor restaura el nombre
anterior y mantiene la webapp detenida para no arrancar un runtime incompatible.
Volver a Node 16 requiere restaurar también su workspace/node_modules desde backup.
El comando sigue siendo `npm run docker-start`, que ejecuta `/work/build/index.js`.
`start` sin BUILD_ID verifica y arranca la activación actual, sin reconstruirla.
No reconstruir por fuera de este procedimiento si se quiere conservar la evidencia:
`verify` detecta cambios en fuentes, build y dependencias instaladas.

## Configuración

`--build-env` admite exclusivamente las variables públicas VITE_* ya utilizadas por
LETICIA, en formato `NOMBRE=valor` sin comillas. Copia y registra esos valores;
requiere modo production y flow explícitos. No hereda secretos runtime al builder,
no crea `.env` y no usa `.env.example` como configuración efectiva.

El backend conserva las variables configuradas en `leticia-webapp` (procedentes del
setup runtime existente, por ejemplo `leticia-runtime.env`). No se modifica ese
archivo; al sustituir la imagen se conservan sus variables. CURRENT_SESSION_FLOW sigue siendo runtime;
VITE_CURRENT_SESSION_FLOW sigue incorporándose al bundle. Este bloque no cambia
su selección ni sus valores, y no unifica ambos mecanismos.

### Configuración privada futura

`server/constants.js` centraliza, mediante dotenv/process.env, `LLM_API_KEY` y
`LLM_API_BASE_URL`. Son opcionales y su default es vacío: no habilitan ninguna API,
proveedor o endpoint. Inyectar sus valores únicamente en el runtime backend, mediante
el entorno del contenedor o su archivo runtime privado externo al checkout.

Nunca usar nombres `VITE_*` para credenciales: esos valores son públicos y pueden
quedar incorporados al bundle. El snapshot excluye archivos dotenv privados; el
builder sólo recibe las variables VITE_* admitidas por `workspace-snapshot.py`.
BUILD_INFO registra esa configuración pública, no el entorno completo. El reporte
de arranque enumera campos concretos y no imprime estas variables privadas.
No registrar/exportar el objeto completo de configuración ni enviar secretos por API.
Los placeholders de `.env.example` deben permanecer vacíos, sin valores reales.

Para comprobar aislamiento usar sólo un sentinel ficticio en un runtime de prueba
del mismo build. Confirmar arranque y lectura backend sin imprimir el valor; ejecutar
`test:secrets` contra `build/frontend` y comprobar también ausencia en BUILD_INFO,
snapshot y logs. La prueba no requiere reconstruir con la clave ni modificar el
frontend. La comprobación de ausencia por sí sola no demuestra recepción backend.

## Evidencia y comprobación

`/work/build/BUILD_INFO.json` registra revisión/rama, cambios locales, hashes de cada
fuente, lockfile, árbol de dependencias, build y entrypoint, versiones Node/npm,
IDs de imágenes y configuración pública de build. Excluye assets mutables del hash
del código; su preservación se verifica durante la activación mediante otro manifest.

```bash
docker exec -w /work leticia-webapp npm test
docker exec -w /work \
  -e REGRESSION_MONGO_DATA_URL=mongodb://database:27017/leticia-data \
  -e REGRESSION_MONGO_USER_URL=mongodb://database:27017/leticia-user \
  leticia-webapp npm run test:persistence
```

Las cuentas reservadas del Bloque A se reutilizan sólo por lectura en esta validación.
El build ID identifica una ejecución trazable, no promete identidad binaria de todo
el directorio entre fechas distintas ni captura versiones de datos Mongo/Solr.

Si el shim `docker` de WSL no funciona, seleccionar el CLI existente, por ejemplo:

```bash
export DOCKER_BIN=/mnt/wsl/docker-desktop/cli-tools/usr/bin/docker
```

Opcionales: `LETICIA_CONTAINER`, `LETICIA_BUILDER_IMAGE` y `LETICIA_RUNTIME_IMAGE`.
Las imágenes deben existir localmente y cumplir las versiones objetivo comprobadas.

El Dockerfile/Compose histórico sigue siendo otro flujo basado en `/app` y
`npm install`; también referencia Node 24.22.3, pero no se utiliza para este workflow.
La copia histórica hacia `/work`
no tenía un procedimiento versionado verificable. El flujo anterior se conserva
como referencia, no como evidencia de este nuevo procedimiento.

## Actualización acotada de Express 4.22.2

Express queda fijado a `4.22.2`. Se conservaron los rangos originales y las versiones
resueltas de todas las demás dependencias directas, incluido `body-parser` 1.20.1.
Para evitar una deduplicación que actualizaba ese parser directo, se resolvió el
lockfile en un directorio aislado fijando temporalmente las versiones directas,
y después se restauraron sus especificadores originales (salvo Express).
El checkout final se valida con `npm ci`, sin esa fijación temporal.

Cambios principales en el grafo transitivo requerido por Express:

| Paquete | Antes | Después |
|---|---|---|
| body-parser de Express | Compartido con 1.20.1 | 1.20.9 anidado; el directo sigue 1.20.1 |
| qs de Express | 6.11.0 | 6.15.4; el parser anidado usa 6.16.2 |
| cookie de Express | 0.5.0 | 0.7.2 |
| encodeurl | 1.0.2 | 2.0.3 |
| finalhandler | 1.2.0 | 1.3.2 |
| merge-descriptors | 1.0.1 | 1.0.3 |
| path-to-regexp | 0.1.7 | 0.1.13 |
| send / serve-static | 0.18.0 / 1.15.0 | 0.19.2 / 1.16.3 |
| content-type | 1.0.4 | 1.0.5 |
| http-errors / statuses | Copias existentes | Nuevas copias anidadas 2.0.1 / 2.0.2 |
| raw-body de Express | Compartido con 2.5.1 | 2.5.3 anidado |
| side-channel | 1.0.4 | 1.1.1 y submódulos list/map/weakmap |

El soporte de qs/side-channel actualiza function-bind (1.1.2), get-intrinsic (1.3.0)
y has-symbols (1.1.0); incorpora call-bind-apply-helpers, call-bound, dunder-proto,
es-define-property, es-errors, es-object-atoms, get-proto, gopd, hasown,
math-intrinsics y object-inspect. Desaparecen copias ya no utilizadas de call-bind
y object-inspect. npm también normaliza metadatos license/dev/integrity en entradas
sin cambio de versión; no es un upgrade de esas versiones.


## Frontend con Vue compat

El contrato de salida se conserva en `build/frontend`, servido por el mismo backend.
La instalación limpia usa el `.npmrc` versionado (`legacy-peer-deps=true`): los
plugins Vue 2 retenidos, como vue-select y Font Awesome, declaran rangos anteriores
a Vue 3 aunque sus imports se ejecutan mediante el alias `@vue/compat`. Esto no
certifica compatibilidad funcional completa de dichos plugins. No se usa `--force`.

Vue, compat, Router, Vuex, i18n, Vite y plugin-vue quedan fijados a sus versiones
objetivo. `@vitejs/plugin-legacy` se actualiza a 7.2.1 porque 3.0.1 exige Vite 4.
Se mantienen sus targets/configuración; no se añade soporte de navegador nuevo.
Al resolver el lockfile se fijaron temporalmente las otras dependencias directas
a las versiones anteriores y se restauraron después sus rangos originales. Los
cambios transitivos corresponden al compilador/runtime, Router (que incorpora su
tooling), Vite/Rollup/esbuild y plugin-legacy/Babel/core-js. No se instaló Pinia.
