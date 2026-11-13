const $ = (id) => document.getElementById(id);

const DEFAULTS = {
  server: "http://54.255.181.218",
  code: "TALKSKETCH",
  topic: "Family meeting",
  participants: "",
};

const settings = { ...DEFAULTS, ...JSON.parse(localStorage.getItem("ts_settings") || "{}") };
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

/* ---------- tabs ---------- */
let activeTab = "notes";
let boardTimer = null;

function activate(name) {
  activeTab = name;
  document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.tab === name));
  document.querySelectorAll(".tab-pane").forEach((pane) => pane.classList.toggle("active", pane.id === `pane-${name}`));
  if (boardTimer) {
    clearInterval(boardTimer);
    boardTimer = null;
  }
  if (name === "board") {
    refreshBoard();
    boardTimer = setInterval(refreshBoard, 15000);
  }
}

document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => activate(tab.dataset.tab)));

function refreshBoard() {
  $("board").src = `${settings.server.replace(/\/$/, "")}/api/live/board.png?t=${Date.now()}`;
}

/* ---------- panel state ---------- */
const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function poll() {
  try {
    const res = await fetch(`${settings.server.replace(/\/$/, "")}/api/live/state`, { cache: "no-store" });
    const state = await res.json();
    render(state);
  } catch {
    /* server down: keep the last state */
  }
}

function render(state) {
  $("summary").textContent = state.summary ?? "";
  $("summary").hidden = !state.summary;

  const notes = state.notes ?? [];
  $("notes").innerHTML = notes.length
    ? notes.map((note) => `<div class="item"><p>${esc(note.content)}</p></div>`).join("")
    : `<p class="muted">No notes yet.</p>`;

  const actions = state.actions ?? [];
  $("actions-count").textContent = actions.length;
  $("actions").innerHTML = actions.length
    ? actions
        .map((action) => {
          const owner = [action.assignee, action.deadline].filter(Boolean).join(" · ");
          return `<div class="item action"><p>${esc(action.content)}</p>${owner ? `<span class="meta">${esc(owner)}</span>` : ""}</div>`;
        })
        .join("")
    : `<p class="muted">No action items yet.</p>`;

  const suggestions = state.suggestions ?? [];
  $("suggestions-count").textContent = suggestions.length;
  $("suggestions").innerHTML = suggestions.length
    ? suggestions
        .map(
          (suggestion) =>
            `<div class="item suggestion"><span class="meta">${esc(suggestion.topic)}</span><p><b>${esc(suggestion.rationale)}</b></p><p>${esc(suggestion.content)}</p></div>`,
        )
        .join("")
    : `<p class="muted">No suggestions yet.</p>`;
}

setInterval(poll, 3000);
poll();

/* ---------- Claude panel ---------- */
if (window.talksketch?.onPanel) {
  window.talksketch.onPanel((markdown) => {
    $("claude").textContent = markdown;
    activate("claude");
  });
}

/* ---------- captions ---------- */
let capturing = false;
let timer = null;
let captured = 0;

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

async function api(path, body) {
  const res = await fetch(`${settings.server.replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: settings.code, ...body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Server ${res.status}`);
  return data;
}

async function drain() {
  if (!capturing) return;
  try {
    const lines = await $("meet").executeJavaScript("window.__tsQueue ? window.__tsQueue.splice(0) : []", true);
    if (!Array.isArray(lines) || lines.length === 0) return;
    for (const line of lines) {
      window.talksketch?.line(line);
      await api("/api/live/ingest", { lines: [line] });
      captured += 1;
    }
    $("captured").textContent = `${captured} lines captured`;
    setStatus("Capturing captions · notes update in the right panel.");
  } catch (error) {
    setStatus(`Capture error: ${error.message}`, true);
  }
}

$("start").addEventListener("click", async () => {
  persist();
  $("start").disabled = true;
  setStatus("Starting session…");
  try {
    await api("/api/live/start", { topic: settings.topic, participants: settings.participants });
    const injected = await injectObserver();
    if (injected === "failed") throw new Error("The Meet page is not ready yet.");
    capturing = true;
    captured = 0;
    $("captured").textContent = "0 lines captured";
    $("stop").hidden = false;
    setStatus("Live. Turn on captions (CC) in Meet.");
    timer = setInterval(drain, 900);
    drain();
    poll();
  } catch (error) {
    setStatus(`Could not start: ${error.message}`, true);
    $("start").disabled = false;
  }
});

$("stop").addEventListener("click", async () => {
  capturing = false;
  if (timer) clearInterval(timer);
  timer = null;
  $("stop").hidden = true;
  $("start").disabled = false;
  setStatus("Stopping and writing the summary…");
  try {
    await api("/api/live/end", {});
    setStatus("Meeting ended. Summary is in the Notes tab.");
    poll();
  } catch (error) {
    setStatus(`Stop failed: ${error.message}`, true);
  }
});

$("meet").addEventListener("dom-ready", () => {
  setStatus("Meeting view ready. Join the call, then start notes.");
  if (capturing) injectObserver();
});

$("meet").addEventListener("did-fail-load", () => setStatus("Meeting view failed to load. Check the URL.", true));

persist();
