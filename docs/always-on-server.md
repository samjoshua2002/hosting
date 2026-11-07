# Always-on server (databases, big apps, models)

The InstaBox sandboxes sleep after 30 minutes idle and stop after their max runtime, each has ~8 GB RAM and ~20 GB disk, and they only expose HTTPS. That is fine for builds, tests and small apps, but databases and anything that must stay up need one server that never sleeps. This guide sets one up with **Coolify** (free, open-source "own Vercel/Heroku") and connects it to this dashboard.

## 1. Create the server (you)

Any Ubuntu 22.04/24.04 VPS works (amd64 or arm64, 2+ CPU, 4+ GB RAM). The free option:

**Oracle Cloud Always Free** (check current limits; historically up to 4 ARM cores, 24 GB RAM, 200 GB disk at $0, card needed for verification):

1. Sign up at cloud.oracle.com and pick a home region close to you (it can't be changed later).
2. Compute → Instances → **Create instance**
   - Image: **Canonical Ubuntu 24.04**
   - Shape: **Ampere** → `VM.Standard.A1.Flex`, 4 OCPU, 24 GB memory (if it says "out of capacity", try another availability domain or fewer OCPUs and retry later)
   - Boot volume: up to **200 GB**
   - SSH keys: **Paste public key** → the contents of `~/.ssh/id_ed25519.pub` from your laptop
3. Networking → your VCN → Security List → **Add ingress rules** (source `0.0.0.0/0`, TCP): `80`, `443`, `8000`, `6001`, `6002`
4. Copy the instance's **public IP**.

## 2. Bootstrap it (one command)

```bash
scp scripts/bootstrap-server.sh ~/.ssh/hosting_dashboard.pub ubuntu@<ip>:
ssh ubuntu@<ip> 'sudo bash bootstrap-server.sh hosting_dashboard.pub'
```

Updates, a key-only `deploy` user for the dashboard, SSH hardening, firewall, fail2ban, then Coolify.

## 3. Coolify

Open `http://<ip>:8000` and **create the admin account immediately** (the first visitor becomes admin). Then:

- **Databases:** + New → Database → PostgreSQL / MySQL / MariaDB / MongoDB / Redis. Turn on "Make it publicly available" only for databases your apps elsewhere (e.g. Vercel) must reach, always with a strong password. Copy the connection string into your project's env.
- **Backups:** each database → Backups → schedule to S3-compatible storage (Cloudflare R2 has a free tier).
- **Admin UIs:** + New → Service → pgAdmin, phpMyAdmin, Mongo Express…
- **Apps:** + New → Application → from your GitHub repo; Coolify gives it HTTPS on your domain.
- Give Coolify itself a domain (Settings) so you can use `https://` and close port 8000.

## 4. Add it to this dashboard

1. Vercel → Environment Variables:
   - `VMS` → append `,cloud=deploy@<ip>:22`
   - `SSH_PRIVATE_KEY_B64` → the value from `.env.local` (generated for you; the private key of `~/.ssh/hosting_dashboard`)
2. Redeploy. The agent installs itself on first contact; `cloud` shows up next to box1–5 with live metrics, Run, Assistant and alerts.

## Sizing

| Workload | Needs |
|---|---|
| Postgres / MySQL / Mongo for a few apps | 1–2 GB RAM each, disk = your data |
| Local LLM 7–8B (4-bit, CPU) | ~6 GB RAM; 13B ~10 GB; ARM CPU only, so a few tokens/s |
| Game server | per game; big assets belong in object storage (R2/S3), not the server disk |
