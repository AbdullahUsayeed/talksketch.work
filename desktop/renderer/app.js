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
  $("notes").src = `${settings.server.replace(/\/$/, "")}/live`;
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

let capturing = false;
let timer = null;
let seen = new Set();
let captured = 0;

const SCRAPER = String.raw`(() => {
  const pick = (sel) => document.querySelector(sel);
  let rows = [];
  const container = pick('div[jsname="YSxPC"]');
  if (container) {
    rows = [...container.querySelectorAll('.iOzk7, .TBMuR, .a4cQT')];
    if (!rows.length) rows = [...container.querySelectorAll(':scope > div')];
    if (!rows.length) rows = [container];
  }
  if (!rows.length) {
    const live = [...document.querySelectorAll('div[aria-live="polite"]')].filter((el) => (el.innerText || '').trim());
    if (live.length) {
      const el = live[live.length - 1];
      rows = [...el.querySelectorAll(':scope > div')];
      if (!rows.length) rows = [el];
    }
  }
  const out = [];
  for (const row of rows) {
    const text = (row.innerText || '').trim();
    if (!text) continue;
    const lines = text.split('\n').map((s) => s.trim()).filter(Boolean);
    let speaker = 'Participant';
    let body = text;
    if (lines.length > 1) {
      speaker = lines[0].replace(/:$/, '');
      body = lines.slice(1).join(' ');
    } else {
      const m = text.match(/^([^:]{1,40}):\s*(.+)$/);
      if (m) { speaker = m[1].trim(); body = m[2].trim(); }
    }
    body = body.replace(/\s+/g, ' ').trim();
    if (body.length >= 3 && body.length < 600) out.push({ speaker, text: body });
  }
  return out;
})()`;

async function api(path, body) {
  const base = settings.server.replace(/\/$/, "");
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: settings.code, ...body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Server ${res.status}`);
  return data;
}

async function scan() {
  if (!capturing) return;
  try {
    const rows = await $("meet").executeJavaScript(SCRAPER, true);
    if (!Array.isArray(rows) || rows.length === 0) {
      if (captured === 0) setStatus("No captions found yet — click CC in Meet.");
      return;
    }
    for (const row of rows) {
      const key = `${row.speaker}|${row.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (seen.size > 800) seen = new Set([...seen].slice(-400));
      await api("/api/live/ingest", { lines: [row] });
      captured += 1;
      $("captured").textContent = `${captured} lines captured`;
    }
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
    await api("/api/live/start", {
      topic: settings.topic,
      participants: settings.participants,
    });
    capturing = true;
    seen = new Set();
    captured = 0;
    $("captured").textContent = "0 lines captured";
    $("stop").hidden = false;
    setStatus("Live. Turn on captions (CC) in Meet.");
    timer = setInterval(scan, 1400);
    scan();
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
    setStatus("Meeting ended. Summary is in the notes panel.");
  } catch (error) {
    setStatus(`Stop failed: ${error.message}`, true);
  }
});

$("meet").addEventListener("dom-ready", () => setStatus("Meeting view ready. Join the call, then start notes."));
$("meet").addEventListener("did-fail-load", () => setStatus("Meeting view failed to load. Check the URL.", true));

persist();
