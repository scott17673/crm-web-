import { normalizeDomain } from "./dedupe.mjs";
import { DEFAULT_INDUSTRY_IDS, getIndustryPreset } from "./industries.mjs";

const BLOCKED_DOMAINS = new Set([
  "duckduckgo.com",
  "www.duckduckgo.com",
  "bing.com",
  "www.bing.com",
  "bbb.org",
  "www.bbb.org",
  "datagemba.com",
  "www.datagemba.com",
  "aeroleads.com",
  "www.aeroleads.com",
  "allpages.com",
  "www.allpages.com",
  "cylex-canada.ca",
  "www.cylex-canada.ca",
  "canadapages.com",
  "www.canadapages.com",
  "canadaubm.com",
  "www.canadaubm.com",
  "canpages.ca",
  "www.canpages.ca",
  "ctidirectory.com",
  "www.ctidirectory.com",
  "concrete.org",
  "www.concrete.org",
  "edir24.com",
  "www.edir24.com",
  "clutch.co",
  "www.clutch.co",
  "firmania.ca",
  "www.firmania.ca",
  "workopolis.com",
  "www.workopolis.com",
  "indeed.com",
  "www.indeed.com",
  "linkedin.com",
  "www.linkedin.com",
  "investburlington.ca",
  "www.investburlington.ca",
  "linkedin.com",
  "www.linkedin.com",
  "miltonchamber.ca",
  "www.miltonchamber.ca",
  "business.miltonchamber.ca",
  "indianbusinesscanada.com",
  "www.indianbusinesscanada.com",
  "ontariobusinessdir.com",
  "www.ontariobusinessdir.com",
  "ontario.ca",
  "www.ontario.ca",
  "processing.org",
  "www.processing.org",
  "supportontariomade.ca",
  "www.supportontariomade.ca",
  "scottsdirectories.com",
  "www.scottsdirectories.com",
  "canada.ca",
  "www.canada.ca",
  "gc.ca",
  "www.gc.ca",
  "inspection.gc.ca",
  "akama.ca",
  "www.akama.ca",
  "usnews.com",
  "www.usnews.com",
  "facebook.com",
  "www.facebook.com",
  "instagram.com",
  "www.instagram.com",
  "x.com",
  "twitter.com",
  "www.twitter.com",
  "yellowpages.ca",
  "www.yellowpages.ca",
  "canada411.ca",
  "www.canada411.ca",
  "companylisting.ca",
  "www.companylisting.ca",
  "canada-listing.com",
  "www.canada-listing.com",
  "yelp.ca",
  "www.yelp.ca",
  "yelp.com",
  "www.yelp.com",
  "mapquest.com",
  "www.mapquest.com",
  "dnb.com",
  "www.dnb.com",
  "zoominfo.com",
  "www.zoominfo.com",
  "opencorporates.com",
  "www.opencorporates.com",
  "glassdoor.ca",
  "www.glassdoor.ca",
  "exploretock.com",
  "www.exploretock.com",
  "opentable.com",
  "www.opentable.com",
  "eater.com",
  "www.eater.com",
  "apple.com",
  "www.apple.com",
  "developer.apple.com",
  "baidu.com",
  "www.baidu.com",
  "zhidao.baidu.com",
  "zhihu.com",
  "www.zhihu.com",
  "weforum.org",
  "www.weforum.org",
  "wikipedia.org",
  "www.wikipedia.org",
  "sciencedirect.com",
  "www.sciencedirect.com",
  "wordreference.com",
  "www.wordreference.com",
  "reddit.com",
  "www.reddit.com",
  "redflagdeals.com",
  "forums.redflagdeals.com",
  "forum.processing.org",
  "environment.ec.europa.eu",
  "environment.nsw.gov.au",
  "4pda.to",
  "www.4pda.to"
]);

const DEFAULT_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36"
};
const REQUEST_TIMEOUT_MS = 20000;

export async function searchWeb(query, options = {}) {
  const providers = [
    () => searchBingHtml(query, options),
    () => searchYahooHtml(query, options),
    () => searchDuckDuckGoHtml(query, options)
  ];
  let lastError = null;
  let hadSuccessfulProvider = false;

  for (const provider of providers) {
    try {
      const parsed = await provider();
      hadSuccessfulProvider = true;
      const filtered = filterSearchResults(parsed, query, options);
      if (filtered.length) {
        return filtered;
      }
    } catch (error) {
      lastError = error;
    }
  }

  if (hadSuccessfulProvider) {
    return [];
  }

  if (lastError) {
    throw lastError;
  }

  return [];
}

async function searchDuckDuckGoHtml(query, options = {}) {
  const url = new URL("https://html.duckduckgo.com/html/");
  url.searchParams.set("q", query);
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;

  const response = await fetch(url, {
    headers: DEFAULT_HEADERS,
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (!response.ok) {
    throw new Error(`DuckDuckGo search failed for "${query}": ${response.status} ${response.statusText}`);
  }

  const html = await response.text();
  return parseDuckDuckGoResults(html);
}

async function searchBingHtml(query, options = {}) {
  const url = new URL("https://www.bing.com/search");
  url.searchParams.set("q", query);
  url.searchParams.set("setlang", options.region || "en-CA");
  url.searchParams.set("cc", "ca");
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;

  const response = await fetch(url, {
    headers: DEFAULT_HEADERS,
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (!response.ok) {
    throw new Error(`Bing search failed for "${query}": ${response.status} ${response.statusText}`);
  }

  const html = await response.text();
  return parseBingResults(html);
}

async function searchYahooHtml(query, options = {}) {
  const url = new URL("https://search.yahoo.com/search");
  url.searchParams.set("p", query);
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;

  const response = await fetch(url, {
    headers: DEFAULT_HEADERS,
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (!response.ok) {
    throw new Error(`Yahoo search failed for "${query}": ${response.status} ${response.statusText}`);
  }

  const html = await response.text();
  return parseYahooResults(html);
}

function filterSearchResults(parsed, query, options = {}) {
  const results = [];
  const seenSites = new Set();

  for (const result of parsed) {
    if (results.length >= (options.limit ?? 8)) {
      break;
    }

    const domain = normalizeDomain(result.url);
    if (!domain) {
      continue;
    }

    if (!matchesAllowedDomain(domain, options.allowedDomains)) {
      continue;
    }

    if (!options.allowBlockedDomains && isBlockedDomain(domain, options.allowedDomains)) {
      continue;
    }

    if (shouldSkipResult(result, options.skipPatterns, options)) {
      continue;
    }

    if (!looksLocallyRelevant(result, query, domain)) {
      continue;
    }

    const siteKey = shouldKeepResultPath(domain, options)
      ? normalizeResultUrl(result.url)
      : normalizeSiteKey(result.url);
    if (!siteKey || seenSites.has(siteKey)) {
      continue;
    }

    seenSites.add(siteKey);

    results.push({
      ...result,
      domain,
      siteKey,
      websiteUrl: toCanonicalWebsiteUrl(result.url)
    });
  }

  return results;
}

export async function searchDuckDuckGo(query, options = {}) {
  return searchWeb(query, options);
}

export async function searchYellowPagesListings(query, city, province = "Ontario", options = {}) {
  const results = [];
  const limit = options.limit ?? 8;
  const seenSites = new Set();
  let listings = [];

  try {
    const url = buildYellowPagesSearchUrl(query, city, province);
    const response = await fetch(url, {
      headers: DEFAULT_HEADERS,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });

    if (!response.ok) {
      throw new Error(`Yellow Pages search failed for "${query}" in ${city}: ${response.status} ${response.statusText}`);
    }

    const html = await response.text();
    listings = parseYellowPagesSearchResults(html);
  } catch {
    return searchDirectWebsiteMatches(query, options);
  }

  for (const listing of listings) {
    if (results.length >= limit) {
      break;
    }

    const detail = await fetchYellowPagesListing(listing.detailUrl);
    let websiteUrl = detail.websiteUrl;

    if (!websiteUrl && listing.companyName) {
      try {
        const officialMatches = await searchWeb(
          `"${listing.companyName}" "${city}" "${province}" official site -yellowpages -pagesjaunes -directory`,
          {
            limit: 3,
            skipPatterns: ["yellowpages", "pagesjaunes", "directory", "canpages", "cdncompanies"]
          }
        );
        const officialMatch = officialMatches.find((match) => matchesLikelyOfficialSite(match, listing.companyName));
        websiteUrl = officialMatch?.websiteUrl || officialMatch?.url || "";
      } catch {
        websiteUrl = "";
      }
    }

    if (!websiteUrl) {
      continue;
    }

    const domain = normalizeDomain(websiteUrl);
    if (!domain || (!options.allowBlockedDomains && isBlockedDomain(domain, options.allowedDomains))) {
      continue;
    }

    const result = {
      title: detail.companyName || listing.companyName,
      companyName: detail.companyName || listing.companyName,
      url: websiteUrl,
      snippet: [
        detail.address || listing.address,
        detail.phone,
        "Yellow Pages listing"
      ].filter(Boolean).join(" | "),
      domain,
      sourceUrl: detail.detailUrl
    };

    if (shouldSkipResult(result, options.skipPatterns, options)) {
      continue;
    }

    const normalized = {
      ...result,
      siteKey: normalizeSiteKey(websiteUrl),
      websiteUrl: toCanonicalWebsiteUrl(websiteUrl)
    };

    if (!normalized.siteKey || seenSites.has(normalized.siteKey)) {
      continue;
    }

    seenSites.add(normalized.siteKey);
    results.push(normalized);
  }

  if (results.length < limit) {
    const directMatches = await searchDirectWebsiteMatches(query, options);
    for (const match of directMatches) {
      if (results.length >= limit) {
        break;
      }

      const siteKey = normalizeSiteKey(match.websiteUrl || match.url);
      if (!siteKey || seenSites.has(siteKey)) {
        continue;
      }

      seenSites.add(siteKey);
      results.push({
        ...match,
        companyName: match.companyName || match.title,
        siteKey,
        websiteUrl: toCanonicalWebsiteUrl(match.websiteUrl || match.url)
      });
    }
  }

  return results;
}

export function normalizeSiteKey(url) {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.replace(/^www\./i, "").toLowerCase();
    return hostname ? `site://${hostname}` : "";
  } catch {
    return "";
  }
}

export function toCanonicalWebsiteUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}/`;
  } catch {
    return url;
  }
}

export function buildCityQueries(city, province = "Ontario", industries = []) {
  const selected = industries.length ? industries : DEFAULT_INDUSTRY_IDS;
  const queries = new Set();

  for (const industryId of selected) {
    const preset = getIndustryPreset(industryId);
    if (!preset) {
      continue;
    }

    for (const query of preset.queries) {
      queries.add(`${query} in "${city}" "${province}" -jobs -directory -forum -pdf`);
    }
  }

  if (queries.size === 0) {
    queries.add(`manufacturer in "${city}" "${province}" -jobs -directory -forum -pdf`);
    queries.add(`manufacturing company in "${city}" "${province}" -jobs -directory -forum -pdf`);
    queries.add(`industrial manufacturer in "${city}" "${province}" -jobs -directory -forum -pdf`);
  }

  return Array.from(queries).map((query) =>
    `${query} -restaurant -menu -reservation -opentable -tock -cafe -dining`
  );
}

function buildYellowPagesSearchUrl(query, city, province) {
  const provinceCode = /^ontario$/i.test(String(province || "").trim()) ? "ON" : String(province || "").trim();
  const searchWhat = sanitizeYellowPagesQuery(query);
  const what = encodeURIComponent(searchWhat).replace(/%20/g, "+");
  const where = encodeURIComponent(`${city} ${provinceCode}`.trim()).replace(/%20/g, "+");
  return `https://www.yellowpages.ca/search/si/1/${what}/${where}`;
}

function parseYellowPagesSearchResults(html) {
  const matches = html.matchAll(/href="([^"]*\/bus\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi);
  const listings = new Map();

  for (const match of matches) {
    const href = decodeHtml(match[1] || "");
    const text = decodeHtml(stripTags(match[2] || "")).replace(/\s+/g, " ").trim();
    const absoluteUrl = toAbsoluteUrl("https://www.yellowpages.ca", href);
    if (!absoluteUrl) {
      continue;
    }

    const key = absoluteUrl.replace(/[?#].*$/, "");
    const entry = listings.get(key) || {
      detailUrl: key,
      companyName: "",
      address: ""
    };

    if (looksLikeYellowPagesAddress(text)) {
      entry.address = entry.address || text.replace(/\s*Get directions\s*$/i, "").trim();
    } else if (isYellowPagesCompanyName(text)) {
      entry.companyName = entry.companyName || text;
    }

    listings.set(key, entry);
  }

  return Array.from(listings.values()).filter((entry) => entry.companyName);
}

async function fetchYellowPagesListing(detailUrl) {
  try {
    const response = await fetch(detailUrl, {
      headers: DEFAULT_HEADERS,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });

    if (!response.ok) {
      return {
        detailUrl,
        companyName: "",
        address: "",
        phone: "",
        websiteUrl: ""
      };
    }

    const html = await response.text();
    const companyName = decodeHtml(
      stripTags((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").split(" - ")[0])
    ).trim();
    const websiteMatch =
      html.match(/redirect=([^"&]+)[\s\S]{0,500}?Visit [^"]+ website/i) ||
      html.match(/Visit [^"]+ website[\s\S]{0,500}?redirect=([^"&]+)/i) ||
      html.match(/click - Website[\s\S]{0,500}?redirect=([^"&]+)/i);
    const phoneMatch = html.match(/Phone Number[\s\S]{0,400}?(\d{3}[-.\s]\d{3}[-.\s]\d{4})/i);
    const telMatch = html.match(/href="tel:([^"]+)"/i);
    const phone = normalizeYellowPagesPhone(
      decodeHtml(phoneMatch?.[1] || telMatch?.[1] || "")
    ) || extractLikelyPhone(html);

    return {
      detailUrl,
      companyName,
      address: extractYellowPagesAddress(html),
      phone,
      websiteUrl: websiteMatch?.[1] ? decodeURIComponent(websiteMatch[1]) : ""
    };
  } catch {
    return {
      detailUrl,
      companyName: "",
      address: "",
      phone: "",
      websiteUrl: ""
    };
  }
}

async function searchDirectWebsiteMatches(query, options = {}) {
  let directMatches = [];
  try {
    directMatches = await searchWeb(query, {
      limit: options.limit ?? 8,
      skipPatterns: ["yellowpages", "pagesjaunes", "directory", "canpages", "cdncompanies"]
    });
  } catch {
    directMatches = [];
  }

  const seenSites = new Set();
  const results = [];

  for (const match of directMatches) {
    const websiteUrl = toCanonicalWebsiteUrl(match.websiteUrl || match.url);
    const siteKey = normalizeSiteKey(websiteUrl);
    if (!siteKey || seenSites.has(siteKey)) {
      continue;
    }

    seenSites.add(siteKey);
    results.push({
      ...match,
      companyName: match.companyName || match.title,
      siteKey,
      websiteUrl
    });
  }

  return results;
}

function parseDuckDuckGoResults(html) {
  const results = [];
  const anchorRegex = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = anchorRegex.exec(html))) {
    const rawUrl = decodeHtml(match[1]);
    const title = decodeHtml(stripTags(match[2])).trim();
    const nearby = html.slice(match.index, match.index + 1600);
    const snippetMatch = nearby.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div)>/i);
    const url = unwrapDuckDuckGoUrl(rawUrl);
    if (!url || !/^https?:\/\//i.test(url)) {
      continue;
    }

    results.push({
      title,
      url,
      snippet: snippetMatch ? decodeHtml(stripTags(snippetMatch[1])).trim() : ""
    });
  }

  return dedupeUrls(results);
}

function parseBingResults(html) {
  const results = [];
  const blocks = html.match(/<li class="b_algo"[\s\S]*?<\/li>/gi) || [];

  for (const block of blocks) {
    const headingMatch = block.match(/<h2[^>]*><a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!headingMatch) {
      continue;
    }

    const rawUrl = decodeHtml(headingMatch[1]);
    const title = decodeHtml(stripTags(headingMatch[2])).trim();
    const url = unwrapBingUrl(rawUrl);
    if (!url || !/^https?:\/\//i.test(url)) {
      continue;
    }

    const snippetMatch =
      block.match(/<div class="b_caption"[\s\S]*?<p>([\s\S]*?)<\/p>/i) ||
      block.match(/<p>([\s\S]*?)<\/p>/i);

    results.push({
      title,
      url,
      snippet: snippetMatch ? decodeHtml(stripTags(snippetMatch[1])).trim() : ""
    });
  }

  return dedupeUrls(results);
}

function parseYahooResults(html) {
  const results = [];
  const blocks = html.match(/<div class="dd(?:[^"]*)algo-sr(?:[^"]*)"[\s\S]*?<\/li>/gi) || [];

  for (const block of blocks) {
    const headingMatch =
      block.match(/<a[^>]+href="([^"]+)"[^>]*>[\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>/i) ||
      block.match(/<h3[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!headingMatch) {
      continue;
    }

    const rawUrl = decodeHtml(headingMatch[1]);
    const title = decodeHtml(stripTags(headingMatch[2])).trim();
    const url = unwrapYahooUrl(rawUrl);
    if (!url || !/^https?:\/\//i.test(url)) {
      continue;
    }

    const snippetMatch =
      block.match(/<div class="compText[^"]*"[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i) ||
      block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);

    results.push({
      title,
      url,
      snippet: snippetMatch ? decodeHtml(stripTags(snippetMatch[1])).trim() : ""
    });
  }

  return dedupeUrls(results);
}

function unwrapDuckDuckGoUrl(rawUrl) {
  try {
    const resolved = new URL(rawUrl, "https://duckduckgo.com");
    if (resolved.hostname.endsWith("duckduckgo.com") && resolved.pathname.startsWith("/l/")) {
      return resolved.searchParams.get("uddg") || "";
    }
    return resolved.toString();
  } catch {
    return "";
  }
}

function unwrapBingUrl(rawUrl) {
  try {
    const resolved = new URL(rawUrl, "https://www.bing.com");
    if (resolved.hostname.endsWith("bing.com") && resolved.pathname === "/ck/a") {
      const direct = decodeBingUrl(resolved.searchParams.get("u"));
      return direct || "";
    }
    return resolved.toString();
  } catch {
    return "";
  }
}

function unwrapYahooUrl(rawUrl) {
  try {
    const resolved = new URL(rawUrl, "https://search.yahoo.com");
    const directMatch = resolved.pathname.match(/\/RU=([^/]+)\/RK=/i);
    if (directMatch?.[1]) {
      return decodeURIComponent(directMatch[1]);
    }

    const directParam = resolved.searchParams.get("RU") || resolved.searchParams.get("ru");
    if (directParam) {
      return decodeURIComponent(directParam);
    }

    return resolved.toString();
  } catch {
    return "";
  }
}

function decodeBingUrl(value) {
  if (!value) {
    return "";
  }

  let candidate = value;
  if (/^a\d/i.test(candidate)) {
    candidate = candidate.slice(2);
  }

  try {
    return Buffer.from(candidate, "base64").toString("utf8");
  } catch {
    return "";
  }
}

function isBlockedDomain(domain, allowedDomains = []) {
  if (allowedDomains.some((allowed) => domain === allowed || domain.endsWith(`.${allowed}`))) {
    return false;
  }

  for (const blocked of BLOCKED_DOMAINS) {
    if (domain === blocked || domain.endsWith(`.${blocked}`)) {
      return true;
    }
  }

  return false;
}

function matchesAllowedDomain(domain, allowedDomains = []) {
  if (!allowedDomains?.length) {
    return true;
  }

  return allowedDomains.some((allowed) => domain === allowed || domain.endsWith(`.${allowed}`));
}

function shouldKeepResultPath(domain, options = {}) {
  if (options.keepUrlPath) {
    return true;
  }

  return matchesAllowedDomain(domain, ["linkedin.com"]);
}

function normalizeResultUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.search = "";
    return parsed.toString().replace(/\/$/, "").toLowerCase();
  } catch {
    return "";
  }
}

function shouldSkipResult(result, extraPatterns = [], options = {}) {
  const haystack = `${result.title} ${result.url} ${result.snippet}`.toLowerCase();
  if (isTrustedWorkforceSource(result)) {
    return false;
  }

  const industrialFoodSignal = /\b(roast|roastery|brewery|manufactur|plant|facility|production|processing)\b/.test(haystack);

  const jobPatterns = options.keepJobResults ? [] : [
    "/jobs/",
    "jobs in",
    "job opening"
  ];

  const patterns = [
    ".pdf",
    "/pdf/",
    " filetype:pdf",
    "search?q=",
    "manufacturing-companies",
    "major-employers",
    "business directory",
    "local directory",
    "company directory",
    "manufacturer directory",
    "category/",
    "categories/",
    "near ",
    " near ",
    "nearby",
    "review",
    "reviews",
    "residential",
    "driveway",
    "landscape",
    "landscaping",
    "sealing",
    "paving",
    "contractor",
    "contractors",
    "repair",
    "installation",
    "services",
    "restaurant",
    "restaurants",
    "menu",
    "reservation",
    "reservations",
    "book a table",
    "dining",
    "brunch",
    "lunch",
    "dinner",
    "cafe",
    "company in",
    "companies in",
    "manufacturers near",
    "manufacturers in",
    "top companies",
    "top industrial companies",
    "best companies",
    "list of",
    "opening hours",
    "get direction",
    "photos",
    "forum",
    "question",
    "answer",
    "topicdetail",
    "documentation",
    "resources",
    "factory outlet",
    "shoe outlet",
    ...jobPatterns
  ].concat(extraPatterns || []).filter((pattern) => !(industrialFoodSignal && pattern === "cafe"));

  if (patterns.some((pattern) => haystack.includes(pattern))) {
    return true;
  }

  return !looksLikeOfficialCompanyPage(result);
}

function looksLikeOfficialCompanyPage(result) {
  const title = String(result.title || "").toLowerCase();
  const snippet = String(result.snippet || "").toLowerCase();
  const url = String(result.url || "").toLowerCase();
  const industrialFoodSignal = /\b(roast|roastery|brewery|manufactur|plant|facility|production|processing)\b/.test(`${title} ${snippet} ${url}`);

  if (isTrustedWorkforceSource(result)) {
    return true;
  }

  if (/\/(category|categories|directory|search|topic|question|answers?|forums?)\b/.test(url)) {
    return false;
  }

  if (/\b(bbb|directory|directories|near|review|reviews|forum|wiki|question|answer)\b/.test(title)) {
    return false;
  }

  if (/\b(find|compare|browse)\b/.test(snippet) && /\b(companies|businesses|manufacturers)\b/.test(snippet)) {
    return false;
  }

  if (/\b(residential|driveway|landscape|landscaping|sealing|paving|repair|installation|service)\b/.test(title)) {
    return false;
  }

  if (/\b(beer store|bottle shop|convenience store|butcher shop|market|restaurant|restaurants|menu|reservation|dining|brunch|lunch|dinner|cafe|pub|brewpub|brewhouse)\b/.test(title) && !industrialFoodSignal) {
    return false;
  }

  if (!industrialFoodSignal && /\b(restaurant|restaurants|menu|reservation|dining|brunch|lunch|dinner|cafe)\b/.test(title)) {
    return false;
  }

  if (!industrialFoodSignal && /\b(restaurant|restaurants|menu|reservation|dining|brunch|lunch|dinner|cafe)\b/.test(snippet)) {
    return false;
  }

  return true;
}

function isTrustedWorkforceSource(result) {
  const domain = normalizeDomain(result?.url || "");
  return [
    "linkedin.com",
    "wiza.co",
    "signalhire.com",
    "clodura.ai",
    "adapt.io",
    "contactout.com",
    "rocketreach.co",
    "zoominfo.com",
    "apollo.io",
    "lusha.com",
    "theorg.com",
    "glassdoor.com",
    "glassdoor.ca",
    "greatplacetowork.ca",
    "greatplacetowork.com"
  ].some((trusted) => domain === trusted || domain.endsWith(`.${trusted}`));
}

function looksLocallyRelevant(result, query, domain) {
  const haystack = `${result.title} ${result.snippet} ${result.url}`.toLowerCase();
  const location = extractQueryLocation(query);
  const isLinkedInResult = domain === "linkedin.com" || domain.endsWith(".linkedin.com");
  const hasLocalSignal = [
    location.city,
    location.province,
    "ontario",
    "canada"
  ].filter(Boolean).some((token) => haystack.includes(token));
  const hasIndustrySignal = /\b(manufactur|plant|facility|factory|production|processing|fabricat|recycling|concrete|asphalt|aggregate|food|beverage|bakery|metal|steel)\b/.test(haystack);
  const commonOfficialDomain =
    domain.endsWith(".ca") ||
    domain.endsWith(".com") ||
    domain.endsWith(".net") ||
    domain.endsWith(".org");

  if (isLinkedInResult) {
    return true;
  }

  if (commonOfficialDomain) {
    return hasLocalSignal || hasIndustrySignal || looksLikeOfficialCompanyPage(result);
  }

  return hasLocalSignal;
}

function extractQueryLocation(query) {
  const matches = String(query || "").match(/"([^"]+)"/g) || [];
  const values = matches.map((entry) => entry.slice(1, -1).toLowerCase());

  return {
    city: values[0] || "",
    province: values[1] || ""
  };
}

function dedupeUrls(results) {
  const seen = new Set();
  const unique = [];

  for (const result of results) {
    const key = result.url.replace(/[?#].*$/, "");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(result);
  }

  return unique;
}

function stripTags(value) {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
}

function toAbsoluteUrl(base, href) {
  try {
    return new URL(href, base).toString();
  } catch {
    return "";
  }
}

function isYellowPagesCompanyName(text) {
  if (!text || text.length < 3) {
    return false;
  }

  if (looksLikeYellowPagesAddress(text)) {
    return false;
  }

  return !/^(opening at|get directions|phone number|website|view map)$/i.test(text);
}

function looksLikeYellowPagesAddress(text) {
  return /\b\d{1,6}\s+.+,\s*[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s*,\s*(?:ON|Ontario)\b/i.test(text);
}

function extractYellowPagesAddress(html) {
  const stripped = stripTags(html).replace(/\s+/g, " ");
  const match = stripped.match(/\b\d{1,6}\s+[^,]{2,80},\s*[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s*,\s*(?:ON|Ontario)\s+[A-Z]\d[A-Z][ -]?\d[A-Z]\d\b/i);
  return match ? match[0].trim() : "";
}

function sanitizeYellowPagesQuery(query) {
  const cleaned = String(query || "")
    .replace(/"[^"]+"/g, " ")
    .replace(/\s-\S+/g, " ")
    .replace(/\bin\s*$/i, " ")
    .replace(/\s+/g, " ")
    .trim();

  return cleaned || "manufacturer";
}

function matchesLikelyOfficialSite(result, companyName) {
  const companyTokens = buildCompanyIdentityTokens(companyName);
  const domainTokens = buildCompanyIdentityTokens(normalizeDomain(result?.websiteUrl || result?.url || ""));

  if (!companyTokens.length) {
    return true;
  }

  return companyTokens.some((token) => domainTokens.includes(token));
}

function buildCompanyIdentityTokens(value) {
  const stopwords = new Set([
    "and",
    "the",
    "company",
    "manufacturing",
    "manufacturer",
    "food",
    "beverage",
    "products",
    "product",
    "group",
    "canada",
    "ontario",
    "limited",
    "ltd",
    "inc",
    "corp",
    "corporation"
  ]);

  return Array.from(new Set(
    String(value || "")
      .toLowerCase()
      .replace(/&/g, " and ")
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 4 && !stopwords.has(token))
  ));
}

function normalizeYellowPagesPhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) {
    return formatNorthAmericanPhone(digits.slice(1));
  }
  if (digits.length === 10) {
    return formatNorthAmericanPhone(digits);
  }
  return "";
}

function extractLikelyPhone(html) {
  const matches = stripTags(html).match(/(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}/g) || [];
  for (const match of matches) {
    const normalized = normalizeYellowPagesPhone(match);
    if (normalized) {
      return normalized;
    }
  }
  return "";
}

function formatNorthAmericanPhone(digits) {
  return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
}

function decodeHtml(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}
