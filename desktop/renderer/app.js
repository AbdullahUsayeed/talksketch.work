const $ = (id) => document.getElementById(id);

const DEFAULTS = {
  server: "https://54.255.181.218.sslip.io",
  code: "",
  topic: "Family meeting",
  participants: "",
};

const settings = { ...DEFAULTS, ...JSON.parse(localStorage.getItem("ts_settings") || "{}") };
let sessionToken = localStorage.getItem("ts_session") || "";
for (const key of Object.keys(DEFAULTS)) $(key).value = settings[key] ?? "";

function persist() {
  for (const key of Object.keys(DEFAULTS)) settings[key] = $(key).value.trim() || DEFAULTS[key];
  localStorage.setItem("ts_settings", JSON.stringify(settings));
}

$("settings-toggle").addEventListener("click", () => {
  $("settings").hidden = !$("settings").hidden;
});

$("open").addEventListener("click", () => {
  const url = $("url").value.trim();
  if (!/^https:\/\//.test(url)) {
    setStatus("Enter an https meeting URL.", true);
    return;
  }
  $("meet").loadURL(url);
  setStatus("Opening meeting…");
});

function setStatus(text, error = false) {
  const el = $("status");
  el.textContent = text;
  el.className = error ? "err" : "";
}

/* ---------- panel bridge ---------- */
const panel = $("panel");
let panelReady = false;

function post(type, payload = {}) {
  if (!panel.contentWindow) return;
  panel.contentWindow.postMessage({ source: "talksketch", type, ...payload }, "*");
}

window.addEventListener("message", (event) => {
  if (event.data?.source === "talksketch-panel" && event.data.type === "ready") {
    panelReady = true;
    pushState();
  }
});

function pushState() {
  post("state", { notes, actions, suggestions, summary });
}

panel.addEventListener("load", () => {
  panelReady = true;
  pushState();
});

if (window.talksketch?.onPanel) {
  window.talksketch.onPanel((markdown) => post("claude", { markdown }));
}

/* ---------- captions ---------- */
let capturing = false;
let drainTimer = null;
let analyzeTimer = null;
let captured = 0;
let transcript = [];
let notes = [];
let actions = [];
let suggestions = [];
let summary = "";
const seenNotes = new Set();
const seenActions = new Set();
const seenSuggestions = new Set();

const INSTALL_OBSERVER = String.raw`(() => {
  if (window.__tsObserver) return 'already';
  window.__tsQueue = [];
  const seen = new Set();
  let scheduled = false;

  const parse = () => {
    const regions = [
      ...document.querySelectorAll('[aria-live="polite"]'),
      ...document.querySelectorAll('[role="region"][aria-label*="Captions" i]'),
    ];
    const fallback = document.querySelector('div[jsname="YSxPC"]');
    if (fallback && !regions.includes(fallback)) regions.push(fallback);
    if (!regions.length) regions.push(document.body);

    for (const region of regions) {
      const blocks = [...region.querySelectorAll('.iOzk7, .TBMuR, .a4cQT')];
      const rows = blocks.length ? blocks : [...region.querySelectorAll(':scope > div')];
      const list = rows.length ? rows : [region];
      for (const row of list) {
        const text = (row.innerText || '').trim();
        if (!text || text.length > 2000) continue;
        const lines = text.split('\n').map((s) => s.trim()).filter(Boolean);
        let speaker = 'Participant';
        let body = text;
        if (lines.length > 1) {
          speaker = lines[0].replace(/:$/, '');
          body = lines.slice(1).join(' ');
        } else {
          const match = text.match(/^([^:]{1,40}):\s*(.+)$/);
          if (match) { speaker = match[1].trim(); body = match[2].trim(); }
        }
        body = body.replace(/\s+/g, ' ').trim();
        if (body.length < 3 || body.length > 600) continue;
        const key = speaker + '|' + body;
        if (seen.has(key)) continue;
        seen.add(key);
        window.__tsQueue.push({ speaker, text: body });
      }
    }
    if (window.__tsQueue.length > 120) window.__tsQueue.splice(0, window.__tsQueue.length - 120);
  };

  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => { scheduled = false; parse(); }, 350);
  };

  const observer = new MutationObserver(schedule);
  observer.observe(document.body, { subtree: true, childList: true, characterData: true });
  window.__tsObserver = observer;
  parse();
  return 'installed';
})()`;

async function injectObserver() {
  try {
    return await $("meet").executeJavaScript(INSTALL_OBSERVER, true);
  } catch (error) {
    setStatus(`Could not attach to the meeting: ${error.message}`, true);
    return "failed";
  }
}

async function drain() {
  if (!capturing) return;
  try {
    const lines = await $("meet").executeJavaScript("window.__tsQueue ? window.__tsQueue.splice(0) : []", true);
    if (!Array.isArray(lines) || lines.length === 0) return;
    for (const line of lines) {
      window.talksketch?.line(line);
      transcript.push(`${line.speaker}: ${line.text}`);
      if (transcript.length > 2000) transcript.splice(0, transcript.length - 2000);
      captured += 1;
    }
    $("captured").textContent = `${captured} lines captured`;
    setStatus("Capturing captions · notes appear in the panel.");
  } catch (error) {
    setStatus(`Capture error: ${error.message}`, true);
  }
}

/* ---------- stateless analysis ---------- */
async function analyze(final = false) {
  const text = transcript.join("\n").slice(-14000);
  if (text.length < 60) return;

  const base = settings.server.replace(/\/$/, "");
  const headers = { "content-type": "application/json" };
  if (sessionToken) headers.authorization = `Bearer ${sessionToken}`;

  try {
    setStatus(final ? "Writing the final summary…" : "Analyzing the last few minutes…");
    const res = await fetch(`${base}/v1/analyze`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        code: settings.code,
        topic: settings.topic,
        participants: settings.participants.split(",").map((s) => s.trim()).filter(Boolean),
        transcript: text,
        existingNotes: notes.map((note) => note.content),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Server ${res.status}`);

    for (const note of data.notes ?? []) {
      const key = note.content.toLowerCase().replace(/\s+/g, " ").slice(0, 120);
      if (seenNotes.has(key)) continue;
      seenNotes.add(key);
      notes.push(note);
    }
    for (const action of data.actions ?? []) {
      const key = String(action.task).toLowerCase().replace(/\s+/g, " ").slice(0, 120);
      if (seenActions.has(key)) continue;
      seenActions.add(key);
      actions.push(action);
    }
    for (const suggestion of data.suggestions ?? []) {
      const key = String(suggestion.topic).toLowerCase().slice(0, 80);
      if (seenSuggestions.has(key) || suggestions.length >= 3) continue;
      seenSuggestions.add(key);
      suggestions.push(suggestion);
    }

    if (data.summary) summary = data.summary;
    pushState();
    if (Array.isArray(data.board) && data.board.length > 0) post("board", { ops: data.board });
    setStatus(final ? "Done. Summary is in Notes." : "Up to date.");
  } catch (error) {
    setStatus(`Analysis failed: ${error.message}`, true);
  }
}

function reset() {
  transcript = [];
  notes = [];
  actions = [];
  suggestions = [];
  summary = "";
  seenNotes.clear();
  seenActions.clear();
  seenSuggestions.clear();
  pushState();
}

let audioMode = false;
let audioTracks = [];
let recorders = [];
let localStt = false;
let localCaptures = [];

function stopTimers() {
  capturing = false;
  if (drainTimer) clearInterval(drainTimer);
  if (analyzeTimer) clearInterval(analyzeTimer);
  drainTimer = null;
  analyzeTimer = null;
}

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function makeRecorder(stream, speaker) {
  const recorder = new MediaRecorder(stream, {
    mimeType: "audio/webm;codecs=opus",
    audioBitsPerSecond: 32000,
  });
  recorder.ondataavailable = (event) => {
    if (event.data.size > 1200) void transcribe(event.data, speaker);
  };
  return recorder;
}

async function transcribe(blob, speaker) {
  try {
    const base64 = toBase64(await blob.arrayBuffer());
    const headers = { "content-type": "application/json" };
    if (sessionToken) headers.authorization = `Bearer ${sessionToken}`;
    const res = await fetch(`${settings.server.replace(/\/$/, "")}/v1/transcribe`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        code: settings.code,
        audio: base64,
        mime: blob.type || "audio/webm",
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Server ${res.status}`);
    const text = String(data.text ?? "").trim();
    if (text.length < 2) return;
    transcript.push(`${speaker}: ${text}`);
    window.talksketch?.line({ speaker, text });
    captured += 1;
    $("captured").textContent = `${captured} audio chunks`;
    setStatus(`Listening · ${speaker}: ${text.slice(0, 70)}`);
  } catch (error) {
    setStatus(`Transcription failed: ${error.message}`, true);
  }
}

async function startAudio() {
  const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  const system = display.getAudioTracks()[0];
  if (!system) {
    display.getTracks().forEach((track) => track.stop());
    throw new Error("No system audio track was shared.");
  }
  display.getVideoTracks().forEach((track) => {
    track.enabled = false;
  });
  const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
  audioTracks = [...display.getTracks(), ...mic.getTracks()];
  recorders = [
    makeRecorder(new MediaStream([system]), "Meeting"),
    makeRecorder(mic, "You"),
  ];
  recorders.forEach((recorder) => recorder.start(12000));
}

function createPcmCapture(stream, speaker) {
  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(stream);
  const processor = ctx.createScriptProcessor(4096, 1, 1);
  const gain = ctx.createGain();
  gain.gain.value = 0;

  let chunks = [];
  let total = 0;
  const target = 16000;

  const flush = (force = false) => {
    if (total === 0) return;
    if (!force && total < target * 8) return;
    const merged = new Int16Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    chunks = [];
    total = 0;
    window.talksketch?.audioChunk({ speaker, pcm: merged.buffer });
  };

  processor.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0);
    const ratio = ctx.sampleRate / target;
    const length = Math.floor(input.length / ratio);
    const out = new Int16Array(length);
    for (let i = 0; i < length; i += 1) {
      const start = Math.floor(i * ratio);
      const end = Math.min(input.length, Math.floor((i + 1) * ratio));
      let sum = 0;
      for (let j = start; j < end; j += 1) sum += input[j] ?? 0;
      const sample = end > start ? sum / (end - start) : 0;
      out[i] = Math.max(-1, Math.min(1, sample)) * 0x7fff;
    }
    chunks.push(out);
    total += length;
    if (total >= target * 8) flush();
  };

  source.connect(processor);
  processor.connect(gain);
  gain.connect(ctx.destination);
  return { ctx, source, processor, gain, flush };
}

async function startLocalAudio() {
  const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  const system = display.getAudioTracks()[0];
  if (!system) {
    display.getTracks().forEach((track) => track.stop());
    throw new Error("No system audio track was shared.");
  }
  display.getVideoTracks().forEach((track) => {
    track.enabled = false;
  });
  const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
  audioTracks = [...display.getTracks(), ...mic.getTracks()];
  localCaptures = [
    createPcmCapture(new MediaStream([system]), "Meeting"),
    createPcmCapture(mic, "You"),
  ];
}

function stopLocalAudio() {
  for (const capture of localCaptures) {
    try {
      capture.flush(true);
    } catch {
      /* ignore */
    }
    try {
      capture.processor.disconnect();
      capture.source.disconnect();
      capture.gain.disconnect();
    } catch {
      /* ignore */
    }
    capture.ctx.close().catch(() => undefined);
  }
  localCaptures = [];
}

async function startCapture() {
  const localAvailable = await (window.talksketch?.hasLocalStt?.() ?? Promise.resolve(false));
  if (localAvailable) {
    try {
      await startLocalAudio();
      return "local";
    } catch {
      /* fall through to cloud, then captions */
    }
  }
  try {
    await startAudio();
    return "cloud";
  } catch {
    return null;
  }
}

function stopCapture() {
  if (audioMode === "local") stopLocalAudio();
  else stopAudio();
  for (const track of audioTracks) {
    try {
      track.stop();
    } catch {
      /* ignore */
    }
  }
  audioTracks = [];
}

function stopAudio() {
  for (const recorder of recorders) {
    try {
      recorder.stop();
    } catch {
      /* already stopped */
    }
  }
  recorders = [];
  for (const track of audioTracks) {
    try {
      track.stop();
    } catch {
      /* already stopped */
    }
  }
  audioTracks = [];
}

$("start").addEventListener("click", async () => {
  persist();
  if (!settings.code && !sessionToken) {
    $("settings").hidden = false;
    setStatus("Enter your pilot access key in Settings first.", true);
    return;
  }
  $("start").disabled = true;
  setStatus("Starting…");
  reset();
  capturing = true;
  captured = 0;
  $("captured").textContent = "0 lines captured";
  $("stop").hidden = false;

  try {
    const mode = await startCapture();
    if (mode) {
      audioMode = mode;
      setStatus(
        mode === "local"
          ? "Listening locally with Whisper — audio stays on this device."
          : "Listening to meeting audio (cloud transcription).",
      );
    } else {
      audioMode = false;
      const injected = await injectObserver();
      if (injected === "failed") {
        setStatus("Audio and captions are both unavailable. Use Paste.", true);
        stopTimers();
        $("stop").hidden = true;
        $("start").disabled = false;
        return;
      }
      drainTimer = setInterval(drain, 900);
      setStatus("Audio unavailable; using Meet captions.");
    }
  } catch (error) {
    setStatus(`Could not start: ${error.message}`, true);
    $("start").disabled = false;
    return;
  }

  analyzeTimer = setInterval(() => analyze(false), 20000);
  setTimeout(() => analyze(false), 5000);
  setTimeout(() => {
    if (capturing && captured === 0) {
      setStatus(
        audioMode === "local"
          ? "No audio detected — check the meeting output device."
          : audioMode === "cloud"
            ? "No audio detected — check the meeting output device."
            : "No captions detected — use Paste or audio.",
        true,
      );
    }
  }, 25000);
});

$("stop").addEventListener("click", async () => {
  stopTimers();
  stopCapture();
  $("stop").hidden = true;
  $("start").disabled = false;
  await new Promise((resolve) => setTimeout(resolve, 2500));
  await analyze(true);
});

$("meet").addEventListener("dom-ready", () => {
  setStatus("Meeting view ready. Join the call, then start notes.");
  if (capturing) injectObserver();
});

$("meet").addEventListener("did-fail-load", () => setStatus("Meeting view failed to load. Check the URL.", true));

persist();
pushState();

/* ---------- Google sign-in ---------- */
async function setupGoogle() {
  try {
    const config = await fetch(`${settings.server.replace(/\/$/, "")}/v1/config`).then((res) => res.json());
    if (!config.googleEnabled || !config.googleClientId) return;
    await new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://accounts.google.com/gsi/client";
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    });
    window.google.accounts.id.initialize({
      client_id: config.googleClientId,
      callback: async (response) => {
        try {
          const res = await fetch(`${settings.server.replace(/\/$/, "")}/v1/auth/google`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ credential: response.credential }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || "Sign-in failed.");
          sessionToken = data.token;
          localStorage.setItem("ts_session", sessionToken);
          setStatus(`Signed in as ${data.email}.`);
          $("google-signin").style.display = "none";
        } catch (error) {
          setStatus(error.message, true);
        }
      },
    });
    window.google.accounts.id.renderButton($("google-signin"), {
      theme: "filled_black",
      size: "medium",
      text: "signin_with",
      shape: "pill",
    });
  } catch {
    /* Google sign-in is optional for pilot keys */
  }
}

setupGoogle();

/* ---------- local whisper transcripts ---------- */
if (window.talksketch?.onTranscript) {
  window.talksketch.onTranscript(({ speaker, text, error }) => {
    if (!text) {
      if (error) setStatus(`Local transcription: ${error}`, true);
      return;
    }
    transcript.push(`${speaker}: ${text}`);
    captured += 1;
    $("captured").textContent = `${captured} audio chunks`;
    setStatus(`Listening · ${speaker}: ${text.slice(0, 70)}`);
  });
}

/* ---------- caption fallback ---------- */
$("paste-toggle").addEventListener("click", () => {
  $("paste-modal").hidden = false;
  $("paste-text").focus();
});

$("paste-cancel").addEventListener("click", () => {
  $("paste-modal").hidden = true;
});

$("paste-add").addEventListener("click", async () => {
  const lines = $("paste-text")
    .value.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    const match = line.match(/^([^:]{1,40}):\s*(.+)$/);
    const speaker = match ? match[1].trim() : "Participant";
    const text = match ? match[2].trim() : line;
    transcript.push(`${speaker}: ${text}`);
    window.talksketch?.line({ speaker, text });
    captured += 1;
  }
  $("captured").textContent = `${captured} lines captured`;
  $("paste-text").value = "";
  $("paste-modal").hidden = true;
  await analyze(false);
});
