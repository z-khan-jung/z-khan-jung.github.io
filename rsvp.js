(function () {
  "use strict";

  // ---------- storage (optional; page works without it) ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  };

  // ---------- theme ----------
  const root = document.documentElement;
  const savedTheme = store.get("theme", null);
  if (savedTheme) root.setAttribute("data-theme", savedTheme);
  document.getElementById("theme-toggle").addEventListener("click", () => {
    const isDark = root.getAttribute("data-theme") === "dark" ||
      (!root.getAttribute("data-theme") && matchMedia("(prefers-color-scheme: dark)").matches);
    const next = isDark ? "light" : "dark";
    root.setAttribute("data-theme", next);
    store.set("theme", next);
  });

  // ---------- text → tokens ----------
  const PARA = "\u0000PARA";
  const HANGUL = /[가-힣]/;

  function tokenize(text) {
    const out = [];
    text.replace(/\r/g, "").trim().split(/\n\s*\n/).forEach((para, i) => {
      if (i > 0) out.push(PARA);
      para.split(/\s+/).filter(Boolean).forEach(w => out.push(w));
    });
    return out;
  }

  // Group tokens into chunks of `size` words, never crossing a paragraph or a sentence end.
  function chunkify(tokens, size) {
    const chunks = [];
    let cur = [];
    const flush = (para) => {
      if (cur.length) chunks.push({ words: cur, para: !!para });
      cur = [];
    };
    tokens.forEach(t => {
      if (t === PARA) { flush(); if (chunks.length) chunks[chunks.length - 1].para = true; return; }
      cur.push(t);
      if (cur.length >= size || /[.!?。…]["'”’)]*$/.test(t)) flush();
    });
    flush();
    return chunks;
  }

  // Optimal Recognition Point: index of the letter to highlight.
  function orpIndex(s) {
    const chars = Array.from(s);
    // skip leading punctuation / quotes
    let start = 0;
    while (start < chars.length - 1 && /[^\p{L}\p{N}]/u.test(chars[start])) start++;
    let end = chars.length;
    while (end > start + 1 && /[^\p{L}\p{N}]/u.test(chars[end - 1])) end--;
    const len = end - start;
    let i;
    if (HANGUL.test(s)) {
      i = Math.floor((len - 1) / 2);              // 한글은 음절이 넓어서 가운데 쪽
    } else if (len <= 1) i = 0;
    else if (len <= 5) i = 1;
    else if (len <= 9) i = 2;
    else if (len <= 13) i = 3;
    else i = 4;
    return start + Math.min(i, len - 1);
  }

  function delayFor(chunk, wpm) {
    const base = 60000 / wpm;
    const text = chunk.words.join(" ");
    const last = chunk.words[chunk.words.length - 1];
    // multi-word chunks are read a bit faster than the sum of their words
    let ms = base * (chunk.words.length === 1 ? 1 : chunk.words.length * 0.85);
    const longest = Math.max(...chunk.words.map(w => Array.from(w).length));
    if (longest > (HANGUL.test(text) ? 5 : 8)) ms *= 1.25;
    if (/[.!?。…]["'”’)]*$/.test(last)) ms *= 2.2;
    else if (/[,;:、，]["'”’)]*$/.test(last)) ms *= 1.5;
    if (chunk.para) ms *= 1.6;
    return ms;
  }

  // ---------- Reader component ----------
  let activeReader = null;

  class Reader {
    constructor(host, opts) {
      this.host = host;
      this.key = opts.key;
      this.wpm = store.get(this.key + ".wpm", opts.wpm || 250);
      this.size = store.get(this.key + ".size", 1);
      this.showContext = store.get(this.key + ".ctx", true);
      this.idx = 0;
      this.timer = null;
      this.playing = false;
      this.render();
      this.load(opts.text || "", opts.title || "");
    }

    render() {
      this.host.classList.add("reader");
      this.host.innerHTML = `
        <div class="stage" tabindex="0" aria-label="RSVP 읽기 화면. 스페이스로 재생/정지">
          <div class="guide top"></div>
          <div class="word" aria-live="off"><span class="l"></span><span class="p"></span><span class="r"></span></div>
          <div class="guide bottom"></div>
          <div class="overlay"><span class="big-play">▶</span><span class="overlay-msg"></span></div>
        </div>
        <div class="progress" role="slider" aria-label="진행 위치" tabindex="0"><div class="bar"></div></div>
        <div class="meta"><span class="title"></span><span class="pos"></span></div>
        <div class="controls">
          <div class="transport">
            <button class="btn ghost" data-act="restart" title="처음부터">⏮</button>
            <button class="btn ghost" data-act="prev" title="이전 (←)">◀</button>
            <button class="btn primary play" data-act="toggle" title="재생/정지 (Space)">▶ 재생</button>
            <button class="btn ghost" data-act="next" title="다음 (→)">▶</button>
          </div>
          <label class="ctl">
            <span>속도 <b class="wpm-val"></b><small> 어절/분</small></span>
            <input type="range" class="wpm" min="100" max="1000" step="25">
          </label>
          <div class="ctl">
            <span>묶음</span>
            <div class="seg" role="radiogroup" aria-label="한 번에 보여줄 어절 수">
              <button data-size="1">1</button><button data-size="2">2</button><button data-size="3">3</button>
            </div>
          </div>
          <label class="ctl check"><input type="checkbox" class="ctx"> 문맥 보기</label>
        </div>
        <p class="context"></p>`;

      const $ = s => this.host.querySelector(s);
      this.el = {
        stage: $(".stage"), l: $(".l"), p: $(".p"), r: $(".r"), overlay: $(".overlay"),
        overlayMsg: $(".overlay-msg"), bar: $(".bar"), progress: $(".progress"),
        title: $(".title"), pos: $(".pos"), play: $(".play"), wpm: $(".wpm"),
        wpmVal: $(".wpm-val"), ctx: $(".ctx"), context: $(".context"), seg: $(".seg")
      };

      this.el.wpm.value = this.wpm;
      this.el.ctx.checked = this.showContext;
      this.syncControls();

      this.host.addEventListener("click", e => {
        const b = e.target.closest("[data-act]");
        if (b) { this.claim(); this[b.dataset.act](); }
        const s = e.target.closest("[data-size]");
        if (s) { this.claim(); this.setSize(+s.dataset.size); }
      });
      this.el.stage.addEventListener("click", () => { this.claim(); this.toggle(); });
      this.el.stage.addEventListener("focus", () => this.claim());
      this.el.wpm.addEventListener("input", () => { this.claim(); this.setWpm(+this.el.wpm.value); });
      this.el.ctx.addEventListener("change", () => {
        this.showContext = this.el.ctx.checked; store.set(this.key + ".ctx", this.showContext); this.show();
      });
      const seek = e => {
        const r = this.el.progress.getBoundingClientRect();
        const x = (e.touches ? e.touches[0].clientX : e.clientX) - r.left;
        this.claim();
        this.goto(Math.round(Math.max(0, Math.min(1, x / r.width)) * (this.chunks.length - 1)));
      };
      this.el.progress.addEventListener("click", seek);
    }

    claim() { activeReader = this; }

    syncControls() {
      this.el.wpmVal.textContent = this.wpm;
      this.el.seg.querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", +b.dataset.size === this.size));
    }

    load(text, title) {
      this.pause();
      this.text = text;
      this.tokens = tokenize(text);
      this.chunks = chunkify(this.tokens, this.size);
      this.idx = 0;
      this.el.title.textContent = title || "";
      this.done = false;
      this.show();
      this.overlay(true, this.chunks.length ? "눌러서 시작" : "읽을 글이 없어요");
    }

    setSize(n) {
      // keep roughly the same position in the text
      const wordPos = this.chunks.slice(0, this.idx).reduce((a, c) => a + c.words.length, 0);
      this.size = n; store.set(this.key + ".size", n);
      this.chunks = chunkify(this.tokens, n);
      let acc = 0, i = 0;
      while (i < this.chunks.length - 1 && acc + this.chunks[i].words.length <= wordPos) acc += this.chunks[i++].words.length;
      this.idx = i;
      this.syncControls();
      this.show();
    }

    setWpm(v) {
      this.wpm = Math.max(100, Math.min(1000, v));
      this.el.wpm.value = this.wpm;
      store.set(this.key + ".wpm", this.wpm);
      this.syncControls();
      this.show();
    }

    show() {
      const c = this.chunks[this.idx];
      if (!c) { this.el.l.textContent = this.el.p.textContent = this.el.r.textContent = ""; this.updateMeta(); return; }
      const s = c.words.join(" ");
      const chars = Array.from(s);
      const i = c.words.length > 1 ? this.chunkPivot(c.words) : orpIndex(s);
      this.el.l.textContent = chars.slice(0, i).join("");
      this.el.p.textContent = chars[i] || "";
      this.el.r.textContent = chars.slice(i + 1).join("");
      this.updateMeta();
    }

    // pivot for a multi-word chunk: the ORP of the word nearest the middle
    chunkPivot(words) {
      const mid = Math.floor((words.length - 1) / 2);
      let offset = 0;
      for (let k = 0; k < mid; k++) offset += Array.from(words[k]).length + 1;
      return offset + orpIndex(words[mid]);
    }

    updateMeta() {
      const n = this.chunks.length;
      const pct = n > 1 ? this.idx / (n - 1) : 0;
      this.el.bar.style.width = (pct * 100) + "%";
      this.el.progress.setAttribute("aria-valuenow", Math.round(pct * 100));
      const remain = this.chunks.slice(this.idx).reduce((a, c) => a + delayFor(c, this.wpm), 0) / 1000;
      const words = this.tokens.filter(t => t !== PARA).length;
      this.el.pos.textContent = n ? `${this.idx + 1} / ${n} · ${words}어절 · 남은 시간 약 ${remain < 60 ? Math.ceil(remain) + "초" : Math.ceil(remain / 60) + "분"}` : "";
      if (this.showContext && n) {
        const from = Math.max(0, this.idx - 6), to = Math.min(n, this.idx + 7);
        const esc = s => s.replace(/[&<>]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[ch]));
        const html = [];
        for (let k = from; k < to; k++) {
          const t = esc(this.chunks[k].words.join(" "));
          html.push(k === this.idx ? `<mark>${t}</mark>` : t);
        }
        this.el.context.innerHTML = (from > 0 ? "… " : "") + html.join(" ") + (to < n ? " …" : "");
        this.el.context.hidden = false;
      } else {
        this.el.context.hidden = true;
      }
    }

    overlay(on, msg) {
      this.el.overlay.classList.toggle("on", on);
      if (msg !== undefined) this.el.overlayMsg.textContent = msg;
    }

    tick() {
      this.show();
      const c = this.chunks[this.idx];
      this.timer = setTimeout(() => {
        if (this.idx >= this.chunks.length - 1) {
          this.pause(); this.done = true; this.overlay(true, "끝! 다시 보려면 누르세요");
          return;
        }
        this.idx++;
        this.tick();
      }, delayFor(c, this.wpm));
    }

    play() {
      if (!this.chunks.length || this.playing) return;
      if (this.done) { this.idx = 0; this.done = false; }
      this.playing = true;
      this.overlay(false);
      this.el.play.textContent = "❚❚ 정지";
      this.host.classList.add("playing");
      // short lead-in so the eye can settle on the red letter
      this.el.l.textContent = this.el.r.textContent = ""; this.el.p.textContent = "•";
      this.timer = setTimeout(() => this.tick(), 450);
    }

    pause() {
      clearTimeout(this.timer);
      if (!this.playing) return;
      this.playing = false;
      this.el.play.textContent = "▶ 재생";
      this.host.classList.remove("playing");
      this.show();
      this.overlay(true, "일시정지");
    }

    toggle() { this.playing ? this.pause() : this.play(); }
    restart() { this.pause(); this.done = false; this.goto(0); }
    goto(i) {
      const wasPlaying = this.playing;
      clearTimeout(this.timer);
      this.idx = Math.max(0, Math.min(this.chunks.length - 1, i));
      this.done = false;
      if (wasPlaying) this.tick(); else this.show();
    }
    prev() { this.goto(this.idx - 1); }
    next() { this.goto(this.idx + 1); }
  }

  // ---------- keyboard ----------
  document.addEventListener("keydown", e => {
    if (!activeReader) return;
    const tag = (e.target.tagName || "").toLowerCase();
    if (tag === "textarea" || (tag === "input" && e.target.type !== "range" && e.target.type !== "checkbox")) return;
    const r = activeReader;
    switch (e.key) {
      case " ": e.preventDefault(); r.toggle(); break;
      case "ArrowLeft": e.preventDefault(); r.prev(); break;
      case "ArrowRight": e.preventDefault(); r.next(); break;
      case "ArrowUp": e.preventDefault(); r.setWpm(r.wpm + 25); break;
      case "ArrowDown": e.preventDefault(); r.setWpm(r.wpm - 25); break;
    }
  });

  // pause everything when the tab is hidden
  document.addEventListener("visibilitychange", () => { if (document.hidden) readers.forEach(r => r.pause()); });

  // ---------- wire up the page ----------
  const introText = document.getElementById("intro-text").textContent;
  const intro = new Reader(document.getElementById("intro-reader"), { key: "intro", text: introText, title: "자기소개", wpm: 250 });
  activeReader = intro;

  const samples = window.RSVP_SAMPLES || [];
  const practice = new Reader(document.getElementById("practice-reader"), {
    key: "practice", text: samples[0] ? samples[0].text : "", title: samples[0] ? samples[0].title : "", wpm: 250
  });
  const readers = [intro, practice];
  // only one reader plays at a time
  readers.forEach(r => {
    const orig = r.play.bind(r);
    r.play = () => { readers.forEach(o => o !== r && o.pause()); orig(); };
  });

  const sampleBox = document.getElementById("samples");
  const selectSample = (btn) => {
    sampleBox.querySelectorAll("button").forEach(b => b.setAttribute("aria-selected", b === btn));
  };
  samples.forEach((s, i) => {
    const b = document.createElement("button");
    b.className = "chip";
    b.type = "button";
    b.setAttribute("role", "tab");
    b.textContent = s.title;
    b.addEventListener("click", () => {
      selectSample(b);
      practice.load(s.text, s.title);
      practice.claim();
    });
    if (i === 0) b.setAttribute("aria-selected", "true");
    sampleBox.appendChild(b);
  });

  const ta = document.getElementById("custom-text");
  const stats = document.getElementById("text-stats");
  ta.value = store.get("custom", "");
  const updateStats = () => {
    const n = tokenize(ta.value).filter(t => t !== PARA).length;
    stats.textContent = n ? `${n}어절 · ${practice.wpm}어절/분이면 약 ${Math.max(1, Math.round(n / practice.wpm * 60))}초` : "";
  };
  ta.addEventListener("input", () => { store.set("custom", ta.value); updateStats(); });
  updateStats();
  document.getElementById("load-custom").addEventListener("click", () => {
    if (!ta.value.trim()) { ta.focus(); return; }
    selectSample(null);
    practice.load(ta.value, "내 글");
    practice.claim();
    document.getElementById("practice-reader").scrollIntoView({ behavior: "smooth", block: "center" });
    practice.play();
  });
})();
