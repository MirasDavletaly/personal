#!/usr/bin/env python3
"""Build Team Kazakhstan image archives for `docker load` WITHOUT a Docker daemon.

The application is pure JavaScript (node:sqlite is built into Node, photos are
processed by jpeg-js), so the app layer is identical for every architecture.
This tool takes the official multi-arch base image from Docker Hub (layers
verified by SHA-256), appends one deterministic app layer and writes, per
platform, a tarball in the format of `docker save` (manifest.json, read by
Docker 20.10) that is at the same time an OCI image layout (index.json).
The result is equivalent to building the Dockerfile; it is verified by
re-reading it (digests, diff_ids, config) — but not run under Docker here.

  python -I tools/build-image.py --stage release/stage --version 1.0.0 --out release
"""
import argparse
import gzip
import hashlib
import io
import json
import os
import sys
import tarfile
import time
import urllib.request

BASE_REPO = "library/node"
BASE_TAG = "24.22.0-alpine3.24"
IMAGE_REPO = "team-kazakhstan"
PLATFORMS = [("amd64", None), ("arm64", "v8")]
ACCEPT = ", ".join([
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json",
])


def sha256(data):
    return hashlib.sha256(data).hexdigest()


class Registry:
    def __init__(self, repo, cache):
        self.repo = repo
        self.cache = cache
        os.makedirs(cache, exist_ok=True)
        url = f"https://auth.docker.io/token?service=registry.docker.io&scope=repository:{repo}:pull"
        with urllib.request.urlopen(url, timeout=60) as r:
            self.token = json.load(r)["token"]

    def get(self, path, accept=None):
        req = urllib.request.Request(f"https://registry-1.docker.io/v2/{self.repo}/{path}")
        req.add_header("Authorization", f"Bearer {self.token}")
        if accept:
            req.add_header("Accept", accept)
        with urllib.request.urlopen(req, timeout=600) as r:
            return r.read(), r.headers.get("Content-Type", ""), r.headers.get("Docker-Content-Digest", "")

    def manifest(self, ref):
        data, ctype, digest = self.get(f"manifests/{ref}", ACCEPT)
        if digest and digest != "sha256:" + sha256(data):
            raise SystemExit(f"manifest digest mismatch for {ref}")
        return json.loads(data), ctype, "sha256:" + sha256(data)

    def blob(self, digest):
        path = os.path.join(self.cache, digest.replace(":", "_"))
        if os.path.exists(path):
            with open(path, "rb") as f:
                data = f.read()
            if "sha256:" + sha256(data) == digest:
                return data
        data, _, _ = self.get(f"blobs/{digest}")
        if "sha256:" + sha256(data) != digest:
            raise SystemExit(f"blob digest mismatch: {digest}")
        with open(path, "wb") as f:
            f.write(data)
        return data


def app_layer(stage, mtime):
    """Deterministic tar of the app: sorted, root-owned, fixed mtime."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w", format=tarfile.PAX_FORMAT) as tar:
        def add_dir(name, uid=0, gid=0, mode=0o755):
            ti = tarfile.TarInfo(name)
            ti.type = tarfile.DIRTYPE
            ti.mode, ti.uid, ti.gid, ti.uname, ti.gname, ti.mtime = mode, uid, gid, "root" if uid == 0 else "node", "root" if gid == 0 else "node", mtime
            tar.addfile(ti)

        add_dir("app")
        entries = []
        for root, dirs, files in os.walk(stage):
            rel_root = os.path.relpath(root, stage).replace(os.sep, "/")
            # node_modules/.bin holds Windows shims from staging: not needed at runtime.
            dirs[:] = sorted(d for d in dirs if not (d == ".bin" and rel_root.endswith("node_modules")))
            for d in dirs:
                entries.append(("d", f"{rel_root}/{d}" if rel_root != "." else d, None))
            for fn in sorted(files):
                entries.append(("f", f"{rel_root}/{fn}" if rel_root != "." else fn, os.path.join(root, fn)))
        for kind, rel, src in sorted(entries, key=lambda e: e[1]):
            name = f"app/{rel}"
            if kind == "d":
                add_dir(name)
                continue
            if os.path.islink(src):
                raise SystemExit(f"symlink in stage: {src}")
            with open(src, "rb") as f:
                data = f.read()
            if src.endswith(".node"):
                raise SystemExit(f"native module in stage: {src}")
            ti = tarfile.TarInfo(name)
            ti.size, ti.mode, ti.uid, ti.gid, ti.uname, ti.gname, ti.mtime = len(data), 0o644, 0, 0, "root", "root", mtime
            tar.addfile(ti, io.BytesIO(data))
        add_dir("data", uid=1000, gid=1000, mode=0o750)
    return buf.getvalue()


def build_config(base_cfg, app_diff_id, version, created, base_ref, base_digest):
    cfg = json.loads(json.dumps(base_cfg))
    c = cfg.setdefault("config", {})
    env = [e for e in c.get("Env") or [] if e.split("=", 1)[0] not in ("NODE_ENV", "DATA_DIR", "HOST", "PORT")]
    c["Env"] = env + ["NODE_ENV=production", "DATA_DIR=/data", "HOST=0.0.0.0", "PORT=8080"]
    c["WorkingDir"] = "/app"
    c["User"] = "1000:1000"
    c["Cmd"] = ["node", "dist/server/main.js"]
    c["ExposedPorts"] = {"8080/tcp": {}}
    c["Healthcheck"] = {
        "Test": ["CMD", "node", "/app/dist/server/healthcheck.js"],
        "Interval": 30_000_000_000,
        "Timeout": 5_000_000_000,
        "StartPeriod": 30_000_000_000,
        "Retries": 3,
    }
    labels = dict(c.get("Labels") or {})
    labels.update({
        "org.opencontainers.image.title": "Team Kazakhstan",
        "org.opencontainers.image.description": "Internal employee directory of the group of companies",
        "org.opencontainers.image.version": version,
        "org.opencontainers.image.created": created,
        "org.opencontainers.image.base.name": f"docker.io/{base_ref}",
        "org.opencontainers.image.base.digest": base_digest,
    })
    c["Labels"] = labels
    cfg["created"] = created
    cfg["rootfs"]["diff_ids"] = list(cfg["rootfs"]["diff_ids"]) + [app_diff_id]
    cfg.setdefault("history", []).append({
        "created": created,
        "created_by": "tools/build-image.py: app layer (dist, node_modules --omit=dev, migrations), USER 1000:1000, HEALTHCHECK, CMD node dist/server/main.js",
    })
    return cfg


def add_bytes(tar, name, data, mtime):
    ti = tarfile.TarInfo(name)
    ti.size, ti.mode, ti.mtime = len(data), 0o644, mtime
    tar.addfile(ti, io.BytesIO(data))


def write_archive(path, tag, cfg_bytes, layers, mtime):
    """layers: list of (digest, gz_bytes). docker-save manifest.json + OCI layout."""
    cfg_digest = "sha256:" + sha256(cfg_bytes)
    oci_manifest = json.dumps({
        "schemaVersion": 2,
        "mediaType": "application/vnd.oci.image.manifest.v1+json",
        "config": {"mediaType": "application/vnd.oci.image.config.v1+json", "digest": cfg_digest, "size": len(cfg_bytes)},
        "layers": [{"mediaType": "application/vnd.oci.image.layer.v1.tar+gzip", "digest": d, "size": len(b)} for d, b in layers],
    }, separators=(",", ":")).encode()
    man_digest = "sha256:" + sha256(oci_manifest)
    index = json.dumps({
        "schemaVersion": 2,
        "mediaType": "application/vnd.oci.image.index.v1+json",
        "manifests": [{
            "mediaType": "application/vnd.oci.image.manifest.v1+json",
            "digest": man_digest,
            "size": len(oci_manifest),
            "annotations": {"io.containerd.image.name": f"docker.io/library/{tag}", "org.opencontainers.image.ref.name": tag.split(":")[1]},
        }],
    }, separators=(",", ":")).encode()
    docker_manifest = json.dumps([{
        "Config": f"blobs/sha256/{cfg_digest[7:]}",
        "RepoTags": [tag],
        "Layers": [f"blobs/sha256/{d[7:]}" for d, _ in layers],
    }], separators=(",", ":")).encode()
    tmp = path + ".partial"
    with tarfile.open(tmp, "w", format=tarfile.PAX_FORMAT) as tar:
        add_bytes(tar, "oci-layout", b'{"imageLayoutVersion":"1.0.0"}', mtime)
        add_bytes(tar, "index.json", index, mtime)
        add_bytes(tar, "manifest.json", docker_manifest, mtime)
        add_bytes(tar, f"blobs/sha256/{cfg_digest[7:]}", cfg_bytes, mtime)
        add_bytes(tar, f"blobs/sha256/{man_digest[7:]}", oci_manifest, mtime)
        seen = set()
        for d, b in layers:
            if d not in seen:
                add_bytes(tar, f"blobs/sha256/{d[7:]}", b, mtime)
                seen.add(d)
    os.replace(tmp, path)


def verify_archive(path, arch, tag, version):
    """Re-reads the archive the way `docker load` does and checks everything."""
    with tarfile.open(path) as tar:
        names = set(tar.getnames())
        man = json.load(tar.extractfile("manifest.json"))
        assert len(man) == 1 and man[0]["RepoTags"] == [tag], "RepoTags"
        cfg_bytes = tar.extractfile(man[0]["Config"]).read()
        assert sha256(cfg_bytes) == man[0]["Config"].split("/")[-1], "config digest"
        cfg = json.loads(cfg_bytes)
        assert cfg["architecture"] == arch and cfg["os"] == "linux", "platform"
        assert cfg["config"]["User"] == "1000:1000" and cfg["config"]["WorkingDir"] == "/app", "user/workdir"
        assert cfg["config"]["Labels"]["org.opencontainers.image.version"] == version, "version label"
        diff_ids = cfg["rootfs"]["diff_ids"]
        assert len(diff_ids) == len(man[0]["Layers"]), "layer count"
        for layer_path, diff_id in zip(man[0]["Layers"], diff_ids):
            gz = tar.extractfile(layer_path).read()
            assert sha256(gz) == layer_path.split("/")[-1], f"layer digest {layer_path}"
            assert "sha256:" + sha256(gzip.decompress(gz)) == diff_id, f"diff_id {layer_path}"
        index = json.load(tar.extractfile("index.json"))
        m = index["manifests"][0]["digest"][7:]
        assert f"blobs/sha256/{m}" in names, "OCI manifest blob"
    return cfg, diff_ids


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--stage", required=True, help="directory with the /app contents")
    ap.add_argument("--version", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--cache", default=os.path.join(os.path.expanduser("~"), ".cache", "team-kz-image-cache"))
    args = ap.parse_args()

    created = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    mtime = int(time.time())
    os.makedirs(args.out, exist_ok=True)
    reg = Registry(BASE_REPO, args.cache)
    index, ctype, index_digest = reg.manifest(BASE_TAG)
    if "index" not in ctype and "list" not in ctype:
        raise SystemExit(f"{BASE_TAG} is not a multi-platform image ({ctype})")
    print(f"base node:{BASE_TAG} index {index_digest}")

    layer_tar = app_layer(args.stage, mtime)
    app_diff_id = "sha256:" + sha256(layer_tar)
    app_gz = gzip.compress(layer_tar, compresslevel=6, mtime=0)
    app_digest = "sha256:" + sha256(app_gz)
    print(f"app layer {len(layer_tar)} bytes, gzip {len(app_gz)} bytes, diff_id {app_diff_id}")

    results = []
    for arch, variant in PLATFORMS:
        desc = next(m for m in index["manifests"] if m["platform"]["os"] == "linux" and m["platform"]["architecture"] == arch
                    and (variant is None or m["platform"].get("variant") in (variant, None)))
        manifest, _, _ = reg.manifest(desc["digest"])
        base_cfg = json.loads(reg.blob(manifest["config"]["digest"]))
        layers = [(l["digest"], reg.blob(l["digest"])) for l in manifest["layers"]]
        for (d, b), diff in zip(layers, base_cfg["rootfs"]["diff_ids"]):
            if "sha256:" + sha256(gzip.decompress(b)) != diff:
                raise SystemExit(f"base layer {d} does not match its diff_id")
        cfg = build_config(base_cfg, app_diff_id, args.version, created, f"library/node:{BASE_TAG}", index_digest)
        cfg_bytes = json.dumps(cfg, separators=(",", ":")).encode()
        tag = f"{IMAGE_REPO}:{args.version}"
        out = os.path.join(args.out, f"{IMAGE_REPO}-{args.version}-linux-{arch}.tar")
        write_archive(out, tag, cfg_bytes, layers + [(app_digest, app_gz)], mtime)
        verify_archive(out, arch, tag, args.version)
        size = os.path.getsize(out)
        with open(out, "rb") as f:
            digest = sha256(f.read())
        print(f"{os.path.basename(out)}: {size} bytes, sha256 {digest}, base platform manifest {desc['digest']}, config sha256:{sha256(cfg_bytes)}")
        results.append({"file": os.path.basename(out), "arch": arch, "size": size, "sha256": digest,
                        "basePlatformManifest": desc["digest"], "config": "sha256:" + sha256(cfg_bytes)})
    with open(os.path.join(args.out, "images.json"), "w") as f:
        json.dump({"created": created, "base": f"node:{BASE_TAG}", "baseIndexDigest": index_digest, "appLayer": {"diffId": app_diff_id, "digest": app_digest}, "images": results}, f, indent=2)


if __name__ == "__main__":
    main()
