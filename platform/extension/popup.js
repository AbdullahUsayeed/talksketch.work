const $ = (id) => document.getElementById(id);

const DEFAULTS = {
  server: "http://localhost:8788",
  code: "TALKSKETCH",
  topic: "Family meeting",
  participants: "",
  capturing: false,
  lines: 0,
  error: "",
};

function fill(values) {
  $("server").value = values.server;
  $("code").value = values.code;
  $("topic").value = values.topic;
  $("participants").value = values.participants;
  $("dot").className = values.capturing ? "dot on" : "dot";
  $("state").textContent = values.capturing ? "Capturing" : "Idle";
  $("lines").textContent = `${values.lines ?? 0} caption lines sent`;
  $("error").textContent = values.error || "";
  $("start").disabled = Boolean(values.capturing);
  $("stop").disabled = !values.capturing;
  $("dash").href = `${String(values.server).replace(/\/$/, "")}/live`;
}

function read() {
  return {
    server: $("server").value.trim() || DEFAULTS.server,
    code: $("code").value.trim() || DEFAULTS.code,
    topic: $("topic").value.trim() || DEFAULTS.topic,
    participants: $("participants").value.trim(),
  };
}

chrome.storage.local.get(DEFAULTS, fill);

$("start").addEventListener("click", () => {
  const settings = read();
  chrome.storage.local.set(settings);
  chrome.runtime.sendMessage({ type: "start", settings });
  $("state").textContent = "Starting…";
});

$("stop").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "stop" });
  $("state").textContent = "Stopping…";
});

setInterval(() => chrome.storage.local.get(DEFAULTS, fill), 1000);
