# TalkSketch Desktop (preview)

Electron shell that hosts Google Meet in a webview, shows live notes, and exposes a local
MCP server so an agent can read captions, send chat, update the panel, and speak.

## Run

```bash
npm install
npm start
```

Default server: `https://54.255.181.218.sslip.io`; paste the pilot access key under
**Settings**. The public demo key is `TALKSKETCH`.

## Use

1. Paste the Meet link in the address bar.
2. Join (guest join works if Google sign-in is blocked in Electron).
3. Turn on captions (CC).
4. Press **Start notes**.
5. Tabs: Notes, Actions, Board (live snapshot), Claude (agent-pushed markdown).

## Local MCP

`http://127.0.0.1:3333/mcp` (streamable HTTP, bound to loopback).

Tools:

- `get_recent_captions({ seconds })`
- `send_meet_chat({ message })`
- `get_meet_chat()`
- `update_live_panel({ markdown })`
- `speak_in_meeting({ text })` — local speech; route audio to VB-Cable and select it as the Meet mic.

Resource: `meet://transcript/live`.

## Known limits

- **Captions, not audio.** The scraper reads Meet's caption DOM through an injected
  MutationObserver. Google can change the markup; treat it as beta.
- **Chat send is best-effort.** It opens the chat panel, inserts text, clicks Send. Meet's
  DOM changes can break it.
- **TTS needs a virtual cable.** The app speaks locally; it cannot select Meet's microphone
  for you.
- **Google sign-in may be blocked in Electron.** The app strips Electron from the user agent,
  but Google can still refuse; guest join is the fallback.
- **One live session at a time** on the demo server; the whiteboard is shared.
- **Unsigned portable Windows build.** SmartScreen warns on first run.
- **MCP is unauthenticated on loopback.** Any local process can call it while the app runs.

## Build

```bash
npm run dist
```

electron-builder needs Windows Developer Mode (or an elevated shell) to unpack its signing
tools. The portable build copies `node_modules/electron/dist`, adds `resources/app`, renames
`electron.exe` to `TalkSketch.exe`, and zips the folder.
