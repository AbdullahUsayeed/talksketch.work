/* Copy-to-clipboard for install commands.
 *
 * Any element with data-copy copies its value. Elements that also carry
 * data-winget first check whether the package exists in microsoft/winget-pkgs,
 * so the site never advertises a command that winget cannot resolve yet.
 */
const WINGET_MANIFEST_URL =
  "https://api.github.com/repos/microsoft/winget-pkgs/contents/manifests/t/TalkSketch/TalkSketch";

let wingetCheck = null;

function wingetPublished() {
  if (!wingetCheck) {
    wingetCheck = fetch(WINGET_MANIFEST_URL, { method: "HEAD", cache: "no-store" })
      .then((res) => res.ok)
      .catch(() => false);
  }
  return wingetCheck;
}

function flash(el, text, extraClass) {
  const original = el.innerHTML;
  el.innerHTML = text;
  if (extraClass) el.classList.add(extraClass);
  window.setTimeout(() => {
    el.innerHTML = original;
    if (extraClass) el.classList.remove(extraClass);
  }, 2600);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const field = document.createElement("textarea");
    field.value = text;
    field.setAttribute("readonly", "");
    field.style.position = "fixed";
    field.style.opacity = "0";
    document.body.appendChild(field);
    field.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    field.remove();
    return ok;
  }
}

for (const el of document.querySelectorAll("[data-copy]")) {
  el.addEventListener("click", async (event) => {
    event.preventDefault();

    if (el.hasAttribute("data-winget") && !(await wingetPublished())) {
      flash(el, "In review — use Download", "unavailable");
      return;
    }

    if (!(await copyText(el.dataset.copy))) return;
    flash(el, el.dataset.copied || "Copied", "copied");
  });
}
