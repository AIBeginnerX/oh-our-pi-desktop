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
  for (const el of document.querySelectorAll("[data-aria-en]")) {
    el.setAttribute("aria-label", (lang === "ko" && el.dataset.ariaKo) || el.dataset.ariaEn);
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

// ---------------------------------------------------------------------------
// Motion. Everything below is one-shot or step driven (no endless loops), only moves
// transform, opacity and stroke-dashoffset, runs only while on screen, and with
// prefers-reduced-motion shows the final state instead. Without JS the HTML already
// holds the final state of every diagram.
// ---------------------------------------------------------------------------
const reducedQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
const reduced = () => reducedQuery.matches;
const SVG_NS = "http://www.w3.org/2000/svg";

// Runs enter() when el is mostly on screen and leave() when it is not.
function onView(el, enter, leave = () => {}, threshold = 0.4) {
  if (!("IntersectionObserver" in window)) {
    enter();
    return;
  }
  new IntersectionObserver(
    (entries) => {
      for (const e of entries) (e.isIntersecting ? enter : leave)();
    },
    { threshold },
  ).observe(el);
}

// Counts a number up (or between values); with reduced motion it just sets it.
function countTo(el, to, unit = "", ms = 800) {
  const from = Number(el.dataset.shown ?? 0);
  el.dataset.shown = String(to);
  if (reduced() || from === to) {
    el.textContent = to + unit;
    return;
  }
  const t0 = performance.now();
  const tick = (now) => {
    const t = Math.min(1, (now - t0) / ms);
    el.textContent = Math.round(from + (to - from) * (1 - (1 - t) ** 3)) + unit;
    if (t < 1 && el.dataset.shown === String(to)) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// Step-through diagram. Steps are the <li> of an <ol data-steps>: data-on / data-off list the
// data-id elements to light or unlight, data-run lists the edges a particle travels along.
function initFlow(root) {
  const lists = [...root.querySelectorAll("[data-steps]")];
  const svg = root.querySelector(".flow-svg");
  const particles = root.querySelector(".particles");
  const playBtn = root.querySelector('[data-act="play"]');
  const live = root.querySelector("[data-live]");
  const segButtons = [...root.querySelectorAll("[data-mode]")];
  const ids = (v) => (v ? v.split(",").filter(Boolean) : []);
  const byId = (id) => root.querySelectorAll(`[data-id="${id}"]`);
  const named = (n) => lists.find((l) => l.dataset.steps === n);
  let list = lists.find((l) => !l.hidden) ?? lists[0];
  let idx = -1;
  let playing = false;
  let visible = false;
  let started = false;
  let timer = 0;
  if (svg && particles) svg.append(particles);

  function fly(id) {
    const path = root.querySelector(`.fl-edge[data-id="${id}"]`);
    if (!path || !particles) return;
    const len = path.getTotalLength();
    const dot = document.createElementNS(SVG_NS, "circle");
    dot.setAttribute("r", "5");
    dot.setAttribute("class", "particle");
    const place = (t) => {
      const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      const pt = path.getPointAtLength(len * e);
      dot.style.transform = `translate(${pt.x}px, ${pt.y}px)`;
    };
    place(0);
    particles.append(dot);
    const t0 = performance.now();
    const tick = (now) => {
      const t = Math.min(1, (now - t0) / 700);
      place(t);
      if (t < 1) requestAnimationFrame(tick);
      else dot.remove();
    };
    requestAnimationFrame(tick);
  }

  function apply(li, animate) {
    for (const id of ids(li.dataset.off)) for (const e of byId(id)) e.classList.remove("on");
    for (const e of root.querySelectorAll(".cur")) e.classList.remove("cur");
    for (const id of ids(li.dataset.on)) {
      for (const e of byId(id)) {
        e.classList.add("on");
        if (e.matches(".fl-node, .rung")) e.classList.add("cur");
      }
    }
    if (animate && !reduced()) for (const id of ids(li.dataset.run)) fly(id);
  }

  function mark() {
    [...list.children].forEach((li, k) => {
      if (k === idx) li.setAttribute("aria-current", "step");
      else li.removeAttribute("aria-current");
    });
  }

  // Silently puts the diagram in the state after `upTo` steps of the current list.
  function reset(upTo) {
    clearTimeout(timer);
    for (const e of root.querySelectorAll("[data-id]")) e.classList.remove("on", "cur");
    const base = list.dataset.base && named(list.dataset.base);
    if (base) for (const li of base.children) apply(li, false);
    [...list.children].slice(0, upTo).forEach((li) => apply(li, false));
    idx = upTo - 1;
    mark();
  }

  function showFinal() {
    stop();
    reset(list.children.length);
    for (const e of root.querySelectorAll(".cur")) e.classList.remove("cur");
    idx = -1;
    mark();
  }

  function setPlaying(on) {
    playing = on;
    if (playBtn) playBtn.dataset.state = on ? "playing" : "paused";
  }

  function stop() {
    clearTimeout(timer);
    setPlaying(false);
  }

  function announce(li) {
    if (!live) return;
    const t = li.querySelector(`[lang="${root.lang || document.documentElement.lang}"]`) ?? li;
    live.textContent = t.textContent;
  }

  function next(user) {
    const items = [...list.children];
    if (idx >= items.length - 1) reset(0);
    idx += 1;
    apply(items[idx], true);
    mark();
    if (user) announce(items[idx]);
    return idx >= items.length - 1;
  }

  function schedule() {
    clearTimeout(timer);
    if (!playing || !visible) return;
    timer = setTimeout(() => {
      if (next(false)) stop();
      else schedule();
    }, 1700);
  }

  function play() {
    if (idx >= list.children.length - 1) reset(0);
    setPlaying(true);
    if (next(false)) stop();
    else schedule();
  }

  function setMode(name, user) {
    list = named(name) ?? list;
    for (const l of lists) l.hidden = l !== list;
    for (const b of segButtons) b.setAttribute("aria-pressed", String(b.dataset.mode === name));
    stop();
    if (reduced()) showFinal();
    else {
      reset(0);
      play();
    }
    if (user && live) {
      const b = segButtons.find((x) => x.dataset.mode === name);
      live.textContent =
        b?.querySelector(`[lang="${document.documentElement.lang}"]`)?.textContent ?? "";
    }
  }

  playBtn?.addEventListener("click", () => {
    if (playing) stop();
    else play();
  });
  root.querySelector('[data-act="step"]')?.addEventListener("click", () => {
    stop();
    next(true);
  });
  root.querySelector('[data-act="replay"]')?.addEventListener("click", () => {
    stop();
    reset(0);
    if (reduced()) next(true);
    else play();
  });
  for (const b of segButtons) b.addEventListener("click", () => setMode(b.dataset.mode, true));
  reducedQuery.addEventListener("change", () => reduced() && showFinal());

  if (reduced()) showFinal();
  else reset(0);
  onView(
    root.querySelector(".flow-svg, .tm-win, .ladder") ?? root,
    () => {
      visible = true;
      if (!started && !reduced()) {
        started = true;
        play();
      } else schedule();
    },
    () => {
      visible = false;
      clearTimeout(timer);
    },
    0.3,
  );
}
for (const root of document.querySelectorAll("[data-flow]")) initFlow(root);

// Sample chart: bars grow, the donut sweeps and the numbers count up when it comes into view,
// and again when the sample is switched or replayed.
function initChart(root) {
  const SETS = {
    a: { bars: [3, 8, 5, 12, 6], pie: [50, 30, 20] },
    b: { bars: [9, 4, 10, 2, 7], pie: [25, 45, 30] },
  };
  const MAX = 12;
  const bars = [...root.querySelectorAll(".hbars li")];
  const slices = [...root.querySelectorAll(".sl")];
  const legend = [...root.querySelectorAll(".legend b")];
  const sweep = root.querySelector(".sweep");
  const buttons = [...root.querySelectorAll("[data-set]")];
  let set = "a";

  function show(name) {
    const d = SETS[name];
    bars.forEach((li, i) => {
      li.querySelector("i").style.setProperty("--v", String(d.bars[i] / MAX));
      countTo(li.querySelector("b"), d.bars[i]);
    });
    let at = 0;
    d.pie.forEach((v, i) => {
      slices[i].setAttribute("stroke-dasharray", `${v - 0.8} 100`);
      slices[i].setAttribute("stroke-dashoffset", String(-at));
      at += v;
      countTo(legend[i], v, "%");
    });
    sweep.style.strokeDashoffset = "0";
  }

  function zero() {
    root.classList.add("reset");
    for (const li of bars) {
      li.querySelector("i").style.setProperty("--v", "0");
      const b = li.querySelector("b");
      b.dataset.shown = "0";
      b.textContent = "0";
    }
    for (const b of legend) {
      b.dataset.shown = "0";
      b.textContent = "0%";
    }
    sweep.style.strokeDashoffset = "100";
    void root.offsetWidth;
    root.classList.remove("reset");
  }

  function play(name) {
    set = name;
    for (const b of buttons) b.setAttribute("aria-pressed", String(b.dataset.set === name));
    if (!reduced()) zero();
    show(name);
  }

  for (const b of buttons) b.addEventListener("click", () => play(b.dataset.set));
  root.querySelector('[data-act="replay"]')?.addEventListener("click", () => play(set));
  if (reduced()) return;
  zero();
  onView(root.querySelector(".cd-grid"), () => {
    if (!root.dataset.played) {
      root.dataset.played = "1";
      play(set);
    }
  });
}
for (const root of document.querySelectorAll("[data-chart]")) initChart(root);

// Facts strip: the numbers count up once.
const factsRoot = document.querySelector(".facts");
if (factsRoot && !reduced()) {
  const nums = [...factsRoot.querySelectorAll("[data-count]")];
  for (const n of nums) n.textContent = "0";
  onView(factsRoot, () => {
    if (factsRoot.dataset.played) return;
    factsRoot.dataset.played = "1";
    nums.forEach((n, i) =>
      setTimeout(() => countTo(n, Number(n.dataset.count), "", 1300), i * 160),
    );
  });
}

// Recordings: play only while on screen, with a visible play/pause button. With reduced motion
// they stay on the poster and keep the native controls.
for (const box of document.querySelectorAll("[data-video]")) {
  const video = box.querySelector("video");
  const btn = box.querySelector(".vid-btn");
  const fallback = box.querySelector(".vid-fallback");
  let userPaused = false;
  let inView = false;
  const sync = () => {
    btn.dataset.state = video.paused ? "paused" : "playing";
  };
  const autoplay = () => {
    if (inView && !userPaused && !reduced() && !document.hidden) video.play().catch(() => {});
  };
  if (!reduced()) video.removeAttribute("controls");
  video.addEventListener("play", sync);
  video.addEventListener("pause", sync);
  btn.addEventListener("click", () => {
    if (video.paused) {
      userPaused = false;
      video.play().catch(() => {});
    } else {
      userPaused = true;
      video.pause();
    }
  });
  // A recording that cannot load: show the still image instead, or hide the figure.
  video.addEventListener(
    "error",
    () => {
      if (fallback) {
        fallback.hidden = false;
        video.hidden = true;
        box.querySelector(".rec")?.remove();
        btn.remove();
      } else {
        box.closest("figure").hidden = true;
      }
    },
    true,
  );
  onView(
    box,
    () => {
      inView = true;
      autoplay();
    },
    () => {
      inView = false;
      video.pause();
    },
  );
  document.addEventListener("visibilitychange", () =>
    document.hidden ? video.pause() : autoplay(),
  );
}

// ---------------------------------------------------------------------------
// Scroll-linked motion. One rAF-throttled listener feeds the reading-progress bar and the
// tilt/drift of the shots; word masks, the hero mesh and the nav highlight use observers.
// ---------------------------------------------------------------------------
const frameOnce = (fn) => {
  let queued = false;
  return () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      fn();
    });
  };
};

const progressBar = document.querySelector(".progress i");
const updateProgress = frameOnce(() => {
  const max = root.scrollHeight - window.innerHeight;
  progressBar.style.transform = `scaleX(${max > 0 ? Math.min(1, window.scrollY / max) : 0})`;
});
if (progressBar) {
  addEventListener("scroll", updateProgress, { passive: true });
  addEventListener("resize", updateProgress);
  updateProgress();
}

// Nav: mark the section that crosses the middle of the screen.
const navLinks = [...document.querySelectorAll('.nav a[href^="#"]')];
if (navLinks.length && "IntersectionObserver" in window) {
  const sectionIo = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        for (const a of navLinks) {
          if (a.getAttribute("href") === `#${e.target.id}`) a.setAttribute("aria-current", "true");
          else a.removeAttribute("aria-current");
        }
      }
    },
    { rootMargin: "-40% 0px -55% 0px" },
  );
  for (const a of navLinks) {
    const section = document.querySelector(a.getAttribute("href"));
    if (section) sectionIo.observe(section);
  }
}

// Headings: each word slides up out of a mask, staggered. Both languages are split.
function splitWords(el) {
  for (const lang of el.querySelectorAll(":scope > [lang]")) {
    let i = 0;
    const walk = (node) => {
      for (const child of [...node.childNodes]) {
        if (child.nodeType === 3) {
          const frag = document.createDocumentFragment();
          for (const part of child.textContent.split(/(\s+)/)) {
            if (!part) continue;
            if (/^\s+$/.test(part)) {
              frag.append(part);
              continue;
            }
            const mask = document.createElement("span");
            mask.className = "w";
            const word = document.createElement("span");
            word.className = "wi";
            word.style.setProperty("--i", String(Math.min(i++, 14)));
            word.textContent = part;
            mask.append(word);
            frag.append(mask);
          }
          child.replaceWith(frag);
        } else if (child.nodeType === 1 && child.tagName !== "BR") walk(child);
      }
    };
    walk(lang);
  }
  el.classList.add("split");
}
if (!reduced()) {
  for (const h of document.querySelectorAll(".sec-head h2, .hero h1")) splitWords(h);
  const h1 = document.querySelector(".hero h1");
  if (h1) requestAnimationFrame(() => requestAnimationFrame(() => h1.classList.add("in")));
}

// Hero mesh runs only while the hero is on screen (it is transform-only CSS).
const mesh = document.querySelector(".hero-mesh");
if (mesh && !reduced()) {
  onView(
    mesh.parentElement,
    () => mesh.classList.add("run"),
    () => mesh.classList.remove("run"),
    0,
  );
}

// Shots tilt in as they arrive and drift slightly in the Screens section.
if (!reduced() && "IntersectionObserver" in window) {
  const shots = document.querySelectorAll(
    "#screens .panel img, #flows .showcase .shot img, #charts > .shot img",
  );
  const live = new Set();
  const place = frameOnce(() => {
    const vh = window.innerHeight;
    for (const el of live) {
      const r = el.getBoundingClientRect();
      const arrive = Math.min(1, Math.max(0, (vh - r.top) / (vh * 0.7)));
      const drift = el.closest("#screens") ? (r.top + r.height / 2 - vh / 2) * -0.04 : 0;
      el.style.transform = `perspective(1200px) translateY(${drift.toFixed(1)}px) rotateX(${((1 - arrive) * 7).toFixed(2)}deg) scale(${(0.95 + 0.05 * arrive).toFixed(3)})`;
    }
  });
  const shotIo = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) live.add(e.target);
        else {
          live.delete(e.target);
          e.target.style.transform = "";
        }
      }
      place();
    },
    { rootMargin: "20% 0px" },
  );
  for (const img of shots) {
    img.dataset.fx = "";
    shotIo.observe(img);
  }
  addEventListener("scroll", place, { passive: true });
  addEventListener("resize", place);
}
