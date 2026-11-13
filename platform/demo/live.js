const $ = (id) => document.getElementById(id);
const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

$("code").value = localStorage.getItem("ts_code") ?? "";

function clock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function item(record, kind) {
  if (kind === "suggestion") {
    return `<div class="item suggestion"><span class="meta">${esc(record.topic)}</span><p><b>${esc(record.rationale)}</b></p><p>${esc(record.content)}</p></div>`;
  }
  if (kind === "action") {
    const owner = [record.assignee, record.deadline].filter(Boolean).join(" · ");
    return `<div class="item action"><p>${esc(record.content)}</p>${owner ? `<span class="meta">${esc(owner)}</span>` : ""}</div>`;
  }
  return `<div class="item"><p>${esc(record.content)}</p></div>`;
}

function render(state) {
  const active = Boolean(state.active);
  $("live-dot").style.background = active ? "var(--green)" : "#b7b1a3";
  $("live-label").textContent = active ? "Live" : "Idle";
  $("clock").textContent = clock(state.elapsedMs ?? 0);
  $("segments").textContent = `${state.segments ?? 0} lines`;
  $("meeting-topic").textContent = state.topic || (active ? "Live meeting" : "Waiting for a meeting");
  $("hint").hidden = active;
  $("end").hidden = !active;

  $("notes-count").textContent = state.notes?.length ?? 0;
  $("suggestions-count").textContent = state.suggestions?.length ?? 0;
  $("actions-count").textContent = state.actions?.length ?? 0;

  $("notes").innerHTML = state.notes?.length ? state.notes.map((n) => item(n, "note")).join("") : `<p class="muted">No notes yet.</p>`;
  $("suggestions").innerHTML = state.suggestions?.length
    ? state.suggestions.map((s) => item(s, "suggestion")).join("")
    : `<p class="muted">No suggestions yet.</p>`;
  $("actions").innerHTML = state.actions?.length
    ? state.actions.map((a) => item(a, "action")).join("")
    : `<p class="muted">No action items yet.</p>`;

  if (state.summary) {
    $("summary-block").hidden = false;
    $("summary").textContent = state.summary;
  }
}

async function poll() {
  try {
    const code = $("code").value.trim() || localStorage.getItem("ts_code") || "";
    const res = await fetch(`/api/live/state?code=${encodeURIComponent(code)}`, { cache: "no-store" });
    if (res.status === 401) {
      $("notice").textContent = "Enter your access key to see the live record.";
      return;
    }
    render(await res.json());
  } catch {
    $("notice").textContent = "Cannot reach the demo server.";
  }
}
poll();
setInterval(poll, 3000);

$("start-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const code = $("code").value.trim();
  localStorage.setItem("ts_code", code);
  $("notice").textContent = "Starting…";
  try {
    const res = await fetch("/api/live/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code,
        topic: $("topic").value.trim(),
        participants: $("participants").value.trim(),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "Could not start.");
    $("notice").textContent = "Live. Enable captions in Meet.";
    poll();
  } catch (error) {
    $("notice").textContent = error.message;
  }
});

$("paste-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = $("paste").value.trim();
  if (!text) return;
  try {
    const res = await fetch("/api/live/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: $("code").value.trim(), text }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "Could not send.");
    $("paste").value = "";
    $("notice").textContent = `Sent ${data.received} lines.`;
    poll();
  } catch (error) {
    $("notice").textContent = error.message;
  }
});

$("end").addEventListener("click", async () => {
  if (!confirm("End the meeting and generate the summary?")) return;
  $("notice").textContent = "Summarizing…";
  try {
    const res = await fetch("/api/live/end", { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "Could not end.");
    render(data);
    $("notice").textContent = "Meeting ended.";
  } catch (error) {
    $("notice").textContent = error.message;
  }
});
