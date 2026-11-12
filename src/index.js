// Bubble Edge Prerender
// Serves pre-rendered HTML snapshots of a Bubble app to crawlers that do not
// run JavaScript (GPTBot, ClaudeBot, PerplexityBot, link previewers). Humans
// always get the normal app. Snapshots are rendered with Cloudflare Browser
// Run, stored in R2 and indexed in D1.

import { classifyBot } from "./bots.js";
import { cleanSnapshot, extractText, extractTitle, parseSitemap, withBaseHref } from "./html.js";

export const VERSION = "1.0.0";
const API_PREFIX = "/__prerender";
const RENDERER_MARK = "BubbleEdgePrerender";
const RENDER_UA = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 ${RENDERER_MARK}/${VERSION}`;
const PREFLIGHT_UA = `Mozilla/5.0 (compatible; ${RENDERER_MARK}/${VERSION}; preflight)`;

const DEFAULT_EXCLUDES = [
  "/api/",
  "/version-",
  "/package/",
  "/static/",
  "/fileupload",
  "/elasticsearch/",
  "/workflow/",
  "/user/",
  "/cdn-cgi/",
  "/reset_pw",
  API_PREFIX,
];
const TRACKING_PARAMS = new Set([
  "gclid", "gbraid", "wbraid", "fbclid", "msclkid", "dclid", "yclid", "twclid", "igshid",
  "mc_cid", "mc_eid", "_hsenc", "_hsmi", "ref", "ref_src", "debug_mode", "_ga", "_gl",
]);

// ---------------------------------------------------------------- utilities

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const num = (v, d) => (v === undefined || v === null || v === "" || !Number.isFinite(Number(v)) ? d : Number(v));
const bool = (v, d) => (v === undefined || v === null || v === "" ? d : /^(1|true|yes|on)$/i.test(String(v).trim()));
const csv = (v) => String(v || "").split(",").map((s) => s.trim()).filter(Boolean);
const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
const monthKey = (ms) => new Date(ms).toISOString().slice(0, 7);
const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const r2Key = async (pathKey) => `snap/${await sha256Hex(pathKey)}.html`;

// ------------------------------------------------------------ configuration

export function loadConfig(env, reqUrl) {
  const originRaw = String(env.ORIGIN_URL || "").trim().replace(/\/+$/, "");
  let origin = null;
  if (originRaw) origin = new URL(originRaw);
  else if (reqUrl) origin = new URL(`${reqUrl.protocol}//${reqUrl.host}`);
  const originBasePath = origin ? origin.pathname.replace(/\/+$/, "") : "";
  const publicHost = reqUrl ? reqUrl.hostname.toLowerCase() : "";
  const originHost = origin ? origin.hostname.toLowerCase() : "";
  const allowedHosts = new Set([publicHost, originHost, ...csv(env.ALLOWED_HOSTS).map((h) => h.toLowerCase())]);
  allowedHosts.delete("");
  const botSet = ["ai", "ai+social", "all"].includes(String(env.BOT_SET || "").trim()) ? String(env.BOT_SET).trim() : "ai+social";
  return {
    originBase: origin ? origin.origin + originBasePath : "",
    originHost,
    originBasePath,
    publicHost,
    publicBase: reqUrl ? `${reqUrl.protocol}//${reqUrl.host}` : "",
    // Standalone: the Worker runs on a different host than the Bubble app.
    standalone: !!(origin && reqUrl && originHost !== publicHost),
    allowedHosts,
    botSet,
    extraBots: csv(env.EXTRA_BOTS).map((t) => t.toLowerCase()),
    excludes: [...DEFAULT_EXCLUDES, ...csv(env.EXCLUDE_PATHS)],
    includes: csv(env.INCLUDE_PATHS),
    ignoreQuery: bool(env.IGNORE_QUERY, false),
    ttlMs: num(env.SNAPSHOT_TTL_HOURS, 168) * 3600_000,
    maxPages: num(env.MAX_PAGES, 50),
    maxRendersPerMonth: num(env.MAX_RENDERS_PER_MONTH, 500),
    renderIntervalMs: num(env.RENDER_INTERVAL_SECONDS, 11) * 1000,
    queueBatch: num(env.QUEUE_BATCH, 3),
    minTextChars: num(env.MIN_TEXT_CHARS, 80),
    waitUntil: ["load", "domcontentloaded", "networkidle0", "networkidle2"].includes(env.WAIT_UNTIL) ? env.WAIT_UNTIL : "networkidle2",
    waitSelector: String(env.WAIT_SELECTOR || "").trim(),
    // Extra time after the network goes quiet, for late list rendering.
    settleMs: Math.min(Math.max(num(env.SETTLE_MS, 500), 0), 20000),
    renderTimeoutMs: num(env.RENDER_TIMEOUT_SECONDS, 30) * 1000,
    // Nothing is blocked by default. Blocking fonts in particular makes Bubble
    // hold back its data rendering for about three seconds.
    blockResources: csv(env.BLOCK_RESOURCES),
    autoQueue: bool(env.AUTO_QUEUE_ON_MISS, true),
    autoRefresh: bool(env.AUTO_REFRESH, true),
    humanMode: String(env.HUMAN_MODE || "redirect").trim() === "proxy" ? "proxy" : "redirect",
    publicPreview: bool(env.PUBLIC_PREVIEW, true),
    retryCooldownMs: num(env.RETRY_COOLDOWN_HOURS, 24) * 3600_000,
  };
}

function normalizePath(pathname) {
  let p = pathname || "/";
  if (!p.startsWith("/")) p = "/" + p;
  p = p.replace(/\/{2,}/g, "/");
  if (p.length > 1) p = p.replace(/\/+$/, "");
  return p || "/";
}

function normalizeQuery(searchParams, cfg) {
  if (cfg.ignoreQuery) return "";
  const pairs = [];
  for (const [k, v] of searchParams) {
    const key = k.toLowerCase();
    if (key.startsWith("utm_") || TRACKING_PARAMS.has(key)) continue;
    pairs.push([k, v]);
  }
  pairs.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1));
  return pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
}

export function isEligiblePath(path, cfg) {
  const lower = path.toLowerCase();
  for (const prefix of cfg.excludes) {
    if (prefix && lower.startsWith(prefix.toLowerCase())) return false;
  }
  const last = lower.slice(lower.lastIndexOf("/") + 1);
  const dot = last.lastIndexOf(".");
  if (dot > 0 && !/\.html?$/.test(last)) return false;
  if (cfg.includes.length && !cfg.includes.some((p) => lower.startsWith(p.toLowerCase()))) return false;
  return true;
}

/**
 * Maps a URL or path given by a caller (or requested by a crawler) to the
 * cache key and the origin URL that will be rendered.
 */
export function resolveTarget(input, cfg) {
  let raw = String(input ?? "").trim();
  if (!raw) throw new HttpError(400, "missing_url", "Provide a page URL or a path such as /pricing.");
  if (!cfg.originBase) throw new HttpError(500, "no_origin", "ORIGIN_URL is not configured.");
  let u;
  try {
    if (raw.startsWith("/")) {
      u = new URL(raw, cfg.originBase.replace(/^(https?:\/\/[^/]+).*$/, "$1"));
    } else {
      if (!/^https?:\/\//i.test(raw)) raw = "https://" + raw;
      u = new URL(raw);
      if (!cfg.allowedHosts.has(u.hostname.toLowerCase())) {
        throw new HttpError(400, "host_not_allowed", `The host ${u.hostname} is not served by this Worker.`);
      }
    }
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, "invalid_url", "That is not a valid URL or path.");
  }
  let path = u.pathname;
  const base = cfg.originBasePath;
  if (base && (path === base || path.startsWith(base + "/"))) path = path.slice(base.length) || "/";
  path = normalizePath(path);
  const query = normalizeQuery(u.searchParams, cfg);
  const pathKey = path + (query ? "?" + query : "");
  const originPath = path === "/" && base ? "" : path;
  return {
    path,
    pathKey,
    originUrl: cfg.originBase + originPath + (query ? "?" + query : ""),
    publicUrl: (cfg.publicBase || cfg.originBase) + pathKey,
  };
}

// ----------------------------------------------------------------- database

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS snapshots (
    path_key TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'new',
    pending INTEGER NOT NULL DEFAULT 0,
    r2_key TEXT,
    bytes INTEGER NOT NULL DEFAULT 0,
    text_chars INTEGER NOT NULL DEFAULT 0,
    raw_text_chars INTEGER NOT NULL DEFAULT 0,
    title TEXT,
    content_hash TEXT,
    render_ms INTEGER NOT NULL DEFAULT 0,
    renders INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    source TEXT,
    queued_at INTEGER,
    last_attempt_at INTEGER,
    rendered_at INTEGER,
    hits INTEGER NOT NULL DEFAULT 0,
    last_hit_at INTEGER,
    last_bot TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_snapshots_pending ON snapshots (pending, queued_at)`,
  `CREATE INDEX IF NOT EXISTS idx_snapshots_rendered ON snapshots (status, rendered_at)`,
  `CREATE TABLE IF NOT EXISTS bot_hits (
    day TEXT NOT NULL,
    bot TEXT NOT NULL,
    served INTEGER NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, bot, served)
  )`,
  `CREATE TABLE IF NOT EXISTS usage (
    month TEXT PRIMARY KEY,
    renders INTEGER NOT NULL DEFAULT 0,
    browser_ms INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)`,
];

let schemaPromise = null;
function ensureSchema(env) {
  if (!schemaPromise) {
    schemaPromise = env.DB.batch(SCHEMA.map((sql) => env.DB.prepare(sql))).catch((err) => {
      schemaPromise = null;
      throw err;
    });
  }
  return schemaPromise;
}
/** Test hook: forget that the schema was created (each test gets fresh storage). */
export function resetSchemaCache() {
  schemaPromise = null;
}

async function getMeta(env, key) {
  const row = await env.DB.prepare("SELECT v FROM meta WHERE k = ?").bind(key).first();
  return row ? row.v : null;
}
const setMeta = (env, key, value) =>
  env.DB.prepare("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(key, String(value)).run();

const getRow = (env, pathKey) => env.DB.prepare("SELECT * FROM snapshots WHERE path_key = ?").bind(pathKey).first();

function rowToJson(row, cfg) {
  const now = Date.now();
  const cached = row.status === "ready" && !!row.r2_key;
  const publicBase = cfg.publicBase || cfg.originBase;
  return {
    path: row.path_key,
    url: row.url,
    public_url: publicBase + row.path_key,
    preview_url: `${publicBase}${API_PREFIX}/snapshot?url=${encodeURIComponent(row.path_key)}`,
    status: row.pending && !cached ? "queued" : row.status,
    cached,
    pending: !!row.pending,
    stale: cached && !!row.rendered_at && now - row.rendered_at > cfg.ttlMs,
    rendered_at: iso(row.rendered_at),
    age_minutes: row.rendered_at ? Math.round((now - row.rendered_at) / 60000) : null,
    bytes: row.bytes,
    text_chars: row.text_chars,
    raw_text_chars: row.raw_text_chars,
    title: row.title || "",
    renders: row.renders,
    render_ms: row.render_ms,
    hits: row.hits,
    last_bot: row.last_bot || "",
    last_hit_at: iso(row.last_hit_at),
    source: row.source || "",
    error: row.error || "",
  };
}

/** Adds a page to the render queue. Returns { ok, reason }. */
async function enqueue(env, cfg, target, source, { force = false } = {}) {
  const now = Date.now();
  const existing = await env.DB.prepare("SELECT pending, last_attempt_at FROM snapshots WHERE path_key = ?").bind(target.pathKey).first();
  if (!existing) {
    const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM snapshots").first();
    if (n >= cfg.maxPages) return { ok: false, reason: "page_limit" };
    await env.DB.prepare(
      "INSERT INTO snapshots (path_key, url, status, pending, source, queued_at, created_at) VALUES (?, ?, 'new', 1, ?, ?, ?) ON CONFLICT(path_key) DO NOTHING",
    ).bind(target.pathKey, target.originUrl, source, now, now).run();
    return { ok: true, reason: "queued" };
  }
  if (existing.pending) return { ok: true, reason: "already_queued" };
  if (!force && existing.last_attempt_at && now - existing.last_attempt_at < cfg.retryCooldownMs) {
    return { ok: false, reason: "cooldown" };
  }
  await env.DB.prepare("UPDATE snapshots SET pending = 1, queued_at = ?, url = ? WHERE path_key = ?").bind(now, target.originUrl, target.pathKey).run();
  return { ok: true, reason: "queued" };
}

// ---------------------------------------------------------------- rendering

async function callBrowser(env, cfg, url) {
  const body = {
    url,
    userAgent: RENDER_UA,
    gotoOptions: { waitUntil: cfg.waitUntil, timeout: cfg.renderTimeoutMs },
  };
  if (cfg.blockResources.length) body.rejectResourceTypes = cfg.blockResources;
  if (cfg.waitSelector) body.waitForSelector = { selector: cfg.waitSelector, timeout: Math.min(cfg.renderTimeoutMs, 20000) };
  if (cfg.settleMs > 0) body.waitForTimeout = cfg.settleMs;
  const res = await env.BROWSER.quickAction("content", body);
  const browserMs = Math.round(num(res.headers.get("X-Browser-Ms-Used"), 0));
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    // Non-JSON error body; handled below.
  }
  if (res.status === 429) {
    const message = data?.errors?.[0]?.message || text.slice(0, 200);
    return { ok: false, limited: /time limit/i.test(message) ? "daily" : "rate", message, browserMs };
  }
  if (!res.ok || !data?.success || typeof data.result !== "string") {
    const message = data?.errors?.[0]?.message || text.slice(0, 200) || `Browser Run returned ${res.status}`;
    return { ok: false, message: `Browser Run ${res.status}: ${message}`, browserMs };
  }
  return { ok: true, html: data.result, browserMs };
}

/**
 * Renders one queued page and stores the snapshot.
 * outcome: ready | thin | gone | error | deferred (left in the queue).
 */
async function renderRow(env, cfg, row, { allowWaitMs = 0 } = {}) {
  const now = Date.now();
  const month = monthKey(now);

  const blockedUntil = num(await getMeta(env, "browser_blocked_until"), 0);
  if (blockedUntil > now) return { outcome: "deferred", reason: "browser_daily_limit" };

  const used = await env.DB.prepare("SELECT renders FROM usage WHERE month = ?").bind(month).first();
  if ((used?.renders || 0) >= cfg.maxRendersPerMonth) return { outcome: "deferred", reason: "monthly_render_cap" };

  const lastRender = num(await getMeta(env, "last_render_at"), 0);
  const waitMs = lastRender + cfg.renderIntervalMs - now;
  if (waitMs > 0) {
    if (waitMs > allowWaitMs) return { outcome: "deferred", reason: "rate_paced" };
    await sleep(waitMs);
  }

  const finish = async (fields, outcome) => {
    const sets = Object.keys(fields).map((k) => `${k} = ?`).join(", ");
    await env.DB.prepare(`UPDATE snapshots SET ${sets}, pending = 0, last_attempt_at = ? WHERE path_key = ?`)
      .bind(...Object.values(fields), Date.now(), row.path_key).run();
    return { outcome };
  };

  // 1. Preflight: only snapshot pages the origin serves as HTML with a 200.
  let rawHtml = "";
  try {
    const pre = await fetch(row.url, { headers: { "user-agent": PREFLIGHT_UA, accept: "text/html" }, redirect: "manual" });
    if (pre.status === 404 || pre.status === 410) {
      if (row.r2_key) await env.SNAPSHOTS.delete(row.r2_key);
      return finish({ status: "gone", r2_key: null, error: `Origin returned ${pre.status}` }, "gone");
    }
    if (pre.status >= 300 && pre.status < 400) {
      return finish({ status: "error", error: `Origin redirects to ${pre.headers.get("location") || "another URL"}; render that URL instead` }, "error");
    }
    if (!pre.ok) return finish({ status: "error", error: `Origin returned ${pre.status}` }, "error");
    if (!/html/i.test(pre.headers.get("content-type") || "")) {
      return finish({ status: "error", error: "Origin response is not HTML" }, "error");
    }
    rawHtml = await pre.text();
  } catch (err) {
    return finish({ status: "error", error: `Origin fetch failed: ${String(err?.message || err).slice(0, 200)}` }, "error");
  }
  const rawTextChars = extractText(rawHtml).length;

  // 2. Render in a real browser.
  const started = Date.now();
  await setMeta(env, "last_render_at", started);
  let result;
  try {
    result = await callBrowser(env, cfg, row.url);
  } catch (err) {
    result = { ok: false, message: `Browser Run failed: ${String(err?.message || err).slice(0, 200)}`, browserMs: 0 };
  }
  const renderMs = Date.now() - started;

  if (result.limited) {
    if (result.limited === "daily") {
      const tomorrow = new Date(started);
      tomorrow.setUTCHours(24, 0, 0, 0);
      await setMeta(env, "browser_blocked_until", tomorrow.getTime());
      return { outcome: "deferred", reason: "browser_daily_limit" };
    }
    return { outcome: "deferred", reason: "rate_limited" };
  }

  await env.DB.prepare(
    "INSERT INTO usage (month, renders, browser_ms) VALUES (?, 1, ?) ON CONFLICT(month) DO UPDATE SET renders = renders + 1, browser_ms = browser_ms + excluded.browser_ms",
  ).bind(month, result.browserMs || 0).run();

  if (!result.ok) {
    return finish({ status: row.r2_key ? row.status : "error", error: result.message, renders: row.renders + 1, render_ms: renderMs, raw_text_chars: rawTextChars }, "error");
  }

  // 3. Clean, validate, store.
  const renderedAt = Date.now();
  const html = cleanSnapshot(result.html, { renderedAt });
  const text = extractText(html);
  const title = extractTitle(html);
  if (text.length < cfg.minTextChars) {
    // Keep any earlier good snapshot rather than replacing it with an empty one.
    return finish(
      { status: row.r2_key ? row.status : "thin", error: `Rendered page had only ${text.length} characters of text`, renders: row.renders + 1, render_ms: renderMs, raw_text_chars: rawTextChars, title },
      "thin",
    );
  }
  const key = await r2Key(row.path_key);
  const bytes = new TextEncoder().encode(html).byteLength;
  await env.SNAPSHOTS.put(key, html, {
    httpMetadata: { contentType: "text/html; charset=utf-8" },
    customMetadata: { pathKey: row.path_key.slice(0, 512), originUrl: row.url.slice(0, 512), renderedAt: String(renderedAt), textChars: String(text.length) },
  });
  return finish(
    {
      status: "ready", r2_key: key, bytes, text_chars: text.length, raw_text_chars: rawTextChars, title,
      content_hash: await sha256Hex(text), render_ms: renderMs, renders: row.renders + 1, error: null, rendered_at: renderedAt,
    },
    "ready",
  );
}

async function processQueue(env, cfg, { max, allowWaitMs }) {
  let processed = 0;
  let reason = "";
  while (processed < max) {
    const row = await env.DB.prepare("SELECT * FROM snapshots WHERE pending = 1 ORDER BY queued_at ASC LIMIT 1").first();
    if (!row) break;
    const result = await renderRow(env, cfg, row, { allowWaitMs });
    if (result.outcome === "deferred") {
      reason = result.reason;
      break;
    }
    processed++;
  }
  return { processed, reason };
}

// --------------------------------------------------------------- edge layer

function wantsHtml(request) {
  const accept = request.headers.get("accept");
  return !accept || /text\/html|application\/xhtml|\*\/\*/i.test(accept);
}

async function recordHit(env, pathKey, bot, served) {
  await ensureSchema(env);
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("UPDATE snapshots SET hits = hits + 1, last_hit_at = ?, last_bot = ? WHERE path_key = ?").bind(now, bot, pathKey),
    env.DB.prepare("INSERT INTO bot_hits (day, bot, served, count) VALUES (?, ?, ?, 1) ON CONFLICT(day, bot, served) DO UPDATE SET count = count + 1")
      .bind(dayKey(now), bot, served ? 1 : 0),
  ]);
}

function snapshotResponse(html, { originUrl, renderedAt, cfg, method, extraHeaders = {} }) {
  let body = html;
  if (cfg.standalone && originUrl) {
    try {
      body = withBaseHref(html, new URL(originUrl).origin + "/");
    } catch {
      // Keep the snapshot as stored.
    }
  }
  const headers = {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "private, no-store",
    vary: "User-Agent",
    "x-prerender": "HIT",
    "x-prerender-rendered-at": iso(renderedAt) || "",
    "x-prerender-age": String(renderedAt ? Math.max(0, Math.round((Date.now() - renderedAt) / 1000)) : 0),
    ...extraHeaders,
  };
  return new Response(method === "HEAD" ? null : body, { status: 200, headers });
}

function passthrough(request, cfg, url) {
  if (!cfg.standalone) return fetch(request);
  // Standalone (the Worker is not on the app's own domain): send people to the app.
  const base = cfg.originBasePath;
  const originPath = url.pathname === "/" && base ? "" : url.pathname;
  const target = cfg.originBase + originPath + url.search;
  if (cfg.humanMode === "proxy" && (request.method === "GET" || request.method === "HEAD")) {
    const headers = new Headers(request.headers);
    headers.delete("host");
    return fetch(target, { method: request.method, headers, redirect: "manual" });
  }
  return Response.redirect(target, 302);
}

async function handleEdge(request, env, ctx, cfg, url) {
  const method = request.method;
  if (method !== "GET" && method !== "HEAD") return passthrough(request, cfg, url);
  const ua = request.headers.get("user-agent") || "";
  if (ua.includes(RENDERER_MARK)) return passthrough(request, cfg, url);
  const bot = classifyBot(ua, cfg.botSet, cfg.extraBots);
  if (!bot || !wantsHtml(request)) return passthrough(request, cfg, url);

  let target;
  try {
    target = resolveTarget(url.pathname + url.search, cfg);
  } catch {
    return passthrough(request, cfg, url);
  }
  if (!isEligiblePath(target.path, cfg)) return passthrough(request, cfg, url);

  const object = await env.SNAPSHOTS.get(await r2Key(target.pathKey));
  if (object) {
    const renderedAt = num(object.customMetadata?.renderedAt, 0);
    const age = Date.now() - renderedAt;
    // Serve stale snapshots while a refresh is queued; drop them at 4x the TTL.
    if (age <= cfg.ttlMs * 4) {
      const html = await object.text();
      ctx.waitUntil(
        (async () => {
          await recordHit(env, target.pathKey, bot, true);
          if (age > cfg.ttlMs && cfg.autoRefresh) await enqueue(env, cfg, target, "refresh", { force: true });
        })().catch(() => {}),
      );
      return snapshotResponse(html, { originUrl: object.customMetadata?.originUrl, renderedAt, cfg, method, extraHeaders: { "x-prerender-bot": bot } });
    }
  }

  ctx.waitUntil(
    (async () => {
      await recordHit(env, target.pathKey, bot, false);
      if (cfg.autoQueue) await enqueue(env, cfg, target, "bot");
    })().catch(() => {}),
  );
  const response = await passthrough(request, cfg, url);
  const out = new Response(response.body, response);
  out.headers.set("x-prerender", "MISS");
  return out;
}

// ---------------------------------------------------------------------- API

async function isAuthorized(request, env) {
  const key = String(env.API_KEY || "");
  if (!key) return false;
  const auth = request.headers.get("authorization") || "";
  const given = /^bearer\s+/i.test(auth) ? auth.replace(/^bearer\s+/i, "").trim() : request.headers.get("x-api-key") || "";
  if (!given) return false;
  const [a, b] = await Promise.all([sha256Hex(given), sha256Hex(key)]);
  return a === b;
}

async function readBody(request) {
  if (request.method !== "POST") return {};
  try {
    const body = await request.json();
    return body && typeof body === "object" ? body : {};
  } catch {
    return {};
  }
}

function targetOrThrow(input, cfg) {
  const target = resolveTarget(input, cfg);
  if (!isEligiblePath(target.path, cfg)) {
    throw new HttpError(400, "path_excluded", `The path ${target.path} is excluded from prerendering.`);
  }
  return target;
}

async function apiRender(request, env, ctx, cfg) {
  const body = await readBody(request);
  const urls = Array.isArray(body.urls) ? body.urls.filter((u) => typeof u === "string" && u.trim()) : [];
  const single = typeof body.url === "string" && body.url.trim() ? body.url : null;
  const wait = body.wait === undefined ? true : !!body.wait;

  if (single && wait && !urls.length) {
    const target = targetOrThrow(single, cfg);
    const queued = await enqueue(env, cfg, target, "api", { force: true });
    if (!queued.ok) throw new HttpError(409, queued.reason, limitMessage(queued.reason, cfg));
    const row = await getRow(env, target.pathKey);
    const tuned = { ...cfg };
    if (["load", "domcontentloaded", "networkidle0", "networkidle2"].includes(body.wait_until)) tuned.waitUntil = body.wait_until;
    if (body.settle_ms !== undefined) tuned.settleMs = Math.min(Math.max(num(body.settle_ms, cfg.settleMs), 0), 20000);
    if (typeof body.wait_selector === "string") tuned.waitSelector = body.wait_selector.trim();
    const result = await renderRow(env, tuned, row, { allowWaitMs: cfg.renderIntervalMs + 1000 });
    const fresh = await getRow(env, target.pathKey);
    return json({
      ok: result.outcome === "ready",
      outcome: result.outcome,
      message: result.outcome === "deferred" ? limitMessage(result.reason, cfg) : fresh.error || "",
      snapshot: rowToJson(fresh, cfg),
    }, result.outcome === "deferred" ? 202 : 200);
  }

  const inputs = single ? [single, ...urls] : urls;
  if (!inputs.length) throw new HttpError(400, "missing_url", "Provide url (text) or urls (list of texts).");
  if (inputs.length > 500) throw new HttpError(400, "too_many", "Send at most 500 URLs per call.");
  let queuedCount = 0;
  const skipped = [];
  for (const input of inputs) {
    try {
      const target = targetOrThrow(input, cfg);
      const queued = await enqueue(env, cfg, target, "api", { force: true });
      if (queued.ok) queuedCount++;
      else skipped.push({ url: input, reason: queued.reason });
    } catch (err) {
      skipped.push({ url: input, reason: err.code || "invalid_url" });
    }
  }
  ctx.waitUntil(processQueue(env, cfg, { max: 1, allowWaitMs: 0 }).catch(() => {}));
  return json({ ok: true, outcome: "queued", queued: queuedCount, skipped_count: skipped.length, skipped, message: `${queuedCount} page(s) queued for rendering.` }, 202);
}

function limitMessage(reason, cfg) {
  switch (reason) {
    case "page_limit": return `Page limit reached (${cfg.maxPages} pages). Purge pages you no longer need or raise MAX_PAGES.`;
    case "monthly_render_cap": return `Monthly render limit reached (${cfg.maxRendersPerMonth}). The page stays queued until next month or until MAX_RENDERS_PER_MONTH is raised.`;
    case "browser_daily_limit": return "Cloudflare's daily browser time limit is used up. The page stays queued and renders after midnight UTC.";
    case "rate_limited":
    case "rate_paced": return "The renderer is busy. The page is queued and will render within a few minutes.";
    case "cooldown": return "This page was attempted recently and is cooling down.";
    default: return reason || "";
  }
}

async function deleteRows(env, rows) {
  const keys = rows.map((r) => r.r2_key).filter(Boolean);
  for (let i = 0; i < keys.length; i += 500) await env.SNAPSHOTS.delete(keys.slice(i, i + 500));
  for (let i = 0; i < rows.length; i += 50) {
    const chunk = rows.slice(i, i + 50);
    await env.DB.prepare(`DELETE FROM snapshots WHERE path_key IN (${chunk.map(() => "?").join(",")})`).bind(...chunk.map((r) => r.path_key)).run();
  }
  return rows.length;
}

async function apiPurge(request, env, cfg) {
  const body = await readBody(request);
  let rows;
  if (body.all === true) {
    rows = (await env.DB.prepare("SELECT path_key, r2_key FROM snapshots").all()).results;
  } else if (typeof body.prefix === "string" && body.prefix.trim()) {
    const prefix = normalizePath(body.prefix.trim());
    const like = prefix.replace(/[\\%_]/g, "\\$&") + "%";
    rows = (await env.DB.prepare("SELECT path_key, r2_key FROM snapshots WHERE path_key LIKE ? ESCAPE '\\'").bind(like).all()).results;
  } else if (typeof body.url === "string" && body.url.trim()) {
    const target = resolveTarget(body.url, cfg);
    const row = await env.DB.prepare("SELECT path_key, r2_key FROM snapshots WHERE path_key = ?").bind(target.pathKey).first();
    // Remove the object even if the index row is missing.
    await env.SNAPSHOTS.delete(await r2Key(target.pathKey));
    rows = row ? [row] : [];
  } else {
    throw new HttpError(400, "missing_target", "Provide url, prefix, or all: true.");
  }
  const purged = await deleteRows(env, rows);
  return json({ ok: true, purged, message: `${purged} page(s) purged.` });
}

async function apiStatus(env, cfg, url) {
  const target = resolveTarget(url.searchParams.get("url"), cfg);
  const row = await getRow(env, target.pathKey);
  if (!row) {
    return json({
      ok: true, found: false,
      snapshot: { path: target.pathKey, url: target.originUrl, public_url: target.publicUrl, preview_url: "", status: "none", cached: false, pending: false, stale: false, rendered_at: null, age_minutes: null, bytes: 0, text_chars: 0, raw_text_chars: 0, title: "", renders: 0, render_ms: 0, hits: 0, last_bot: "", last_hit_at: null, source: "", error: "" },
    });
  }
  return json({ ok: true, found: true, snapshot: rowToJson(row, cfg) });
}

async function apiList(env, cfg, url) {
  const limit = Math.min(Math.max(num(url.searchParams.get("limit"), 50), 1), 200);
  const offset = Math.max(num(url.searchParams.get("offset"), 0), 0);
  const status = url.searchParams.get("status") || "";
  const where = [];
  const binds = [];
  if (status === "queued") where.push("pending = 1");
  else if (status) {
    where.push("status = ?");
    binds.push(status);
  }
  const q = (url.searchParams.get("q") || "").trim();
  if (q) {
    where.push("path_key LIKE ? ESCAPE '\\'");
    binds.push("%" + q.replace(/[\\%_]/g, "\\$&") + "%");
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = await env.DB.prepare(`SELECT COUNT(*) AS n FROM snapshots ${clause}`).bind(...binds).first();
  const rows = await env.DB.prepare(`SELECT * FROM snapshots ${clause} ORDER BY COALESCE(rendered_at, queued_at, created_at) DESC LIMIT ? OFFSET ?`).bind(...binds, limit, offset).all();
  return json({ ok: true, total: total.n, limit, offset, items: rows.results.map((r) => rowToJson(r, cfg)) });
}

async function apiUsage(env, cfg) {
  const now = Date.now();
  const month = monthKey(now);
  const since = dayKey(now - 29 * 86400_000);
  const [usage, counts, hits, top, blocked] = await env.DB.batch([
    env.DB.prepare("SELECT renders, browser_ms FROM usage WHERE month = ?").bind(month),
    env.DB.prepare("SELECT COUNT(*) AS pages, SUM(CASE WHEN status = 'ready' AND r2_key IS NOT NULL THEN 1 ELSE 0 END) AS ready, SUM(pending) AS queued, SUM(CASE WHEN status IN ('error','thin') AND pending = 0 THEN 1 ELSE 0 END) AS failed, SUM(bytes) AS bytes FROM snapshots"),
    env.DB.prepare("SELECT SUM(count) AS total, SUM(CASE WHEN served = 1 THEN count ELSE 0 END) AS served FROM bot_hits WHERE day >= ?").bind(since),
    env.DB.prepare("SELECT bot, SUM(count) AS n FROM bot_hits WHERE day >= ? GROUP BY bot ORDER BY n DESC LIMIT 1").bind(since),
    env.DB.prepare("SELECT v FROM meta WHERE k = 'browser_blocked_until'"),
  ]);
  const u = usage.results[0] || {};
  const c = counts.results[0] || {};
  const h = hits.results[0] || {};
  const blockedUntil = num(blocked.results[0]?.v, 0);
  return json({
    ok: true,
    month,
    renders_used: u.renders || 0,
    renders_limit: cfg.maxRendersPerMonth,
    renders_remaining: Math.max(0, cfg.maxRendersPerMonth - (u.renders || 0)),
    browser_seconds: Math.round((u.browser_ms || 0) / 1000),
    pages: c.pages || 0,
    pages_limit: cfg.maxPages,
    pages_ready: c.ready || 0,
    pages_queued: c.queued || 0,
    pages_failed: c.failed || 0,
    storage_bytes: c.bytes || 0,
    bot_hits_30d: h.total || 0,
    bot_hits_served_30d: h.served || 0,
    top_bot_30d: top.results[0]?.bot || "",
    renderer_paused_until: blockedUntil > now ? iso(blockedUntil) : null,
  });
}

async function apiBots(env, url) {
  const days = Math.min(Math.max(num(url.searchParams.get("days"), 30), 1), 365);
  const since = dayKey(Date.now() - (days - 1) * 86400_000);
  const rows = await env.DB.prepare(
    "SELECT bot, SUM(count) AS hits, SUM(CASE WHEN served = 1 THEN count ELSE 0 END) AS served, MAX(day) AS last_day FROM bot_hits WHERE day >= ? GROUP BY bot ORDER BY hits DESC LIMIT 100",
  ).bind(since).all();
  return json({ ok: true, days, bots: rows.results.map((r) => ({ bot: r.bot, hits: r.hits, served: r.served, missed: r.hits - r.served, last_day: r.last_day })) });
}

async function apiCheck(env, cfg, url) {
  const target = resolveTarget(url.searchParams.get("url"), cfg);
  let rawTextChars = 0;
  let originStatus = 0;
  let title = "";
  try {
    const res = await fetch(target.originUrl, { headers: { "user-agent": PREFLIGHT_UA, accept: "text/html" }, redirect: "manual" });
    originStatus = res.status;
    if (res.ok) {
      const html = await res.text();
      rawTextChars = extractText(html).length;
      title = extractTitle(html);
    }
  } catch {
    originStatus = 0;
  }
  const row = await getRow(env, target.pathKey);
  const cached = !!row && row.status === "ready" && !!row.r2_key;
  const snapshotTextChars = cached ? row.text_chars : 0;
  const verdict = rawTextChars >= 400 ? "readable" : cached ? "fixed" : "invisible";
  return json({
    ok: true,
    path: target.pathKey,
    url: target.originUrl,
    origin_status: originStatus,
    title,
    raw_text_chars: rawTextChars,
    snapshot_text_chars: snapshotTextChars,
    cached,
    verdict,
    message:
      verdict === "readable" ? "This page already has readable text without JavaScript."
        : verdict === "fixed" ? `Without JavaScript this page shows ${rawTextChars} characters of text. Crawlers now receive a snapshot with ${snapshotTextChars}.`
          : `Without JavaScript this page shows ${rawTextChars} characters of text and no snapshot is cached yet.`,
  });
}

async function apiSitemap(request, env, ctx, cfg) {
  const body = await readBody(request);
  const limit = Math.min(Math.max(num(body.limit, cfg.maxPages), 1), 1000);
  const prefix = typeof body.path_prefix === "string" ? body.path_prefix.trim() : "";
  const sitemapUrl = typeof body.sitemap_url === "string" && body.sitemap_url.trim() ? body.sitemap_url.trim() : cfg.originBase + "/sitemap.xml";
  let first;
  try {
    first = new URL(sitemapUrl);
  } catch {
    throw new HttpError(400, "invalid_url", "sitemap_url is not a valid URL.");
  }
  if (!cfg.allowedHosts.has(first.hostname.toLowerCase())) throw new HttpError(400, "host_not_allowed", `The host ${first.hostname} is not served by this Worker.`);

  const fetchXml = async (u) => {
    const res = await fetch(u, { headers: { "user-agent": PREFLIGHT_UA } });
    if (!res.ok) throw new HttpError(502, "sitemap_unavailable", `Sitemap request returned ${res.status}. In Bubble, enable it under Settings, SEO / metatags, Expose a sitemap file.`);
    return parseSitemap(await res.text());
  };
  let { isIndex, urls } = await fetchXml(first.toString());
  if (isIndex) {
    const pages = [];
    for (const child of urls.slice(0, 5)) {
      try {
        if (cfg.allowedHosts.has(new URL(child).hostname.toLowerCase())) pages.push(...(await fetchXml(child)).urls);
      } catch {
        // Skip unreadable child sitemaps.
      }
    }
    urls = pages;
  }

  let queuedCount = 0;
  let skipped = 0;
  let capped = false;
  for (const loc of urls) {
    if (queuedCount >= limit) {
      capped = true;
      break;
    }
    try {
      const target = targetOrThrow(loc, cfg);
      if (prefix && !target.path.startsWith(normalizePath(prefix))) {
        skipped++;
        continue;
      }
      const queued = await enqueue(env, cfg, target, "sitemap");
      if (queued.ok && queued.reason === "queued") queuedCount++;
      else if (queued.reason === "page_limit") {
        capped = true;
        break;
      } else skipped++;
    } catch {
      skipped++;
    }
  }
  ctx.waitUntil(processQueue(env, cfg, { max: 1, allowWaitMs: 0 }).catch(() => {}));
  return json({ ok: true, found: urls.length, queued: queuedCount, skipped, capped, message: `${queuedCount} of ${urls.length} sitemap page(s) queued.` });
}

async function apiSnapshot(env, cfg, url, method) {
  const target = resolveTarget(url.searchParams.get("url"), cfg);
  const object = await env.SNAPSHOTS.get(await r2Key(target.pathKey));
  if (!object) throw new HttpError(404, "not_cached", "No snapshot is cached for that page yet.");
  const html = await object.text();
  if (url.searchParams.get("format") === "text") {
    return new Response(extractText(html), { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*", "x-robots-tag": "noindex" } });
  }
  return snapshotResponse(html, {
    originUrl: object.customMetadata?.originUrl,
    renderedAt: num(object.customMetadata?.renderedAt, 0),
    cfg: { ...cfg, standalone: true },
    method,
    extraHeaders: { "x-robots-tag": "noindex", "access-control-allow-origin": "*" },
  });
}

async function handleApi(request, env, ctx, cfg, url) {
  const route = url.pathname.slice(API_PREFIX.length).replace(/\/+$/, "") || "/";
  const method = request.method;
  try {
    if (route === "/health" && method === "GET") {
      return json({
        ok: true, version: VERSION, mode: cfg.standalone ? "standalone" : "route", origin: cfg.originBase,
        bot_set: cfg.botSet, api_key_set: !!env.API_KEY, pages_limit: cfg.maxPages, renders_limit: cfg.maxRendersPerMonth,
        ttl_hours: cfg.ttlMs / 3600_000,
      }, 200, { "access-control-allow-origin": "*" });
    }
    await ensureSchema(env);
    if (route === "/snapshot" && (method === "GET" || method === "HEAD")) {
      if (!cfg.publicPreview && !(await isAuthorized(request, env))) throw new HttpError(401, "unauthorized", "Missing or wrong API key.");
      return await apiSnapshot(env, cfg, url, method);
    }
    if (!env.API_KEY) throw new HttpError(503, "not_configured", "Set the API_KEY secret on the Worker first.");
    if (!(await isAuthorized(request, env))) throw new HttpError(401, "unauthorized", "Missing or wrong API key.");

    if (route === "/render" && method === "POST") return await apiRender(request, env, ctx, cfg);
    if (route === "/purge" && method === "POST") return await apiPurge(request, env, cfg);
    if (route === "/sitemap" && method === "POST") return await apiSitemap(request, env, ctx, cfg);
    if (route === "/status" && method === "GET") return await apiStatus(env, cfg, url);
    if (route === "/list" && method === "GET") return await apiList(env, cfg, url);
    if (route === "/usage" && method === "GET") return await apiUsage(env, cfg);
    if (route === "/bots" && method === "GET") return await apiBots(env, url);
    if (route === "/check" && method === "GET") return await apiCheck(env, cfg, url);
    throw new HttpError(404, "not_found", "Unknown endpoint.");
  } catch (err) {
    if (err instanceof HttpError) return json({ ok: false, error: err.code, message: err.message }, err.status);
    console.error("prerender api error", err);
    return json({ ok: false, error: "internal_error", message: String(err?.message || err).slice(0, 300) }, 500);
  }
}

// ----------------------------------------------------------------- handlers

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cfg = loadConfig(env, url);
    if (url.pathname === API_PREFIX || url.pathname.startsWith(API_PREFIX + "/")) {
      return handleApi(request, env, ctx, cfg, url);
    }
    try {
      return await handleEdge(request, env, ctx, cfg, url);
    } catch (err) {
      // The prerender layer must never take the site down.
      console.error("prerender edge error", err);
      return passthrough(request, cfg, url);
    }
  },

  // Runs every minute: drains the render queue at the plan's pace and
  // re-queues snapshots older than the TTL.
  async scheduled(controller, env, ctx) {
    const cfg = loadConfig(env, null);
    await ensureSchema(env);
    const now = Date.now();
    if (cfg.autoRefresh && new Date(controller.scheduledTime || now).getUTCMinutes() % 10 === 0) {
      await env.DB.prepare(
        "UPDATE snapshots SET pending = 1, queued_at = ? WHERE path_key IN (SELECT path_key FROM snapshots WHERE status = 'ready' AND pending = 0 AND rendered_at < ? ORDER BY rendered_at ASC LIMIT 10)",
      ).bind(now, now - cfg.ttlMs).run();
    }
    await processQueue(env, cfg, { max: cfg.queueBatch, allowWaitMs: cfg.renderIntervalMs + 1000 });
  },
};
