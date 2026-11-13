# TalkSketch Desktop

Electron shell that opens the meeting in your real browser, captures **system audio + your
microphone**, transcribes locally with whisper.cpp, and shows notes, actions and an
**Excalidraw** board. The server is used for Google sign-in, entitlements, and one stateless
AI call per analysis window. No sessions, no server-side audio, no server-side canvas.

## Run

```bash
npm install
cd panel && npm install && npm run build && cd ..
npm start
```

The renderer is served from `http://localhost:3345`; the panel from
`http://localhost:3344`; local MCP from `http://127.0.0.1:3333/mcp`.

## Audio and transcription

**Start notes** captures system audio (everyone in the call) and your microphone through
`getDisplayMedia` + `getUserMedia`. If the bundled whisper.cpp runtime is present,
transcription runs on the device with `ggml-base.en.bin`; audio never leaves the machine.
If the runtime is missing, the app falls back to the server's `/v1/transcribe` endpoint.
Captions and manual Paste are the second fallbacks.

The first start shows a consent disclosure: participants must be told an AI assistant is
taking notes.

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
Without it the app still runs, using cloud STT when the server has `STT_API_KEY` set.

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

1. **Sign in with Google** — the system browser opens the OAuth consent page; the app polls
   the server and stores the session token.
2. Press **Open meeting** — the Meet link opens in your real browser (Google blocks
   sign-in inside embedded browsers).
3. In the app, press **Start notes** and accept the consent disclosure, then allow
   screen/audio sharing and pick the meeting tab or window.
4. Notes / Actions / Board update on the right every 20 seconds.

The app analyzes the last few minutes and applies board operations to the local Excalidraw
scene. Nothing about the meeting is stored on the server.

## Google sign-in

1. Google Cloud Console → **APIs & Services → Credentials → Create OAuth client ID → Web application**.
2. Authorized redirect URI: `https://<your-server>/v1/auth/google/callback`.
3. On the server set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET`, and
   optionally `ALLOWED_EMAILS`; restart the service.
4. The app shows **Sign in with Google**; the server verifies the account and issues a
   12-hour session token. `/v1/analyze` and `/v1/transcribe` accept that token or a pilot
   access key, and enforce the trial server-side.

## Trial and billing

- The trial starts on first Google sign-in and lasts `TRIAL_DAYS` (default 3).
- After it ends, AI endpoints return `402` and the app points at **Upgrade**.
- **Upgrade** renders PayPal Buttons for `PAYPAL_PLAN_ID` and calls
  `/v1/billing/activate`; PayPal webhooks flip the entitlement on cancellation or expiry.

## Local MCP

`http://127.0.0.1:3333/mcp` (loopback only):

- `get_recent_captions({ seconds })` — rolling transcript with speaker labels
- `speak_in_meeting({ text })` — local speech; route audio to VB-Cable and select it as the Meet mic

Resource: `meet://transcript/live`.

The chat tools (`send_meet_chat`, `get_meet_chat`) need a Meet page inside the app. This
build opens Meet in the system browser, so they return "No Google Meet page is open."

## Limits

- **Windows only for now.** The source builds on macOS and Linux, but only the Windows
  installer is produced.
- **System audio capture** depends on the OS share picker and on the meeting playing sound on
  this device.
- **Speaker labels are coarse:** remote participants appear as `Meeting`, you as `You`.
- **Whisper `base.en`** trades accuracy for size; `small.en` improves names and numbers.
- **Unsigned build.** SmartScreen warns on first run until a certificate is configured.
- **MCP is unauthenticated on loopback.** Any local process can call it while the app runs.
