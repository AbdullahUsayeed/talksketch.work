(() => {
  if (window.__talkSketchCapture) return;
  window.__talkSketchCapture = true;

  let capturing = false;
  let timer = null;
  const sent = new Set();
  const pending = new WeakMap();

  const ROW_SELECTORS = [".iOzk7", ".TBMuR", ".a4cQT"];

  function rows() {
    const container = document.querySelector('div[jsname="YSxPC"]');
    if (container) {
      const blocks = [...container.querySelectorAll(".iOzk7, .TBMuR, .a4cQT")];
      if (blocks.length) return blocks;
      const children = [...container.querySelectorAll(":scope > div")];
      if (children.length) return children;
      return [container];
    }

    const live = [...document.querySelectorAll('div[aria-live="polite"]')].filter(
      (el) => (el.innerText || "").trim().length > 0,
    );
    if (live.length) {
      const el = live[live.length - 1];
      const children = [...el.querySelectorAll(":scope > div")];
      return children.length ? children : [el];
    }

    return [...document.querySelectorAll(ROW_SELECTORS.join(","))];
  }

  function parse(row) {
    const text = (row.innerText || "").trim();
    if (!text) return null;
    const lines = text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    let speaker = "Participant";
    let body = text;

    if (lines.length > 1) {
      speaker = lines[0].replace(/:$/, "");
      body = lines.slice(1).join(" ");
    } else {
      const match = text.match(/^([^:]{1,40}):\s*(.+)$/);
      if (match) {
        speaker = match[1].trim();
        body = match[2].trim();
      }
    }

    body = body.replace(/\s+/g, " ").trim();
    if (body.length < 3 || body.length > 600) return null;
    return { speaker, text: body };
  }

  function consider(row, parsed) {
    const previous = pending.get(row);
    if (previous && previous.text === parsed.text) return;
    if (previous) clearTimeout(previous.timer);

    const timerId = setTimeout(() => {
      const key = `${parsed.speaker}|${parsed.text}`;
      if (sent.has(key)) return;
      sent.add(key);
      if (sent.size > 500) sent.clear();
      chrome.runtime.sendMessage({ type: "caption", speaker: parsed.speaker, text: parsed.text });
    }, 1300);

    pending.set(row, { text: parsed.text, timer: timerId });
  }

  function scan() {
    if (!capturing) return;
    for (const row of rows()) {
      const parsed = parse(row);
      if (parsed) consider(row, parsed);
    }
  }

  function start() {
    if (capturing) return;
    capturing = true;
    sent.clear();
    timer = setInterval(scan, 800);
    scan();
  }

  function stop() {
    capturing = false;
    if (timer) clearInterval(timer);
    timer = null;
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "start-capture") start();
    if (message?.type === "stop-capture") stop();
  });

  chrome.storage.local.get({ capturing: false }, (state) => {
    if (state.capturing) start();
  });
})();
