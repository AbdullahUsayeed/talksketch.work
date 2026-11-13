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

## Audio and transcription

**Start notes** captures system audio (everyone in the call) and your microphone. If the bundled
whisper.cpp runtime is present, transcription runs on the device with `ggml-base.en.bin`; audio never
leaves the machine. If the runtime is missing, the app falls back to the server's
`/v1/transcribe` endpoint. Captions are the second fallback.

### Bundle the local runtime (needed for the installer)

Create `whisper-runtime/` next to this README:

```
whisper-runtime/
├── whisper-cli.exe
├── whisper.dll
├── ggml.dll
├── ggml-base.dll
├── ggml-cpu-*.dll
└── models/ggml-base.en.bin
```

- Binaries: <https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip>
- Model: <https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin> (~141 MB)

`extraResources` copies it into the installed app. The installer is ~209 MB as a result.

## Build the Windows installer

```bash
npm install
cd panel && npm install && npm run build && cd ..
npm run dist
# dist/TalkSketch Setup 0.1.0.exe  (installer)
# dist/TalkSketch 0.1.0.exe        (portable)
```

electron-builder uses the locally installed Electron (`electronDist`), so it does not download
it again. The installer is unsigned until a code-signing certificate is configured.

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
