const SITE_ORIGIN = "https://agent.kasimirszekeres.com";
const RATE_LIMIT = 5;
const RATE_TTL_SECONDS = 3600;
const MAX_FROM = 80;
const MAX_MESSAGE = 500;
const MAX_NOTES = 100;
const MAX_BODY_BYTES = 4096;
const STRIPE_TOLERANCE_SECONDS = 300;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = request.method.toUpperCase();

    if (method === "OPTIONS") {
      return handleOptions(request);
    }

    try {
      if (path === "/note" && method === "POST") return await handleNote(request, env);
      if (path === "/notes" && method === "GET") return await handleNotes(request, env);
      if (path === "/stats" && method === "GET") return await handleStats(request, env);
      if (path === "/stripe-webhook" && method === "POST") return await handleStripeWebhook(request, env);
      if (path === "/admin/hide" && method === "GET") return await handleHide(request, url, env);
      if (method !== "GET" && (path === "/notes" || path === "/stats" || path === "/note" || path === "/admin/hide" || path === "/stripe-webhook")) {
        return json(request, 405, { ok: false, error: "Method not allowed." });
      }
      return json(request, 404, { ok: false, error: "Not found." });
    } catch {
      return json(request, 500, { ok: false, error: "The request could not be completed." });
    }
  },
};

function handleOptions(request) {
  const origin = request.headers.get("Origin");
  if (origin !== SITE_ORIGIN) {
    return new Response(null, { status: 403 });
  }
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": SITE_ORIGIN,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
    },
  });
}

function corsHeaders(request) {
  const origin = request.headers.get("Origin");
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  };
  if (origin === SITE_ORIGIN) {
    headers["Access-Control-Allow-Origin"] = SITE_ORIGIN;
    headers.Vary = "Origin";
  }
  return headers;
}

function json(request, status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: corsHeaders(request),
  });
}

async function handleNote(request, env) {
  const limited = await isRateLimited(request, env);
  if (limited) {
    return json(request, 429, {
      ok: false,
      error: "Rate limit reached. Notes may also be left as GitHub issues.",
    });
  }

  const raw = await readBody(request);
  if (raw === null) {
    return json(request, 400, { ok: false, error: "Request body is too large." });
  }

  let data;
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    return json(request, 400, { ok: false, error: "Body is not valid JSON." });
  }

  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return json(request, 400, { ok: false, error: "Body is not a JSON object." });
  }

  if (typeof data.message !== "string") {
    return json(request, 400, { ok: false, error: "message is required, 1 to 500 characters." });
  }
  if (data.from != null && data.from !== "" && typeof data.from !== "string") {
    return json(request, 400, { ok: false, error: "from is optional, maximum 80 characters." });
  }

  const from = sanitize(data.from || "", MAX_FROM);
  const message = sanitize(data.message, MAX_MESSAGE);
  const fromLength = stripHtml(data.from || "").trim().length;
  const messageLength = stripHtml(data.message).trim().length;

  if (!message || messageLength < 1 || messageLength > MAX_MESSAGE) {
    return json(request, 400, { ok: false, error: "message is required, 1 to 500 characters." });
  }
  if (fromLength > MAX_FROM) {
    return json(request, 400, { ok: false, error: "from is optional, maximum 80 characters." });
  }

  const counted = await consumeRateLimit(request, env);
  if (!counted) {
    return json(request, 429, {
      ok: false,
      error: "Rate limit reached. Notes may also be left as GitHub issues.",
    });
  }

  const ts = Date.now();
  const id = crypto.randomUUID();
  const key = `note:${String(ts).padStart(15, "0")}:${id}`;
  const note = {
    id,
    from,
    message,
    ts,
    hidden: false,
  };

  await env.NOTES.put(key, JSON.stringify(note));
  await env.NOTES.put(`id:${id}`, key);
  await bumpStat(env, "note_count", 1);

  return json(request, 200, { ok: true, id });
}

async function handleNotes(request, env) {
  const keys = await listNoteKeys(env);
  keys.reverse();

  const notes = [];
  for (const key of keys) {
    if (notes.length >= MAX_NOTES) break;
    const raw = await env.NOTES.get(key);
    if (!raw) continue;
    let note;
    try {
      note = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!note || note.hidden) continue;
    notes.push({
      id: note.id,
      from: note.from || "",
      message: note.message || "",
      ts: note.ts,
    });
  }

  return json(request, 200, notes);
}

async function handleStats(request, env) {
  const notes = parseInt((await env.STATS.get("note_count")) || "0", 10);
  const cents = parseInt((await env.STATS.get("contribution_total_cents")) || "0", 10);
  const updated = (await env.STATS.get("updated")) || new Date().toISOString();
  return json(request, 200, {
    notes: Number.isFinite(notes) ? notes : 0,
    contributions_eur: (Number.isFinite(cents) ? cents : 0) / 100,
    updated,
  });
}

async function handleHide(request, url, env) {
  const token = bearerToken(request);
  if (!env.ADMIN_TOKEN || !token || !timingSafeEqual(token, env.ADMIN_TOKEN)) {
    return json(request, 401, { ok: false, error: "Unauthorized." });
  }

  const id = (url.searchParams.get("id") || "").trim();
  if (!id) {
    return json(request, 400, { ok: false, error: "id is required." });
  }

  const key = await findNoteKey(env, id);
  if (!key) {
    return json(request, 404, { ok: false, error: "Note not found." });
  }

  const raw = await env.NOTES.get(key);
  if (!raw) {
    return json(request, 404, { ok: false, error: "Note not found." });
  }

  let note;
  try {
    note = JSON.parse(raw);
  } catch {
    return json(request, 500, { ok: false, error: "Stored note is not readable." });
  }

  if (note.hidden === true) {
    return json(request, 200, { ok: true, id, hidden: true });
  }

  note.hidden = true;
  await env.NOTES.put(key, JSON.stringify(note));
  await bumpStat(env, "note_count", -1);
  return json(request, 200, { ok: true, id, hidden: true });
}

async function handleStripeWebhook(request, env) {
  const payload = await request.text();
  const header = request.headers.get("stripe-signature") || "";

  if (!env.STRIPE_WEBHOOK_SECRET) {
    return json(request, 500, { ok: false, error: "Webhook secret is not configured." });
  }

  const valid = await verifyStripeSignature(payload, header, env.STRIPE_WEBHOOK_SECRET);
  if (!valid) {
    return json(request, 400, { ok: false, error: "Invalid signature." });
  }

  let event;
  try {
    event = JSON.parse(payload);
  } catch {
    return json(request, 400, { ok: false, error: "Body is not valid JSON." });
  }

  if (!event || event.type !== "checkout.session.completed") {
    return json(request, 200, { ok: true });
  }

  const eventId = event.id;
  if (!eventId) {
    return json(request, 400, { ok: false, error: "Event id is missing." });
  }

  const processedKey = `processed:${eventId}`;
  const already = await env.STATS.get(processedKey);
  if (already) {
    return json(request, 200, { ok: true });
  }

  // Mark processed before incrementing so a Stripe retry cannot double-count.
  await env.STATS.put(processedKey, "1");

  const amount = event.data && event.data.object ? event.data.object.amount_total : null;
  if (typeof amount === "number" && Number.isFinite(amount) && amount > 0) {
    await bumpStat(env, "contribution_total_cents", Math.round(amount));
  } else {
    await env.STATS.put("updated", new Date().toISOString());
  }

  return json(request, 200, { ok: true });
}

async function readBody(request) {
  const length = Number(request.headers.get("Content-Length") || "0");
  if (length > MAX_BODY_BYTES) return null;
  const buf = await request.arrayBuffer();
  if (buf.byteLength > MAX_BODY_BYTES) return null;
  return new TextDecoder().decode(buf);
}

function sanitize(value, max) {
  const plain = stripHtml(String(value));
  return plain.slice(0, max);
}

function stripHtml(input) {
  let s = String(input);
  let prev;
  do {
    prev = s;
    s = s.replace(/<[^>]*>/g, "");
  } while (s !== prev);
  s = s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#x2F;/gi, "/")
    .replace(/&#(\d+);/g, (_, n) => fromSafeCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => fromSafeCodePoint(parseInt(n, 16)));
  do {
    prev = s;
    s = s.replace(/<[^>]*>/g, "");
  } while (s !== prev);
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
}

function fromSafeCodePoint(code) {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return "";
  if (code < 32 && code !== 9 && code !== 10 && code !== 13) return "";
  return String.fromCodePoint(code);
}

async function clientHash(request) {
  const ip = request.headers.get("CF-Connecting-IP") || "";
  const data = new TextEncoder().encode(ip);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function rateKey(request) {
  return `rl:${await clientHash(request)}`;
}

async function isRateLimited(request, env) {
  const key = await rateKey(request);
  const current = parseInt((await env.NOTES.get(key)) || "0", 10);
  return current >= RATE_LIMIT;
}

async function consumeRateLimit(request, env) {
  const key = await rateKey(request);
  const current = parseInt((await env.NOTES.get(key)) || "0", 10);
  if (current >= RATE_LIMIT) return false;
  await env.NOTES.put(key, String(current + 1), { expirationTtl: RATE_TTL_SECONDS });
  return true;
}

async function bumpStat(env, key, delta) {
  const current = parseInt((await env.STATS.get(key)) || "0", 10);
  const safe = Number.isFinite(current) ? current : 0;
  const next = Math.max(0, safe + delta);
  await env.STATS.put(key, String(next));
  await env.STATS.put("updated", new Date().toISOString());
  return next;
}

async function listNoteKeys(env) {
  const keys = [];
  let cursor;
  while (true) {
    const page = await env.NOTES.list({ prefix: "note:", cursor });
    for (const item of page.keys) keys.push(item.name);
    if (page.list_complete) break;
    cursor = page.cursor;
  }
  return keys;
}

async function findNoteKey(env, id) {
  const indexed = await env.NOTES.get(`id:${id}`);
  if (indexed) return indexed;
  const keys = await listNoteKeys(env);
  const suffix = `:${id}`;
  return keys.find((key) => key.endsWith(suffix)) || null;
}

function bearerToken(request) {
  const header = request.headers.get("Authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function timingSafeEqual(a, b) {
  const left = new TextEncoder().encode(String(a));
  const right = new TextEncoder().encode(String(b));
  if (left.length !== right.length) return false;
  let out = 0;
  for (let i = 0; i < left.length; i++) out |= left[i] ^ right[i];
  return out === 0;
}

async function verifyStripeSignature(payload, header, secret) {
  if (!header || !secret) return false;
  const parsed = parseStripeSignature(header);
  if (!parsed.t || parsed.v1.length === 0) return false;

  const ts = Number(parsed.t);
  if (!Number.isFinite(ts)) return false;
  const age = Math.abs(Math.floor(Date.now() / 1000) - ts);
  if (age > STRIPE_TOLERANCE_SECONDS) return false;

  const signed = `${parsed.t}.${payload}`;
  const expected = await hmacHex(secret, signed);
  return parsed.v1.some((sig) => timingSafeEqual(sig, expected));
}

function parseStripeSignature(header) {
  let t = "";
  const v1 = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t") t = value;
    if (key === "v1") v1.push(value);
  }
  return { t, v1 };
}

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
