const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* year */
document.getElementById("year").textContent = new Date().getFullYear();

/* sticky nav border */
const nav = document.getElementById("nav");
const onScroll = () => nav.classList.toggle("scrolled", window.scrollY > 8);
onScroll();
window.addEventListener("scroll", onScroll, { passive: true });

/* mobile menu */
const menu = document.getElementById("menu");
const links = document.getElementById("navLinks");
menu.addEventListener("click", () => {
  const open = links.classList.toggle("open");
  menu.setAttribute("aria-expanded", String(open));
});
links.addEventListener("click", (event) => {
  if (event.target.tagName === "A") {
    links.classList.remove("open");
    menu.setAttribute("aria-expanded", "false");
  }
});

/* scroll reveal */
const reveals = document.querySelectorAll(".reveal");
if ("IntersectionObserver" in window && !REDUCED) {
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const delay = entry.target.dataset.delay;
        if (delay) entry.target.style.setProperty("--d", delay);
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      }
    },
    { rootMargin: "0px 0px -8% 0px", threshold: 0.12 }
  );
  reveals.forEach((el) => observer.observe(el));
} else {
  reveals.forEach((el) => el.classList.add("is-visible"));
}

/* board tilt */
const board = document.getElementById("board");
if (board && !REDUCED && window.matchMedia("(pointer: fine)").matches) {
  const wrap = board.parentElement;
  wrap.addEventListener("mousemove", (event) => {
    const rect = wrap.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width - 0.5;
    const y = (event.clientY - rect.top) / rect.height - 0.5;
    board.style.setProperty("--ry", `${x * 6}deg`);
    board.style.setProperty("--rx", `${-y * 5}deg`);
  });
  wrap.addEventListener("mouseleave", () => {
    board.style.setProperty("--ry", "0deg");
    board.style.setProperty("--rx", "0deg");
  });
}

/* typewriter */
const phrases = [
  "Let's lock the retention default at two years.",
  "SSO is the blocker for the enterprise deal.",
  "Jon takes the Okta sandbox, Friday.",
  "Can we ship the audit log without legal?"
];
const typed = document.getElementById("typed");
if (typed) {
  if (REDUCED) {
    typed.textContent = phrases[0];
  } else {
    let phrase = 0;
    let char = 0;
    let deleting = false;
    const tick = () => {
      const current = phrases[phrase];
      char += deleting ? -1 : 1;
      typed.textContent = current.slice(0, char);
      let wait = deleting ? 26 : 48;
      if (!deleting && char === current.length) {
        deleting = true;
        wait = 2200;
      } else if (deleting && char === 0) {
        deleting = false;
        phrase = (phrase + 1) % phrases.length;
        wait = 380;
      }
      window.setTimeout(tick, wait);
    };
    window.setTimeout(tick, 900);
  }
}

