# Changelog

## 1.0.0 — 2026-10-21

First release.

* Directory: badge-style cards grouped by company and team, search by name,
  title, profession and current work, filters by company, team, language and
  availability for Algoritmi projects, initials when there is no photo.
* Person page with clickable email/phone, availability and update date.
* My profile: read-only official fields, editable profession, current work,
  languages and optional contacts, completeness indicator, camera selfie
  (getUserMedia, front camera, face oval, retake/save, no gallery upload).
* Director panel (role `coordinator`, shown as Director / Директор): employee table, incomplete / no-photo filters, official
  fields, one-time invitation links (create, re-issue, revoke, copy),
  removal of an unsuitable photo (moderation; new photos only by the camera).
* Admin panel: users and roles, linking accounts to employee profiles,
  companies and teams, deactivation and permanent deletion, activity log,
  settings, JSON/CSV export, backups.
* Home-screen icon and web manifest ("Add to Home Screen", no app store).
* First administrator also from `.env` (`INITIAL_ADMIN_USERNAME`,
  `INITIAL_ADMIN_PASSWORD`, password via stdin); minimum password length 8.
  Administrators are created in the web interface only by administrators;
  employees are added only by administrators and directors.
* Security: server sessions (HttpOnly, Secure, `__Host-`), scrypt passwords,
  login rate limiting, CSRF tokens, origin and Host checks, strict CSP, no
  CORS, input validation, server-side photo re-encoding without metadata,
  photos only via an authenticated route, audit log without secrets.
* English (default) and Russian interface, choice remembered.
* Synology delivery: Task Scheduler scripts (setup, start/boot/watchdog, stop,
  update with pre-migration backup, rollback, backup with retention and
  second copy, restore with checks, admin link, diagnostics, demo data),
  own Tailscale machine with Tailscale Serve HTTPS, Dockerfile (multi-stage,
  Alpine, non-root), `compose.yaml` (format 2.4) as an alternative, image
  archives for linux/amd64 and linux/arm64.

* Optional public access through Tailscale Funnel: `TS_FUNNEL` in `.env`,
  `scripts/funnel.sh on | off | status` (off by default).

Database schema: version 2 (`001_initial.sql`, `002_base_companies.sql`).
