# TalkSketch Desktop (preview)

Electron shell that hosts Google Meet in a webview and shows the live notes panel next to
it. Captions are read from the Meet page and sent to the TalkSketch live API — no audio
leaves the browser.

## Run

```bash
npm install
npm start
```

The notes panel defaults to the hosted demo (`http://54.255.181.218`, code `TALKSKETCH`).
Change it under **Settings** to point at your own server (`npm run demo` in the platform
repo).

## Use

1. Paste the Meet link in the address bar and open it.
2. Join the call (guest join works if Google sign-in is blocked in Electron).
3. Turn on captions (CC).
4. Press **Start notes**.

## Build (portable Windows)

```bash
npm run dist
```

A signed NSIS installer needs Windows Developer Mode or an elevated shell (electron-builder
creates symlinks while unpacking its signing tools). The portable folder is built by copying
Electron's local `dist` and adding `resources/app`; the zip is what the download link serves.

## Limitations

- Windows x64, unsigned — SmartScreen will warn on first run.
- Captions come from Meet's DOM; Google can change it.
- One live session at a time on the demo server.
- No system-audio capture yet; the native recorder fork is the next step.
