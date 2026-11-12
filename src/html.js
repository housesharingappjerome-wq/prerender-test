// Pure HTML helpers. They operate on HTML serialized by a browser, which is
// well formed, so targeted regular expressions are reliable here.

const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code) => {
    if (code[0] === "#") {
      const n = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : " ";
    }
    const named = NAMED_ENTITIES[code.toLowerCase()];
    return named === undefined ? match : named;
  });
}

/** The text a non-JavaScript crawler can read from the page body. */
export function extractText(html) {
  if (!html) return "";
  const bodyMatch = html.match(/<body\b[^>]*>([\s\S]*)<\/body>/i);
  let body = bodyMatch ? bodyMatch[1] : html.replace(/<head\b[\s\S]*?<\/head>/i, "");
  body = body
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg|iframe)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  return decodeEntities(body).replace(/\s+/g, " ").trim();
}

export function extractTitle(html) {
  const m = html && html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeEntities(m[1]).replace(/\s+/g, " ").trim().slice(0, 300) : "";
}

/**
 * Turns a rendered DOM into a static snapshot: executable scripts are removed
 * (structured data is kept) so the markup is exactly what a visitor saw at
 * render time and cannot re-run and duplicate itself.
 */
export function cleanSnapshot(html, { renderedAt } = {}) {
  let out = html.replace(/<script\b([^>]*)>[\s\S]*?<\/script>/gi, (match, attrs) =>
    /type\s*=\s*["']?application\/ld\+json/i.test(attrs) ? match : "",
  );
  out = out.replace(/<link\b[^>]*>/gi, (tag) => {
    const rel = (tag.match(/\brel\s*=\s*["']?([^"'\s>]+)/i) || [])[1] || "";
    const as = (tag.match(/\bas\s*=\s*["']?([^"'\s>]+)/i) || [])[1] || "";
    if (/^modulepreload$/i.test(rel)) return "";
    if (/^(preload|prefetch)$/i.test(rel) && /^script$/i.test(as)) return "";
    return tag;
  });
  out = out.replace(/\n{3,}/g, "\n\n");
  if (renderedAt) {
    const stamp = `<!-- snapshot rendered ${new Date(renderedAt).toISOString()} -->`;
    out = /<\/body>/i.test(out) ? out.replace(/<\/body>/i, `${stamp}</body>`) : out + stamp;
  }
  return out;
}

/** Adds a <base> so root-relative assets resolve when a snapshot is viewed off its own host. */
export function withBaseHref(html, baseHref) {
  if (/<base\b/i.test(html)) return html;
  const tag = `<base href="${baseHref.replace(/"/g, "&quot;")}">`;
  if (/<head\b[^>]*>/i.test(html)) return html.replace(/<head\b[^>]*>/i, (m) => m + tag);
  return tag + html;
}

/** Extracts <loc> URLs from a sitemap or sitemap index. */
export function parseSitemap(xml) {
  const isIndex = /<sitemapindex\b/i.test(xml);
  const urls = [];
  const re = /<loc\b[^>]*>\s*(?:<!\[CDATA\[)?\s*([^<\]]+?)\s*(?:\]\]>)?\s*<\/loc>/gi;
  let m;
  while ((m = re.exec(xml))) urls.push(decodeEntities(m[1].trim()));
  return { isIndex, urls };
}
