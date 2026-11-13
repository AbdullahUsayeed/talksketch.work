# TalkSketch platform

Self-hostable backend for TalkSketch: Google sign-in, 3-day trials, PayPal activation and
cancellation webhooks, one stateless `/v1/analyze` call, an optional `/v1/transcribe`
fallback, and the hosted transcript demo. It stores no meeting audio and no canvas state —
the desktop client owns capture, transcription, notes and the Excalidraw board.

It is an **assembly of projects that already work**, not a new meeting platform:

| Concern | Reused project | License |
| --- | --- | --- |
| Notes / actions / board operations | any OpenAI-compatible model (DeepSeek by default) | – |
| Google sign-in | [google-auth-library](https://github.com/googleapis/google-auth-library-nodejs) | Apache-2.0 |
| Payments and subscription state | PayPal Subscriptions API | – |
| Optional bot transcript source | [Vexa](https://github.com/Vexa-ai/vexa) 0.12 | Apache-2.0 |
| Canvas (client side) | [Excalidraw](https://github.com/excalidraw/excalidraw) / [mcp-excalidraw-server](https://github.com/yctimlin/mcp_excalidraw) | MIT |

The glue in this repo is about 1,250 lines — transcript adapters, a rolling window, rate limits, a
Markdown/JSONL record, prompts, and the scheduler. There is no in-house agent loop, tool protocol,
canvas, or element model.

```
Meet / Zoom / Teams
        │  bot joins, captures audio
        ▼
      Vexa ── GET /transcripts/{platform}/{id} ──►  meeting-partner
                                                      │  rolling window
                                                      │  OpenAI Agents SDK
                                                      │   ├─ record_note
                                                      │   ├─ record_suggestion
                                                      │   ├─ record_action_item
                                                      │   └─ Excalidraw MCP ──► live board
                                                      ▼
                                              notes.md · summary.md · records.jsonl
```

## Why this shape

The first version of this repo implemented its own orchestrator, function-calling loop, tool
schemas and whiteboard layout engine. Two assumptions in that plan were wrong:

1. **Vexa 0.12 does not stream transcripts over WebSocket.** WS streaming and mid-call bot control
   return 404 in open-core; polling the documented REST endpoint is the supported path.
2. **`excalidraw-room` has no element API.** It is a socket.io relay, not a scene store. An external
   process cannot POST elements to it.

`mcp-excalidraw-server` solves the second problem properly: it runs a real canvas with REST, a
WebSocket sync channel, and 27 MCP tools (`create_element`, `batch_create_elements`,
`describe_scene`, screenshots, export). The agent draws through MCP instead of reverse-engineering
a collaboration protocol. Details: [docs/0001-integration-contracts.md](docs/0001-integration-contracts.md).

## Self-host the service

Requirements: Node 20+, an OpenAI-compatible model key, a Google OAuth web client, and a
PayPal app if you want billing. Production needs HTTPS for the OAuth redirect.

```bash
npm install
cp .env.example .env      # fill in the values
npm run build
node dist/web.js          # http://localhost:8788
```

- **AI only:** `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL`.
- **Sign-in and trials:** `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET`,
  `PUBLIC_BASE_URL`, `TRIAL_DAYS`. Without Google, access keys still work.
- **Billing:** `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_PLAN_ID`,
  `PAYPAL_WEBHOOK_ID`, `PAYPAL_API_BASE`.
- **Speech-to-text:** `STT_PROVIDER` (`xai` or `openai`), `STT_API_KEY`, `STT_BASE_URL`,
  `STT_MODEL`. xAI `/v1/stt` auto-detects English and Bangla; OpenAI uses
  `/audio/transcriptions`.

Google Cloud → Credentials → OAuth client (Web application) → authorized redirect URI:
`${PUBLIC_BASE_URL}/v1/auth/google/callback`.

PayPal webhook: `${PUBLIC_BASE_URL}/v1/paypal/webhook` with
`BILLING.SUBSCRIPTION.ACTIVATED`, `RE-ACTIVATED`, `CANCELLED`, `SUSPENDED`, `EXPIRED`.

Health check: `GET /healthz`. State lives in `DATA_DIR` (`trials.json`,
`entitlements.json`) and hosted records are purged after 24 hours; use `backup.sh` for
daily backups.

## Demo

- Hosted: <https://54.255.181.218.sslip.io>
- Access code: `TALKSKETCH` (`DEMO_CODE`)
- Paste a transcript, get notes, actions, suggestions and a rendered board.

Run it yourself:

```bash
npm run build
DEMO_CODE=my-code node dist/web.js   # http://localhost:8788
```

## Legacy bot mode (optional)

The sections below describe the earlier Vexa-driven bot (`src/index.ts`, `src/live.ts`,
`src/agent.ts`). The shipped desktop app does not use it; the client captures and
transcribes audio itself. Keep it only if you want a bot that joins calls server-side.

## With a real meeting

1. Deploy Vexa and send a bot:

   ```bash
   git clone https://github.com/Vexa-ai/vexa && cd vexa && make all

   curl -X POST http://localhost:18056/bots \
     -H "X-API-Key: $VEXA_API_KEY" -H "Content-Type: application/json" \
     -d '{"platform":"google_meet","native_meeting_id":"abc-defg-hij","bot_name":"Scribe"}'
   ```

2. Run this service against it:

   ```bash
   TRANSCRIPT_SOURCE=vexa \
   MEETING_PLATFORM=google_meet \
   MEETING_ID=abc-defg-hij \
   VEXA_API_KEY=vxa_... \
   OPENAI_API_KEY=sk-... \
   npm run dev
   ```

The meeting ends when Vexa reports a final status or after `END_AFTER_SILENCE_MS` without a new
confirmed segment. A final agent turn writes the conclusion on the board and produces `summary.md`.

## What the agent does

| Action | Trigger | Guardrail |
| --- | --- | --- |
| `record_note` | decision, number, commitment, risk | one per `NOTE_MIN_INTERVAL_MS`, duplicate detection |
| `record_suggestion` | a risk or option the room missed | max 3 per meeting, cooldown, near-duplicate check |
| `record_action_item` | explicit commitment with an owner | duplicate detection, no inferred tasks |
| Excalidraw element | a point is settled | board zones in the prompt, `describe_scene` first |

The guardrails are enforced in code (`src/policy/Gatekeeper.ts`), so a model that ignores the prompt
still cannot spam the room. Rejections are returned to the model as `{"ok":false,"reason":"..."}`.

The board is laid out in zones (agenda, key points, decisions, risks, conclusion) so elements do not
overlap; the model chooses the zone, the MCP server owns the element model.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `OPENAI_API_KEY` | required | Model access (DeepSeek key by default) |
| `OPENAI_MODEL` | `deepseek-flash` | Any tool-calling model |
| `OPENAI_BASE_URL` | `https://api.deepseek.com` | OpenAI-compatible endpoint (Chat Completions) |
| `TRANSCRIPT_SOURCE` | `mock` | `mock` or `vexa` |
| `MEETING_PLATFORM` | `google_meet` | `google_meet`, `zoom`, `teams`, `jitsi` |
| `MEETING_ID` | — | Native id, required for `vexa` |
| `MEETING_TOPIC` | — | Seed for the agenda |
| `MEETING_PARTICIPANTS` | — | Comma-separated names |
| `COMPANY_CONTEXT` | — | Product/company background |
| `VEXA_BASE_URL` | `http://localhost:18056` | Vexa gateway |
| `VEXA_API_KEY` | — | Vexa key |
| `RUN_INTERVAL_MS` | `20000` | Agent review cadence |
| `MAX_TURNS` | `8` | Max model/tool iterations per turn |
| `EXPRESS_SERVER_URL` | `http://127.0.0.1:3000` | Canvas address |
| `NOTE_MIN_INTERVAL_MS` | `60000` | Note cooldown |
| `SUGGESTION_MIN_INTERVAL_MS` | `120000` | Suggestion cooldown |
| `MAX_SUGGESTIONS` | `3` | Hard cap |
| `NOTE_WARMUP_MS` | `45000` | No notes during intros/agenda |
| `SUGGESTION_MIN_MEETING_MS` | `120000` | No suggestions before the discussion has substance |
| `CONTEXT_MAX_TOKENS` | `2000` | Transcript window budget |
| `MOCK_SPEED` | `3` | Demo speed multiplier |
| `DATA_DIR` | `./data` | Artifact root |

## Artifacts

```
data/<platform>-<meeting-id>/
├── notes.md        # live, human-readable record
├── records.jsonl   # append-only, machine-readable
└── summary.md      # final summary + action items
```

There is intentionally no custom web UI for bot mode: Vexa's Terminal (`:13000`) shows the bot
and transcript, and the Excalidraw canvas (`:3000`) is the shared board. The web service in
`src/web.ts` is the one used in production.

## Docker

```bash
cp .env.example .env      # fill in the values
docker compose up --build # http://localhost:8788
```

The image builds `dist/web.js` and serves the demo from the same process. `./data` is mounted
for trials, entitlements and demo records, and the service needs no database or canvas
container — the board lives in the desktop client. For production, put it behind Caddy or
nginx with TLS and set `PUBLIC_BASE_URL` to the public HTTPS origin.

## Limitations

- **Vexa 0.12 has no in-meeting chat API.** Notes go to the board, the Markdown record, and any
  export you add. Do not expect the bot to speak or post in chat.
- **Polling, not push.** `POLL_INTERVAL_MS` is the floor on transcript latency (2s by default).
- **The model decides what matters.** That is the point, but it means variance. Rate limits and
  duplicate checks bound the failure mode; they do not make it deterministic.
- **Cost.** One model call per review interval while speech continues. A 30-minute call at 20s
  intervals with a 2k-token window is roughly 60-90 calls.
- Excalidraw's canvas has **no authentication** in its open-source server. Do not expose port 3000
  publicly without a proxy and access control.

## AI disclosure

A bot joining a call must identify itself. Vexa joins under `BOT_NAME`, and participants must be
told that transcription and an AI assistant are active. Do not deploy this covertly.

## Credits and licenses

This project is Apache-2.0. It depends on:

- [Vexa](https://github.com/Vexa-ai/vexa) — Apache-2.0
- [mcp-excalidraw-server](https://github.com/yctimlin/mcp_excalidraw) — MIT
- [Excalidraw](https://github.com/excalidraw/excalidraw) — MIT
- [OpenAI Agents SDK](https://github.com/openai/openai-agents-js) — MIT

If you publish a derivative, keep their notices and licenses intact.
