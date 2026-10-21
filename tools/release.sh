#!/bin/bash
# Builds and checks a release (dev machine, bash: Linux, macOS or Git Bash):
# lockfile install, type check, build, API tests, NAS script simulation,
# image archives for linux/amd64 + linux/arm64 (no Docker needed), ZIP.
#   bash tools/release.sh [output dir]       (default: ../release)
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT=${1:-$ROOT/../release}
VERSION=$(tr -d ' \r\n' < "$ROOT/VERSION")
PY=$(command -v python3 || command -v python)
cd "$ROOT"
[ "$(node -p "require('./package.json').version")" = "$VERSION" ] || { echo "VERSION and package.json differ"; exit 1; }

echo "== 1. dependencies from package-lock.json"
npm ci --no-audit --no-fund
echo "== 2. type check"
npm run typecheck
echo "== 3. build"
npm run build
echo "== 4. tests"
npm test

echo "== 5. app stage (production dependencies only)"
mkdir -p "$OUT"
STAGE="$OUT/stage"
rm -rf "$STAGE"
mkdir -p "$STAGE"
cp package.json package-lock.json VERSION "$STAGE/"
cp -r migrations dist "$STAGE/"
(cd "$STAGE" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund)
if [ -n "$(find "$STAGE/node_modules" -name '*.node' | head -n 1)" ]; then echo "native modules found"; exit 1; fi

echo "== 6. image archives"
"$PY" -I tools/build-image.py --stage "$STAGE" --version "$VERSION" --out "$OUT"

echo "== 7. NAS scripts on the simulated docker (with the amd64 archive)"
bash tools/nas-sim/run.sh "$OUT/team-kazakhstan-$VERSION-linux-amd64.tar"

echo "== 8. ZIP"
"$PY" -I tools/pack-release.py --root "$ROOT" --out "$OUT" --images "$OUT"
(cd "$OUT" && sha256sum "team-kazakhstan-$VERSION-synology.zip" team-kazakhstan-"$VERSION"-linux-*.tar > SHA256SUMS && cat SHA256SUMS)
