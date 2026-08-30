// bedtime-gym-web — stream-of-consciousness CBT-I coach.
// One canonical store (Redis), Claude does the routing/extraction/logging.
const express = require("express");
const fs = require("fs");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");
const { createClient } = require("redis");

const PORT = process.env.PORT || 3000;
const MODEL = process.env.MODEL || "claude-sonnet-5";
// OpenAI-compatible fallback (e.g. xAI Grok) used when Anthropic has no credits.
const FALLBACK_BASE_URL = process.env.FALLBACK_BASE_URL || "";
const FALLBACK_API_KEY = process.env.FALLBACK_API_KEY || "";
const FALLBACK_MODEL = process.env.FALLBACK_MODEL || "grok-4.5";
let anthropicDownUntil = 0; // skip Anthropic for a while after a billing error
const PUBLIC_URL = process.env.PUBLIC_URL || "";
const SHA = (process.env.RENDER_GIT_COMMIT || "dev").slice(0, 7);
const K = { config: "bedtimegym:config", log: "bedtimegym:log" };

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const redis = createClient({ url: process.env.REDIS_URL });
redis.on("error", (e) => console.error("redis:", e.message));

const SYSTEM_BASE =
  fs.readFileSync(path.join(__dirname, "prompt.md"), "utf8") +
  "\n\n---\n\n" +
  fs.readFileSync(path.join(__dirname, "references", "ashley-protocol.md"), "utf8");

const TOOLS = [
  {
    name: "get_state",
    description:
      "Read the canonical store: returns {config, log}. Call before your first reply of a conversation.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "append_log",
    description: "Append one entry object to the sleep log.",
    input_schema: {
      type: "object",
      properties: { entry: { type: "object", description: "The log entry, per the mode's schema." } },
      required: ["entry"],
    },
  },
  {
    name: "update_config",
    description: "Replace the config object (setup and weekly titration only).",
    input_schema: {
      type: "object",
      properties: { config: { type: "object" } },
      required: ["config"],
    },
  },
];

async function getState() {
  const [configRaw, logRaw] = await Promise.all([redis.get(K.config), redis.lRange(K.log, 0, -1)]);
  return {
    config: configRaw ? JSON.parse(configRaw) : null,
    log: logRaw.map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return { raw: l };
      }
    }),
  };
}

async function runTool(name, input) {
  if (name === "get_state") return await getState();
  if (name === "append_log") {
    await redis.rPush(K.log, JSON.stringify(input.entry));
    return { ok: true };
  }
  if (name === "update_config") {
    await redis.set(K.config, JSON.stringify(input.config));
    return { ok: true };
  }
  return { error: "unknown tool " + name };
}

function nowInTz(tz) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hour12: false,
  }).formatToParts(new Date());
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    time: `${p.hour === "24" ? "00" : p.hour}:${p.minute}`,
    weekday: p.weekday,
  };
}

async function runChatAnthropic(system, history) {
  let messages = [...history];
  let reply = "";
  for (let i = 0; i < 8; i++) {
    const resp = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system,
      tools: TOOLS,
      messages,
    });
    const text = resp.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    if (text) reply = text;
    if (resp.stop_reason !== "tool_use") break;
    const results = [];
    for (const block of resp.content) {
      if (block.type !== "tool_use") continue;
      let result;
      try {
        result = await runTool(block.name, block.input);
      } catch (e) {
        result = { error: e.message };
      }
      results.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(result) });
    }
    messages = [...messages, { role: "assistant", content: resp.content }, { role: "user", content: results }];
  }
  return reply;
}

// Same loop against an OpenAI-compatible API (xAI Grok).
async function runChatFallback(system, history) {
  const tools = TOOLS.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
  let messages = [{ role: "system", content: system }, ...history];
  let reply = "";
  for (let i = 0; i < 8; i++) {
    const r = await fetch(`${FALLBACK_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${FALLBACK_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: FALLBACK_MODEL, max_tokens: 1024, messages, tools }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(`fallback ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
    const msg = j.choices[0].message;
    if (msg.content) reply = msg.content;
    if (!msg.tool_calls || !msg.tool_calls.length) break;
    messages.push(msg);
    for (const tc of msg.tool_calls) {
      let result;
      try {
        result = await runTool(tc.function.name, JSON.parse(tc.function.arguments || "{}"));
      } catch (e) {
        result = { error: e.message };
      }
      messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(result) });
    }
  }
  return reply;
}

const app = express.Router();  // mounted at /bedtime by ../server.js
app.use(express.json({ limit: "1mb" }));

app.get("/", (_req, res) => {
  const html = fs
    .readFileSync(path.join(__dirname, "public", "index.html"), "utf8")
    .replace("__SHA__", SHA);
  res.type("html").send(html);
});

// ---- chat ----------------------------------------------------------------
app.post("/api/chat", async (req, res) => {
  try {
    const incoming = (req.body.messages || [])
      .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .slice(-40);
    if (!incoming.length || incoming[incoming.length - 1].role !== "user")
      return res.status(400).json({ error: "last message must be from user" });

    const cfg = (await getState()).config;
    const tz = (cfg && cfg.timezone) || "America/Los_Angeles";
    const now = nowInTz(tz);
    const system =
      SYSTEM_BASE +
      `\n\n---\n\nCurrent moment in Ori's timezone (${tz}): ${now.weekday} ${now.date} ${now.time}.`;

    const history = incoming.map((m) => ({ role: m.role, content: m.content }));
    let reply;
    if (Date.now() < anthropicDownUntil && FALLBACK_API_KEY) {
      reply = await runChatFallback(system, history);
    } else {
      try {
        reply = await runChatAnthropic(system, history);
      } catch (e) {
        const billing = /credit balance|billing/i.test(e.message || "");
        if (billing && FALLBACK_API_KEY) {
          anthropicDownUntil = Date.now() + 10 * 60 * 1000;
          console.warn("anthropic billing error — using fallback for 10 min");
          reply = await runChatFallback(system, history);
        } else throw e;
      }
    }
    res.json({ reply: reply || "…(no reply — try again)" });
  } catch (e) {
    console.error("chat:", e);
    res.status(500).json({ error: e.message });
  }
});

// ---- state read/write (also used by the local /bedtime-gym skill) --------
app.get("/api/state", async (_req, res) => {
  try {
    res.json(await getState());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/log", async (req, res) => {
  try {
    if (!req.body.entry) return res.status(400).json({ error: "entry required" });
    await redis.rPush(K.log, JSON.stringify(req.body.entry));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/config", async (req, res) => {
  try {
    if (!req.body.config) return res.status(400).json({ error: "config required" });
    await redis.set(K.config, JSON.stringify(req.body.config));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// One-time migration: {token, config, log:[entries]} — replaces the log.
app.post("/api/import", async (req, res) => {
  try {
    if (!process.env.IMPORT_TOKEN || req.body.token !== process.env.IMPORT_TOKEN)
      return res.status(403).json({ error: "bad token" });
    if (req.body.config) await redis.set(K.config, JSON.stringify(req.body.config));
    if (Array.isArray(req.body.log)) {
      await redis.del(K.log);
      for (const e of req.body.log) await redis.rPush(K.log, JSON.stringify(e));
    }
    res.json({ ok: true, ...(await getState()) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- tick: called every 15 min by GitHub Actions -------------------------
// Sends the winddown/wake Pushover ping when its window [T, T+20min) is open,
// once per calendar day, and doubles as a keepalive for the free instance.
app.get("/api/tick", async (_req, res) => {
  try {
    const { config } = await getState();
    if (!config) return res.json({ ok: true, note: "no config" });
    const tz = config.timezone || "America/Los_Angeles";
    const now = nowInTz(tz);
    const mins = (t) => {
      const [h, m] = t.split(":").map(Number);
      return h * 60 + m;
    };
    const nowMin = mins(now.time);
    const due = [];
    const checks = [
      {
        mode: "winddown",
        at: config.screens_off,
        title: "🌙 Bedtime Gym — wind-down",
        msg: `Screens off. Lights out at ${config.bedtime}. Dump your stream of consciousness — one tap below.`,
        url_title: "Do the rep",
      },
      {
        mode: "wake",
        at: config.wake_time,
        title: "☀️ Bedtime Gym — I see you! Are you up?",
        msg: "Feet on floor. Never 2 oversleeps in a row. Tell me about last night — one tap below.",
        url_title: "Log last night",
      },
    ];
    for (const c of checks) {
      if (!c.at) continue;
      const diff = nowMin - mins(c.at);
      if (diff < 0 || diff >= 20) continue;
      const dedupe = `bedtimegym:ping:${now.date}:${c.mode}`;
      const fresh = await redis.set(dedupe, "1", { NX: true, EX: 86400 });
      if (!fresh) continue;
      // priority 1 bypasses quiet hours — a default-priority push at 1 AM is
      // exactly what DND exists to silence (this ping failed that way once).
      const body = new URLSearchParams({
        token: process.env.PUSHOVER_TOKEN,
        user: process.env.PUSHOVER_USER,
        title: c.title,
        message: c.msg,
        priority: "1",
        url: PUBLIC_URL,
        url_title: c.url_title,
      });
      const r = await fetch("https://api.pushover.net/1/messages.json", {
        method: "POST",
        body,
      });
      due.push({ mode: c.mode, pushover: r.status });
    }
    res.json({ ok: true, now: now.time, sent: due });
  } catch (e) {
    console.error("tick:", e);
    res.status(500).json({ error: e.message });
  }
});

app.use(express.static(path.join(__dirname, "public")));

// Mounted inside the host service: connect Redis on load, but NEVER exit the
// process on failure - that would take the whole host app down with us.
redis
  .connect()
  .then(() => console.log(`bedtime-gym ${SHA} mounted at /bedtime`))
  .catch((e) => console.error("bedtime redis connect failed:", e.message));

module.exports = app;
