# Ubuntu single-server deployment

Public URL: `https://trinitymatrix.org`. Nginx terminates HTTPS and proxies HTTP
and WebSockets to `127.0.0.1:8180`. `www.trinitymatrix.org` redirects to the apex.
The administrator UI uses `https://trinitymatrix.org/admin` and requires an
allowlisted email plus an enrolled passkey. PostgreSQL and Redis are private
to this Compose project, with persistent named volumes and generated secrets.

## Server layout

```text
/opt/trinitymatrix/releases/<release>/   application source and deployment files
/opt/trinitymatrix/current              symlink to the active release
/opt/trinitymatrix/shared/runtime.env   root-only runtime configuration
/opt/trinitymatrix/shared/postgres-tls/  PostgreSQL certificate and public CA
/opt/trinitymatrix/backups/             database dumps and deployment records
```

Run `sh deploy/single-server/bootstrap-runtime.sh /opt/trinitymatrix/shared`
once as root. It creates secrets and a CA-signed PostgreSQL certificate whose
SAN is `postgres`, matching the Compose service hostname. Keep the private
CA key outside the directory mounted into the database. Configure
`RESEND_API_KEY`, `EMAIL_FROM` (a verified sender), and `ADMIN_EMAILS` in
`runtime.env`, then set `AUTH_PROVIDER=resend`. Until then, `AUTH_PROVIDER=disabled`
serves the site with both sign-in endpoints returning HTTP 503. No fixed code or
fallback login is available. Never publish the development fixed OTP on an Internet server.

From the release directory:

```sh
docker compose --env-file /opt/trinitymatrix/shared/runtime.env -f deploy/single-server/compose.yml build app
docker compose --env-file /opt/trinitymatrix/shared/runtime.env -f deploy/single-server/compose.yml up -d --wait postgres redis
docker compose --env-file /opt/trinitymatrix/shared/runtime.env -f deploy/single-server/compose.yml run --rm migrate
docker compose --env-file /opt/trinitymatrix/shared/runtime.env -f deploy/single-server/compose.yml up -d --wait app
curl --fail http://127.0.0.1:8180/readyz
```

Install `nginx-http.conf` for the two hostnames first. Test with `nginx -t`
and reload. Request a certificate with the existing Certbot webroot at
`/var/www/letsencrypt`, for both names, then install `nginx.conf`, test, and
reload. Keep the existing Certbot renewal timer and Nginx deployment hook.
Install `trinitymatrix.service` in `/etc/systemd/system/`, reload systemd,
then enable it after the `current` symlink points at the healthy release.

## Backups and recovery

Replays and profiles are stored in PostgreSQL. Single-server mode does not
require an AWS bucket. Database dumps and Redis AOF must be backed up along
with the private runtime configuration and encryption key. Preserve those
keys to restore encrypted chat. Copies stored only on this VPS do not protect
against loss of the VPS; configure an off-host backup destination separately.

Before updating, take a PostgreSQL dump, preserve the previous image and
release directory, build the new image, run migrations, and verify readiness.
Rollback the `current` symlink and image only after checking schema compatibility.
`docker compose stop` preserves data. Do not use `down --volumes` during updates.
