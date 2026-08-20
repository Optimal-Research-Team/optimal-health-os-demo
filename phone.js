/* Optimal Health OS demo phone — the SMS coach, in your browser.
   Three brains, one thread:
   1. grounded  — the product's deterministic engine over sample data (default)
   2. webllm    — a real LLM running locally via WebGPU (no server, no key)
   3. claude    — bring-your-own Anthropic key (stored in localStorage only)
   All answers ground in demo-data.json; marker charts attach like MMS. */
(() => {
  const $ = (s, el = document) => el.querySelector(s);
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
    if (
      lower === "summary" || lower === "panel" ||
      /\blatest\b.*\b(labs?|tests?|results?|panel|bloodwork)\b|\b(labs?|tests?|results?|bloodwork)\b.*\blatest\b|\bmy (labs|lab tests|results|bloodwork)\b/.test(lower)
    ) return { text: DATA.panelSms ?? "No panels on file." };
    if (lower === "compare" || /\bchanged\b|\bsince (my )?last (draw|panel|test|labs)\b/.test(lower)) {
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
        messages: [...history, { role: "user", content: q }].slice(-12),
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
    const { CreateMLCEngine } = await import("https://esm.run/@mlc-ai/web-llm");
    engine = await CreateMLCEngine("Llama-3.2-1B-Instruct-q4f16_1-MLC", {
      initProgressCallback: (p) => { statusEl.textContent = `Loading model… ${Math.round((p.progress ?? 0) * 100)}%`; },
    });
    statusEl.textContent = "Model ready — this phone now runs a real LLM locally.";
  }


  // ── Structured follow-up flows ───────────────────────────
  // The product concept: post-procedure check-ins are PROTOCOLS — scheduled,
  // structured, branching on answers, logged to the issue timeline. The demo
  // flow is fully interactive; answers land on a real chart.
  let flow = null; // { step, answers }
  const PAIN_HISTORY = [
    { date: "Day 1", value: 7 },
    { date: "Day 3", value: 4 },
  ];
  const FLOW = [
    {
      ask: "Q1 of 4 — pain right now, 0–10?",
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
        if (/red|warm|hot|pus|fever|concern/.test(t))
          return { reply: "Redness + warmth can mean infection — that one's not a wait-and-see. Call the clinic now, or after hours go to urgent care. Flagging this at the top of your timeline.", flag: true };
        if (/little|some|mild|slight/.test(t)) return { reply: "A little swelling is normal this week. Keep it elevated when you're sitting." };
        return { reply: "Clean incision — exactly what day 5 should look like." };
      },
    },
    {
      ask: "Q3 — did you get today's pendulum exercises in?",
      chips: ["Done ✓", "Not yet"],
      parse(a) {
        if (/not|no\b|later|skip/.test(a.toLowerCase()))
          return { reply: "The first two weeks set your range for the year — 5 gentle minutes counts. I'll nudge you at 4pm." };
        return { reply: "Done — adherence is the #1 predictor of how this rehab goes. 💪" };
      },
    },
    {
      ask: "Last one — sleeping okay with the sling?",
      chips: ["Fine", "Rough"],
      parse(a) {
        if (/rough|bad|awful|terrible|no\b/.test(a.toLowerCase()))
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
  const DEFAULT_CHIPS = ["TODAY", "What's my ferritin trend?", "What changed since my last draw?", "SCORE", "MEDS", "Post-op check-in ▶"];
  function startFlow() {
    flow = { step: 0, answers: [], flags: 0 };
    bubble("in", "🏥 Day 5 after your rotator cuff repair (sample scenario) — your scheduled check-in. Four quick questions; answer with a tap or in your own words. Type STOP anytime.");
    setTimeout(() => {
      bubble("in", FLOW[0].ask);
      setChips(FLOW[0].chips);
    }, 700);
  }
  function flowAnswer(q) {
    if (/^stop$|^skip$|^cancel$/i.test(q.trim())) {
      flow = null;
      setChips(DEFAULT_CHIPS);
      bubble("in", "No problem — we'll pick the check-in up tomorrow.");
      return;
    }
    const step = FLOW[flow.step];
    const res = step.parse(q);
    if (res.retry) { bubble("in", res.retry); return; }
    flow.answers.push(q);
    if (res.flag) flow.flags++;
    bubble("in", res.reply);
    flow.step++;
    if (flow.step < FLOW.length) {
      setTimeout(() => { bubble("in", FLOW[flow.step].ask); setChips(FLOW[flow.step].chips); }, 900);
    } else {
      const pain = FLOW[0].value ?? 4;
      setTimeout(() => {
        bubble(
          "in",
          `That's everything — logged to your "Rotator cuff repair" timeline:\n• Pain ${pain}/10 (from 7 on day 1)\n• Incision: ${flow.answers[1]}\n• Exercises: ${flow.answers[2]}\n• Sleep: ${flow.answers[3]}${flow.flags ? "\n⚠️ " + flow.flags + " item(s) flagged for your care team." : "\nNo flags — trajectory looks good."}\nNext check-in: day 8.`,
          painCard(pain),
        );
        flow = null;
        setChips(DEFAULT_CHIPS);
      }, 1000);
    }
  }

  // ── Send pipeline ────────────────────────────────────────
  async function send(text) {
    const q = text.trim();
    if (!q) return;
    bubble("out", q);
    input.value = "";
    if (/^post-?op/i.test(q) || q === "Post-op check-in ▶") { startFlow(); return; }
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
    sysNote(`Today ${now()}`);
    bubble("in", "Morning — here's where you stand today. 🌿");
    const b = DATA.brief;
    if (b) bubble("in", `${b.headline}\n${b.detail}`);
    bubble("in", "Ask me anything about this (sample) body — try FERRITIN or \"what changed since my last draw?\". Tap ✨ to switch the brain to a real LLM, or try the structured post-op check-in below. 👇");
    setChips(DEFAULT_CHIPS);
  });
})();
