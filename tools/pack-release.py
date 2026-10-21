#!/usr/bin/env python3
"""Pack the installation ZIP for Synology (sources + scripts, compose.yaml at the root).

  python -I tools/pack-release.py --root . --out ../release --images ../release

Text files get LF line endings (scripts with CRLF fail on Linux), scripts get
the executable bit, runtime files (.env, data, logs, state, node_modules,
dist, image archives) are left out. images/SHA256SUMS lists the image
archives so that setup.sh can verify the uploaded one.
"""
import argparse
import re
import hashlib
import os
import sys
import time
import zipfile

INCLUDE = [
    "compose.yaml", "compose.proxy.yaml", ".env.example", "Dockerfile", ".dockerignore", ".gitignore",
    "VERSION", "package.json", "package-lock.json", "tsconfig.base.json", "tsconfig.server.json",
    "tsconfig.web.json", "vite.config.ts", "README_RU.md", "README_EN.md", "CHANGELOG.md", "BUILD_INFO.md",
    "src", "migrations", "scripts", "deploy", "test", "tools",
]
SKIP_DIRS = {"node_modules", "dist", "data", "logs", "state", "release", ".git", "__pycache__"}
TEXT_EXT = {".ts", ".tsx", ".js", ".mjs", ".json", ".md", ".sh", ".sql", ".yaml", ".yml", ".txt", ".html",
            ".css", ".svg", ".py", ".example"}
TEXT_NAMES = {"Dockerfile", "VERSION", ".gitignore", ".dockerignore", "docker", ".env.example"}
EXECUTABLE = {"tools/nas-sim/bin/docker"}


def files(root):
    for item in INCLUDE:
        path = os.path.join(root, item)
        if os.path.isfile(path):
            yield item
        elif os.path.isdir(path):
            for d, dirs, fs in os.walk(path):
                dirs[:] = sorted(x for x in dirs if x not in SKIP_DIRS and not x.startswith(".tmp"))
                for f in sorted(fs):
                    yield os.path.relpath(os.path.join(d, f), root).replace(os.sep, "/")
        else:
            raise SystemExit(f"missing: {item}")


def is_text(rel):
    base = rel.rsplit("/", 1)[-1]
    return base in TEXT_NAMES or os.path.splitext(base)[1] in TEXT_EXT


# A real Tailscale key looks like tskey-auth-<id>-<secret>; documentation
# uses placeholders such as "tskey-auth-..." which do not match.
REAL_TS_KEY = re.compile(rb"tskey-[a-z]+-[A-Za-z0-9]{6,}-[A-Za-z0-9]{10,}")
SECRET_KEYS = (b"TS_AUTHKEY", b"INITIAL_ADMIN_PASSWORD")


def sanitize(rel, data):
    """The template must never carry secrets someone typed into it."""
    if rel == ".env.example":
        lines = []
        for line in data.split(b"\n"):
            key = line.split(b"=", 1)[0].strip()
            if key in SECRET_KEYS and line.split(b"=", 1)[1].strip():
                print(f"note: the value of {key.decode()} in .env.example was left out of the ZIP")
                line = key + b"="
            lines.append(line)
        data = b"\n".join(lines)
    if REAL_TS_KEY.search(data):
        raise SystemExit(f"{rel} contains a real Tailscale key: remove it before packing")
    return data


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--images", help="directory with team-kazakhstan-<v>-linux-*.tar")
    args = ap.parse_args()
    root = os.path.abspath(args.root)
    version = open(os.path.join(root, "VERSION"), encoding="utf8").read().strip()
    os.makedirs(args.out, exist_ok=True)
    target = os.path.join(args.out, f"team-kazakhstan-{version}-synology.zip")
    now = time.localtime()[:6]

    sums = []
    if args.images:
        for name in sorted(os.listdir(args.images)):
            if name.startswith(f"team-kazakhstan-{version}-linux-") and name.endswith(".tar"):
                h = hashlib.sha256()
                with open(os.path.join(args.images, name), "rb") as f:
                    for chunk in iter(lambda: f.read(1 << 20), b""):
                        h.update(chunk)
                sums.append(f"{h.hexdigest()}  {name}\n")

    count = 0
    with zipfile.ZipFile(target + ".partial", "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        def put(rel, data, executable=False):
            zi = zipfile.ZipInfo(rel, now)
            zi.create_system = 3
            zi.external_attr = ((0o100755 if executable else 0o100644) & 0xFFFF) << 16
            zi.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(zi, data)

        for rel in files(root):
            with open(os.path.join(root, rel), "rb") as f:
                data = f.read()
            if is_text(rel):
                data = sanitize(rel, data.replace(b"\r\n", b"\n"))
            put(rel, data, rel.endswith(".sh") or rel in EXECUTABLE)
            count += 1
        readme = (
            "Image archives (variant A) go into this folder:\n"
            f"  team-kazakhstan-{version}-linux-amd64.tar   for x86_64 NAS (Intel/AMD)\n"
            f"  team-kazakhstan-{version}-linux-arm64.tar   for aarch64 NAS (64-bit ARM)\n"
            "scripts/setup.sh and update.sh load the one matching this NAS and check it\n"
            "against SHA256SUMS. Without an archive the image is built from source.\n"
        )
        put("images/README.txt", readme.encode())
        if sums:
            put("images/SHA256SUMS", "".join(sums).encode())
        count += 1 + bool(sums)
    os.replace(target + ".partial", target)

    with zipfile.ZipFile(target) as z:
        names = z.namelist()
        assert "compose.yaml" in names and "scripts/setup.sh" in names and ".env.example" in names, "layout"
        assert not any(n.startswith(("node_modules/", "dist/")) or n == ".env" or "/.env" == n[-5:] for n in names), "runtime files"
        for n in names:
            if n.endswith(".sh"):
                assert b"\r\n" not in z.read(n), f"CRLF in {n}"
    print(f"{target}: {count} files, {os.path.getsize(target)} bytes")


if __name__ == "__main__":
    main()
