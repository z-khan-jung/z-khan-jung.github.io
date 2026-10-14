// RSVP reader: one word (or chunk) at a time, pivot letter (ORP) fixed in place.
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
  const themeBtn = document.getElementById("theme-toggle");
  if (themeBtn) themeBtn.addEventListener("click", () => {
    const isDark = root.getAttribute("data-theme") === "dark" ||
      (!root.getAttribute("data-theme") && matchMedia("(prefers-color-scheme: dark)").matches);
    const next = isDark ? "light" : "dark";
    root.setAttribute("data-theme", next);
    store.set("theme", next);
  });

  // ---------- text → tokens ----------
  const PARA = "\u0000PARA";
  const LINE = "\u0000LINE";
  const HANGUL = /[가-힣]/;
  const END = /[.!?。…]["'”’)]*$/;
  const COMMA = /[,;:、，]["'”’)]*$/;

  // blank line = paragraph, single newline = line break (matters for poems)
  function tokenize(text) {
    const out = [];
    text.replace(/\r/g, "").trim().split(/\n\s*\n/).forEach((para, i) => {
      if (i > 0) out.push(PARA);
      para.split("\n").forEach((line, j) => {
        if (j > 0) out.push(LINE);
        line.split(/\s+/).filter(Boolean).forEach(w => out.push(w));
      });
    });
    return out;
  }
  const wordCount = text => tokenize(text).filter(t => t !== PARA && t !== LINE).length;

  // Group tokens into chunks of `size` words, never crossing a line, paragraph or sentence end.
  function chunkify(tokens, size) {
    const chunks = [];
    let cur = [];
    const flush = () => { if (cur.length) chunks.push({ words: cur }); cur = []; };
    const mark = (k) => { flush(); const last = chunks[chunks.length - 1]; if (last) last[k] = true; };
    tokens.forEach(t => {
      if (t === PARA) return mark("para");
      if (t === LINE) return mark("line");
      cur.push(t);
      if (cur.length >= size || END.test(t)) flush();
    });
    flush();
    return chunks;
  }

  // Optimal Recognition Point: index of the letter to highlight.
  function orpIndex(s) {
    const chars = Array.from(s);
    let start = 0;
    while (start < chars.length - 1 && /[^\p{L}\p{N}]/u.test(chars[start])) start++;
    let end = chars.length;
    while (end > start + 1 && /[^\p{L}\p{N}]/u.test(chars[end - 1])) end--;
    const len = end - start;
    let i;
    if (HANGUL.test(s)) i = Math.floor((len - 1) / 2);   // 한글은 음절이 넓어서 가운데 쪽
    else if (len <= 1) i = 0;
    else if (len <= 5) i = 1;
    else if (len <= 9) i = 2;
    else if (len <= 13) i = 3;
    else i = 4;
    return start + Math.min(i, len - 1);
  }

  function delayFor(chunk, wpm) {
    const base = 60000 / wpm;
    const last = chunk.words[chunk.words.length - 1];
    let ms = base * (chunk.words.length === 1 ? 1 : chunk.words.length * 0.85);
    const longest = Math.max(...chunk.words.map(w => Array.from(w).length));
    if (longest > (HANGUL.test(last) ? 5 : 8)) ms *= 1.15;
    if (END.test(last)) ms *= 1.6;
    else if (COMMA.test(last)) ms *= 1.25;
    if (chunk.para) ms *= 1.4;
    else if (chunk.line) ms *= 1.2;
    return ms;
  }

  const esc = s => s.replace(/[&<>]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[ch]));

  // ---------- Reader component ----------
  const SPEEDS = [250, 300, 400];
  const readers = [];
  let activeReader = null;

  class Reader {
    constructor(host, opts) {
      this.host = host;
      this.key = opts.key;
      this.wpm = 300;                     // always start at the default; not remembered between visits
      this.size = 1;
      this.showContext = store.get(this.key + ".ctx", opts.context !== false);
      this.idx = 0;
      this.timer = null;
      this.playing = false;
      this.onEnd = opts.onEnd || null;
      this.render();
      this.load(opts.text || "", opts.title || "");
      readers.push(this);
      if (!activeReader) activeReader = this;
    }

    render() {
      this.host.classList.add("reader");
      this.host.innerHTML = `
        <div class="titlebar"><span class="tb-x" aria-hidden="true">×</span><span class="title"></span></div>
        <div class="stage" tabindex="0" aria-label="읽기 화면. 탭하면 재생/정지, 좌우로 밀면 이전/다음">
          <div class="guide top"></div>
          <div class="word"><span class="l"></span><span class="p"></span><span class="r"></span></div>
          <div class="guide bottom"></div>
          <div class="overlay"><span class="big-play" aria-hidden="true">▶</span><span class="overlay-msg"></span></div>
          <button class="focus-btn" type="button" data-act="focusToggle" aria-label="전체 화면" title="전체 화면">□</button>
        </div>
        <div class="progress" role="slider" aria-label="진행 위치" tabindex="0"><div class="bar"></div></div>
        <div class="meta"><span class="speed-cell">현재속도 :<b class="wpm-now"></b></span><span class="pos"></span></div>
        <div class="controls">
          <div class="transport">
            <button class="btn ghost" type="button" data-act="restart" aria-label="처음부터">⏮</button>
            <button class="btn ghost" type="button" data-act="prev" aria-label="이전">◀</button>
            <button class="btn primary play" type="button" data-act="toggle">▶ 재생</button>
            <button class="btn ghost" type="button" data-act="next" aria-label="다음">▶</button>
          </div>
          <div class="ctl-row">
            <div class="ctl">
              <span>속도 <small class="wpm-val"></small></span>
              <div class="seg speeds" role="radiogroup" aria-label="읽기 속도">
                <button type="button" data-wpm="250">느리게</button><button type="button" data-wpm="300">보통</button><button type="button" data-wpm="400">빠르게</button>
              </div>
            </div>
            <label class="ctl check"><input type="checkbox" class="ctx"> 문맥 보기</label>
          </div>
        </div>
        <p class="context"></p>`;

      const $ = s => this.host.querySelector(s);
      this.el = {
        stage: $(".stage"), word: $(".word"), l: $(".l"), p: $(".p"), r: $(".r"), overlay: $(".overlay"),
        overlayMsg: $(".overlay-msg"), bar: $(".bar"), progress: $(".progress"),
        title: $(".title"), wpmNow: $(".wpm-now"), pos: $(".pos"), play: $(".play"), speeds: $(".speeds"),
        wpmVal: $(".wpm-val"), ctx: $(".ctx"), context: $(".context")
      };
      this.el.ctx.checked = this.showContext;
      this.syncControls();

      this.host.addEventListener("click", e => {
        const b = e.target.closest("[data-act]");
        const w = e.target.closest("[data-wpm]");
        if (w) { this.claim(); this.setWpm(+w.dataset.wpm); return; }
        if (b) { e.stopPropagation(); this.claim(); this[b.dataset.act](); }
      });

      // tap = play/pause, horizontal swipe = prev/next
      let sx = null, sy = null, swiped = false;
      this.el.stage.addEventListener("touchstart", e => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; swiped = false; }, { passive: true });
      this.el.stage.addEventListener("touchend", e => {
        if (sx === null) return;
        const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
        if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) { swiped = true; this.claim(); dx < 0 ? this.next() : this.prev(); }
        sx = null;
      });
      this.el.stage.addEventListener("click", e => {
        if (e.target.closest("[data-act]")) return;
        if (swiped) { swiped = false; return; }
        this.claim(); this.toggle();
      });
      this.el.stage.addEventListener("focus", () => this.claim());
      this.el.ctx.addEventListener("change", () => {
        this.showContext = this.el.ctx.checked; store.set(this.key + ".ctx", this.showContext); this.updateMeta();
      });
      this.el.progress.addEventListener("click", e => {
        const r = this.el.progress.getBoundingClientRect();
        this.claim();
        this.goto(Math.round(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * (this.chunks.length - 1)));
      });
      window.addEventListener("resize", () => this.fit());
    }

    claim() { activeReader = this; }

    syncControls() {
      this.el.wpmVal.textContent = this.wpm + "어절/분";
      this.el.wpmNow.textContent = this.wpm + "어절";
      this.el.speeds.querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", +b.dataset.wpm === this.wpm));
    }

    load(text, title) {
      this.pause();
      this.tokens = tokenize(text);
      this.chunks = chunkify(this.tokens, this.size);
      this.idx = 0;
      this.done = false;
      this.el.title.textContent = title || "";
      this.show();
      this.overlay(true, this.chunks.length ? "탭해서 시작" : "읽을 글이 없어요");
    }

    setWpm(v) {
      this.wpm = v;
      this.syncControls();
      this.updateMeta();
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
      this.fit();
      this.updateMeta();
    }

    // shrink the font when a long word/chunk would not fit either side of the pivot (narrow phones)
    fit() {
      const w = this.el.word;
      w.style.fontSize = "";
      const half = this.el.stage.clientWidth / 2 - 14 - this.el.p.offsetWidth / 2;
      const need = Math.max(this.el.l.scrollWidth, this.el.r.scrollWidth);
      if (need > half && half > 0) {
        const base = parseFloat(getComputedStyle(w).fontSize);
        w.style.fontSize = Math.max(14, Math.floor(base * half / need)) + "px";
      }
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
      this.el.pos.textContent = n ? `진행 :${this.idx + 1}/${n} · ${remain < 60 ? Math.ceil(remain) + "초" : Math.ceil(remain / 60) + "분"}` : "";
      if (this.showContext && n) {
        const from = Math.max(0, this.idx - 5), to = Math.min(n, this.idx + 6);
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
          this.pause(); this.done = true; this.overlay(true, "끝! 다시 보려면 탭하세요");
          if (this.onEnd) this.onEnd();
          return;
        }
        this.idx++;
        this.tick();
      }, delayFor(c, this.wpm));
    }

    play() {
      if (!this.chunks.length || this.playing) return;
      readers.forEach(o => o !== this && o.pause());
      if (this.done) { this.idx = 0; this.done = false; }
      this.playing = true;
      this.overlay(false);
      this.el.play.textContent = "❚❚ 정지";
      this.host.classList.add("playing");
      // short lead-in so the eye can settle on the red marks
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

    focusToggle(force) {
      const on = typeof force === "boolean" ? force : !this.host.classList.contains("focus");
      this.host.classList.toggle("focus", on);
      document.body.classList.toggle("no-scroll", on);
      this.host.querySelector(".focus-btn").textContent = on ? "✕" : "□";
      this.host.querySelector(".focus-btn").setAttribute("aria-label", on ? "전체 화면 닫기" : "전체 화면");
      requestAnimationFrame(() => this.fit());
    }
  }

  // ---------- keyboard ----------
  document.addEventListener("keydown", e => {
    const r = activeReader;
    if (!r) return;
    const tag = (e.target.tagName || "").toLowerCase();
    if (tag === "textarea" || (tag === "input" && e.target.type !== "range" && e.target.type !== "checkbox")) return;
    if (tag === "button" && (e.key === " " || e.key === "Enter")) return;
    switch (e.key) {
      case " ": e.preventDefault(); r.toggle(); break;
      case "ArrowLeft": e.preventDefault(); r.prev(); break;
      case "ArrowRight": e.preventDefault(); r.next(); break;
      case "ArrowUp": e.preventDefault(); r.setWpm(SPEEDS[Math.min(2, SPEEDS.indexOf(r.wpm) + 1)]); break;
      case "ArrowDown": e.preventDefault(); r.setWpm(SPEEDS[Math.max(0, SPEEDS.indexOf(r.wpm) - 1)]); break;
      case "Escape": r.focusToggle(false); break;
    }
  });

  document.addEventListener("visibilitychange", () => { if (document.hidden) readers.forEach(r => r.pause()); });

  window.RSVP = { Reader, wordCount, store, esc };
})();
