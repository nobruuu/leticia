"""Archive the selected checkout bytes and public build configuration; stdlib only."""
import argparse
import hashlib
import io
import json
import subprocess
import tarfile
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    for name in ["repo", "output", "build-env", "build-id", "builder-image", "runtime-image"]:
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--allow-dirty", action="store_true")
    args = parser.parse_args()
    repo, output = Path(args.repo).resolve(), Path(args.output)

    def git(*options):
        return subprocess.check_output(["git", "-C", str(repo), *options])

    status = git("status", "--porcelain=v1", "--untracked-files=all").decode().splitlines()
    if status and not args.allow_dirty:
        raise SystemExit("Checkout has local changes; explicitly use --allow-dirty to record them")
    allowed = {
        "VITE_NODE_ENV", "VITE_LETICIA_HOST", "VITE_LETICIA_PORT", "VITE_LETICIA_PROTOCOL",
        "VITE_LETICIA_PILOT_MODE", "VITE_ENABLE_GOOGLE_LOGIN", "VITE_ENABLE_FACEBOOK_LOGIN",
        "VITE_ENABLE_EMAIL_LOGIN", "VITE_LETICIA_LOCALE", "VITE_CURRENT_SESSION_FLOW",
    }
    config = {}
    for line in Path(args.build_env).read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        key, separator, value = line.partition("=")
        if not separator or key not in allowed or key in config or any(c in value for c in "\r\n\"'"):
            raise SystemExit("Build env must contain unique allowed public VITE_* keys, without quotes")
        config[key] = value
    if config.get("VITE_NODE_ENV") != "production" or not config.get("VITE_CURRENT_SESSION_FLOW"):
        raise SystemExit("Explicit production mode and session flow are required")
    (output / "build.env").write_text("".join(f"{k}={v}\n" for k, v in sorted(config.items())))
    names = sorted(set(git("ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "src").split(b"\0")) - {b""})
    files = {}
    with tarfile.open(output / "source.tar.gz", "w:gz") as archive:
        def add(name, data, mode=0o644):
            info = tarfile.TarInfo(name)
            info.size, info.mode = len(data), mode
            archive.addfile(info, io.BytesIO(data))

        for raw in names:
            relative = raw.decode()
            source = repo / relative
            if not source.exists():  # A tracked local deletion belongs to this snapshot too.
                continue
            if source.is_symlink() or not source.is_file():
                raise SystemExit("Source archive accepts regular files only: " + relative)
            name = str(Path(relative).relative_to("src"))
            if any(part in {"node_modules", "build", "dev-build", ".reproducible"} for part in Path(name).parts):
                raise SystemExit("Generated files must not be tracked: " + name)
            if source.name.startswith(".env") and source.name != ".env.example":
                raise SystemExit("Environment files must stay outside the source archive")
            data = source.read_bytes()
            files[name] = hashlib.sha256(data).hexdigest()
            add(name, data, source.stat().st_mode & 0o777)
        metadata = {
            "buildId": args.build_id, "revision": git("rev-parse", "HEAD").decode().strip(),
            "branch": git("branch", "--show-current").decode().strip(),
            "dirty": bool(status), "localChanges": status, "files": files,
            "lockSha256": files["package-lock.json"], "buildEnvironment": config,
            "buildEnvironmentSource": str(Path(args.build_env).resolve()),
            "builderImageId": args.builder_image, "runtimeImageId": args.runtime_image,
        }
        metadata["sourceSha256"] = hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest()
        add(".source-info.json", json.dumps(metadata, indent=2).encode())
    print(json.dumps({k: metadata[k] for k in ["buildId", "revision", "dirty", "sourceSha256", "lockSha256", "buildEnvironment"]}, indent=2))


if __name__ == "__main__":
    main()
