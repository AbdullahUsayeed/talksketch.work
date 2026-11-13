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

function stopTimers() {
  capturing = false;
  if (drainTimer) clearInterval(drainTimer);
  if (analyzeTimer) clearInterval(analyzeTimer);
  drainTimer = null;
  analyzeTimer = null;
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
  try {
    const injected = await injectObserver();
    if (injected === "failed") throw new Error("The Meet page is not ready yet.");
    reset();
    capturing = true;
    captured = 0;
    $("captured").textContent = "0 lines captured";
    $("stop").hidden = false;
    setStatus("Live. Turn on captions (CC) in Meet.");
    drainTimer = setInterval(drain, 900);
    analyzeTimer = setInterval(() => analyze(false), 20000);
    setTimeout(() => analyze(false), 5000);
  } catch (error) {
    setStatus(`Could not start: ${error.message}`, true);
    $("start").disabled = false;
  }
});

$("stop").addEventListener("click", async () => {
  stopTimers();
  $("stop").hidden = true;
  $("start").disabled = false;
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
