# TalkSketch Desktop

Electron shell that captures **system audio + your microphone** and shows notes, actions and an
**Excalidraw** board in a full-window panel. Short audio chunks go to the server for cloud
speech-to-text (any language); the transcript goes to DeepSeek for notes. No local model,
no meeting integration, no server-side audio storage, no server-side canvas.

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
`getDisplayMedia` + `getUserMedia`. Audio is captured as **16 kHz PCM in an AudioWorklet**,
cut into 6–20 second chunks **at pauses** (simple VAD, no fixed timer), encoded as WAV and sent
to `/v1/transcribe`. Each chunk carries a sequence number and start time; results are inserted
by index, not arrival order. A chunk that fails after retries becomes a visible
`[missing chunk N]` segment so the notes model knows about the gap.

Language is auto-detected by the provider (any language, including mixed speech); audio is not
stored, only the returned text. WAV removes the WebM-header class of failures entirely.

The provider is server-side configuration — `STT_PROVIDER` (`xai` or `openai`), `STT_BASE_URL`,
`STT_API_KEY`, `STT_MODEL` — so it can be swapped without rebuilding the app. The shipped
server uses xAI `/v1/stt`.

The first start shows a consent disclosure: participants must be told an AI assistant is
taking notes.

Paste remains as a fallback when audio sharing is unavailable.

## Notes

Notes are updated incrementally: every ~60 seconds (or after 6 new segments), the app sends the
**current notes JSON** plus only the **new numbered segments** to `/v1/analyze`. The model
returns the complete structured notes:

`title`, `summary`, `topics[].points[]`, `decisions[]`, `action_items[]`,
`open_questions[]`, `uncertain[]` — each carrying the segment numbers it came from.

On **Stop**, the app sends the full transcript once and rebuilds the notes from scratch, which
corrects drift from incremental updates. An invalid JSON answer is retried once; if it still
fails, the previous notes stay intact.

## Persistence

Every transcribed segment is appended immediately to
`%APPDATA%/TalkSketch/sessions/session-<timestamp>.jsonl`; final notes are written to
`session-<timestamp>.notes.json`. **Settings → Open sessions** opens the folder. A crash loses
nothing that was already transcribed.

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
2. Press **Start notes** and accept the consent disclosure, then allow screen/audio sharing
   and pick the window or screen that is playing the meeting.
3. Notes / Actions / Board update in the window every 20 seconds.

It works with any audio on the device — Meet, Zoom, Teams, WhatsApp, a YouTube video. There is
no meeting URL and no bot; the app only listens while you are capturing.

The app applies board labels from the notes model to the local Excalidraw scene. Nothing about
the meeting is stored on the server.

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

- **Cloud transcription only.** The provider detects the language automatically; mixed speech is supported.
- **Windows only for now.** The source builds on macOS and Linux, but only the Windows
  installer is produced.
- **System audio capture** depends on the OS share picker and on the meeting playing sound on
  this device.
- **Speaker labels are coarse:** remote participants appear as `Meeting`, you as `You`.
- **Chunks cut at pauses:** 6–20 seconds; a chunk with no speech is discarded.
- **Unsigned build.** SmartScreen warns on first run until a certificate is configured.
- **MCP is unauthenticated on loopback.** Any local process can call it while the app runs.
