# 0001 — Integration contracts

Status: accepted, revised (2026-07-06)

The original project plan made two claims about third-party capabilities that are wrong. Both change
the architecture, so they are recorded here with the evidence and the resulting decision.

Revision: v0.2 replaces this repo's custom orchestrator, function-calling loop and layout engine with
maintained projects (Vexa, mcp-excalidraw-server, OpenAI Agents SDK). See section 5.

## 1. Vexa transcript transport

**Plan assumed:** subscribe to a Redis stream `transcription_segments`, or use Vexa's WebSocket API.

**Reality (Vexa 0.12, open-core):**

- The API reference lists `GET /transcripts/{platform}/{native_meeting_id}` and says "poll while
  live".
- The README states that WebSocket streaming and mid-call bot control return `404` today.
- The roadmap lists "WebSocket transcript multiplex — Planned (poll today)".
- "Redis transcript streaming — Production" is internal. Keys and payloads are not a public contract.

**Decision:** poll the documented REST endpoint. Drafts (`completed: false`) are dropped; finals are
de-duplicated by `segment_id` (or `speaker:start` when absent). A `TranscriptSource` interface keeps
the choice swappable.

**Consequences:** 2s median latency by default. Acceptable for notes and suggestions, which are not
word-by-word features.

## 2. Excalidraw whiteboard control

**Plan assumed:** "call the Excalidraw collaboration server API to add elements".

**Reality:**

- `excalidraw-room` is a socket.io relay for multiplayer sessions; it has no REST endpoint for scene
  mutation and does not own the scene.
- The authoritative Excalidraw API is the React imperative handle `updateScene`, which only exists in
  a browser.

**Decision:** do not touch `excalidraw-room` and do not build a React client. Use
[`mcp-excalidraw-server`](https://github.com/yctimlin/mcp_excalidraw) (MIT, v2.2): it runs a real
Excalidraw canvas with:

- REST + WebSocket sync on `:3000`
- 27 MCP tools (`create_element`, `batch_create_elements`, `describe_scene`, `export_to_image`, …)
- headless screenshot rendering, so an agent can inspect its own layout
- durable snapshots and export

The agent calls those tools through the OpenAI Agents SDK's stdio MCP client. Verified locally:
`npm run board:check` connects and lists all 27 tools; elements created over the API appear in
`describe_scene`.

**Consequences:** the canvas is a separate process (or container) and has no auth of its own; do not
expose it publicly without a proxy. Humans and the agent share one scene, one undo model, and one
export path.

## 3. In-meeting chat

**Plan assumed:** `POST /bots/{platform}/{id}/chat`, with a fallback to a WS `chat` channel.

**Reality:** Vexa 0.12 exposes no send-chat endpoint; the plan itself flagged this as unimplemented.

**Decision:** notes go to the Excalidraw board and to `notes.md` / `summary.md`. A future `ChatSink`
can be added without changing the tools.

## 4. Decision layer

**Reality:** an agent loop with tool execution, retries, turn limits, tracing and MCP support is a
solved problem and is not where this project adds value.

**Decision:** use the [OpenAI Agents SDK](https://github.com/openai/openai-agents-js) (MIT) for the
loop and MCP client. Keep only:

- the prompt (`src/agent.ts`)
- three local record tools
- a code-enforced `Gatekeeper` for note cadence, suggestion budget and duplicates
- a scheduler that skips turns when no new speech arrived

Optional fields use `zod` schemas that the SDK converts to strict JSON Schema.

## 5. Assembly over custom code

**Trigger:** the v0.1 implementation worked (26 tests, end-to-end mock run), but it re-implemented
an agent loop, tool schemas, a whiteboard model and a control panel — four surfaces that already
exist, are maintained, and have more users than this repo ever will.

**Decision:** delete the custom orchestrator (preserved in git tag `custom-orchestrator-v0` and
branch `archive/custom-orchestrator`) and keep a thin integration:

| Layer | Before | After |
| --- | --- | --- |
| Agent loop | custom 3-iteration loop | OpenAI Agents SDK |
| Tool schemas | hand-written JSON Schema | `zod` + SDK |
| Whiteboard | custom layout engine + element type | mcp-excalidraw-server |
| UI | custom SSE panel | Vexa Terminal + Excalidraw canvas |
| Transcript | custom poller | kept (documented REST, ~90 lines) |
| Guardrails | custom gatekeeper | kept (~130 lines, tested) |

**Consequences:** roughly 1,250 lines of glue (a third of it transcript adapters and storage) instead
of an in-house orchestrator. Fewer failure modes, but two new runtime dependencies and a
supply-chain surface to review. Both are MIT/Apache-2.0 and pinned in `package.json`.
