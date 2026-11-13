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
    if (/trial/i.test(error.message)) void refreshEntitlement();
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
  post("board", { clear: true });
  pushState();
}

let audioTracks = [];
let recorders = [];
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

/**
 * MediaRecorder timeslices are not standalone files: only the first chunk has a
 * WebM header, so providers reject later chunks with 400. Record one complete
 * file per cycle instead: start -> stop after 12s -> transcribe -> start again.
 */
function startRecorder(stream, speaker) {
  if (!capturing) return;
  if (!stream.getAudioTracks().some((track) => track.readyState === "live")) return;

  const recorder = new MediaRecorder(stream, {
    mimeType: "audio/webm;codecs=opus",
    audioBitsPerSecond: 32000,
  });
  const chunks = [];

  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };

  let timer = null;
  recorder.onstop = () => {
    if (timer) clearTimeout(timer);
    recorders = recorders.filter((item) => item !== recorder);
    const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
    if (blob.size > 1200) void transcribe(blob, speaker);
    if (capturing) startRecorder(stream, speaker);
  };

  recorders.push(recorder);
  recorder.start();
  timer = setTimeout(() => {
    if (recorder.state === "recording") recorder.stop();
  }, 12000);
}

async function transcribe(blob, speaker, attempt = 1) {
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
    const line = `${speaker}: ${text}`;
    if (transcript[transcript.length - 1] === line) return;
    transcript.push(line);
    window.talksketch?.line({ speaker, text });
    captured += 1;
    $("captured").textContent = `${captured} audio chunks`;
    setStatus(`Listening · ${speaker}: ${text.slice(0, 70)}`);
  } catch (error) {
    const message = error.message || "Network error";
    const retryable =
      attempt < 3 && !/trial|sign in|401|402|not configured/i.test(message);
    if (retryable) {
      setStatus(`Transcription hiccup — retrying (${attempt}/3)…`);
      await new Promise((resolve) => setTimeout(resolve, 800 * attempt));
      return transcribe(blob, speaker, attempt + 1);
    }
    setStatus(`Transcription failed: ${message}`, true);
    if (/trial/i.test(message)) void refreshEntitlement();
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
  recorders = [];
  startRecorder(new MediaStream([system]), "Meeting");
  startRecorder(mic, "You");
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
  const consented = await ensureConsent();
  if (!consented) {
    $("start").disabled = false;
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
      setStatus("Listening to meeting audio with cloud transcription (English / বাংলা).");
    } else {
      setStatus("Audio unavailable. Allow screen/audio sharing, or use Paste.", true);
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
      setStatus("No audio detected — check the meeting output device, or use Paste.", true);
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

  if (!paypalClientId || !sessionEmail) {
    if (planId) {
      window.talksketch?.openExternal(
        `https://www.paypal.com/webapps/billing/plans/subscribe?plan_id=${encodeURIComponent(planId)}`,
      );
    } else {
      $("upgrade-error").textContent = "Billing is not configured on this server.";
    }
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
    if (data.status === "trial") {
      $("upgrade").hidden = false;
      setStatus(`Trial: ${data.daysLeft} day${data.daysLeft === 1 ? "" : "s"} left.`);
    } else if (data.status === "expired") {
      $("upgrade").hidden = false;
      setStatus("Trial ended. Subscribe to continue.", true);
    } else if (data.status === "active") {
      $("upgrade").hidden = true;
      setStatus("Pro is active.");
    } else {
      $("upgrade").hidden = true;
    }
  } catch {
    /* keep the current status */
  }
}

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
    transcript.push(`${speaker}: ${text}`);
    window.talksketch?.line({ speaker, text });
    captured += 1;
  }
  $("captured").textContent = `${captured} lines captured`;
  $("paste-text").value = "";
  $("paste-modal").hidden = true;
  await analyze(false);
});
