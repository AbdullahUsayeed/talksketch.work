const form = document.getElementById("form");
const code = document.getElementById("code");
const topic = document.getElementById("topic");
const participants = document.getElementById("participants");
const transcript = document.getElementById("transcript");
const counter = document.getElementById("counter");
const submit = document.getElementById("submit");
const sample = document.getElementById("sample");
const empty = document.getElementById("empty");
const working = document.getElementById("working");
const result = document.getElementById("result");
const stage = document.getElementById("stage");
const stageDetail = document.getElementById("stage-detail");
const elapsedEl = document.getElementById("elapsed");
const errorEl = document.getElementById("error");

code.value = localStorage.getItem("ts_code") ?? "";

const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function updateCount() {
  counter.textContent = `${transcript.value.length.toLocaleString()} characters`;
}
transcript.addEventListener("input", updateCount);
updateCount();

sample.addEventListener("click", async () => {
  sample.disabled = true;
  try {
    const res = await fetch("/api/sample");
    const data = await res.json();
    transcript.value = data.transcript;
    topic.value = "Q2 pipeline review";
    participants.value = "Sarah, Tom, Priya, Marcus";
    updateCount();
  } catch {
    errorEl.textContent = "Could not load the sample. Try again.";
  } finally {
    sample.disabled = false;
  }
});

function stageFor(elapsedMs) {
  if (elapsedMs < 4000) return ["Reading the transcript", "Splitting speakers and finding the shape of the meeting…"];
  if (elapsedMs < 14000) return ["Finding decisions", "Separating decisions from discussion, numbers from noise…"];
  if (elapsedMs < 26000) return ["Writing notes and actions", "Checking owners, dates and duplicates…"];
  return ["Drawing the board", "Placing agenda, decisions, risks and the conclusion…"];
}

function reset() {
  empty.hidden = true;
  result.hidden = true;
  working.hidden = false;
  errorEl.textContent = "";
  stage.textContent = "Queued";
  stageDetail.textContent = "Waiting for the current analysis to finish…";
  elapsedEl.textContent = "0s";
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (transcript.value.trim().length < 80) {
    errorEl.textContent = "Paste a longer transcript first.";
    return;
  }
  localStorage.setItem("ts_code", code.value.trim());
  submit.disabled = true;
  reset();

  const start = Date.now();
  const timer = setInterval(() => {
    const ms = Date.now() - start;
    elapsedEl.textContent = `${Math.round(ms / 1000)}s`;
    const [title, detail] = stageFor(ms);
    if (stage.textContent !== "Analyzing") {
      stage.textContent = title;
      stageDetail.textContent = detail;
    }
  }, 1000);

  try {
    const res = await fetch("/api/analyze", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code: code.value.trim(),
        transcript: transcript.value,
        topic: topic.value,
        participants: participants.value,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "The analysis could not start.");

    stage.textContent = "Analyzing";
    stageDetail.textContent = "The agent is reading, recording and drawing. This takes about a minute.";

    let job;
    for (let i = 0; i < 150; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const poll = await fetch(`/api/jobs/${data.id}`);
      job = await poll.json();
      if (job.status === "done" || job.status === "error") break;
    }
    if (!job) throw new Error("The job timed out.");
    if (job.status === "error") throw new Error(job.error ?? "The analysis failed.");
    if (job.status !== "done") throw new Error("The analysis took too long. Try a shorter transcript.");

    render(job);
  } catch (error) {
    working.hidden = true;
    empty.hidden = false;
    errorEl.textContent = error.message;
  } finally {
    clearInterval(timer);
    submit.disabled = false;
  }
});

function render(job) {
  working.hidden = true;
  empty.hidden = true;
  result.hidden = false;

  document.getElementById("summary").textContent = job.summary ?? "";
  document.getElementById("timing").textContent = `${(job.elapsedMs / 1000).toFixed(1)}s`;
  document.getElementById("error").textContent = "";

  const board = document.getElementById("board");
  const boardWrap = document.getElementById("board-wrap");
  if (job.boardUrl) {
    board.src = `${job.boardUrl}?t=${Date.now()}`;
    boardWrap.hidden = false;
  } else {
    boardWrap.hidden = true;
  }

  const notes = job.notes ?? [];
  document.getElementById("notes-count").textContent = notes.length;
  document.getElementById("notes").innerHTML = notes.length
    ? notes.map((n) => `<div class="item"><span class="meta">${esc(new Date(n.createdAt).toLocaleTimeString())}</span><p>${esc(n.content)}</p></div>`).join("")
    : `<p class="muted">No notes captured.</p>`;

  const suggestions = job.suggestions ?? [];
  document.getElementById("suggestions-count").textContent = suggestions.length;
  document.getElementById("suggestions").innerHTML = suggestions.length
    ? suggestions
        .map(
          (s) =>
            `<div class="item suggestion"><span class="meta">${esc(s.topic)}</span><p><b>${esc(s.rationale)}</b></p><p>${esc(s.content)}</p></div>`,
        )
        .join("")
    : `<p class="muted">No suggestion — the room covered the gaps.</p>`;

  const actions = job.actions ?? [];
  document.getElementById("actions-count").textContent = actions.length;
  document.getElementById("actions").innerHTML = actions.length
    ? actions
        .map((a) => {
          const owner = [a.assignee, a.deadline].filter(Boolean).join(" · ");
          return `<div class="item action"><p>${esc(a.content)}</p>${owner ? `<span class="meta">${esc(owner)}</span>` : ""}</div>`;
        })
        .join("")
    : `<p class="muted">No action items captured.</p>`;
}
