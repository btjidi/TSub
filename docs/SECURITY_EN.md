[简体中文](SECURITY.md)

# Security Model

## Trust boundaries

The admin browser, platform adapter, storage, agent/local executor, server Runtime, proxy core, and external sources are separate boundaries. KV mode never connects to a server; full-mode agents poll outward. The local server HTTP subscription has no TLS and relies on a high-entropy path token, so clients should prefer the control-plane HTTPS mirror.

## Identity and sessions

- Administrator usernames are 3–32 characters and passwords are 8–128 characters.
- Password changes are stored as salted PBKDF2-SHA256 hashes, never plaintext.
- HttpOnly Cookies use stable signing keys and SameSite restrictions.
- A credential-version change invalidates all old sessions.
- External API, Bootstrap, Callback, Push, and subscription tokens are independent.
- Agent tokens are independent 256-bit values stored only as SHA-256. Command leases last 120 seconds and a deployment has only one active mutating command.

## Deployment secrets

`DEPLOYMENT_SECRET_KEY` derives the AES-256-GCM key for deployment configuration. WebDAV, Telegram, Cron, and External API secrets prefer a separate `SETTINGS_SECRET_KEY` and fall back to `DEPLOYMENT_SECRET_KEY` for compatibility. Legacy plaintext settings migrate automatically to an encrypted record. Public settings, lists, logs, backups, and errors do not reveal passwords, REALITY/WARP keys, certificate keys, or tokens. Bootstrap tokens are stored only as SHA-256 digests and are single-use.

## Input and network

APIs limit JSON and push payload sizes, and accept only supported share protocols. External fetches, source refresh, and WebDAV validate URLs and addresses to reduce SSRF risk. Administrators remain responsible for trusting remote rule scripts and proxy endpoints.

## Server privileges

Runtime prefers least privilege. Unprivileged mode uses user directories and disables low ports, system firewall changes, and system services. Secret files use `0600`, directories use `0700`, and temporary files are removed by stage. Failed service, configuration, or firewall switches roll back transactionally.

The server web controller runs as a dedicated unprivileged user. A separate root executor claims fixed actions over a dedicated Unix socket and accepts only server-validated configuration, never arbitrary shell, paths, or environment. The socket is `0660`; configurations, tokens, and temporary files are `0600`. Docker deployments must not mount the Docker socket or use `privileged`.

The Node adapter accepts forwarded protocol, host, and client address only from sources allowed by `TSUB_TRUST_PROXY`. Bare metal trusts loopback Caddy/Nginx by default. Compose uses an isolated private network and does not publish the controller port. `TSUB_PUBLIC_URL` is authoritative for public URLs.

Controller ownership transfer uses a 30-minute one-time claim stored only as a hash. A node verifies target HTTPS and claims a new agent token, atomically writes local configuration, and only then asks the old controller to revoke access. A failed target registration leaves the old controller active. Package passwords are never stored or logged; AES-GCM authentication and a canonical digest detect tampering.

## Demo and screenshots

Demo records use RFC 5737 addresses and `.invalid` domains. Screenshot requests return only demos and redacted settings and never trigger Cron. Demo URLs cannot be copied and Profiles cannot become public. The screenshot script reads credentials from environment variables and checks known sensitive values before saving.

## Operational requirements

Rotate administrator passwords, Cookie keys, deployment keys, and External API tokens. Recreate or migrate encrypted deployment records before replacing the deployment key; ciphertext cannot be recovered without the old key. Never commit `.dev.vars`, Cloudflare tokens, server passwords, or real subscription links.
