# meeting-partner

An AI meeting partner that joins a call, follows the transcript, writes notes, and draws on a
shared Excalidraw board while the meeting is still happening.

It is an **assembly of projects that already work**, not a new meeting platform:

| Concern | Reused project | License |
| --- | --- | --- |
| Bot joins Meet / Teams / Zoom, audio capture, transcription | [Vexa](https://github.com/Vexa-ai/vexa) 0.12 | Apache-2.0 |
| Shared whiteboard, live sync, element API | [mcp-excalidraw-server](https://github.com/yctimlin/mcp_excalidraw) 2.2 | MIT |
| Agent loop, tool calling, MCP client, turn limits | [OpenAI Agents SDK](https://github.com/openai/openai-agents-js) 0.22 | MIT |
| Decision model | DeepSeek V4.1 Flash (default) or any tool-calling model | — |

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

## Quick start

Requirements: Node 20+, a DeepSeek API key (or any OpenAI-compatible endpoint).

```bash
npm install
cp .env.example .env          # add OPENAI_API_KEY
npm run dev
```

The demo transcript runs by default, so no meeting is needed. The Excalidraw MCP server starts the
canvas automatically; open **http://127.0.0.1:3000** to watch the board fill in. Notes land in
`data/<meeting-id>/`.

Check the board wiring at any time:

```bash
npm run board:check
# excalidraw MCP ok ... tools: 27
```

## Live demo

The same engine, exposed as a one-shot web app:

- URL: `http://54.255.181.218/` (temporary IP; `demo.talksketch.work` once DNS is added)
- Access code: `TALKSKETCH` (`DEMO_CODE`)
- Paste a transcript, get notes, actions, suggestions and a rendered board.

Run it yourself:

```bash
npm run build
DEMO_CODE=my-code node dist/web.js   # http://localhost:8788
```

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

There is intentionally no custom web UI: Vexa's Terminal (`:13000`) shows the bot and transcript,
and the Excalidraw canvas (`:3000`) is the shared board.

## Docker

```bash
docker compose up --build
```

The compose file starts the Excalidraw canvas and the agent. Vexa stays its own stack; see the note
at the bottom of `docker-compose.yml` about joining its Docker network.

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

This project is MIT. It depends on:

- [Vexa](https://github.com/Vexa-ai/vexa) — Apache-2.0
- [mcp-excalidraw-server](https://github.com/yctimlin/mcp_excalidraw) — MIT
- [Excalidraw](https://github.com/excalidraw/excalidraw) — MIT
- [OpenAI Agents SDK](https://github.com/openai/openai-agents-js) — MIT

If you publish a derivative, keep their notices and licenses intact.
