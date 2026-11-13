const DEFAULTS = {
  server: "http://localhost:8788",
  code: "TALKSKETCH",
  topic: "Family meeting",
  participants: "",
  capturing: false,
  lines: 0,
  error: "",
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(DEFAULTS, (values) => chrome.storage.local.set(values));
});

async function settings() {
  return chrome.storage.local.get(DEFAULTS);
}

async function api(path, body) {
  const { server } = await settings();
  const base = String(server).replace(/\/$/, "");
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Server ${res.status}`);
  return data;
}

async function meetTab() {
  const tabs = await chrome.tabs.query({ url: "https://meet.google.com/*" });
  return tabs.find((tab) => tab.active) || tabs[0];
}

async function tellTab(type) {
  const tab = await meetTab();
  if (!tab?.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type });
  } catch {
    if (type !== "start-capture") return;
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
      await chrome.tabs.sendMessage(tab.id, { type });
    } catch {
      // tab is not a Meet page or cannot be scripted
    }
  }
}

async function start(settingsOverride) {
  const current = await settings();
  const next = { ...current, ...settingsOverride };
  await chrome.storage.local.set({ ...next, capturing: true, lines: 0, error: "" });
  try {
    await api("/api/live/start", {
      code: next.code,
      topic: next.topic,
      participants: next.participants,
    });
    await tellTab("start-capture");
  } catch (error) {
    await chrome.storage.local.set({ capturing: false, error: String(error.message || error) });
  }
}

async function stop() {
  const current = await settings();
  await chrome.storage.local.set({ capturing: false });
  await tellTab("stop-capture");
  try {
    await api("/api/live/end", { code: current.code });
  } catch {
    // the server may already have ended it
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "caption") {
    (async () => {
      const current = await settings();
      if (!current.capturing) return;
      try {
        await api("/api/live/ingest", {
          code: current.code,
          lines: [{ speaker: message.speaker, text: message.text }],
        });
        const { lines = 0 } = await chrome.storage.local.get({ lines: 0 });
        await chrome.storage.local.set({ lines: lines + 1, error: "" });
      } catch (error) {
        await chrome.storage.local.set({ error: String(error.message || error) });
      }
    })();
    return false;
  }

  if (message?.type === "start") {
    start(message.settings).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message?.type === "stop") {
    stop().then(() => sendResponse({ ok: true }));
    return true;
  }

  return false;
});
