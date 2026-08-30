[简体中文](../README.md#服务器部署)

# Server Controller Deployment

This guide deploys the TSub controller, not just a proxy node. The server controller supports single-instance SQLite, multi-instance PostgreSQL, remote agents, and an optional same-host root executor.

## Deployment modes

| Mode | Web controller | HTTPS | Same-host control |
| --- | --- | --- | --- |
| Docker Compose | Unprivileged container | Caddy in Compose | Not installed by default; install the executor on the host |
| Bare metal | `tsub-controller` user | Install Caddy or configure Nginx | Installer registers the root executor |

Remote agents always initiate outbound connections and require no stored SSH password. Install the local executor only when the controller must manage a proxy node on its own host.

### Node public address detection

The deployment command first probes the node address through the controller. When a self-hosted controller cannot provide a Cloudflare client address, the node script tries the AWS Global API (`https://checkip.global.api.aws`) and then Akamai (`https://whatismyip.akamai.com`) over IPv4/IPv6. These services only return the egress IP and receive no deployment token or configuration. NAT, proxies, and special cloud networks can make the egress IP differ from the reachable address, so confirm the node public address manually in production.

## Preflight

- `amd64` and `arm64` Linux are supported. Bare metal supports Debian/Ubuntu with systemd and Alpine with OpenRC.
- Docker requires Docker Engine and Compose v2. At least 1 GB of available memory and 2 GB of disk are recommended.
- Bare metal requires Node.js 22, npm, Git, and a build environment for the frontend and native SQLite dependency.
- Point the domain A/AAAA record at the controller. DNS-only mode is recommended until the first certificate is issued.
- Allow `80/TCP` and `443/TCP` through provider and host firewalls. Allow `443/UDP` only when HTTP/3 is wanted. Never expose internal port `8787` publicly.
- The initializer generates a strong administrator password and distinct `COOKIE_SECRET`, `DEPLOYMENT_SECRET_KEY`, and `SETTINGS_SECRET_KEY` values. Keep them stable.

## Docker Compose

All `tsub.example.com` and `db.example.com` values in this section are placeholders. Replace them with your own domain, database hostname, or IP before running any command.

### 1. Get the source

```bash
git clone https://github.com/btjidi/TSub.git
cd TSub
TSUB_DOMAIN=tsub.example.com sh scripts/init-controller-env.sh
```

The initializer writes the complete template to `.env` with mode `0600` and prints the random administrator password once in the current terminal. Save it immediately. The script refuses to overwrite an existing `.env`.

To choose the administrator username or password during first initialization, pass them explicitly:

```bash
TSUB_DOMAIN=tsub.example.com \
TSUB_ADMIN_USERNAME=admin \
TSUB_ADMIN_PASSWORD='a-strong-password-of-at-least-twelve-characters' \
sh scripts/init-controller-env.sh
```

An explicit password is not echoed. Generated and explicit passwords are written only to `.env`, not to the image.

Public proxy-core and BusyBox versions, download URLs, and SHA-256 checksums are built into the application, so server deployments do not need `TSUB_XRAY_*`, `TSUB_SINGBOX_*`, or `TSUB_BUSYBOX_*` variables. For a custom mirror, provide a complete override for one core, including its version and AMD64/ARM64 URLs and checksums; incomplete overrides are rejected.

### 2. Optional manual `.env` setup

If the initializer is not used, copy the template and replace at least these values:

```dotenv
TSUB_PUBLIC_URL=https://tsub.example.com
DEPLOYMENT_SECRET_KEY=independent-random-value
SETTINGS_SECRET_KEY=another-independent-random-value
COOKIE_SECRET=a-third-independent-random-value
ADMIN_USERNAME=admin
ADMIN_PASSWORD=a-strong-password-of-at-least-twelve-characters
TSUB_DOMAIN=tsub.example.com
```

Use a 3-32 character administrator username, a password of at least 12 characters when supplied to the server initializer, and at least 16 characters for `COOKIE_SECRET`, `DEPLOYMENT_SECRET_KEY`, and `SETTINGS_SECRET_KEY` (32-64 random characters are recommended).

First run `cp server/controller.env.example .env && chmod 600 .env`, then run `openssl rand -hex 32` separately for each Secret. Never reuse a value or commit `.env`. Keep `TSUB_STATIC_DIR=/app/dist` in the Docker template.

### 3. Start

```bash
docker compose config
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 controller caddy
```

Compose publishes only 80/443. Port 8787 stays inside its private network. Named volumes retain Caddy and SQLite data across a normal `docker compose down`.

### 4. Verify

```bash
curl -I https://tsub.example.com/login
docker compose exec controller node -v
docker compose logs --tail=100 controller
```

After signing in, confirm server platform and active SQLite storage under Settings → System, then export the first backup.

### 5. Optional host executor

Skip this section when only remote agents are needed. The executor runs as root but accepts fixed actions rather than arbitrary shell strings.

On a systemd host:

```bash
sudo install -d -m 700 /opt/tsub-controller/server/executor /var/lib/tsub/bin /var/lib/tsub-controller/executor /etc/tsub
sudo install -d -m 770 /run/tsub
sudo install -m 700 server/executor/tsub-local-executor.sh /opt/tsub-controller/server/executor/tsub-local-executor.sh
sudo install -m 700 public/proxy/v2/tsub-proxy.sh /var/lib/tsub/bin/tsub-proxy.sh
sudo install -m 644 server/install/tsub-executor.service /etc/systemd/system/tsub-executor.service
sudo systemctl daemon-reload
sudo systemctl enable --now tsub-executor.service
```

On Alpine/OpenRC:

```bash
doas install -d -m 700 /opt/tsub-controller/server/executor /var/lib/tsub/bin /var/lib/tsub-controller/executor /etc/tsub
doas install -d -m 770 /run/tsub
doas install -m 700 server/executor/tsub-local-executor.sh /opt/tsub-controller/server/executor/tsub-local-executor.sh
doas install -m 700 public/proxy/v2/tsub-proxy.sh /var/lib/tsub/bin/tsub-proxy.sh
doas install -m 700 server/install/tsub-executor.openrc /etc/init.d/tsub-executor
doas rc-update add tsub-executor default
doas rc-service tsub-executor start
```

Binding a deployment to the local executor creates `/run/tsub/executor.conf` with mode `0600`. Verify with:

```bash
sudo test -S /run/tsub/controller.sock
sudo systemctl status tsub-executor.service --no-pager
sudo journalctl -u tsub-executor.service -n 100 --no-pager
```

For OpenRC use `rc-service tsub-executor status` and `/var/log/tsub-executor.log`.

## Bare-metal installation

Replace `tsub.example.com` in this section with your own domain before running commands.

### 1. Install dependencies and build

Install Node.js 22 from its official instructions, then build:

```bash
node -v
npm -v
git clone https://github.com/btjidi/TSub.git
cd TSub
npm ci
npm run build
```

`node -v` must report v22 or later. Avoid unreviewed third-party Node.js installation scripts.

### 2. Run the installer

```bash
sudo env \
  TSUB_DOMAIN=tsub.example.com \
  TSUB_ADMIN_USERNAME=admin \
  sh scripts/install-controller.sh
```

Without `TSUB_ADMIN_PASSWORD`, the installer generates a random password and prints it once after the first successful installation. To choose a password, add `TSUB_ADMIN_PASSWORD='a-strong-password-of-at-least-twelve-characters'`; explicit passwords are not echoed.

The first installation creates the unprivileged `tsub-controller` user, installs into `/opt/tsub-controller`, generates the administrator password and three independent encryption Secrets, writes `/etc/tsub-controller/controller.env` with mode `0600`, creates `/var/lib/tsub-controller`, and registers controller and executor services.

The installer does not install or configure a reverse proxy. The controller listens only on `127.0.0.1:8787`.

### 3. Configure Caddy

After installing Caddy, write this to `/etc/caddy/Caddyfile` with the real domain:

```caddyfile
tsub.example.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:8787
    header {
        -Server
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Content-Type-Options "nosniff"
        Referrer-Policy "no-referrer"
    }
}
```

Validate and start it:

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl enable --now caddy
sudo systemctl reload caddy
```

On Alpine use `rc-update add caddy default` and `rc-service caddy restart`. An Nginx installation must proxy only to `127.0.0.1:8787`, pass `Host`, `X-Forwarded-Proto`, and `X-Forwarded-For`, and manage its own certificate.

### 4. Verify services

systemd:

```bash
sudo systemctl status tsub-controller tsub-executor caddy --no-pager
sudo journalctl -u tsub-controller -n 100 --no-pager
sudo ss -lntp | grep -E ':(80|443|8787)\b'
curl -I http://127.0.0.1:8787/login
curl -I https://tsub.example.com/login
sudo stat -c '%a %U:%G %n' /etc/tsub-controller/controller.env /var/lib/tsub-controller/tsub.sqlite
```

OpenRC:

```bash
rc-service tsub-controller status
rc-service tsub-executor status
tail -n 100 /var/log/tsub-controller.log
```

## PostgreSQL

SQLite WAL is the default and is appropriate for one controller process. Use PostgreSQL for multiple controller instances or higher concurrency.

1. Create a dedicated database and least-privilege account in an external PostgreSQL server.
2. Add the connection to `.env` or `/etc/tsub-controller/controller.env`:

```dotenv
TSUB_POSTGRES_URL=postgresql://tsub:url-encoded-password@db.example.com:5432/tsub
TSUB_DATABASE_POOL_SIZE=10
```

3. Restart the controller so it connects and initializes the empty PostgreSQL schema.
4. Run the verified SQLite-to-PostgreSQL migration under Settings → System. Do not bypass migration by directly changing `TSUB_STORAGE_TYPE`.

Compose does not bundle PostgreSQL. The database address must be reachable from the `controller` container; `127.0.0.1` inside the container refers to the container itself.

## Backup and restore

- Prefer application export or scheduled WebDAV backups because they do not depend on database files.
- Store the three encryption Secrets separately. Deployment and settings ciphertext cannot be recovered from the database without the original Secrets.
- For an online SQLite file backup use `sqlite3 /var/lib/tsub-controller/tsub.sqlite ".backup '/safe/path/tsub.sqlite'"`. Do not copy a live WAL file directly.
- For a complete Docker volume backup, stop `controller` first and back up the `controller-data` named volume. Never run `docker compose down -v` as a backup step.
- Stop writes before restore, retain a snapshot of current data, and confirm application-version compatibility.

## Upgrade and rollback

### 1.0.12 default TLS/REALITY target and Runtime update

TSub `1.0.12` changes the default server name for new TLS/REALITY deployments to `www.cloudflare.com` for better handshake compatibility on AWS and similar cloud networks. Existing deployments are not changed automatically; edit the server name in the deployment record and run **Update Configuration** when needed.

### 1.0.13 deployment request protection

TSub `1.0.13` adds per-endpoint JSON body-size limits for deployment creation, configuration updates, defaults, and remote operations. Authenticated dashboard actions are not rate-limited; Agent heartbeats and callbacks use separate limits. Oversized requests return `413`, malformed JSON returns `400`, and request contents or secrets are never echoed.

### 1.0.11 Runtime update and rollback

TSub `1.0.10` adds **Update Version** and **Roll Back Runtime** to remote execution. Update Version validates the current manifest, atomically replaces the Runtime, and reloads the Agent. Rollback uses the historical `1.0.9` manifest retained by the controller, verifies its SHA-256, and then replaces the Runtime. It does not modify proxy cores, node configuration, or deployment data.

If an operation remains pending, check whether the node's Agent controller URL and deployment ID still point to the current controller. A node bound to an older controller must be reinstalled or rebound from the current controller; do not reuse an old command.

Docker upgrade:

```bash
git fetch --tags origin
git checkout main
git pull --ff-only
docker compose build --pull
docker compose up -d
docker compose logs --tail=100 controller caddy
```

Bare-metal upgrade:

```bash
git pull --ff-only
npm ci
npm run build
sudo sh scripts/install-controller.sh
```

Upgrade mode preserves `/etc/tsub-controller/controller.env` and all three encryption Secrets. Export a backup first. To roll back, check out the last known-good commit and rebuild. Restore the pre-upgrade backup as well if the new release wrote incompatible data.

## Uninstall

First uninstall same-host proxy deployments through the controller and export a backup.

- Docker: `docker compose down` stops containers but retains volumes. Only `docker compose down -v` removes SQLite and Caddy volumes.
- systemd: stop and disable `tsub-controller` and `tsub-executor`, remove their units, then run `systemctl daemon-reload`.
- OpenRC: stop both services, remove them from the default runlevel, then delete their init scripts.
- Delete `/opt/tsub-controller`, `/etc/tsub-controller`, and `/var/lib/tsub-controller` only after confirming the backup. `/etc/tsub`, `/var/lib/tsub`, and proxy firewall rules belong to the node Runtime and must be removed through deployment uninstall.

## Troubleshooting

- **404 page with a running API**: Docker requires `TSUB_STATIC_DIR=/app/dist`; bare metal requires `/opt/tsub-controller/dist/index.html`.
- **Certificate issuance failure**: verify DNS, public access to 80/443, port conflicts, and Caddy logs.
- **Session expires immediately**: verify that `COOKIE_SECRET` is unchanged and the proxy forwards HTTPS correctly.
- **Existing deployment cannot decrypt**: restore the original `DEPLOYMENT_SECRET_KEY` and `SETTINGS_SECRET_KEY`.
- **SQLite already in use**: only one SQLite controller is allowed. Stop the duplicate process or migrate to PostgreSQL.
- **Local executor offline**: inspect the Unix socket, `/run/tsub/executor.conf`, executor service, and Runtime permissions.
- **Compose cannot reach PostgreSQL**: do not use container-local `127.0.0.1`; use a resolvable database hostname or a service on the same Compose network.

Related: [Cloudflare Pages deployment tutorial](../README_EN.md#cloudflare-pages-deployment-guide) · [Architecture](ARCHITECTURE_EN.md) · [Security](SECURITY_EN.md) · [Operations](OPERATIONS_EN.md)
