# TalkSketch Desktop (preview)

Electron shell that hosts Google Meet, captures captions, shows notes, and embeds
**Excalidraw** locally. The server is used for exactly two things: Google sign-in and one
stateless AI call per analysis window. No sessions, no server-side canvas.

## Run

```bash
npm install
cd panel && npm install && npm run build && cd ..
npm start
```

Build the portable Windows app:

```bash
npx esbuild main.js --bundle --platform=node --target=node20 --external:electron --format=cjs --outfile=main.bundle.js
# copy main.bundle.js, preload.js, renderer/, panel-dist/, package.json into Electron's resources/app
```

## Use

1. Paste the Meet link in the address bar.
2. Join (guest join works if Google sign-in is blocked in the webview).
3. Turn on captions (CC).
4. Press **Start notes**.
5. Tabs: Notes, Actions, Board (Excalidraw), Claude (agent-pushed markdown).

The app analyzes the last few minutes every 20 seconds and applies board operations to the
local Excalidraw scene.

## Google sign-in

1. Google Cloud Console → **APIs & Services → Credentials → Create OAuth client ID → Web application**.
2. Authorized JavaScript origin: `http://localhost:3345`.
3. On the server, set `GOOGLE_CLIENT_ID`, `ALLOWED_EMAILS` (pilot emails), and a long
   `SESSION_SECRET`; restart the demo service.
4. The app will show **Sign in with Google**. The server verifies the ID token and issues a
   12-hour session token; `/v1/analyze` accepts that token or a pilot access key.

## Local MCP

`http://127.0.0.1:3333/mcp` (loopback only):

- `get_recent_captions({ seconds })`
- `send_meet_chat({ message })`
- `get_meet_chat()`
- `update_live_panel({ markdown })`
- `speak_in_meeting({ text })` — local speech; route audio to VB-Cable and select it as the Meet mic.

Resource: `meet://transcript/live`.

## Limits

- **Captions, not audio.** Meet's caption DOM is read via MutationObserver; Google can change it.
- **One AI call per 20s per client.** No meeting state is stored server-side.
- **Chat send / TTS are best-effort**, untested against every Meet build.
- **Unsigned portable Windows build.** SmartScreen warns on first run.
- **MCP is unauthenticated on loopback.** Any local process can call it while the app runs.
- **Google sign-in requires the OAuth client setup above.**
