# Workspace reproducible con el entorno baseline

Este procedimiento utiliza el checkout seleccionado y el volumen existente
`leticia-5c-work:/work`. No cambia Mongo, Solr, la configuración del contenedor web,
Node (16.20.2), npm (8.19.4) ni versiones del lockfile. No ejecuta loaders.

Requisitos: Bash, Git, Python 3 estándar y Docker CLI en el host. Deben existir
`leticia-webapp`, su volumen y las imágenes locales Node 16.20.2 bullseye y slim.
El builder bullseye completo aporta el compilador requerido por `iconv`; la webapp
sigue ejecutándose en su imagen slim existente. Se usan IDs de imagen resueltos y
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

Se ejecuta, con Node 16.20.2 y npm 8.19.4:

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

Antes de iniciar, se verifica también con la imagen runtime existente. El contenedor
mantiene su comando `npm run docker-start`, que ejecuta `/work/build/index.js`.
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
archivo ni se recrea el contenedor. CURRENT_SESSION_FLOW sigue siendo runtime;
VITE_CURRENT_SESSION_FLOW sigue incorporándose al bundle. Este bloque no cambia
su selección ni sus valores, y no unifica ambos mecanismos.

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

Opcionales: `LETICIA_CONTAINER` y `LETICIA_BUILDER_IMAGE`. La imagen builder debe
existir localmente y seguir cumpliendo las versiones baseline comprobadas.

El Dockerfile/Compose histórico sigue siendo otro flujo basado en `/app` y
`npm install`; no se utiliza ni se modifica aquí. La copia histórica hacia `/work`
no tenía un procedimiento versionado verificable. El flujo anterior se conserva
como referencia, no como evidencia de este nuevo procedimiento.
