# Deploying RONDA on the PAIO Contabo VPS

Handoff for the agent that administers the VPS. This document is **secret-free**:
no API keys, tokens or passwords appear here, and none should be pasted into a chat.

## What RONDA is

A voice agent for industrial operator rounds, built on the AssemblyAI Voice Agent API.
Plain Node.js HTTP server, **zero npm dependencies** — there is no `npm install` step.
It serves a small web UI, mints single-use browser tokens, and exposes four tool
endpoints that **AssemblyAI's servers call directly over the public internet**.

## Non-negotiables

1. Do **not** touch the `n8n`, `sales-n8n` or `sales-telegram-bot` containers, or ports
   `5678`, `5679`, `20128`. RONDA is a standalone service on its own port and subdomain.
2. Do **not** commit or print the contents of `.env`. It carries the AssemblyAI API key
   and the tool shared secret.
3. `.env` must be mode `600`, owned by the service user.
4. The tool endpoints must be reachable over **public HTTPS**. AssemblyAI blocks private
   and loopback addresses and verifies the hostname resolves in DNS.

## Preconditions — check these before doing anything else

| Check | Requirement | Why |
|---|---|---|
| `node --version` | **≥ 22.5.0** | The app uses the built-in `node:sqlite` module. On Node 20 it fails at import with `Cannot find module 'node:sqlite'`. |
| Free TCP port | `8787` suggested | Must not collide with 5678 / 5679 / 20128. |
| Subdomain | e.g. `ronda.<domain>` → VPS A record | Must already resolve publicly **before** the agent is published. |
| TLS | Caddy or nginx + certbot | Plain HTTP will be rejected. |

If Node on the VPS is older than 22.5, install a current Node 22 LTS or newer before
continuing. Do not attempt to swap `node:sqlite` for a third-party driver.

## Steps

### 1. Place the code

Target `/opt/ronda`, owned by a dedicated unprivileged user (e.g. `ronda`).
The source is on Dewa's MacBook at `Desktop/Dewa Research/Hackathon/AssemblyVoice`.
Transfer by `rsync` or, once the public GitHub repo exists, `git clone`.

**Exclude `.env` and `ronda.db` from any transfer** — `.gitignore` already covers both.

### 2. Create `.env`

Copy `.env.example` to `.env` and fill it in on the server. Dewa supplies the
AssemblyAI key out of band. Fields:

| Key | Value |
|---|---|
| `ASSEMBLYAI_API_KEY` | from Dewa, out of band |
| `PUBLIC_URL` | `https://ronda.<domain>` — no trailing slash, must be https |
| `TOOL_SECRET` | generate on the server: `node -e "console.log(crypto.randomUUID())"` |
| `AGENT_ID` | leave **empty** for now; step 6 fills it in |
| `PORT` | `8787` |
| `LLM_MODEL` | `qwen3.5-4b-32k-fast` |

`chmod 600 .env`.

### 3. Seed the database

```bash
cd /opt/ronda && node server/seed.mjs
```

Creates `ronda.db` in the project root. SQLite runs in WAL mode, so `ronda.db-wal`
and `ronda.db-shm` appear alongside it — the service user needs write access to the
**directory**, not just the file.

### 4. systemd unit

`/etc/systemd/system/ronda.service`:

```ini
[Unit]
Description=RONDA voice copilot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ronda
WorkingDirectory=/opt/ronda
ExecStart=/usr/bin/node server/index.mjs
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/ronda

[Install]
WantedBy=multi-user.target
```

The app reads `.env` from its own project root, not from the working directory, so
`WorkingDirectory` is not load-bearing for config — but keep it set anyway.

### 5. Reverse proxy

Caddy is the lower-effort option; it obtains and renews the certificate itself:

```
ronda.<domain> {
    reverse_proxy 127.0.0.1:8787
}
```

**If you use nginx instead**, disable response buffering on the events endpoint or the
UI will appear frozen — `/api/round/<id>/events` is a long-lived Server-Sent Events
stream:

```nginx
location ~ ^/api/round/.+/events$ {
    proxy_pass http://127.0.0.1:8787;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 3600s;
}
```

### 6. Publish the agent — only after the domain is live

Ordering matters. AssemblyAI resolves the tool hostname at agent-create time, so this
step fails with `422 … webhook URL host does not resolve` if run too early.

```bash
cd /opt/ronda && node publish.mjs
```

It creates the agent and writes `AGENT_ID` back into `.env`. **Restart the service
afterwards** so the process picks up the new value:

```bash
systemctl restart ronda
```

## Verification

Run in order; each one should pass before moving on.

```bash
# 1. service is up locally
curl -s localhost:8787/healthz                       # {"ok":true}

# 2. reachable over public HTTPS
curl -s https://ronda.<domain>/healthz               # {"ok":true}

# 3. tool endpoints reject unauthenticated callers
curl -s -o /dev/null -w '%{http_code}\n' \
  'https://ronda.<domain>/tools/asset-checklist?asset_tag=P-3A'   # 401

# 4. and accept the shared secret
curl -s -H "x-ronda-key: $TOOL_SECRET" \
  'https://ronda.<domain>/tools/asset-checklist?asset_tag=P-3A'   # JSON with 5 checks

# 5. the browser token endpoint returns a token AND a non-null agent_id
curl -s https://ronda.<domain>/api/token

# 6. nothing else was disturbed
docker ps --format 'table {{.Names}}\t{{.Status}}'
```

Step 5 returning `"agent_id": null` means step 6 of the deployment was skipped or the
service was not restarted.

## Report back

- the public URL
- Node version on the VPS
- port and systemd unit name in use
- confirmation that step 3 returned 401 and step 5 returned a non-null `agent_id`

Do **not** report the API key, the `TOOL_SECRET`, or any token.
