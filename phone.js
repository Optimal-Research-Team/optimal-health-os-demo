/* Optimal Health OS demo phone — the SMS coach, in your browser.
   Three brains, one thread:
   1. grounded  — the product's deterministic engine over sample data (default)
   2. webllm    — a real LLM running locally via WebGPU (no server, no key)
   3. claude    — bring-your-own Anthropic key (stored in localStorage only)
   All answers ground in demo-data.json; marker charts attach like MMS. */
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  // Deep link: …/#/trends/ferritin opens the app pane there (sanitized).
  const hash = location.hash.replace(/^#\//, "");
  if (/^[a-z0-9_\/-]+$/.test(hash) && hash) {
    const f = document.getElementById("app-frame");
    if (f) f.src = `./app/${hash}${hash.endsWith("/") ? "" : "/"}`;
  }
  document.querySelectorAll(".tabs button").forEach((b) =>
    b.addEventListener("click", () => {
      document.querySelectorAll(".tabs button").forEach((x) => x.classList.remove("sel"));
      b.classList.add("sel");
      document.querySelector(".split").dataset.tab = b.dataset.tab;
    }),
  );
  const thread = $("#ph-thread");
  const input = $("#ph-input");
  const form = $("#ph-form");
  const chipsRow = $("#ph-chips");
  let DATA = null;
  let mode = localStorage.getItem("oh-demo-mode") || "grounded";
  let engine = null; // webllm handle
  let history = []; // {role, content} for LLM modes

  const fmt = (n) => (Math.abs(n) >= 100 ? Math.round(n).toString() : (+n.toFixed(2)).toString());
  const now = () => new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  // ── Thread rendering ─────────────────────────────────────
  function bubble(role, text, cardEl) {
    const wrap = document.createElement("div");
    wrap.className = `ph-msg ${role}`;
    if (text) {
      const b = document.createElement("div");
      b.className = "ph-bub";
      b.textContent = text;
      wrap.appendChild(b);
    }
    if (cardEl) wrap.appendChild(cardEl);
    thread.appendChild(wrap);
    thread.scrollTop = thread.scrollHeight;
    return wrap;
  }
  function typing(on) {
    let t = $("#ph-typing");
    if (on && !t) {
      t = document.createElement("div");
      t.id = "ph-typing";
      t.className = "ph-msg in";
      t.innerHTML = '<div class="ph-bub ph-dots"><i></i><i></i><i></i></div>';
      thread.appendChild(t);
      thread.scrollTop = thread.scrollHeight;
    } else if (!on && t) t.remove();
  }
  function sysNote(text) {
    const n = document.createElement("div");
    n.className = "ph-note";
    n.textContent = text;
    thread.appendChild(n);
    thread.scrollTop = thread.scrollHeight;
  }

  // ── MMS-style cards (inline SVG, brand palette) ──────────
  const TONE = { "t-opt": "#2f9e57", "t-in": "#4e9b3f", "t-brd": "#b67a1e", "t-out": "#c0472f" };
  function trendCard(m) {
    const pts = m.points;
    if (!pts || pts.length < 2) return null;
    const w = 240, h = 84, pad = 8;
    const vals = pts.map((p) => p.value);
    const min = Math.min(...vals, m.target ?? Infinity);
    const max = Math.max(...vals, m.target ?? -Infinity);
    const span = max - min || 1;
    const x = (i) => (i / (pts.length - 1)) * w;
    const y = (v) => h - pad - ((v - min) / span) * (h - pad * 2);
    const line = vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
    const color = TONE[m.toneClass] || "#4e9b3f";
    const bandLo = m.optimalLow !== null ? Math.max(m.optimalLow, min) : null;
    const bandHi = m.optimalHigh !== null ? Math.min(m.optimalHigh, max) : null;
    const band = bandLo !== null && bandHi !== null && bandHi > bandLo
      ? `<rect x="0" y="${y(bandHi)}" width="${w}" height="${Math.max(2, y(bandLo) - y(bandHi))}" fill="rgba(78,155,63,.12)"/>` : "";
    const target = m.target != null
      ? `<line x1="0" x2="${w}" y1="${y(m.target)}" y2="${y(m.target)}" stroke="rgba(23,37,26,.3)" stroke-dasharray="3 5"/>` : "";
    const last = vals[vals.length - 1];
    const card = document.createElement("div");
    card.className = "ph-card";
    card.innerHTML = `
      <div class="ph-card-h"><b>${m.name}</b><span class="ph-pill" style="color:${color};background:${color}22">${m.label}</span></div>
      <div class="ph-card-v">${fmt(last)} <i>${m.unit}</i></div>
      <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${band}${target}
        <polyline points="${line}" fill="none" stroke="${color}" stroke-width="2"/>
        <circle cx="${w}" cy="${y(last)}" r="3.5" fill="${color}"/></svg>
      <div class="ph-card-f"><span>${pts[0].date}</span><span>${pts[pts.length - 1].date}</span></div>`;
    return card;
  }
  function scoreCard() {
    const s = DATA.scoreViz;
    if (!s) return null;
    const m = {
      name: "Health score", unit: "/100", label: `${s.current}`, toneClass: "t-opt",
      optimalLow: null, optimalHigh: null, target: null,
      points: s.points.map((p) => ({ date: p.date, value: p.score })),
    };
    const c = trendCard(m);
    if (c) c.querySelector(".ph-card-v").innerHTML = `${s.current} <i>/100 · ${s.deltaText}</i>`;
    return c;
  }

  // ── Grounded brain (mirrors the product's demo mode) ─────
  function findMarker(q) {
    const lower = ` ${q.toLowerCase()} `;
    let best = null;
    for (const m of DATA.markers) {
      const names = new Set([
        m.name.toLowerCase(), m.name.toLowerCase().replace(/\s*\(.*\)$/, ""),
        m.name.toLowerCase().split(",")[0].trim(), m.slug.replace(/_/g, " "),
      ]);
      for (const n of names) {
        if (n.length < 3) continue;
        if (lower.includes(` ${n} `) || lower.includes(` ${n}?`) || lower.includes(` ${n}.`) || lower.includes(` ${n},`)) {
          if (!best || n.length > best.len) best = { m, len: n.length };
        }
      }
    }
    return best?.m ?? null;
  }
  function markerAnswer(m) {
    const first = m.points[0], last = m.points[m.points.length - 1];
    const dir = last.value > first.value ? "up" : last.value < first.value ? "down" : "flat";
    return `${m.name} is ${fmt(last.value)} ${m.unit} (${m.label.toLowerCase()}) as of ${last.date} — ${dir} from ${fmt(first.value)} on ${first.date}. Optimal ${m.optimalLow ?? "—"}–${m.optimalHigh ?? "—"} ${m.unit}.`;
  }
  function grounded(q) {
    const lower = q.trim().toLowerCase().replace(/^\//, "");
    if (["help", "?"].includes(lower)) {
      return { text: "Text me:\nTODAY — morning brief vs your baseline\nSUMMARY — latest panel\nCOMPARE — this draw vs last\nSCORE — health score trend\nMEDS — current medications\n…or a marker name (APOB, FERRITIN, HDL) for its trend card. Plain questions work too." };
    }
    if (["today", "brief"].includes(lower)) {
      const b = DATA.brief;
      return b ? { text: `${b.tone === "push" ? "🟢" : b.tone === "easy" ? "🟠" : "🌿"} ${b.headline}\n${b.detail}` } : { text: "No fresh wearable data for a brief." };
    }
    const namedMarker = findMarker(q);
    if (namedMarker && !/^(summary|panel|compare|score|meds|today|brief|help)$/.test(lower)) {
      return { text: markerAnswer(namedMarker), card: trendCard(namedMarker) };
    }
    if (
      lower === "summary" || lower === "panel" ||
      /\blatest\b.*\b(labs?|tests?|results?|panel|bloodwork)\b|\b(labs?|tests?|results?|bloodwork)\b.*\blatest\b|\bmy (labs|lab tests|results|bloodwork)\b/.test(lower)
    ) return { text: DATA.panelSms ?? "No panels on file." };
    if (lower === "compare" || /\bchanged\b|\bsince (my )?last (draw|panel|test|labs|bloodwork)\b/.test(lower)) {
      const c = DATA.compareViz;
      return c ? { text: `${c.toDate} vs ${c.fromDate}:\n✅ ${c.improved} improved · ⚠️ ${c.worsened} worsened · ${c.steady} steady\nBiggest movers: ${c.movers.map((v) => `${v.name} ${fmt(v.from)}→${fmt(v.to)} ${v.unit}`).join(", ")}` } : { text: "Need two panels to compare." };
    }
    if (lower === "score" || /\bhealth score\b|\bmy score\b|\bhow am i doing\b/.test(lower)) {
      const s = DATA.scoreViz;
      return s ? { text: `Health score ${s.current}/100 (${s.deltaText}) — the share of your panel in the optimal band.`, card: scoreCard() } : { text: "Not enough draws yet." };
    }
    if (lower === "meds" || /\bmedication|\bsupplement/.test(lower)) {
      return { text: DATA.meds.length ? `Active (from your records):\n${DATA.meds.map((m) => `• ${m.label}${m.detail ? ` — ${m.detail}` : ""}`).join("\n")}` : "No active medications on file." };
    }
    if (/\bissues?\b|\btracking\b/.test(lower)) {
      return { text: `Tracking ${DATA.issues.length} issues:\n${DATA.issues.map((i) => `• ${i.title} (${i.status})`).join("\n")}` };
    }
    const m = findMarker(q);
    if (m) return { text: markerAnswer(m), card: trendCard(m) };
    return {
      text: "I ground every answer in the sample data — try a marker name (ferritin, ApoB, HDL…), TODAY, SUMMARY, COMPARE, SCORE, or MEDS. For free-form conversation, tap ✨ and enable an AI model.",
    };
  }

  // ── LLM tiers ────────────────────────────────────────────
  const SYSTEM = () =>
    `You are Optimal — a warm, concise health-data coach texting with a user. This is a PUBLIC DEMO with FABRICATED sample data for a fictional person. Ground every number in the data below; never invent values. Keep replies SMS-short (2-4 sentences). You describe trends and suggest doctor questions; you never diagnose or prescribe.\n\n${DATA.digest}`;

  async function askClaude(q) {
    const key = localStorage.getItem("oh-demo-key");
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 400,
        system: SYSTEM(),
        messages: (() => {
          const h = [...history, { role: "user", content: q }].slice(-12);
          while (h.length && h[0].role !== "user") h.shift();
          return h;
        })(),
      }),
    });
    if (!res.ok) throw new Error(`Claude API ${res.status} — check the key in ✨ settings`);
    const data = await res.json();
    return data.content?.find((b) => b.type === "text")?.text ?? "(no reply)";
  }

  async function askWebLLM(q) {
    if (!engine) throw new Error("Model not loaded yet — tap ✨ to load it.");
    const out = await engine.chat.completions.create({
      messages: [{ role: "system", content: SYSTEM() }, ...history.slice(-10), { role: "user", content: q }],
      max_tokens: 300,
      temperature: 0.4,
    });
    return out.choices?.[0]?.message?.content ?? "(no reply)";
  }

  async function loadWebLLM(statusEl) {
    const { CreateMLCEngine } = await import("https://esm.run/@mlc-ai/web-llm@0.2.79");
    engine = await CreateMLCEngine("Llama-3.2-1B-Instruct-q4f16_1-MLC", {
      initProgressCallback: (p) => { statusEl.textContent = `Loading model… ${Math.round((p.progress ?? 0) * 100)}%`; },
    });
    statusEl.textContent = "Model ready — this phone now runs a real LLM locally.";
  }



  // Why each exercise earns its place — tappable education on every diagram.
  const WHY = {
    "Pendulum swings": "Gravity moves the joint so the healing tendon doesn't have to — it keeps the capsule from stiffening while the repair is still fragile. That's why it's the ONLY arm motion in the protection phase.",
    "Wall crawl": "Active-assisted range: the wall carries some load while your shoulder relearns its arc. Height on the wall is a direct, visible measure of flexion — which is why I chart it.",
    "Band external rotation": "The repaired rotator cuff's actual job is rotation control. Light band work in mid-range rebuilds that strength without stressing the fixation — slow eccentrics (the return) matter most.",
    "Cross-body stretch": "Targets the posterior capsule, which tightens fast in a sling. A looser posterior capsule takes pressure off the front of the shoulder when you start lifting again.",
  };
  function adherenceCard() {
    const days = [
      ["W", "done"], ["T", "done"], ["F", "miss"], ["S", "done"], ["S", "done"], ["M", "done"], ["T", "today"],
    ];
    const card = document.createElement("div");
    card.className = "ph-card";
    card.innerHTML = `
      <div class="ph-card-h"><b>Rehab adherence — this week</b><span class="ph-pill" style="color:#2f9e57;background:#2f9e5722">5 OF 6</span></div>
      <div class="ph-week">${days.map(([d, k]) => `<span class="${k}"><i></i>${d}</span>`).join("")}</div>
      <div style="font:11px Inter,sans-serif;color:#6e7768;margin-top:8px;line-height:1.45">One missed day all week — consistency like this is what shows up in your range numbers.</div>`;
    return card;
  }

  // ── Structured follow-up flows ───────────────────────────
  // The product concept: post-procedure check-ins are PROTOCOLS — scheduled,
  // structured, branching on answers, logged to the issue timeline. The demo
  // flow is fully interactive; answers land on a real chart.
  let flow = null; // { script, step, answers, flags, ctx }
  const PAIN_HISTORY = [
    { date: "Day 1", value: 7 },
    { date: "Day 3", value: 4 },
  ];
  const CHECKIN = [
    {
      ask: "Q1 of 4 — pain right now? Reply with a number, 0-10.",
      chips: ["1", "4", "8"],
      parse(a) {
        const n = parseInt(a.match(/\d+/)?.[0] ?? "", 10);
        if (!Number.isFinite(n) || n < 0 || n > 10) return { retry: "Just a number 0–10 (0 = none, 10 = worst)." };
        this.value = n;
        if (n >= 7)
          return { reply: `${n}/10 is higher than expected for day 5. If it stays ≥7 an hour after your next dose, call Dr. Chen's clinic today — (416) 555-0182. I'm logging it either way.`, flag: true };
        if (n >= 4) return { reply: `${n}/10 — manageable, and down from 7 on day 1. Keep the ice-and-elevate routine going.` };
        return { reply: `${n}/10 — right on track for day 5. 📉` };
      },
    },
    {
      ask: "Q2 — any swelling, redness, or warmth around the incision?",
      chips: ["None", "A little", "Red and warm"],
      parse(a) {
        const t = a.toLowerCase();
        const symptom = /\b(red|redness|warm|warmth|hot|pus|oozing|fever)\b/.test(t);
        const negated = /\b(no|not|none|nothing|isn't|isnt|without|clean|fine|normal|looks good)\b/.test(t);
        if (symptom && !negated)
          return { reply: "Redness + warmth can mean infection — that one's not a wait-and-see. Call the clinic now, or after hours go to urgent care. Flagging this at the top of your timeline.", flag: true };
        if (/\b(little|some|mild|slight|bit)\b/.test(t) && !negated)
          return { reply: "A little swelling is normal this week. Keep it elevated when you're sitting." };
        return { reply: "Clean incision — exactly what day 5 should look like." };
      },
    },
    {
      ask: "Q3 — did you get today's pendulum exercises in?",
      chips: ["Done ✓", "Not yet"],
      parse(a) {
        const t = a.toLowerCase();
        const didIt = /\b(done|did|yes|yep|finished|complete)\b/.test(t) && !/\bnot\b/.test(t);
        const skipped = /\b(not yet|haven't|havent|didn't|didnt|skipped|later|tomorrow|forgot)\b/.test(t) || (/\bno\b/.test(t) && !/\bno (problem|issue|trouble)s?\b/.test(t) && !didIt);
        if (skipped) return { reply: "The first two weeks set your range for the year — 5 gentle minutes counts. I'll nudge you at 4pm." };
        return { reply: "Done — adherence is the #1 predictor of how this rehab goes. 💪" };
      },
    },
    {
      ask: "Last one — sleeping okay with the sling?",
      chips: ["Fine", "Rough"],
      parse(a) {
        const t = a.toLowerCase();
        const okay = /\b(fine|good|okay|ok|great|no (problem|issue|trouble)s?)\b/.test(t);
        const rough = /\b(rough|bad|awful|terrible|poorly|barely|couldn't|couldnt|struggl)\b/.test(t);
        if (rough && !okay)
          return { reply: "Try a wedge pillow or a recliner — semi-upright takes the pull off the repair. Most people sleep flat again around week 3." };
        return { reply: "Good — protected sleep is when the repair does its healing." };
      },
    },
  ];
  function painCard(todayPain) {
    const pts = [...PAIN_HISTORY, { date: "Day 5", value: todayPain }];
    const m = {
      name: "Post-op pain", unit: "/10", label: todayPain <= 3 ? "ON TRACK" : todayPain <= 6 ? "WATCH" : "FLAGGED",
      toneClass: todayPain <= 3 ? "t-opt" : todayPain <= 6 ? "t-brd" : "t-out",
      optimalLow: null, optimalHigh: 3, target: null, points: pts,
    };
    const c = trendCard(m);
    if (c) c.querySelector(".ph-card-v").innerHTML = `${todayPain} <i>/10 today · started 7/10</i>`;
    return c;
  }
  function setChips(list) {
    chipsRow.innerHTML = list.map((c) => `<button data-q="${c}">${c}</button>`).join("");
  }
  const DEFAULT_CHIPS = ["Recovery coach ▶", "Post-op check-in ▶", "TODAY", "What's my ferritin trend?", "What changed since my last draw?", "SCORE", "MEDS"];
  function startFlow(script, intro, close) {
    flow = { script, step: 0, answers: [], flags: 0, ctx: {}, close };
    bubble("in", intro);
    typing(true);
    setTimeout(() => {
      typing(false);
      bubble("in", script[0].ask, script[0].card?.());
      setChips(script[0].chips);
    }, 900);
  }
  function closeCheckin(done) {
    const pain = CHECKIN[0].value ?? 4;
    bubble(
      "in",
      `That's everything — logged to your "Rotator cuff repair" timeline:\n• Pain ${pain}/10 (from 7 on day 1)\n• Incision: ${done.answers[1]}\n• Exercises: ${done.answers[2]}\n• Sleep: ${done.answers[3]}${done.flags ? "\n⚠️ " + done.flags + " item(s) flagged for your care team." : "\nNo flags — trajectory looks good."}\nNext check-in: day 8.`,
      painCard(pain),
    );
    setTimeout(() => bubble("in", "And your week at a glance:", adherenceCard()), 900);
  }
  function flowAnswer(q) {
    if (/^stop$|^skip$|^cancel$/i.test(q.trim())) {
      flow = null;
      setChips(DEFAULT_CHIPS);
      bubble("in", "No problem — we'll pick the check-in up tomorrow.");
      return;
    }
    if (flow.step >= flow.script.length) return; // close-out pending — ignore the race
    const step = flow.script[flow.step];
    const res = step.parse(q);
    if (res.retry) { bubble("in", res.retry); return; }
    flow.answers.push(q);
    if (res.flag) flow.flags++;
    bubble("in", res.reply);
    if (res.cards) {
      res.cards.forEach((k, i) => setTimeout(() => bubble("in", null, exCard(k)), 350 + i * 450));
    }

    flow.step++;
    if (flow.step < flow.script.length) {
      typing(true);
      setTimeout(() => {
        typing(false);
        const nxt = flow.script[flow.step];
        bubble("in", nxt.ask, nxt.card?.());
        setChips(nxt.chips);
      }, 1000);
    } else {
      const done = flow;
      setTimeout(() => {
        done.close(done);
        flow = null;
        setChips(DEFAULT_CHIPS);
      }, 1000);
    }
  }


  // ── Exercise diagrams: brand line-art, MMS-card sized ────
  const STICK = { ink: "#3b4733", limb: "#4e9b3f", move: "#b67a1e" };
  function exCard(key) {
    const EX = {
      pendulum: {
        name: "Pendulum swings", dose: "2 min · 3×/day · let gravity do it",
        tip: "Lean on a table, let the arm hang heavy, draw small circles — momentum, not muscle.",
        svg: `<circle cx="70" cy="22" r="8" fill="none" stroke="${STICK.ink}" stroke-width="2.5"/>
          <path d="M70 30 L96 52 L128 56" fill="none" stroke="${STICK.ink}" stroke-width="2.5" stroke-linecap="round"/>
          <path d="M96 52 L96 92" stroke="${STICK.ink}" stroke-width="2.5" stroke-linecap="round"/>
          <path d="M128 44 L128 60 M112 60 L172 60 M118 60 L118 92 M166 60 L166 92" stroke="${STICK.ink}" stroke-width="2" stroke-linecap="round"/>
          <g class="an-swing" style="transform-origin:78px 36px">
            <path d="M78 36 L74 74" stroke="${STICK.limb}" stroke-width="3.5" stroke-linecap="round"/>
            <circle cx="74" cy="76" r="3" fill="${STICK.limb}"/>
          </g>
          <ellipse cx="74" cy="84" rx="14" ry="7" fill="none" stroke="${STICK.move}" stroke-width="2" stroke-dasharray="4 4"/>`,
      },
      wallcrawl: {
        name: "Wall crawl", dose: "3×10 · stop at pull, not pain",
        tip: "Walk the fingers up the wall; a little higher each day is the whole game.",
        svg: `<path d="M150 8 L150 96" stroke="${STICK.ink}" stroke-width="2.5"/>
          <circle cx="86" cy="30" r="8" fill="none" stroke="${STICK.ink}" stroke-width="2.5"/>
          <path d="M86 38 L86 74 M86 74 L76 96 M86 74 L96 96" fill="none" stroke="${STICK.ink}" stroke-width="2.5" stroke-linecap="round"/>
          <g class="an-crawl" style="transform-origin:86px 44px">
            <path d="M86 44 L148 34" stroke="${STICK.limb}" stroke-width="3.5" stroke-linecap="round"/>
            <path d="M144 30 L148 34 L144 38" fill="none" stroke="${STICK.limb}" stroke-width="2.5" stroke-linecap="round"/>
          </g>
          <path d="M156 34 L156 14" stroke="${STICK.move}" stroke-width="2" stroke-dasharray="4 4" stroke-linecap="round"/>
          <path d="M152 18 L156 12 L160 18" fill="none" stroke="${STICK.move}" stroke-width="2" stroke-linecap="round"/>`,
      },
      bandrot: {
        name: "Band external rotation", dose: "3×12 · elbow glued to your side",
        tip: "Elbow pinned at 90°, rotate the forearm out against the band. Slow out, slower back.",
        svg: `<circle cx="66" cy="24" r="8" fill="none" stroke="${STICK.ink}" stroke-width="2.5"/>
          <path d="M66 32 L66 78 M66 78 L56 96 M66 78 L76 96" fill="none" stroke="${STICK.ink}" stroke-width="2.5" stroke-linecap="round"/>
          <path d="M66 44 L84 56" stroke="${STICK.limb}" stroke-width="3.5" stroke-linecap="round"/>
          <g class="an-rot" style="transform-origin:84px 56px">
            <path d="M84 56 L122 48" stroke="${STICK.limb}" stroke-width="3.5" stroke-linecap="round"/>
            <path d="M122 48 C138 44 148 40 156 30" fill="none" stroke="${STICK.ink}" stroke-width="2" stroke-dasharray="2 3"/>
          </g>
          <ellipse cx="156" cy="24" rx="5" ry="8" fill="none" stroke="${STICK.ink}" stroke-width="2"/>
          <path d="M112 62 A26 26 0 0 0 116 36" fill="none" stroke="${STICK.move}" stroke-width="2" stroke-dasharray="4 4"/>
          <path d="M112 40 L117 34 L121 41" fill="none" stroke="${STICK.move}" stroke-width="2" stroke-linecap="round"/>`,
      },
      crossbody: {
        name: "Cross-body stretch", dose: "4×20s · gentle pull, no bounce",
        tip: "Bring the arm across the chest with the other hand; a stretch, never a strain.",
        svg: `<circle cx="96" cy="22" r="8" fill="none" stroke="${STICK.ink}" stroke-width="2.5"/>
          <path d="M96 30 L96 76 M96 76 L86 96 M96 76 L106 96" fill="none" stroke="${STICK.ink}" stroke-width="2.5" stroke-linecap="round"/>
          <g class="an-pull">
            <path d="M96 40 L132 52" stroke="${STICK.limb}" stroke-width="3.5" stroke-linecap="round"/>
            <path d="M132 52 L64 58" stroke="${STICK.limb}" stroke-width="3.5" stroke-linecap="round"/>
          </g>
          <path d="M96 42 L70 52" stroke="${STICK.ink}" stroke-width="2.5" stroke-linecap="round"/>
          <path d="M120 66 A30 22 0 0 1 84 66" fill="none" stroke="${STICK.move}" stroke-width="2" stroke-dasharray="4 4"/>
          <path d="M90 62 L83 67 L90 71" fill="none" stroke="${STICK.move}" stroke-width="2" stroke-linecap="round"/>`,
      },
    };
    const e = EX[key];
    const card = document.createElement("div");
    card.className = "ph-card";
    card.innerHTML = `
      <div class="ph-card-h"><b>${e.name}</b><span class="ph-pill" style="color:#4e9b3f;background:#4e9b3f22" title="Over real SMS this arrives as an MMS PNG card — see ./app/api/exercise-image/${key}.png in this demo">MMS ✓</span></div>
      <svg viewBox="0 0 200 100" style="height:88px;background:#f7f4ec;border-radius:8px">${e.svg}</svg>
      <div style="font:600 10px ui-monospace,monospace;color:#3b4733;margin-top:6px">${e.dose}</div>
      <div style="font:11px Inter,sans-serif;color:#6e7768;margin-top:3px;line-height:1.45">${e.tip}</div>
      <div class="ph-why">TEXT "WHY ${key.toUpperCase()}" FOR THE REASONING</div>`;
    return card;
  }
  function romCard(nowDeg) {
    const m = {
      name: "Shoulder flexion range", unit: "°", label: nowDeg >= 90 ? "AHEAD OF PLAN" : "BUILDING",
      toneClass: nowDeg >= 90 ? "t-opt" : "t-brd", optimalLow: null, optimalHigh: null, target: 170,
      points: [
        { date: "Wk 1", value: 40 },
        { date: "Wk 2", value: 65 },
        { date: "Wk 3", value: nowDeg },
      ],
    };
    const c = trendCard(m);
    if (c) c.querySelector(".ph-card-v").innerHTML = `${nowDeg}° <i>now · surgeon's target 170° by wk 12</i>`;
    return c;
  }

  // ── Recovery coaching: optimal rehab, phase-matched, chart + diagrams ──
  const RECOVERY = [
    {
      ask: "Which week are you in? (this sample scenario assumes rotator cuff repair)",
      chips: ["Week 2", "Week 3", "Week 6"],
      parse(a) {
        const w = parseInt(a.match(/\d+/)?.[0] ?? "3", 10);
        this.week = w;
        const phase =
          w <= 2 ? { reply: "Week " + w + " — protection phase. The job is gentle motion without loading the repair. Two moves, both passive:", cards: ["pendulum", "crossbody"] }
          : w <= 5 ? { reply: "Week " + w + " — active-assisted phase. Time to reclaim range. Your two dailies:", cards: ["wallcrawl", "pendulum"] }
          : { reply: "Week " + w + " — early strengthening. Range work continues, and the band comes out:", cards: ["bandrot", "wallcrawl"] };
        flow.ctx.primary = phase.cards[0];
        return phase;
      },
    },
    {
      ask: "Want to do a set right now? Text DONE when you finish it (or SKIP).",
      chips: ["DONE", "SKIP"],
      parse(a) {
        if (/skip|later|no\b/.test(a.toLowerCase()))
          return { reply: "No pressure — the diagrams stay in this thread whenever you're ready." };
        return { reply: "That's one quality set in the bank — smooth beats fast, and you kept it smooth. Two more today keeps you on protocol. 💪" };
      },
    },
    {
      ask: "Range check — can you raise the arm to shoulder height (90°)?",
      chips: ["Easily", "With effort", "Not yet"],
      parse(a) {
        const t = a.toLowerCase();
        const deg = /easil|yes|easy/.test(t) ? 95 : /effort|almost|nearly/.test(t) ? 85 : 70;
        this.deg = deg;
        if (deg >= 90) return { reply: "95° and climbing — you're ahead of the typical curve. 📈" };
        if (deg >= 85) return { reply: "~85° with effort is exactly where week 3 usually sits. The wall crawl is what moves this number." };
        return { reply: "Under shoulder height for now — normal at this stage, and pushing through pain sets you BACK. Consistency over intensity.", flag: false };
      },
    },
    {
      ask: "Want today's session matched to your recovery score?",
      chips: ["Yes", "Not today"],
      parse(a) {
        if (/not|no\b|later/.test(a.toLowerCase())) return { reply: "Fair — rest is part of the protocol too. I'll offer again tomorrow." };
        const rec = DATA?.brief ? DATA.briefViz?.rows?.find((r) => r.name === "Recovery") : null;
        const recToday = rec ? Math.round(rec.today) : 72;
        const sleep = DATA?.briefViz?.rows?.find((r) => r.name === "Sleep");
        return {
          reply: `Your recovery score today is ${recToday}% (sample WHOOP data) — a normal-load day:\n• 5 min heat + pendulums to warm up\n• Full sets of today's two exercises\n• Ice 10 min after\nAnd the boring multipliers: ${sleep ? sleep.today + "h sleep last night — aim for 8+ while healing" : "protect 8h sleep"}, and ~1.6g/kg protein for tissue repair.`,
        };
      },
    },
  ];
  function closeRecovery(done) {
    const deg = RECOVERY[1].deg ?? 85;
    bubble(
      "in",
      `Session logged to "Rotator cuff repair — rehab":\n• Phase-matched plan delivered\n• Flexion ~${deg}° (target 170° by wk 12)\n• Next milestone: full overhead reach\nI'll check your range again Friday — and if your recovery score dips below 55%, I'll swap that day to stretching only. 🌿`,
      romCard(deg),
    );
  }

  // ── Send pipeline ────────────────────────────────────────
  async function send(text) {
    const q = text.trim();
    if (!q) return;
    bubble("out", q);
    input.value = "";
    const whyM = q.match(/^why\s+(?:the\s+)?([a-z\s-]+?)\??$/i);
    if (whyM) {
      const t = whyM[1].trim().toLowerCase().replace(/[\s-]/g, "");
      const hit = Object.keys(WHY).find((n) => n.toLowerCase().replace(/[\s-]/g, "").includes(t) || t.includes(n.split(" ")[0].toLowerCase()));
      if (hit) {
        setTimeout(() => bubble("in", WHY[hit]), 500);
        return;
      }
    }
    if (/^post-?op/i.test(q) || q === "Post-op check-in ▶") {
      startFlow(CHECKIN, "🏥 Day 5 after your rotator cuff repair (sample scenario) — your scheduled check-in. Four quick questions; answer with a tap or in your own words. Type STOP anytime.", closeCheckin);
      return;
    }
    if (/^recover|^rehab|recovery coach/i.test(q)) {
      startFlow(RECOVERY, "💪 Recovery coaching (sample scenario: shoulder surgery rehab). I'll match the protocol to your phase, your range, and today's recovery score. Type STOP anytime.", closeRecovery);
      return;
    }
    if (flow) { flowAnswer(q); return; }
    typing(true);
    try {
      if (mode === "claude" && localStorage.getItem("oh-demo-key")) {
        const reply = await askClaude(q);
        history.push({ role: "user", content: q }, { role: "assistant", content: reply });
        typing(false);
        const m = findMarker(q);
        bubble("in", reply, m ? trendCard(m) : null);
      } else if (mode === "webllm" && engine) {
        const reply = await askWebLLM(q);
        history.push({ role: "user", content: q }, { role: "assistant", content: reply });
        typing(false);
        const m = findMarker(q);
        bubble("in", reply, m ? trendCard(m) : null);
      } else {
        const a = grounded(q);
        await new Promise((r) => setTimeout(r, 420 + Math.random() * 500));
        typing(false);
        bubble("in", a.text, a.card ?? null);
      }
    } catch (e) {
      typing(false);
      bubble("in", `⚠️ ${e.message || e}`);
    }
  }

  // ── Settings sheet (✨) ──────────────────────────────────
  function openSettings() {
    const sheet = $("#ph-sheet");
    sheet.classList.add("open");
    $("#ph-sheet [data-mode='" + mode + "']")?.classList.add("sel");
  }
  $("#ph-ai").addEventListener("click", openSettings);
  document.getElementById("head-key")?.addEventListener("click", () => {
    document.querySelector('.tabs button[data-tab="phone"]')?.click();
    openSettings();
    document.querySelector("#ph-sheet [data-mode='claude']")?.click();
    setTimeout(() => document.getElementById("ph-key")?.focus(), 350);
  });
  $("#ph-sheet-close").addEventListener("click", () => $("#ph-sheet").classList.remove("open"));
  document.querySelectorAll("#ph-sheet [data-mode]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      document.querySelectorAll("#ph-sheet [data-mode]").forEach((b) => b.classList.remove("sel"));
      btn.classList.add("sel");
      mode = btn.dataset.mode;
      localStorage.setItem("oh-demo-mode", mode);
      const status = $("#ph-sheet-status");
      if (mode === "webllm") {
        status.textContent = "Downloading the model (~700MB, needs WebGPU — desktop Chrome/Edge)…";
        try { await loadWebLLM(status); sysNote("✨ In-browser LLM active"); }
        catch (e) { status.textContent = `WebGPU unavailable: ${e.message}. Using the grounded engine.`; mode = "grounded"; }
      } else if (mode === "claude") {
        $("#ph-key-row").style.display = "flex";
        status.textContent = "Your key stays in this browser's localStorage and calls Anthropic directly.";
      } else {
        status.textContent = "Grounded engine: instant answers computed from the sample data.";
        sysNote("Grounded engine active");
      }
    });
  });
  $("#ph-key-save").addEventListener("click", () => {
    const v = $("#ph-key").value.trim();
    if (v) {
      localStorage.setItem("oh-demo-key", v);
      $("#ph-key").value = "";
      $("#ph-sheet-status").textContent = "Key saved locally. The phone now answers with Claude.";
      sysNote("✨ Claude active (your key, this browser only)");
      $("#ph-sheet").classList.remove("open");
    }
  });

  form.addEventListener("submit", (e) => { e.preventDefault(); send(input.value); });
  chipsRow.addEventListener("click", (e) => {
    const chip = e.target.closest("[data-q]");
    if (chip) send(chip.dataset.q);
  });

  // ── Boot ─────────────────────────────────────────────────
  fetch("./demo-data.json").then((r) => r.json()).then((d) => {
    DATA = d;
    $("#ph-time").textContent = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    if (mode === "claude" && localStorage.getItem("oh-demo-key")) {
      sysNote("✨ Claude mode is still active from a previous visit — your messages go to Anthropic under the saved key. Tap ✨ to change.");
    } else if (mode === "webllm") {
      mode = "grounded"; // the model never persists across loads — don't pretend
      sysNote("Grounded engine active (the in-browser model reloads via ✨).");
    }
    sysNote(`Today ${now()}`);
    bubble("in", "Morning — here's where you stand today. 🌿");
    const b = DATA.brief;
    if (b) bubble("in", `${b.headline}\n${b.detail}`);
    bubble("in", "Ask me anything about this (sample) body — try FERRITIN or \"what changed since my last draw?\". Tap ✨ to switch the brain to a real LLM, or try the structured post-op check-in below. 👇");
    setChips(DEFAULT_CHIPS);
  });
})();
