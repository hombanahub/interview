// Azure Functions (Node v4 model). Put in src/functions/backend.js and deploy.
// Environment variables (Function App > Settings > Environment variables):
//   AOAI_ENDPOINT, AOAI_KEY, AOAI_DEPLOYMENT   Azure OpenAI
//   LIC_SECRET     long random string used to sign licence tokens
//   ADMIN_KEY      long random string only you know (used to issue tokens)
//   NTFY_URL       e.g. https://ntfy.sh/your-private-topic  (install the ntfy app on your phone and subscribe)
// CORS: add the origin of the hosted page (and http://localhost:8080 for local tests).
const { app } = require("@azure/functions");
const crypto = require("crypto");

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const sign = (p) => crypto.createHmac("sha256", process.env.LIC_SECRET).update(p).digest("base64url");

function check(tok) {
  try {
    const [p, s] = String(tok || "").split(".");
    const a = Buffer.from(sign(p)), b = Buffer.from(s || "");
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { valid: false, reason: "bad signature" };
    const o = JSON.parse(Buffer.from(p, "base64url").toString());
    return { valid: true, ...o, expired: Date.now() > o.exp };
  } catch { return { valid: false, reason: "malformed token" }; }
}

async function notify(msg) {
  if (!process.env.NTFY_URL) return;
  try { await fetch(process.env.NTFY_URL, { method: "POST", body: msg, headers: { Title: "Interview app" } }); } catch {}
}

// You issue tokens after a researcher pays: /api/licence-issue?key=ADMIN_KEY&days=5&ref=Dr%20Smith
app.http("licence-issue", {
  methods: ["GET", "POST"], authLevel: "anonymous",
  handler: async (req) => {
    const q = req.query;
    if (q.get("key") !== process.env.ADMIN_KEY) return { status: 401, jsonBody: { error: "unauthorised" } };
    const days = Math.max(1, Math.min(365, parseInt(q.get("days") || "1", 10)));
    const payload = b64({ id: crypto.randomUUID().slice(0, 8), ref: q.get("ref") || "", days, exp: Date.now() + days * 864e5, price: days * 2.5 });
    await notify(`Licence issued: ${days} day(s), US$${(days * 2.5).toFixed(2)}, ref ${q.get("ref") || "-"}`);
    return { jsonBody: { token: payload + "." + sign(payload), days, usd: days * 2.5 } };
  },
});

app.http("licence-verify", {
  methods: ["POST"], authLevel: "anonymous",
  handler: async (req) => {
    const { token } = await req.json();
    const r = check(token);
    return { jsonBody: r.valid ? { valid: true, id: r.id, exp: r.exp, days: r.days, expired: r.expired } : r };
  },
});

// Usage notifications: the page sends {event, licence, ts}. No response text is ever sent here.
app.http("ping", {
  methods: ["POST"], authLevel: "anonymous",
  handler: async (req) => {
    const e = await req.json().catch(() => ({}));
    await notify(`${e.event || "event"} | licence ${e.licence || "free"} | ${e.page || ""}`);
    return { jsonBody: { ok: true } };
  },
});

// AI proxy: only paid, unexpired tokens may use it, so the Azure OpenAI bill is protected.
app.http("code", {
  methods: ["POST"], authLevel: "anonymous",
  handler: async (req) => {
    const { prompt, token } = await req.json();
    const r = check(token);
    if (!r.valid || r.expired) return { status: 402, jsonBody: { error: "A valid paid licence token is required." } };
    const url = `${process.env.AOAI_ENDPOINT}/openai/deployments/${process.env.AOAI_DEPLOYMENT}/chat/completions?api-version=2024-06-01`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "api-key": process.env.AOAI_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: prompt }] }),
    });
    const j = await res.json();
    return { jsonBody: { text: j.choices?.[0]?.message?.content ?? "" } };
  },
});
