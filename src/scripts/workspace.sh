#!/usr/bin/env bash
set -euo pipefail

# Host-side entrypoint. Never invokes loaders, database cleanup or npm install.
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo=$(git -C "$script_dir" rev-parse --show-toplevel)
docker_bin=${DOCKER_BIN:-docker}
container=${LETICIA_CONTAINER:-leticia-webapp}
builder_ref=${LETICIA_BUILDER_IMAGE:-node:24.22.3-bookworm}
runtime_ref=${LETICIA_RUNTIME_IMAGE:-node:24.22.3-bookworm-slim}
action=${1:-help}
if (($#)); then shift; fi

if [[ "$action" == help ]]; then
  echo 'Usage: workspace.sh build --build-env FILE [--allow-dirty]'
  echo '       workspace.sh start [BUILD_ID]'
  echo '       workspace.sh verify'
  exit 0
fi
[[ "$action" =~ ^(build|start|verify)$ ]] || { echo 'Unknown action' >&2; exit 1; }
volume=$("$docker_bin" inspect "$container" --format '{{range .Mounts}}{{if and (eq .Destination "/work") (eq .Type "volume")}}{{.Name}}{{end}}{{end}}')
[[ -n "$volume" ]] || { echo 'Expected an existing named volume mounted at /work' >&2; exit 1; }
runtime_id=$("$docker_bin" image inspect "$runtime_ref" --format '{{.Id}}')
builder_id=$("$docker_bin" image inspect "$builder_ref" --format '{{.Id}}')
echo "container=$container volume=$volume runtime=$runtime_id builder=$builder_id"

run_builder() {
  "$docker_bin" run --rm --pull=never --user node \
    --mount "type=volume,source=$volume,target=/work" "$@"
}

case "$action" in
  build)
    build_env=''
    dirty=()
    while (($#)); do
      case "$1" in
        --build-env) build_env=${2:?Missing build env file}; shift 2 ;;
        --allow-dirty) dirty=(--allow-dirty); shift ;;
        *) echo "Unknown argument: $1" >&2; exit 1 ;;
      esac
    done
    [[ -f "$build_env" ]] || { echo '--build-env FILE is required' >&2; exit 1; }
    build_id="$(date -u +%Y%m%dT%H%M%SZ)-$(git -C "$repo" rev-parse --short=8 HEAD)-$RANDOM"
    stage="/work/.reproducible/releases/$build_id"
    temporary=$(mktemp -d)
    trap 'rm -rf -- "$temporary"' EXIT
    python3 "$script_dir/workspace-snapshot.py" --repo "$repo" --output "$temporary" \
      --build-env "$build_env" --build-id "$build_id" --builder-image "$builder_id" \
      --runtime-image "$runtime_id" "${dirty[@]}"
    # A fresh directory: no inherited node_modules, build, dotenv files or assets.
    # Preparation must also work when the application container is stopped.
    run_builder "$builder_id" mkdir -p "$stage"
    "$docker_bin" cp "$temporary/source.tar.gz" "$container:$stage/source.tar.gz"
    run_builder "$builder_id" tar -xzf "$stage/source.tar.gz" -C "$stage" --no-same-owner
    run_builder "$builder_id" rm -- "$stage/source.tar.gz"
    run_builder --workdir "$stage" --env-file "$temporary/build.env" \
      --env npm_config_nodedir=/usr/local "$builder_id" node scripts/workspace.mjs build
    echo "Prepared BUILD_ID=$build_id (not activated)."
    echo "Activate: bash src/scripts/workspace.sh start $build_id"
    ;;
  start)
    (($# <= 1)) || { echo 'Expected at most one BUILD_ID' >&2; exit 1; }
    if (($#)); then
      build_id=$1
      [[ "$build_id" =~ ^[A-Za-z0-9-]+$ ]] || { echo 'Invalid BUILD_ID' >&2; exit 1; }
      stage="/work/.reproducible/releases/$build_id"
      # Verify candidate before stopping the working application.
      run_builder --workdir "$stage" "$builder_id" node scripts/workspace.mjs verify
      "$docker_bin" stop "$container"
      if run_builder --workdir "$stage" "$builder_id" node scripts/workspace.mjs activate; then
        echo "Activated $build_id"
      else
        result=$?
        if [[ "$result" == 1 ]]; then
          echo 'Activation failed; previous workspace retained/restored. Restarting it.' >&2
          "$docker_bin" start "$container"
        fi
        exit "$result"
      fi
    fi
    # Verify with the target runtime before replacing the stopped webapp container.
    run_builder --workdir /work "$runtime_id" node scripts/workspace.mjs verify
    python3 "$script_dir/runtime-container.py" --docker "$docker_bin" \
      --container "$container" --image "$runtime_id"
    "$docker_bin" start "$container"
    "$docker_bin" exec --workdir /work "$container" node scripts/workspace.mjs verify
    ;;
  verify)
    (($# == 0)) || { echo 'verify takes no arguments' >&2; exit 1; }
    "$docker_bin" exec --workdir /work "$container" node scripts/workspace.mjs verify
    ;;
esac
