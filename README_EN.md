# Team Kazakhstan — employee directory (short guide)

Internal web directory of the group of companies (Algoritmi, Green Spark and
others): people grouped by company and team, official title, profession,
current work, languages, contacts, availability for Algoritmi projects and a
camera selfie. Mobile-first, English (default) and Russian. Full guide in
Russian: `README_RU.md`; what was tested: `BUILD_INFO.md`.

## Architecture

```
phone/laptop with Tailscale ──https://team.<tailnet>.ts.net──► container teamkz-tailscale
   (Tailscale Serve, own tailnet machine "team", Funnel off)        │ 127.0.0.1:8080
                                                                    ▼
                                    container teamkz-app (Node.js 24, SQLite, non-root, read-only)
                                                                    │
                                    /volume1/docker/team-kz-data (database, photos, Tailscale state)
```

Plain `docker` commands driven by Synology **Task Scheduler** scripts; Docker
Compose is optional (`compose.yaml`, format 2.4). Other containers, ports,
networks, the NAS's own Tailscale and existing scheduled tasks are not touched.

## Install on Synology (DSM 6.2 Docker 20.10+ / DSM 7.2 Container Manager)

1. File Station: create `/volume1/docker/team-kz`, upload the ZIP, *Extract here*.
   Variant A: put `team-kazakhstan-1.0.0-linux-<amd64|arm64>.tar` into `images/`
   (x86_64 → amd64, aarch64 → arm64; `scripts/diag.sh` prints it). Variant B:
   no archive — the image is built from source on the NAS.
2. Tailscale admin console → Settings → Keys → generate a one-off auth key.
   MagicDNS and HTTPS Certificates must be enabled in the tailnet.
3. Copy `.env.example` to `.env`; set `TS_AUTHKEY`; check `DATA_DIR`,
   `BACKUP_DIR`, `HTTP_BIND` (default `127.0.0.1:8095`), `TS_HOSTNAME` (`team`).
4. Task Scheduler → Create → Scheduled Task → User-defined script, user
   **root**, disabled, command `bash /volume1/docker/team-kz/scripts/setup.sh`
   → Run. Log: `logs/setup.log`.
5. First administrator: either set `INITIAL_ADMIN_USERNAME` / `INITIAL_ADMIN_PASSWORD`
   in `.env` before step 4 (setup.sh creates the account; remove the password
   from `.env` afterwards), or open the one-time link in `ADMIN-LINK.txt`
   (valid 60 min) on a device with Tailscale. There is no default password.
6. Permanent tasks (user root):
   * Triggered Task, event Boot-up: `bash /volume1/docker/team-kz/scripts/start.sh --boot`
   * Scheduled, daily, every 15 minutes: `bash /volume1/docker/team-kz/scripts/start.sh --check`
   * Scheduled, daily 03:15: `bash /volume1/docker/team-kz/scripts/backup.sh`
7. Tailscale admin console → Machines → `team` → Disable key expiry.

One-off tasks: `start.sh`, `stop.sh`, `update.sh`, `rollback.sh --yes`,
`restore.sh --latest [--yes-overwrite]`, `admin-link.sh [--reset <user>]`,
`diag.sh`, `demo-data.sh --yes|--remove`, `funnel.sh on|off|status`. A lock
prevents parallel runs.

## Notes

* The camera needs HTTPS: Tailscale Serve provides a valid certificate for
  `*.ts.net`; plain `http://` over the tailnet is not enough.
* By default everyone needs the Tailscale app and access to the machine `team`
  (invite to the tailnet or *Share* the machine with guests). Public access
  without the app: task `bash /volume1/docker/team-kz/scripts/funnel.sh on`
  (Tailscale Funnel, `TS_FUNNEL=true`; no ports are opened on the NAS or the
  router; only the sign-in page is public, so use long passwords);
  `funnel.sh off` returns to tailnet only.
* Backups: consistent online SQLite snapshot (`VACUUM INTO`) + referenced
  photos, SHA-256 manifest, retention, optional second copy on another
  device (`BACKUP_COPY_DIR`). Update makes a backup before migrations;
  rollback restores it with the previous image.
* Limitation: a web page can offer a camera-only UI but cannot prove the
  origin of an image; the server re-encodes every upload.
* Not verified on the real NAS (no access); see `BUILD_INFO.md`.

## Development

`npm ci && npm run typecheck && npm run build && npm test`;
`bash tools/nas-sim/run.sh` tests the NAS scripts against a fake docker.
