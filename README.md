# hosting

A private control panel for a fleet of Linux machines. Add as many machines as you like (InstaBox sandboxes or any SSH server), watch them live, run commands on one or all, and deploy any number of projects: websites, APIs, workers, databases, local AI models, browser games.

Built with Next.js 16, deployed on Vercel. No database: machines come from environment variables, and everything else lives on the machines themselves.

## What's inside

| Page | What it's for |
|---|---|
| **Overview** | Fleet totals (machines, CPU, memory, storage, projects), one row per machine, usage over time, problems, suggestions |
| **Pipeline** | Live map: control plane → machines → projects. Commands animate along the links |
| **Run** | Shell commands on any set of machines, streamed output, background jobs with logs |
| **Projects** | Deploy a repo or container to N machines as a self-restarting service, with a public, private (token) or no link |
| **Assistant** | Ask about your servers. It runs read-only checks; every change it proposes waits for your click |
| **Machines** | Every configured machine, its agent version and how to add more |
| **Security** | Passkeys, email alerts and a hardening checklist |

The theme comes from a random Unsplash photo on every visit. The whole palette follows the photo's colour; the shuffle button on the Overview picks a new one.

## How it works

```
Browser ──HTTPS──▶ Vercel (Next.js: UI + API routes, session auth)
                       │  SSH (ssh2, host key pinned)
                       ▼
        ssh.instabox.sh:2222 / any SSH server
                       │
          ┌────────────┼────────────┐
        box1         box2   …     boxN        each runs ~/.hosting/bin/hostctl (the agent)
          │            │            │
    projects = systemd --user services, logs, jobs, published ports
```

- **Agent** (`src/agent/hostctl.sh`): a bash script the dashboard installs on each machine on first contact, and replaces when its version (a hash of the script) changes. It reports status as JSON, runs background jobs, deploys projects and records a metrics sample each time it is asked.
- **Projects** run as `systemd --user` services (`hosting-<name>`) that restart on crash. Code lives in `~/apps/<name>`, config and secrets in `~/.hosting/projects/` (mode 600).
- **History** builds up while the dashboard is open (one sample per check). Nothing polls in the background, so idle machines can still sleep.

## Setup

```bash
npm install
# one InstaBox SSH username (ibssh_…) per line:
$EDITOR tokens.txt
npm run env:sync        # writes .env.local (VMS, generated ADMIN_PASSWORD / SESSION_SECRET / CRON_SECRET)
npm run dev             # http://localhost:3000, sign in with the printed password
npm run ssh:sync        # optional: `ssh box1` … aliases on this laptop
```

### Environment variables

| Name | Required | What |
|---|---|---|
| `VMS` | yes | `box1=ibssh_…,box2=ibssh_…` or `web=user@host:22` for any SSH server |
| `ADMIN_PASSWORD` | yes | Password sign-in (turn off with `PASSWORD_LOGIN=off` once you have a passkey) |
| `SESSION_SECRET` | yes | 32+ random chars. Changing it signs everyone out |
| `APP_URL` | prod | `https://your-domain`: pins the domain for passkeys and links in emails |
| `PASSKEYS` | – | Added from the Security page after you register a passkey (public keys only) |
| `PASSWORD_LOGIN` | – | `off` = passkeys only |
| `INSTABOX_HOST_KEY_SHA256` | recommended | Gateway host key pin (set by `env:sync`) |
| `SSH_PRIVATE_KEY` | for non-InstaBox | PEM key for `user@host` machines |
| `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY` | for Assistant | `AZURE_OPENAI_AGENT_MODEL` / `AZURE_OPENAI_FAST_MODEL` optional |
| `UNSPLASH_ACCESS_KEY` | for the theme | Only the Access Key; the Secret Key is not used |
| `EMAIL_USER`, `EMAIL_PASS` | for alerts | Gmail address + app password. `ALERT_EMAIL_TO` optional |
| `CRON_SECRET` | for daily check | Vercel sends it to `/api/cron/health` |

## Deploy to Vercel

1. vercel.com → **Add New → Project** → import this GitHub repo (framework: Next.js, no changes).
2. **Settings → Environment Variables**: paste the block printed by `npm run env:sync -- --print` (Vercel accepts a whole `.env` paste), then add `APP_URL` with your production URL.
3. Deploy. Every `git push` redeploys. Changing an env var needs a redeploy.

**Add a machine later:** add its token to `tokens.txt`, run `npm run env:sync -- --print`, update `VMS` in Vercel, redeploy. The agent installs itself the first time the dashboard connects.

## Security

Passkeys (WebAuthn), password login with lockout, signed `HttpOnly` / `Secure` / `SameSite` session cookies (`__Host-` prefix), origin checks on every write, strict security headers (CSP, frame blocking, HSTS), host key pinning, secrets only in server env, audit log lines for every command/deploy/sign-in (Vercel → Logs), email alerts for sign-ins and problems, confirmation for destructive commands, and an assistant that can only read.

## Limits worth knowing (InstaBox free plan)

Each free machine pauses after 30 minutes idle and stops after its max runtime (2 h by default; check the machine's Settings), followed by a cooldown that grows when it happens repeatedly. Anything that must stay up around the clock (production sites, databases, model endpoints) belongs on an always-on server: a paid InstaBox plan or any VPS. Add it to `VMS` as `name=user@host:22` and it shows up here like the rest.
