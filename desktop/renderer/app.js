const $ = (id) => document.getElementById(id);

const DEFAULTS = {
  server: "https://54.255.181.218.sslip.io",
  code: "",
  topic: "Family meeting",
  participants: "",
};

const settings = { ...DEFAULTS, ...JSON.parse(localStorage.getItem("ts_settings") || "{}") };
let sessionToken = localStorage.getItem("ts_session") || "";
let planId = "";
let trialDays = 3;
let paypalClientId = "";
let sessionEmail = "";
for (const key of Object.keys(DEFAULTS)) $(key).value = settings[key] ?? "";

function persist() {
  for (const key of Object.keys(DEFAULTS)) settings[key] = $(key).value.trim() || DEFAULTS[key];
  localStorage.setItem("ts_settings", JSON.stringify(settings));
}

$("settings-toggle").addEventListener("click", () => {
  $("settings").hidden = !$("settings").hidden;
});

function setStatus(text, error = false) {
  const el = $("status");
  el.textContent = text;
  el.className = error ? "err" : "";
  if (error) lastError = text;
}

let lastError = "";

function ensureConsent() {
  return new Promise((resolve) => {
    if (localStorage.getItem("ts_consent") === "1") return resolve(true);
    $("consent-modal").hidden = false;
    $("consent-accept").onclick = () => {
      localStorage.setItem("ts_consent", "1");
      $("consent-modal").hidden = true;
      resolve(true);
    };
    $("consent-cancel").onclick = () => {
      $("consent-modal").hidden = true;
      resolve(false);
    };
  });
}

$("diagnostics").addEventListener("click", async () => {
  const lines = [
    `TalkSketch 0.1.0`,
    `server: ${settings.server}`,
    `signedIn: ${Boolean(sessionToken)}`,
    `email: ${sessionEmail || "n/a"}`,
    `transcription: cloud STT (auto: en/bn)`,
    `trialDays: ${trialDays}`,
    `planId: ${planId || "n/a"}`,
    `lastError: ${lastError || "none"}`,
  ];
  try {
    await navigator.clipboard.writeText(lines.join("\n"));
    setStatus("Diagnostics copied to clipboard.");
  } catch {
    setStatus("Could not copy diagnostics.", true);
  }
});

$("sessions").addEventListener("click", () => {
  void window.talksketch?.openSessions?.();
});

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
  post("state", { session: sessionNotes });
}

panel.addEventListener("load", () => {
  panelReady = true;
  pushState();
});

/* ---------- session state ---------- */
let capturing = false;
let analyzeTimer = null;
let captured = 0;
let transcript = [];
let sessionNotes = emptyNotes();
let analyzing = false;
let analyzedThrough = 0;
let lastAnalyzeAt = 0;
let pendingTranscriptions = 0;
let chunkSeq = 0;
let sessionId = "";
const postedBoard = new Set();

function emptyNotes() {
  return {
    title: "",
    summary: "",
    topics: [],
    decisions: [],
    action_items: [],
    open_questions: [],
    uncertain: [],
    coverage: null,
  };
}

/* ---------- stateless analysis ---------- */
async function analyze(final = false) {
  if (analyzing) return;
  const pending = transcript.filter((segment) => segment.seq > analyzedThrough);
  const source = final ? transcript : pending;
  if (source.length === 0) return;

  const snapshot = transcript.reduce((max, segment) => Math.max(max, segment.seq), 0);
  analyzing = true;

  const base = settings.server.replace(/\/$/, "");
  const headers = { "content-type": "application/json" };
  if (sessionToken) headers.authorization = `Bearer ${sessionToken}`;

  try {
    setStatus(final ? "Writing the final notes…" : "Updating notes…");
    const res = await fetch(`${base}/v1/analyze`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        code: settings.code,
        topic: settings.topic,
        participants: settings.participants.split(",").map((s) => s.trim()).filter(Boolean),
        mode: final ? "final" : "incremental",
        segments: source.map((segment) => ({
          seq: segment.seq,
          speaker: segment.speaker,
          text: segment.text,
        })),
        ...(final ? {} : { currentNotes: sessionNotes }),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Server ${res.status}`);

    sessionNotes = {
      title: String(data.title ?? ""),
      summary: String(data.summary ?? ""),
      topics: Array.isArray(data.topics) ? data.topics : [],
      decisions: Array.isArray(data.decisions) ? data.decisions : [],
      action_items: Array.isArray(data.action_items) ? data.action_items : [],
      open_questions: Array.isArray(data.open_questions) ? data.open_questions : [],
      uncertain: Array.isArray(data.uncertain) ? data.uncertain : [],
      coverage: data.coverage ?? null,
    };

    if (!final && Array.isArray(data.board) && data.board.length > 0) {
      const fresh = data.board.filter((op) => op?.text && !postedBoard.has(op.text));
      for (const op of fresh) postedBoard.add(op.text);
      if (fresh.length > 0) post("board", { ops: fresh.slice(0, 4) });
    }

    analyzedThrough = snapshot;
    lastAnalyzeAt = Date.now();
    pushState();
    if (final) window.talksketch?.sessionNotes?.(sessionId, sessionNotes);
    setStatus(final ? "Done. Final notes are in Notes." : "Up to date.");
  } catch (error) {
    setStatus(`Notes update failed: ${error.message}`, true);
    if (/trial/i.test(error.message)) void refreshEntitlement();
  } finally {
    analyzing = false;
  }
}

function reset() {
  transcript = [];
  sessionNotes = emptyNotes();
  postedBoard.clear();
  analyzedThrough = 0;
  lastAnalyzeAt = 0;
  chunkSeq = 0;
  sessionId = "";
  post("board", { clear: true });
  pushState();
}

let audioTracks = [];
let captures = [];
function stopTimers() {
  capturing = false;
  if (analyzeTimer) clearInterval(analyzeTimer);
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

function encodeWav(samples, rate = 16000) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const write = (offset, text) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  write(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, sample * 0x7fff, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

function resample(samples, from, to) {
  if (from === to) return samples;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(samples.length / ratio));
  for (let i = 0; i < out.length; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.min(samples.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j += 1) sum += samples[j] ?? 0;
    out[i] = end > start ? sum / (end - start) : 0;
  }
  return out;
}

const CHUNK_MIN_S = 6;
const CHUNK_MAX_S = 20;
const SILENCE_S = 0.7;
const PREROLL_S = 0.35;
const VAD_RMS = 0.006;

/** Raw PCM via AudioWorklet; chunks are cut at pauses, not on a timer. */
async function startPcmCapture(stream, speaker) {
  let ctx;
  try {
    ctx = new AudioContext({ sampleRate: 16000 });
  } catch {
    ctx = new AudioContext();
  }
  const source = ctx.createMediaStreamSource(stream);
  await ctx.audioWorklet.addModule("pcm-worklet.js");
  const node = new AudioWorkletNode(ctx, "pcm-capture");
  const sink = ctx.createGain();
  sink.gain.value = 0;
  source.connect(node);
  node.connect(sink);
  sink.connect(ctx.destination);

  const rate = ctx.sampleRate;
  let buffer = [];
  let buffered = 0;
  let pre = [];
  let preSamples = 0;
  let speech = false;
  let silence = 0;
  let cursor = 0;
  let chunkStart = 0;
  let stopped = false;

  const resetBuffer = () => {
    buffer = [];
    buffered = 0;
    pre = [];
    preSamples = 0;
    speech = false;
    silence = 0;
  };

  const flush = () => {
    if (!speech || buffered < rate * 0.5) {
      resetBuffer();
      return;
    }
    const merged = new Float32Array(buffered);
    let offset = 0;
    for (const frame of buffer) {
      merged.set(frame, offset);
      offset += frame.length;
    }
    const pcm = rate === 16000 ? merged : resample(merged, rate, 16000);
    const seq = (chunkSeq += 1);
    const start = chunkStart / rate;
    void transcribe(encodeWav(pcm), { speaker, seq, start });
    resetBuffer();
  };

  node.port.onmessage = (event) => {
    if (stopped) return;
    const frame = event.data;
    let sum = 0;
    for (let i = 0; i < frame.length; i += 1) sum += frame[i] * frame[i];
    const rms = Math.sqrt(sum / frame.length);

    if (!speech) {
      pre.push(frame);
      preSamples += frame.length;
      while (pre.length > 1 && preSamples > rate * PREROLL_S) {
        preSamples -= pre.shift().length;
      }
      if (rms >= VAD_RMS) {
        speech = true;
        buffer = pre.slice();
        buffered = preSamples;
        chunkStart = Math.max(0, cursor - preSamples);
        pre = [];
        preSamples = 0;
        silence = 0;
      }
    } else {
      buffer.push(frame);
      buffered += frame.length;
      silence = rms < VAD_RMS ? silence + frame.length : 0;
      const duration = buffered / rate;
      if (
        (duration >= CHUNK_MIN_S && silence >= rate * SILENCE_S) ||
        duration >= CHUNK_MAX_S
      ) {
        flush();
      }
    }
    cursor += frame.length;
  };

  const capture = {
    stop() {
      if (stopped) return;
      flush();
      stopped = true;
      node.port.onmessage = null;
      try {
        source.disconnect();
        node.disconnect();
        sink.disconnect();
      } catch {
        /* already gone */
      }
      ctx.close().catch(() => undefined);
    },
  };
  captures.push(capture);
  return capture;
}

function addSegment(meta, text, missing = false) {
  const segment = {
    seq: meta.seq,
    start: meta.start,
    speaker: meta.speaker,
    text,
    ...(missing ? { missing: true } : {}),
  };
  const existing = transcript.find((item) => item.seq === meta.seq);
  if (existing) {
    Object.assign(existing, segment);
  } else {
    transcript.push(segment);
    captured += 1;
    $("captured").textContent = `${captured} segments`;
    window.talksketch?.sessionAppend?.(sessionId, segment);
  }
  transcript.sort((a, b) => a.start - b.start || a.seq - b.seq);
  window.talksketch?.line({
    speaker: meta.speaker,
    text,
    start: meta.start,
    seq: meta.seq,
  });
}

async function transcribe(blob, meta, attempt = 1) {
  const { speaker, seq } = meta;
  pendingTranscriptions += 1;
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
        mime: "audio/wav",
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Server ${res.status}`);
    const text = String(data.text ?? "").trim();
    if (text.length < 2) return;
    addSegment(meta, text);
    setStatus(`Listening · ${speaker}: ${text.slice(0, 70)}`);
  } catch (error) {
    const message = error.message || "Network error";
    const retryable =
      attempt < 3 && !/trial|sign in|401|402|not configured/i.test(message);
    if (retryable) {
      setStatus(`Transcription hiccup — retrying chunk ${seq} (${attempt}/3)…`);
      await new Promise((resolve) => setTimeout(resolve, 800 * attempt));
      return transcribe(blob, meta, attempt + 1);
    }
    addSegment(meta, `[missing chunk ${seq}]`, true);
    setStatus(`Chunk ${seq} failed after retries — marked as missing.`, true);
    if (/trial/i.test(message)) void refreshEntitlement();
  } finally {
    pendingTranscriptions -= 1;
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
  captures = [];
  await Promise.all([
    startPcmCapture(new MediaStream([system]), "Meeting"),
    startPcmCapture(mic, "You"),
  ]);
}

async function startCapture() {
  try {
    await startAudio();
    return "cloud";
  } catch {
    return null;
  }
}

function stopCapture() {
  stopAudio();
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
  for (const capture of captures) {
    try {
      capture.stop();
    } catch {
      /* already stopped */
    }
  }
  captures = [];
  for (const track of audioTracks) {
    try {
      track.stop();
    } catch {
      /* already stopped */
    }
  }
  audioTracks = [];
}

function maybeAnalyze() {
  if (!capturing || analyzing) return;
  const pending = transcript.filter((segment) => segment.seq > analyzedThrough);
  if (pending.length === 0) return;
  if (lastAnalyzeAt && Date.now() - lastAnalyzeAt < 60000 && pending.length < 6) return;
  void analyze(false);
}

$("start").addEventListener("click", async () => {
  persist();
  if (!settings.code && !sessionToken) {
    $("settings").hidden = false;
    setStatus("Enter your pilot access key in Settings first.", true);
    return;
  }
  const consented = await ensureConsent();
  if (!consented) {
    $("start").disabled = false;
    return;
  }
  $("start").disabled = true;
  setStatus("Starting…");
  reset();
  sessionId = (await window.talksketch?.sessionStart?.()) || "";
  capturing = true;
  captured = 0;
  $("captured").textContent = "0 segments";
  $("stop").hidden = false;

  try {
    const mode = await startCapture();
    if (mode) {
      setStatus("Listening. Chunks are cut at pauses and transcribed in the cloud.");
    } else {
      setStatus("Audio unavailable. Allow screen/audio sharing, or use Paste.", true);
    }
  } catch (error) {
    setStatus(`Could not start: ${error.message}`, true);
    $("start").disabled = false;
    return;
  }

  analyzeTimer = setInterval(maybeAnalyze, 10000);
  setTimeout(() => {
    if (capturing && captured === 0) {
      setStatus("No audio detected — check the output device, or use Paste.", true);
    }
  }, 30000);
});

$("stop").addEventListener("click", async () => {
  stopTimers();
  stopCapture();
  $("stop").hidden = true;
  $("start").disabled = false;
  setStatus("Finishing transcription…");
  const deadline = Date.now() + 15000;
  while (pendingTranscriptions > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
  for (let i = 0; i < 40 && analyzing; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  await analyze(true);
});

persist();
pushState();

/* ---------- Google sign-in (system browser) ---------- */
async function setupGoogle() {
  try {
    const config = await fetch(`${settings.server.replace(/\/$/, "")}/v1/config`).then((res) => res.json());
    if (config.planId) planId = config.planId;
    if (typeof config.trialDays === "number") trialDays = config.trialDays;
    if (config.paypalClientId) paypalClientId = config.paypalClientId;
    if (!config.googleEnabled) return;
    const host = $("google-signin");
    const button = document.createElement("button");
    button.className = "ghost";
    button.textContent = "Sign in with Google";
    button.addEventListener("click", () => void startGoogleSignIn());
    host.appendChild(button);
  } catch {
    /* access keys still work */
  }
}

$("upgrade").addEventListener("click", () => void openUpgrade());

$("upgrade-cancel").addEventListener("click", () => {
  $("upgrade-modal").hidden = true;
});

function loadPaypal() {
  if (window.paypal) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(
      paypalClientId,
    )}&vault=true&intent=subscription`;
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });
}

async function openUpgrade() {
  $("upgrade-error").textContent = "";
  $("upgrade-modal").hidden = false;
  const base = settings.server.replace(/\/$/, "");

  if (!paypalClientId) {
    try {
      const config = await fetch(`${base}/v1/config`).then((res) => res.json());
      if (config.paypalClientId) paypalClientId = config.paypalClientId;
      if (config.planId) planId = config.planId;
    } catch {
      /* report below */
    }
  }

  if (!sessionEmail) {
    $("upgrade-error").textContent = "Sign in with Google to upgrade.";
    return;
  }
  if (!paypalClientId) {
    $("upgrade-error").textContent = "Billing is not configured on this server.";
    return;
  }

  try {
    await loadPaypal();
  } catch {
    $("upgrade-error").textContent = "Could not load PayPal. Check your connection.";
    return;
  }

  $("paypal-upgrade").innerHTML = "";
  window.paypal
    .Buttons({
      style: { shape: "pill", color: "gold", label: "subscribe_now", height: 45 },
      createSubscription: (_data, actions) =>
        actions.subscription.create({ plan_id: planId, custom_id: sessionEmail }),
      onApprove: async (data) => {
        try {
          const res = await fetch(`${base}/v1/billing/activate`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${sessionToken}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ subscriptionId: data.subscriptionID }),
          });
          const json = await res.json();
          if (!res.ok) throw new Error(json.error || "Activation failed.");
          $("upgrade-modal").hidden = true;
          await refreshEntitlement();
        } catch (error) {
          $("upgrade-error").textContent = error.message;
        }
      },
      onError: () => {
        $("upgrade-error").textContent = "PayPal could not start checkout.";
      },
    })
    .render("#paypal-upgrade");
}

async function refreshEntitlement() {
  if (!sessionToken) return;
  try {
    const base = settings.server.replace(/\/$/, "");
    const res = await fetch(`${base}/v1/entitlement`, {
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    if (!res.ok) return;
    const data = await res.json();
    if (data.email) sessionEmail = data.email;
    if (data.planId) planId = data.planId;
    if (typeof data.trialDays === "number") trialDays = data.trialDays;

    const badge = $("trial-badge");
    if (data.status === "trial") {
      $("upgrade").hidden = false;
      badge.hidden = false;
      badge.classList.remove("expired");
      badge.textContent = `Trial · ${data.daysLeft}d`;
      setStatus(`Trial: ${data.daysLeft} day${data.daysLeft === 1 ? "" : "s"} left.`);
      if (!localStorage.getItem(trialNoticeKey()) && $("trial-modal").hidden) {
        showTrialNotice(data.daysLeft);
      }
    } else if (data.status === "expired") {
      $("upgrade").hidden = false;
      badge.hidden = false;
      badge.classList.add("expired");
      badge.textContent = "Trial ended";
      setStatus("Trial ended. Subscribe to continue.", true);
      if (!localStorage.getItem(trialNoticeKey()) && $("trial-modal").hidden) {
        showTrialNotice(0);
      }
    } else if (data.status === "active") {
      $("upgrade").hidden = true;
      badge.hidden = true;
      $("trial-modal").hidden = true;
      setStatus("Pro is active.");
    } else {
      $("upgrade").hidden = true;
      badge.hidden = true;
    }
  } catch {
    /* keep the current status */
  }
}

function trialNoticeKey() {
  return `ts_trial_notice_${sessionEmail || "anon"}`;
}

function showTrialNotice(daysLeft) {
  const expired = daysLeft <= 0;
  $("trial-title").textContent = expired
    ? "Your trial has ended"
    : `Your ${trialDays}-day trial is active`;
  $("trial-copy").textContent = expired
    ? "Subscribe to keep transcription, notes and the board running. $12/month, cancel anytime."
    : `You have ${daysLeft} day${daysLeft === 1 ? "" : "s"} left with full access. No card required. Upgrade anytime for $12/month.`;
  $("trial-later").textContent = expired ? "Not now" : "Keep using the trial";
  $("trial-modal").hidden = false;
}

$("trial-later").addEventListener("click", () => {
  localStorage.setItem(trialNoticeKey(), "1");
  $("trial-modal").hidden = true;
});

$("trial-upgrade").addEventListener("click", () => {
  localStorage.setItem(trialNoticeKey(), "1");
  $("trial-modal").hidden = true;
  void openUpgrade();
});

async function startGoogleSignIn() {
  const state = crypto.randomUUID();
  const base = settings.server.replace(/\/$/, "");
  const opened = await window.talksketch?.openExternal(
    `${base}/v1/auth/google/start?state=${encodeURIComponent(state)}`,
  );
  if (!opened) {
    setStatus("Could not open the browser for sign-in.", true);
    return;
  }
  setStatus("Finish signing in with Google in your browser…");
  const started = Date.now();
  const timer = setInterval(async () => {
    if (Date.now() - started > 5 * 60 * 1000) {
      clearInterval(timer);
      setStatus("Sign-in timed out. Try again.", true);
      return;
    }
    try {
      const res = await fetch(`${base}/v1/auth/google/poll?state=${encodeURIComponent(state)}`);
      if (res.status === 202) return;
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Sign-in failed.");
      sessionToken = data.token;
      localStorage.setItem("ts_session", sessionToken);
      if (data.email) sessionEmail = data.email;
      $("google-signin").innerHTML = "";
      setStatus(`Signed in as ${data.email}.`);
      clearInterval(timer);
      void refreshEntitlement();
    } catch (error) {
      clearInterval(timer);
      setStatus(error.message, true);
    }
  }, 2000);
}

setupGoogle();
if (sessionToken) void refreshEntitlement();

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
    const start = transcript.reduce((max, segment) => Math.max(max, segment.start), 0) + 1;
    const seq = (chunkSeq += 1);
    addSegment({ speaker, seq, start }, text);
  }
  $("paste-text").value = "";
  $("paste-modal").hidden = true;
  await analyze(false);
});
