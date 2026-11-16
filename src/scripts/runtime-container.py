"""Replace only the baseline webapp image; retain its stopped container/configuration."""
import argparse
import json
import os
import subprocess
import tempfile
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    for key in ["docker", "container", "image"]:
        parser.add_argument("--" + key, required=True)
    args = parser.parse_args()

    def docker(*options):
        return subprocess.check_output([args.docker, *options], text=True).strip()

    old = json.loads(docker("inspect", args.container))[0]
    if old["Image"] == args.image:
        print("Runtime image already matches target")
        return
    if old["State"]["Running"]:
        raise SystemExit("Stop the webapp before changing its image")
    config, host = old["Config"], old["HostConfig"]
    if config["WorkingDir"] != "/work" or config["Cmd"] != ["npm", "run", "docker-start"]:
        raise SystemExit("Unexpected webapp command/workdir; refusing image replacement")
    networks = old["NetworkSettings"]["Networks"]
    primary = host["NetworkMode"]
    if primary not in networks or len(config.get("Entrypoint") or []) > 1:
        raise SystemExit("Unsupported baseline network/entrypoint")
    for mount in old["Mounts"]:
        if mount["Type"] != "volume":
            raise SystemExit("Expected existing named volumes only")

    # Keep user-supplied variables, but take NODE_VERSION/YARN_VERSION defaults
    # from the new image rather than reporting the old image's values.
    image = json.loads(docker("image", "inspect", old["Image"]))[0]
    defaults = dict(item.split("=", 1) for item in image["Config"].get("Env", []))
    environment = []
    for item in config.get("Env", []):
        key, value = item.split("=", 1)
        if defaults.get(key) != value:
            if "\n" in item or "\r" in item:
                raise SystemExit("Multiline environment requires explicit handling")
            environment.append(item)
    backup = f"{args.container}-runtime-backup-{old['Id'][:12]}"
    with tempfile.TemporaryDirectory(prefix="leticia-runtime-") as directory:
        envfile = Path(directory) / "runtime.env"
        envfile.write_text("\n".join(environment) + "\n")
        os.chmod(envfile, 0o600)
        create = ["create", "--name", args.container, "--env-file", str(envfile),
                  "--workdir", config["WorkingDir"], "--user", config["User"],
                  "--network", primary, "--restart", host["RestartPolicy"]["Name"]]
        if config.get("Entrypoint"):
            create += ["--entrypoint", config["Entrypoint"][0]]
        for key, value in (config.get("Labels") or {}).items():
            create += ["--label", f"{key}={value}"]
        for mount in old["Mounts"]:
            value = f"type=volume,source={mount['Name']},target={mount['Destination']}"
            if not mount["RW"]:
                value += ",readonly"
            create += ["--mount", value]
        for port, bindings in (host.get("PortBindings") or {}).items():
            for binding in bindings or []:
                ip = binding.get("HostIp", "")
                if ":" in ip:
                    ip = f"[{ip}]"
                create += ["--publish", f"{ip + ':' if ip else ''}{binding['HostPort']}:{port}"]

        def aliases(name):
            return [alias for alias in networks[name].get("Aliases") or []
                    if alias not in {args.container, old["Id"], old["Id"][:12]}]

        for alias in aliases(primary):
            create += ["--network-alias", alias]
        create += [args.image, *config["Cmd"]]
        docker("rename", args.container, backup)
        created = False
        try:
            docker(*create)
            created = True
            for name in networks:
                if name == primary:
                    continue
                connect = ["network", "connect"]
                for alias in aliases(name):
                    connect += ["--alias", alias]
                docker(*connect, name, args.container)
        except Exception:
            if created:
                docker("rm", args.container)  # Stopped new container; never remove volumes.
            docker("rename", backup, args.container)
            raise
    print(f"Runtime image replaced; previous container retained stopped as {backup}")


if __name__ == "__main__":
    main()
