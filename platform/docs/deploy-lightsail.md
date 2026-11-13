# Deploy on Lightsail

Host: `54.255.181.218` (Tailscale `100.118.35.17`), Ubuntu 24.04, 2 vCPU / 911 MB.

The box also serves `raisa.usayeed.com` through a Cloudflare tunnel. That stack is
untouched; everything unrelated was stopped to free memory.

## What runs

| Piece | How | Port |
| --- | --- | --- |
| Excalidraw canvas | Docker container `meeting-canvas` (240 MB limit) | 3000, tailnet only |
| Agent | `/home/ubuntu/meeting-partner/run.sh` (Node 24, per meeting) | outbound |
| Demo web app | `talksketch-demo.service` on `:8788`, nginx on `:80` | 80 |
| Raisa | nginx :8090 + Cloudflare tunnel + postgrest/Postgres + node apps | 443 via tunnel |

Board: **http://100.118.35.17:3000** (Tailscale). Public port 3000 is blocked by the
Lightsail firewall; do not open it, the canvas has no auth.

Demo: **http://54.255.181.218/** (or `demo.talksketch.work` once the DNS record exists),
access code `TALKSKETCH`. nginx proxies port 80 to `127.0.0.1:8788`; the app is
`talksketch-demo.service`. One analysis runs at a time; each demo costs a few model calls.

## Kept for raisa

`nginx`, `cloudflared` (token tunnel), `postgrest`, `postgresql@16-main`, `coturn`,
`watchwithme` (:5000, `/movie/`), `ourcall` (:5001, `/call/`), `raisa-upload` (:5002),
static files in `/var/www/raisabirthday*`.

## Stopped to free memory

`btc-pay`, `learncad-api`, `usayeed-api`, `usayeed-portal`, `telemetry`, `qt`,
`shadowsocks-libev`, `ss-vpn`, and all five Coolify containers (`restart=no`).

Result: available RAM 127 MB → ~366 MB, swap 1.0 GB → 0.44 GB. Raisa endpoints
`/`, `/rest/v1/`, `/movie/` all return 200.

Restore any of them with:

```bash
sudo systemctl enable --now usayeed-api        # example
sudo docker start coolify coolify-db coolify-redis coolify-sentinel coolify-realtime
```

## Run a meeting

Mock (no Vexa needed):

```bash
cd ~/meeting-partner && ./run.sh
```

Real meeting (Vexa Cloud or self-hosted Vexa):

```bash
cd ~/meeting-partner
TRANSCRIPT_SOURCE=vexa \
MEETING_PLATFORM=google_meet \
MEETING_ID=abc-defg-hij \
VEXA_BASE_URL=https://api.cloud.vexa.ai \
VEXA_API_KEY=vxa_... \
./run.sh
```

The agent writes to `~/meeting-partner/data/<meeting-id>/` and exits when the meeting ends.
`run.sh` pins Node 24; the system Node is 18 and too old for the MCP server.

## Notes

- `npm audit` reports 3 high advisories in `mcp-excalidraw-server`'s bundled MCP SDK and
  zod. The canvas is tailnet-only and memory-capped, which limits exposure; watch upstream
  for a fixed release.
- The container publishes on `0.0.0.0:3000` so it survives a reboot (binding to the
  Tailscale IP can race `tailscaled`). The Lightsail firewall is what keeps it private.
- `.env` is `chmod 600` and contains the model provider key (DeepSeek by default).
