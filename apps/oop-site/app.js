const root = document.documentElement;

// Language toggle. The initial language is chosen by the inline script in <head>.
const langButtons = document.querySelectorAll("[data-set-lang]");

function applyLang(lang) {
  root.lang = lang;
  root.dataset.lang = lang;
  for (const b of langButtons) b.setAttribute("aria-pressed", String(b.dataset.setLang === lang));
  for (const img of document.querySelectorAll("img[alt]")) {
    img.dataset.altEn ??= img.alt;
    img.alt = (lang === "ko" && img.dataset.altKo) || img.dataset.altEn;
  }
  document.title =
    lang === "ko"
      ? "OOP — 모든 코딩 에이전트를 위한 하나의 데스크톱 앱"
      : "OOP — one desktop app for every coding agent";
}

for (const b of langButtons) {
  b.addEventListener("click", () => {
    applyLang(b.dataset.setLang);
    try {
      localStorage.setItem("oop-site-lang", b.dataset.setLang);
    } catch {
      // Storage can be blocked; the choice then only lasts for this visit.
    }
  });
}
applyLang(root.dataset.lang);

// Tabs (screenshots, install). Arrow keys move between tabs.
for (const group of document.querySelectorAll("[data-tabs]")) {
  const tabs = [...group.querySelectorAll('[role="tab"]')];
  const select = (tab, focus) => {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
      group.querySelector("#" + t.getAttribute("aria-controls")).hidden = !on;
    }
    if (focus) tab.focus();
  };
  for (const tab of tabs) {
    tab.addEventListener("click", () => select(tab, false));
    tab.addEventListener("keydown", (e) => {
      const i = tabs.indexOf(tab);
      const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
      if (next === undefined) return;
      e.preventDefault();
      select(tabs[(next + tabs.length) % tabs.length], true);
    });
  }
}

// Copy buttons.
const status = document.getElementById("copy-status");

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }
}

for (const btn of document.querySelectorAll("[data-copy]")) {
  const original = btn.innerHTML;
  btn.addEventListener("click", async () => {
    const ok = await copyText(btn.parentElement.querySelector("code").textContent);
    const ko = root.lang === "ko";
    status.textContent = ok
      ? ko
        ? "복사했습니다"
        : "Copied"
      : ko
        ? "복사하지 못했습니다"
        : "Copy failed";
    if (!ok) return;
    btn.classList.add("done");
    btn.textContent = ko ? "복사됨" : "Copied";
    setTimeout(() => {
      btn.classList.remove("done");
      btn.innerHTML = original;
    }, 1600);
  });
}

// One-shot reveal on scroll. Without IntersectionObserver everything is simply shown.
const reveals = document.querySelectorAll(".reveal");
if ("IntersectionObserver" in window) {
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add("in");
        io.unobserve(e.target);
      }
    },
    { rootMargin: "0px 0px -8% 0px" },
  );
  for (const el of reveals) io.observe(el);
} else {
  for (const el of reveals) el.classList.add("in");
}
