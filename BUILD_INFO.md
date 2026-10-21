# BUILD_INFO — Team Kazakhstan 1.0.0

Built on 2026-10-21 on a Windows 11 developer PC (Node.js 24.15.0, npm
11.12.1, Python 3.12.10, Git Bash, Chrome 155). **Docker is not available on
this PC** (Docker Desktop is installed but has no WSL), and there was **no
access to the NAS**. Everything below states exactly what was and was not run.

## Versions

| Component | Version |
|---|---|
| Runtime image base | `node:24.22.0-alpine3.24` (Node.js 24 LTS, Alpine 3.24, musl), index `sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f` |
| Tailscale image | `tailscale/tailscale:v1.104.2` (pulled on the NAS) |
| Database | SQLite built into Node.js (`node:sqlite`, 3.51.x), WAL mode |
| Server | fastify 5.12.7, @fastify/cookie 11.1.3, @fastify/static 10.1.6, zod 4.6.7, jpeg-js 0.4.4 |
| Client | react 19.3.1, react-dom 19.3.1, vite 8.3.5, @vitejs/plugin-react 6.1.2 |
| Tooling | typescript 7.0.2, @types/node 24.19.2 |
| Database schema | 2 (`001_initial.sql`, `002_base_companies.sql`) |

All versions are pinned in `package.json`; `package-lock.json` (lockfile v3)
contains the platform packages for linux-x64/arm64 musl as well, so
`npm ci` works inside the Alpine build stage on both architectures.
Production dependencies are pure JavaScript (no `.node` files, no install
scripts): 72 packages, 29 MB.

## Image archives (variant A)

Assembled by `tools/build-image.py` **without Docker**: official base layers
from Docker Hub (SHA-256 of every blob and every decompressed diff_id
verified) + one deterministic app layer (dist, node_modules --omit=dev,
migrations; uid/gid 0, `/data` 1000:1000 0750) + config (User 1000:1000,
WorkingDir /app, CMD `node dist/server/main.js`, HEALTHCHECK, OCI labels).
Format: `docker save` (manifest.json, for Docker 20.10) and OCI layout
(index.json). SHA-256 sums: `SHA256SUMS` next to the archives and
`images/SHA256SUMS` in the ZIP.

| File | Size | SHA-256 | Config |
|---|---|---|---|
| `team-kazakhstan-1.0.0-linux-amd64.tar` | 67 235 840 B | `d3bd49e195472df2c19b106a59fcba41f3a18950056e3815446d5031fec7691c` | `sha256:3a268471…` (base `sha256:429bdfbc…`) |
| `team-kazakhstan-1.0.0-linux-arm64.tar` | 67 020 800 B | `59ffe91318eacf077759f26909655ce35acefb4787c29e9558e256e63e1a425b` | `sha256:8e5c95c7…` (base `sha256:5b124563…`, arm64/v8) |

App layer: diff_id `sha256:abc90a8f…`, identical for both architectures.
Details: `release/images.json`.

Verified: archives re-read the way `docker load` does (RepoTags, config
digest, layer digests, diff_ids, architecture, user, labels); the app layer
of the amd64 archive was extracted and started with Node.js: CLI `status`,
server start, `/api/health` 200, app shell 200, wrong Host 421.
**Not verified: `docker load` / `docker run` of these archives** (no Docker).

## Checks that were run

| Check | Result |
|---|---|
| `npm ci` from the lockfile (98 packages) | OK |
| `npm ci --omit=dev --ignore-scripts` for the image (no native modules) | OK |
| TypeScript 7 (`npm run typecheck`): server and client | 0 errors |
| Production build (`npm run build`) | OK: JS 342 KB (99 KB gzip), CSS 21 KB, no inline scripts, no external URLs |
| API tests `npm test` (real server process, fresh data dir, HTTP + CLI) | **24 / 24 passed** |
| Browser check, Chrome 155 headless, 390×844 (phone) and 1280×900, fake camera | 24 screens (`release/screenshots`), 0 console errors, 0 CSP violations, 0 failed requests, 0 px horizontal overflow |
| Local run on this PC (`npm start`, http://localhost:8080) | started, health 200, sign-in Miras → administrator |
| NAS scripts on a simulated docker (`tools/nas-sim/run.sh` with the amd64 archive) | see below |
| `compose.yaml`, `compose.proxy.yaml` | parsed, structure checked; **not run** |

API tests cover: migrations on an empty database; only `/api/health`
public, directory/photos/API closed without a session; one-time admin
set-up link (weak password refused, reuse refused, token stored as hash,
scrypt hash); sign-in, sign-out, cookie flags (HttpOnly, SameSite=Lax,
Max-Age); same answer for unknown users; spoofed X-Forwarded-For ignored;
CSRF token required; foreign Origin and cross-site requests refused; no CORS
headers; wrong Host → 421; CSP/X-Frame-Options/nosniff/no-store headers;
413 for large bodies, 400 for bad JSON; SQL-injection-like names stored as
text; coordinator invitation, activation, **reuse refused (410)**,
**re-issued and revoked links refused (410)**, **expired link refused**,
guessed token invalid, invitation gives no access before activation;
employee can change only profession, current work, languages, contacts —
**official fields and name → 403** (also combined with allowed fields), DB
unchanged; **other employee's profile by id → 403** (edit, photo delete,
invite, deactivate), list/audit endpoints 403; visitor read-only; photo
upload with EXIF/GPS → stored 512×512 without the metadata, served only
with a session (401 without), PNG/broken/small/oversized refused, no upload
route for other people; audit log entries (official changes with from/to,
role changes, invitations, denied changes) and **no tokens or passwords in
the audit log or server log**; exports without hashes; admin backup
download and path traversal 404; deactivation ends sessions and revokes
links, account and photo hidden; admin password reset link; expired session
refused; **CLI backup → verify → `tar -tzf` → data kept after a server
restart → restore refused while running and without --force → restore
--force → state of the backup, photo restored; damaged archive refused**;
database newer than the app → start refused (exit 3); **three processes
migrating at once → migrations applied exactly once**; demo data only with
`--yes`, removable; login rate limit (429, Retry-After); configuration rules
(https required in production, "trust all proxies" refused, insecure
cookies only with an explicit switch); only administrators create
administrators through the web interface (director and employee → 403);
directors and administrators remove photos (moderation), administrators
link accounts to profiles; first administrator without a terminal
(`create-admin --password-stdin`, as setup.sh does with `INITIAL_ADMIN_*`):
password of 8 characters accepted, 7 refused, not echoed, open set-up links
revoked.

## NAS script simulation

`tools/nas-sim/run.sh` runs the real `scripts/*.sh` against a fake `docker`
command that keeps container/image state in files and runs the real build
(dist/) as the app "container"; Tailscale is faked. It checks the script
logic only — not Docker, not Tailscale, not DSM.

Final run with `release/team-kazakhstan-1.0.0-linux-amd64.tar`: **105 / 105
checks passed** (20 min 50 s on this PC). Sections: configuration errors (missing
`.env`, http address, Docker 19.03 refused with clear messages); first
installation (archive SHA-256 verified, `docker load`, architecture check,
data folder owner, Tailscale "connected", app read-only/non-root/no
capabilities in the Tailscale network namespace, trust only loopback, auth
key only in the Tailscale env file, no token or key in any log, admin
created through the one-time link, second run changes nothing); Funnel
(`funnel.sh on` writes `TS_FUNNEL=true`, Serve config with `AllowFunnel`,
Tailscale and app recreated, data kept, admin signs in; `off` back to
tailnet only); locking
(parallel start refused); backup (archive + `.sha256` in BACKUP_DIR, second
copy, status for the admin panel, sums verify); stop / boot task respects
stop.sh / watchdog silent when stopped or healthy, repairs a crashed app;
restore (refused without `--yes-overwrite`, then restored with a safety
backup, sign-in works); update 1.0.0 → 1.0.1 (backup before migrations,
app recreated, previous image recorded) and rollback (needs `--yes`, back
on 1.0.0, start.sh keeps it); admin reset link, demo data only with a flag,
diag.sh masks the auth key; conflicts (port of another container, port of a
non-Docker process, foreign container with our name — all refused before
anything changes); proxy mode (Tailscale container removed, bridge gateway
trusted, health on the published port); clean installation with
`INITIAL_ADMIN_USERNAME=Miras` (administrator created without a link, the
password in no log, Miras signs in as administrator, second run reminds to
remove the password from `.env`); `stop.sh --remove` keeps the data.

## What the browser can see (F12)

`tools/check-exposure.mjs` against the running server, signed in as the
administrator: **nothing exposed**. The page code (JS 346 KB, CSS 22 KB,
icons, manifest) contains no data, no SQL, no secrets and no source maps;
the database file, `.env`, `package.json`, sources, migrations, backups and
path tricks (`../`, `%2e%2e`) return 403 or only the empty app page; every
API without a session returns 401; signed-in API answers contain no
password hashes, token hashes or session ids.

Real browser (Chrome) after using all pages: localStorage holds only
`tkz.locale`; one cookie `tkz_session` with HttpOnly (JavaScript cannot read
it; on HTTPS also Secure + `__Host-`); no IndexedDB, sessionStorage, cache
or service worker; requests go only to the own server. The database (SQLite)
and photos exist only on the NAS in `DATA_DIR/app`.

## Problems found by these checks and fixed

* `GET /` returned 403 (static plugin directory listing) — found by the
  browser check; now the app shell is served for `/`.
* `.env` values in quotes followed by a comment kept their quotes — found by
  the simulation; parser rewritten (one pass, no `source`).
* `tar … | grep -q` and `netstat … | grep -q` under `pipefail` could report
  false failures/false "port free" (SIGPIPE) — switched to `grep -c`.
* `images/SHA256SUMS` in binary-mode form (`hash *name`) was not found —
  both forms are accepted now.
* A foreign container with one of our names was detected only after the
  Tailscale container had been created — both names are checked first now.
* Healthcheck with `fetch` + `process.exit` aborted with a libuv assertion
  on Windows — rewritten with `node:http` and a natural exit.
* Keyboard: the first Tab skipped the skip link; mobile header wrapped; the
  directory wasted space with one-person teams; Russian labels were cut —
  fixed and re-checked in the browser.
* Test harness on Windows (not part of the product): open SQLite handles
  blocked file renames (EBUSY); background node processes inherited the
  runner's pipe; the fake docker stopped a wrapper instead of node and passed
  `node` twice for one-off containers — all fixed in the test tools.

## Reported from the real NAS

The administrator ran `setup.sh` on the target NAS and sent `logs/setup.log`:
Docker 20.10.3 (amd64), image archive loaded, container `personal-tailscale`
created, Tailscale connected as `personal.tail81e59e.ts.net`, app healthy and
answering through Tailscale, administrator `Miras` created from `.env`. The
Docker warning about `--pids-limit` (kernel without the pids cgroup) is
harmless. The address did not open on a device outside the tailnet, so
`scripts/funnel.sh` (Tailscale Funnel, `TS_FUNNEL`) was added; Funnel itself
is checked only in the simulation, not yet on the NAS.

## Not verified here (needs the real NAS, Docker, HTTPS, phones)

* `docker build`, `docker load`, `docker run` on Docker 20.10 / DSM kernel:
  `--read-only`, `--cap-drop ALL`, `--pids-limit`, `--memory`, network mode
  `container:`, restart after a NAS reboot, image healthcheck.
* The tailscale/tailscale container: login with the auth key, MagicDNS name,
  Tailscale Serve, certificate issuance, the Host header Serve forwards.
* Tailscale Funnel on the real tailnet: the `funnel` node attribute in the
  policy, public DNS of the name, access from a device without Tailscale.
* Camera on a real iPhone (Safari) and Android (Chrome) over real HTTPS:
  permission prompts, front camera choice, orientation, image quality.
* Secure `__Host-` cookie and HSTS on a real HTTPS origin.
* DSM Task Scheduler: boot trigger, "every 15 minutes", user root, email.
* File Station: unpacking, opening `ADMIN-LINK.txt`, ACLs vs. `chown` on
  the bind mount; DSM Text Editor and Windows line endings in `.env`.
* Speed on the NAS CPU (scrypt sign-in, JPEG re-encoding, build from source).
* Second backup copy to USB / a mounted share; Hyper Backup.
* Proxy mode behind the DSM reverse proxy; the Compose variants.
