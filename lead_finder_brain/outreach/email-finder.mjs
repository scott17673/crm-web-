const SOCIAL_HOST_RE = /(facebook|instagram|twitter|x\.com|linkedin|youtube|youtu\.be|tiktok|pinterest|reddit|wikipedia|crunchbase|bloomberg|yelp|indeed|glassdoor|maps\.google|goo\.gl|bit\.ly|google\.com|duckduckgo\.com|bing\.com)/i;
const URL_RE = /(https?:\/\/[^\s<>"'`)]+|\bwww\.[^\s<>"'`)]+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\.(?:com|ca|net|org|co|us|io)\b)/gi;

export function extractDomainFromText(...texts) {
  const joined = texts.filter(Boolean).join("\n");
  const matches = joined.match(URL_RE) || [];
  for (const raw of matches) {
    const host = hostnameOf(raw);
    if (!host || SOCIAL_HOST_RE.test(host)) continue;
    return host;
  }
  return "";
}

export function hostnameOf(raw) {
  let candidate = String(raw || "").trim().replace(/[),.;]+$/, "");
  if (!candidate) return "";
  if (!/^https?:\/\//i.test(candidate)) candidate = `https://${candidate.replace(/^\/+/, "")}`;
  try {
    const url = new URL(candidate);
    return url.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

export async function searchDomainViaDuckDuckGo(companyName, { fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  const query = encodeURIComponent(`${companyName} official site`);
  const url = `https://duckduckgo.com/html/?q=${query}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let html = "";
  try {
    const response = await fetchImpl(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; ED-Outreach/1.0)",
        Accept: "text/html,application/xhtml+xml"
      },
      signal: controller.signal
    });
    if (!response.ok) return "";
    html = await response.text();
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }

  const resultRe = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"/gi;
  const matches = Array.from(html.matchAll(resultRe), (m) => m[1]);

  for (const rawHref of matches) {
    const decoded = decodeDuckDuckGoHref(rawHref);
    const host = hostnameOf(decoded);
    if (!host || SOCIAL_HOST_RE.test(host)) continue;
    return host;
  }
  return "";
}

function decodeDuckDuckGoHref(href) {
  try {
    const u = new URL(href, "https://duckduckgo.com");
    const direct = u.searchParams.get("uddg");
    if (direct) return decodeURIComponent(direct);
  } catch {
    // fall through
  }
  return href;
}

export function generatePersonalCandidates(contactName, domain) {
  const cleanedName = String(contactName || "").trim();
  const cleanedDomain = String(domain || "").trim().toLowerCase().replace(/^www\./, "");
  if (!cleanedName || !cleanedDomain) return [];

  const parts = cleanedName
    .toLowerCase()
    .replace(/[^a-z\s'-]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((p) => !/^(mr|mrs|ms|dr|prof|sir|madam)\.?$/.test(p));
  if (!parts.length) return [];

  const first = sanitizeLocal(parts[0]);
  const last = parts.length > 1 ? sanitizeLocal(parts[parts.length - 1]) : "";
  const f = first ? first[0] : "";

  const patterns = [];
  if (first && last) patterns.push(`${first}.${last}`);
  if (first && last) patterns.push(`${first}${last}`);
  if (f && last) patterns.push(`${f}${last}`);
  if (first) patterns.push(first);
  if (last) patterns.push(last);

  const seen = new Set();
  const out = [];
  for (const local of patterns) {
    if (!local) continue;
    const addr = `${local}@${cleanedDomain}`;
    if (seen.has(addr)) continue;
    seen.add(addr);
    out.push(addr);
  }
  return out;
}

function sanitizeLocal(value) {
  return String(value || "").replace(/[^a-z0-9]/g, "");
}
