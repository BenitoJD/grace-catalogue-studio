# Deploying Grace Catalogue Studio

This guide runs the product on one small VPS. The Node API and PDF renderer run
in a single Docker container. Caddy terminates TLS and serves the static web
build. The SQLite database, rendered PDFs and images live in `./data` on the
host, so backups are ordinary file copies.

The result is one host, one container, one domain, a few hundred MB of image,
and a data directory that grows with the number of renders.

## What runs where

| Piece | Where | Notes |
|---|---|---|
| API and PDF renderer | Docker container `grace-catalogue-studio` | Node 24, WeasyPrint 70, Poppler, runs as non root user `node` (uid 1000) |
| Web build (`app/dist`) | Host, served by Caddy from `/srv/grace-web` | Static single page app, no server needed |
| Database and files | Host, bind mounted to `/app/data` | `./data` next to `docker-compose.yml` |
| TLS and routing | Caddy on the host | Automatic certificates from Let's Encrypt |

The container speaks plain HTTP on port 8787. Only Caddy should be able to
reach that port. See [Reverse proxy with Caddy](#reverse-proxy-with-caddy-and-tls).

## Prerequisites

- Ubuntu 24.04 LTS or Debian 12 VPS. 2 vCPU, 2 GB RAM and 20 GB disk is
  comfortable. 1 vCPU and 1 GB works for a single office but renders take
  longer; on a 2 GB VPS keep the commented memory limit at 1 GB or leave it
  unset.
- Root or sudo access.
- A domain name whose A (and optionally AAAA) record points at the VPS, for
  example `catalogue.example.com`.
- Inbound TCP 80 and 443 open for the certificate challenge and HTTPS. Port 22
  for SSH.
- Docker Engine 24 or newer with the Compose v2 plugin. `docker compose version`
  must print `v2.x`.
- `git`, `sqlite3`, `rsync` and optionally `jq` on the host
  (`sudo apt-get install -y git sqlite3 rsync jq`).

There is no external database, message queue or object storage to provision.

## 1. Install Docker

The official convenience script is fine for a dedicated VPS:

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"
newgrp docker          # or log out and back in
docker compose version
```

## 2. Get the code

```bash
sudo mkdir -p /srv
sudo chown "$USER":"$USER" /srv
git clone <repository-url> /srv/grace-catalogue
cd /srv/grace-catalogue
```

The repository is private; use a deploy key or an access token on the VPS. Pull
the same branch that CI builds (`main`).

## 3. Create the environment file

```bash
cp .env.example .env
chmod 600 .env
editor .env
```

The values in `.env.example` work for the layout in this guide: keep the data
paths at their container values and edit `CORS_ORIGINS` only if the web app is
served from a different origin than the API. The full list is in
[Environment variables](#environment-variables).

`docker compose` reads `.env` from this directory and refuses to start without
it. Keep it out of git (it is already ignored).

## 4. Prepare the data directory

The container runs as uid 1000 (`node`). A directory owned by root will fail
with `EACCES` on the first write.

```bash
mkdir -p data backups
sudo chown -R 1000:1000 data
chmod 750 data
ls -ln data            # the owner column must be 1000 1000
```

Keep `backups` outside the data directory so retention pruning in `data/` can
never touch it. Both should be on the same filesystem as the project.

## 5. Build and start

```bash
docker compose config -q          # validates compose file and .env
docker compose build
docker compose up -d
docker compose ps
curl -fsS http://localhost:8787/health
```

Expected health response:

```json
{"ok":true,"version":"1.0.0"}
```

`docker compose ps` should show `healthy` (it can show `starting` for the first
30 seconds). A fresh data directory is empty: create the first customer and
order in the app. The first start also renders the 30 template thumbnails in the
background; watch for `"msg":"Template previews generated.","generated":30` in
the logs. The API answers requests while that happens.

## 6. Build and serve the web app

The API container does not serve the web app. Caddy serves the static build.

Build once on the VPS (needs Node 24) or build in CI and upload the
`web-build` artifact:

```bash
cd app
npm ci
npm run build:web                  # writes app/dist
cd ..
sudo mkdir -p /srv/grace-web
sudo chown -R "$USER":"$USER" /srv/grace-web
sudo rsync -a --delete app/dist/ /srv/grace-web/
sudo chmod -R a+rX /srv/grace-web  # Caddy only needs to read the files
```

Leave `EXPO_PUBLIC_API_URL` unset for this build. When the app is served from
the same domain as the API, `app/lib/api.ts` uses `window.location.origin`, so
there is nothing to configure and no CORS entry is needed for the web app.

For the native phone app the API URL is baked in at build time. Set
`EXPO_PUBLIC_API_URL` as an EAS environment variable or in `app/eas.json` and
rebuild, for example:

```bash
cd app
EXPO_PUBLIC_API_URL=https://catalogue.example.com npx eas build --platform android
```

A phone cannot use `localhost`; it must reach the public HTTPS domain. The
`npx expo export --platform web` command above only builds the web bundle.

## Environment variables

All server variables are read once when the container starts. After editing
`.env`, recreate the container with `docker compose up -d`. `docker compose
restart` does not reload `env_file`.

| Variable | If unset | Purpose |
|---|---|---|
| `PORT` | `8787` | HTTP port the API listens on inside the container. Keep it at 8787 so the compose healthcheck and port mapping match. |
| `CATALOG_DATA_DIR` | `/app/data` in the image, `<repo>/data` outside Docker | Writable root for the database, renders, previews and media. Leave at `/app/data`. |
| `CATALOG_DB` | `$CATALOG_DATA_DIR/catalog.db` | Path to the SQLite database file. Only change it to move the database off the data volume. |
| `CATALOG_TEMPLATES_DIR` | `/app/templates` in the image, `<repo>/templates` outside Docker | Root of the HTML templates, fonts and bundled images. The renderer writes temporary `built-*.html` files here, so it must stay writable. |
| `WEASYPRINT_BIN` | `/opt/venv/bin/weasyprint` in the image, auto detected `.venv` otherwise | WeasyPrint executable used to build PDFs. `/ready` checks that it exists and is executable. |
| `PDFTOPPM_BIN` | `pdftoppm` from PATH, `/usr/bin/pdftoppm` in the image | Poppler executable used to rasterise PDF pages for the app preview. |
| `LOG_LEVEL` | `info` | Server log verbosity: `debug`, `info`, `warn` or `error`. Filters the structured JSON request logs. |
| `CORS_ORIGINS` | localhost development origins | Comma separated browser origins allowed to call the API, for example `https://catalogue.example.com,https://office.example.com`. Origins that are not listed get no CORS headers, so a browser on another origin is blocked. `*` allows any origin and is only for testing. The web app served from the same origin as the API needs no entry. |
| `RATE_LIMIT_PER_MIN` | `120` | Requests per minute per client IP (from `X-Forwarded-For` when a proxy sets it) across all API reads and writes, counted in fixed one minute windows. Values below 1 fall back to 120 instead of disabling the limit. |
| `RENDER_LIMIT_PER_MIN` | `12` | Render requests per minute per client IP (same client IP rules), applied only to the render endpoint. Rendering is CPU heavy and queued in process, so this is lower than the general limit. Values below 1 fall back to 12. |
| `RENDER_RETENTION_DAYS` | `30` | Delete finished renders older than this many days: the PDF, the page images and the `renders` row. The sweep runs on boot and every 24 hours. `0` keeps renders forever. |
| `EXPO_PUBLIC_API_URL` | unset | Build time setting for the Expo app and web bundle. The server ignores it. Unset means same origin on the web and `http://localhost:8787` on a device. |

Two limits are fixed in code rather than configurable: request bodies are capped
at 64 KB (the API only accepts JSON, never file uploads), and renders are
serialised one at a time inside the process.

## Data, persistence and backups

The bind mount maps `./data` on the host to `/app/data` in the container. With
the layout above that is `/srv/grace-catalogue/data`; the commands in this
section assume you are in `/srv/grace-catalogue`.

```
data/
  catalog.db          SQLite database, the source of truth for customers, orders, materials and render records
  catalog.db-wal      write-ahead log while the API runs
  renders/            <renderId>.pdf and <renderId>-<page>.png page images
  previews/           template thumbnails, generated once per template
  media/              material swatch images copied from templates/assets on boot
```

`docker compose down` keeps `./data`. Only deleting the directory loses data.

### Database backup while the server runs

SQLite's `.backup` command produces one consistent file even with open
connections and WAL writes. This is the backup that matters:

```bash
mkdir -p backups
sqlite3 data/catalog.db ".backup 'backups/catalog-$(date +%Y%m%d-%H%M).db'"
sqlite3 backups/catalog-*.db "PRAGMA integrity_check;"
```

The second command must print `ok`.

### Renders, previews and media

Every render has a row in the `renders` table plus the PDF and page images in
`data/renders/`. `RENDER_RETENTION_DAYS` deletes the row and the files together,
so the only copy of an old PDF is one taken before the retention sweep runs.
Previews and media can be recreated, but old PDFs cannot be rebuilt with the
same template version, so copy them if they are business records:

```bash
rsync -a data/renders/ backups/renders/
rsync -a data/previews/ backups/previews/
rsync -a data/media/ backups/media/
```

The retention sweep is the only other writer. `rsync` is safe enough while the
API runs; a file caught mid-write is regenerable.

### Full cold copy

For a single archive of everything, stop writes first:

```bash
docker compose stop
tar czf "backups/catalogue-data-$(date +%Y%m%d-%H%M).tar.gz" data
docker compose start
```

### Daily backup

```bash
crontab -e
```

Add this line (cron needs `%` escaped as `\%`):

```cron
17 2 * * * cd /srv/grace-catalogue && sqlite3 data/catalog.db ".backup 'backups/catalog-$(date +\%F).db'" && rsync -a data/renders/ backups/renders/ && find backups -name 'catalog-*.db' -mtime +14 -delete
```

Copy `backups/` off the VPS every day with `rsync`, `rclone`, or your normal
offsite backup tool. A backup on the same disk is not a backup.

### Restore

```bash
docker compose down
cp backups/catalog-20260131-0217.db data/catalog.db
rm -f data/catalog.db-wal data/catalog.db-shm      # stale WAL must not be replayed
rsync -a backups/renders/ data/renders/
docker compose up -d
curl -fsS http://localhost:8787/health
```

## Upgrading

The database migrates in place on boot (new tables and columns are added when
missing), but take a backup first anyway:

```bash
cd /srv/grace-catalogue

# 1. Back up (see above), for example:
sqlite3 data/catalog.db ".backup 'backups/pre-upgrade-$(date +%Y%m%d-%H%M).db'"

# 2. New code, new image
git pull
docker compose build
docker compose up -d

# 3. Rebuild the web app when app/ changed
cd app && npm ci && npm run build:web && cd ..
rsync -a --delete app/dist/ /srv/grace-web/
sudo chmod -R a+rX /srv/grace-web

# 4. Verify
docker compose ps
curl -fsS http://localhost:8787/health
curl -fsS http://localhost:8787/ready

# 5. Clean up old images
docker image prune -f
```

`docker compose up -d` on its own reuses the old image. Always pair `git pull`
with `docker compose build` (or `docker compose up -d --build`). The container
is recreated, so expect a few seconds of downtime in the middle of a work day;
schedule upgrades for the evening. Shutdown is graceful: the server stops
accepting new requests, lets an in flight render finish for up to 20 seconds,
closes the database and exits. `stop_grace_period: 30s` in the compose file
covers that drain, so do not lower it below 25 seconds.

To roll back: `git checkout <previous-commit>`, then `docker compose build &&
docker compose up -d`. Restore the database only if the failed version already
wrote new data.

`requirements.txt` pins WeasyPrint itself but pip resolves its Python
dependencies at build time, so a rebuild months later can install newer minor
versions. Rebuild and smoke test on the VPS before you delete the previous
image, or pin the full set with `pip freeze` inside the built image if you need
byte for byte reproducible builds.

## Logs

```bash
docker compose logs -f                    # follow everything
docker compose logs -f --tail=200         # last 200 lines, then follow
docker compose logs --since 30m           # recent history
docker compose logs -f app                # just the API container
```

Container logs are rotated at 10 MB with three files kept. Almost every line
is one JSON object on stdout. Useful ones:

- On boot: `{"level":"info","msg":"Grace catalogue API listening.","url":"http://localhost:8787","database":"/app/data/catalog.db","logLevel":"info"}`
- Request log: `{"level":"info","requestId":"...","method":"GET","path":"/health","status":200,"durationMs":1.5}`
- After the first boot render pass: `{"level":"info","msg":"Template previews generated.","generated":30,"total":30}`
- If the renderer is misconfigured: `{"level":"warn","msg":"WeasyPrint was not found or is not executable. Renders and GET /ready will fail until it is installed.","weasyprintBin":"/opt/venv/bin/weasyprint"}`

Request and operational logs are JSON, so you can pipe them through `jq`:

```bash
docker compose logs -f app | jq -c 'select(.level == "error")'
docker compose logs -f app | jq -c 'select(.status == 429)'
```

The only plain text lines are the `[previews] ...` messages that the background
thumbnail pass writes if one template cannot be rendered. `LOG_LEVEL=debug`
adds more detail; switch back to `info` afterwards.

Failed renders are returned to the app as a JSON `error` message with a
`requestId`, and server side failures are logged with the same id so a report
from the office can be matched to a line in the log.

## Health checks

| Check | Command | Pass |
|---|---|---|
| Liveness | `curl -fsS http://localhost:8787/health` | `{"ok":true,"version":"1.0.0"}` |
| Readiness | `curl -fsS http://localhost:8787/ready` | `{"ready":true,"version":"1.0.0","checks":{"database":true,"weasyprint":true}}` |
| Compose status | `docker compose ps` | state `running`, health `healthy` |
| Docker health status | `docker inspect --format '{{.State.Health.Status}}' grace-catalogue-studio` | `healthy` |
| From inside the container | `docker exec grace-catalogue-studio node -e "fetch('http://127.0.0.1:8787/health').then((r) => r.text()).then(console.log)"` | same JSON |

The image and compose file define the same check: `GET /health` on
127.0.0.1:8787 with a 30 second interval, 5 second timeout, 3 retries and a 30
second start period. A container that fails the check is marked unhealthy and
restarted by the `restart: unless-stopped` policy only when the process exits;
Docker itself does not restart unhealthy containers. Watch the status, or use
the logs when a render starts failing.

`/health` is a liveness check: a 200 means the process is accepting requests.
It still returns 200 when WeasyPrint is broken. `/ready` is the stronger
dependency check. It returns 200 only when the database opened and the
WeasyPrint binary exists and is executable, and 503 with a `checks` object, a
`requestId` and an `error` when it does not. Use `/ready` from an external
monitor or a load balancer, and run it after every upgrade:

```bash
curl -fsS http://localhost:8787/ready | jq .
```

## Reverse proxy with Caddy and TLS

Caddy gets and renews Let's Encrypt certificates automatically. It needs the
domain to resolve to the VPS and inbound 80/443.

Install from the official repository:

```bash
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update
sudo apt-get install -y caddy
id caddy                              # Caddy serves files as this user
```

Before doing this, make sure port 8787 is not reachable from the internet.
Edit the `ports` mapping in `docker-compose.yml` to `"127.0.0.1:8787:8787"`
before the first deploy. Docker writes its own iptables rules for published
ports, so a `ufw deny 8787` rule alone is not a reliable substitute: bind the
port to loopback instead.

Write `/etc/caddy/Caddyfile`:

```caddyfile
{
	email admin@example.com
}

catalogue.example.com {
	encode zstd gzip

	@api path /api/* /files/* /pages/* /previews/* /media/* /health /ready
	handle @api {
		reverse_proxy 127.0.0.1:8787
	}

	handle {
		root * /srv/grace-web
		try_files {path} /index.html
		file_server
	}

	header {
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
		X-Content-Type-Options "nosniff"
		Referrer-Policy "strict-origin-when-cross-origin"
	}

	# Request logs go to stdout, which systemd captures in the journal.
	log {
		output stdout
	}
}
```

Caddy writes its runtime, certificate and access logs to its systemd journal,
so `sudo journalctl -u caddy -f` is where TLS and proxy problems show up. If
you would rather have files, add a writable log directory first and change the
`output` line; the container's own logs stay in `docker compose logs`.

The `handle @api` block routes API calls and generated files to the container.
Everything else is the single page app, with `try_files ... /index.html` so deep
links such as `/orders/<id>` work.

One header detail is worth knowing. The API's rate limiter keys its per client
bucket on the first `X-Forwarded-For` entry and only falls back to the socket
address when the header is missing. Caddy handles this correctly out of the
box: for a request from a direct client it sets `X-Forwarded-For` to that
client's address and ignores any value the client sent itself. Do not add a
`header_up` rule that passes a client supplied value through. If you later put
a CDN or load balancer in front of Caddy, configure Caddy's global
`trusted_proxies` so it trusts that hop and still records the real client.

The API must never be reachable directly. A caller that can reach 8787 can
send a forged `X-Forwarded-For` and pick its own rate limit bucket. Keep the
port firewalled or bound to 127.0.0.1 only.

Apply it:

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
sudo journalctl -u caddy -f       # watch the first certificate request
curl -fsS https://catalogue.example.com/health
```

Then open `https://catalogue.example.com` in a browser. The web app calls the
API on the same origin, so no `EXPO_PUBLIC_API_URL` or CORS entry is needed.

Firewall the host:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

The loopback bind is what keeps the API private. If the compose file still has
`"8787:8787"`, change it to `"127.0.0.1:8787:8787"` and run
`docker compose up -d` rather than relying on a firewall rule.

## Restricting access

The API has no user login. Anyone who can reach the domain can read and change
orders, customers and materials. For an internal tool on the public internet,
put one layer in front of it:

1. **VPN or Tailscale (recommended).** Reach the VPS over the private network
   and only expose the proxy to that network. Nothing else changes.
2. **IP allow-list in Caddy.** Allow the office address and block the rest:

   ```caddyfile
   @blocked not remote_ip 203.0.113.10 198.51.100.0/24
   respond @blocked "Not authorised." 403
   ```

3. **Basic auth in Caddy.** Works for the web app in a browser, but the phone
   app cannot send the credentials, so it is only useful for a browser only
   deployment:

   ```bash
   caddy hash-password --plaintext 'a long password'
   ```

   ```caddyfile
   basic_auth {
       office $2a$14$replace-with-the-hash
   }
   ```

Whichever you choose, also keep the API port firewalled as above.

## Troubleshooting

### WeasyPrint binary missing

Symptoms: on boot the log has a warning like `WeasyPrint was not found or is
not executable. Renders and GET /ready will fail until it is installed.`,
`/ready` answers 503 with `"weasyprint":false` under `checks`, and renders fail
with status 500 and `WeasyPrint was not found at /opt/venv/bin/weasyprint.
Install it before rendering.` `/health` still answers 200, which is why `/ready`
is the check to watch.

```bash
docker exec grace-catalogue-studio /opt/venv/bin/weasyprint --version
# WeasyPrint version 70.0
docker exec grace-catalogue-studio sh -c 'echo "$WEASYPRINT_BIN"'
curl -s http://localhost:8787/ready | jq .
```

If the binary is absent, the pip layer of the image is broken. Rebuild without
cache and read the build output:

```bash
docker compose build --no-cache
```

Make sure `WEASYPRINT_BIN` is not pointing at a host path such as
`.venv/bin/weasyprint`; inside the container it must be
`/opt/venv/bin/weasyprint`. The same check applies to `PDFTOPPM_BIN`:

```bash
docker exec grace-catalogue-studio /usr/bin/pdftoppm -v
```

### Permission denied on the data volume

Symptoms: `EACCES: permission denied, mkdir '/app/data/renders'`, SQLite
`SQLITE_CANTOPEN`, or renders that fail after a host reboot.

```bash
ls -ln data
# drwxr-x--- 5 1000 1000 ...
sudo chown -R 1000:1000 data
```

The container's user is uid 1000, so a data directory created by root or by a
different host user cannot be written. Do not solve this by running the
container as root; the non root user is deliberate. On a host with SELinux
enforcing (CentOS, RHEL, Fedora), add the `Z` option to the volume in
`docker-compose.yml`: `./data:/app/data:Z`.

### Port in use

Symptoms: `docker compose up` fails with `Bind for 0.0.0.0:8787 failed: port is
already allocated`, or Caddy cannot connect.

```bash
sudo ss -ltnp | grep -E ':8787|:80|:443'
docker compose ps
docker ps --filter publish=8787
```

Stop the old container or process. To keep two stacks on one host, map a
different host port, for example `"8788:8787"`, and proxy Caddy to
`127.0.0.1:8788`.

### CORS errors in the browser

The browser console shows `blocked by CORS policy`. Set `CORS_ORIGINS` to the
exact origin including scheme and without a trailing slash, for example
`https://catalogue.example.com`, then `docker compose up -d`. A web app served
from the same origin as the API does not need an entry.

### 429 Too Many Requests

A response with status 429 and `Retry-After` means the per client limit was hit.
The defaults are 120 requests per minute and 12 renders per minute per client
IP. A single person cannot reach those by hand; a whole office behind one
public IP shares a bucket, and the web app retries nothing automatically.

```bash
docker compose logs --since 10m app | jq -c 'select(.level == "warn")'
```

If normal use trips the limit, raise `RATE_LIMIT_PER_MIN` or
`RENDER_LIMIT_PER_MIN` in `.env` and run `docker compose up -d`. If one client
is hitting the limit while others are not, check that requests reach the API
through Caddy with a real `X-Forwarded-For` value, and confirm port 8787 is not
reachable directly, since a forged header can otherwise pick its own bucket.

### Container is unhealthy or restarting

```bash
docker compose ps
docker compose logs --tail=200
docker compose exec app node -e "fetch('http://127.0.0.1:8787/health').then((r) => r.text()).then(console.log)"
```

Check free disk and memory with `df -h` and `free -m`. A full disk makes SQLite
and rendering fail. A memory limit that is too low for WeasyPrint shows up as
the container being killed (`exit code 137`) in `docker compose ps`; raise or
remove `mem_limit`.

### Renders are slow or time out

Renders are serialised inside the process by design, so two click happy users do
not corrupt the same template directory. A four page voucher with photography
takes seconds to tens of seconds on one vCPU. The first request for a template
thumbnail is slower because it is generated on demand; later ones are cached in
`data/previews/`. If it is consistently slow, give the VPS more CPU rather than
raising `RENDER_LIMIT_PER_MIN`.

### Disk fills up

```bash
df -h
docker system df
du -sh data/* | sort -h
```

Options: lower `RENDER_RETENTION_DAYS` (30 days by default), remove old
`backups/`, prune unused images with `docker image prune -f`, and prune the
build cache with `docker builder prune -f`.

### A `.env` value is not picked up

`docker compose up -d` recreates the container and reads `.env` again.
`docker compose restart` only restarts the existing container, with the old
environment. Confirm inside the container with
`docker exec grace-catalogue-studio printenv LOG_LEVEL`.

## Smoke test after the first deploy

Work through this once, then after every upgrade:

```bash
docker compose config -q                 # YAML and env file are valid
docker compose ps                        # running, healthy
curl -fsS http://localhost:8787/health   # {"ok":true,"version":"1.0.0"}
curl -fsS http://localhost:8787/ready    # database and WeasyPrint both true
```

Then in the browser at `https://catalogue.example.com`:

1. Load the order book and the designs gallery. Thumbnails may take a moment on
   the first visit while they are generated.
2. Create a customer and an order, then render the voucher.
3. Open the PDF and page images on the order screen.
4. Recreate the stack with `docker compose down && docker compose up -d` and
   confirm the order is still there. That proves the bind mount is persisting
   data across container recreation.
