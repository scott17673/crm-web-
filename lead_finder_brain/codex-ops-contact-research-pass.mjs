import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const inputPath = process.env.CODEX_CONTACT_INPUT ||
  path.join(__dirname, "output", `gta-public-manufacturer-census-100-${new Date().toISOString().slice(0, 10)}.csv`);
const outputPath = process.env.CODEX_CONTACT_OUTPUT || inputPath;
const cacheDir = path.join(__dirname, "cache", "codex-contact-search");

const SEARCH_CONCURRENCY = Number(process.env.CODEX_CONTACT_CONCURRENCY || 5);
const QUERY_LIMIT_PER_COMPANY = Number(process.env.CODEX_CONTACT_QUERY_LIMIT || 12);
const CONTACTS_PER_COMPANY = Number(process.env.CODEX_CONTACTS_PER_COMPANY || 4);
const REQUEST_TIMEOUT_MS = Number(process.env.CODEX_CONTACT_TIMEOUT_MS || 9000);

const ROLE_PATTERN = /\b(?:chief operating officer|chief operations officer|coo|director of operations|operations director|operations manager|operations supervisor|plant manager|plant supervisor|plant superintendent|production manager|production supervisor|manufacturing manager|manufacturing supervisor|maintenance manager|maintenance supervisor|maintenance lead|millwright|quality manager|quality assurance manager|qa manager|food safety manager|warehouse manager|logistics manager|supply chain manager|procurement manager|purchasing manager|general manager|head brewer|brewmaster|lead brewer|owner|founder|president|vice president|vp)\b/i;
const ROLE_CLEANUPS = [
  [/\bcoo\b/i, "COO"],
  [/\bchief operating officer\b|\bchief operations officer\b/i, "Chief Operating Officer"],
  [/\bdirector of operations\b|\boperations director\b/i, "Director of Operations"],
  [/\boperations manager\b/i, "Operations Manager"],
  [/\boperations supervisor\b/i, "Operations Supervisor"],
  [/\bplant manager\b/i, "Plant Manager"],
  [/\bplant supervisor\b/i, "Plant Supervisor"],
  [/\bproduction manager\b/i, "Production Manager"],
  [/\bproduction supervisor\b/i, "Production Supervisor"],
  [/\bmanufacturing manager\b/i, "Manufacturing Manager"],
  [/\bmaintenance manager\b/i, "Maintenance Manager"],
  [/\bmaintenance supervisor\b/i, "Maintenance Supervisor"],
  [/\bquality assurance manager\b/i, "Quality Assurance Manager"],
  [/\bquality manager\b/i, "Quality Manager"],
  [/\bfood safety manager\b/i, "Food Safety Manager"],
  [/\bwarehouse manager\b/i, "Warehouse Manager"],
  [/\blogistics manager\b/i, "Logistics Manager"],
  [/\bsupply chain manager\b/i, "Supply Chain Manager"],
  [/\bprocurement manager\b/i, "Procurement Manager"],
  [/\bpurchasing manager\b/i, "Purchasing Manager"],
  [/\bgeneral manager\b/i, "General Manager"],
  [/\bhead brewer\b/i, "Head Brewer"],
  [/\bbrewmaster\b/i, "Brewmaster"],
  [/\blead brewer\b/i, "Lead Brewer"],
  [/\bowner\b/i, "Owner"],
  [/\bfounder\b/i, "Founder"],
  [/\bpresident\b/i, "President"],
  [/\bvice president\b|\bvp\b/i, "Vice President"]
];
const TITLE_EXCLUDE_PATTERN = /\b(?:sales|marketing|finance|controller|accounting|human resources|hr\b|recruiter|real estate|broker|lawyer|attorney|teacher|student|professor|developer|designer|account manager|business development|customer service|retail)\b/i;
const GENERIC_COMPANY_TOKENS = new Set([
  "food", "foods", "beverage", "beverages", "bakery", "baking", "baker", "dairy", "meat", "poultry", "seafood", "brewery", "brewing", "coffee", "chocolate", "candy", "sauce", "spice", "nutrition", "frozen", "products", "inc", "ltd", "limited", "corp", "corporation", "company", "canada", "ontario"
]);
const BAD_SOURCE_PATTERN = /\b(?:yellowpages|facebook|instagram|opencorporates|indeed|glassdoor|salary|job[-.]?bank|workopolis|realtor|real-estate|zillow|school|university|linkedin\.com\/pub\/dir)\b/i;

async function main() {
  await fs.mkdir(cacheDir, { recursive: true });
  const rows = parseCsv(await fs.readFile(inputPath, "utf8"));
  console.log(`Loaded ${rows.length} companies from ${inputPath}`);

  await mapLimit(rows, SEARCH_CONCURRENCY, async (row, index) => {
    if (index && index % 10 === 0) {
      console.log(`Contact research ${index}/${rows.length}...`);
    }
    const contacts = await researchCompanyContacts(row);
    row.contacts = formatContacts(contacts);
  });

  const backupPath = outputPath.replace(/\.csv$/i, ".before-codex-contact-pass.csv");
  if (outputPath === inputPath) {
    await fs.copyFile(inputPath, backupPath).catch(() => {});
  }
  await fs.writeFile(outputPath, toCsv(rows), "utf8");

  const named = rows.filter((row) => !/^No named/i.test(row.contacts || "")).length;
  console.log(`Wrote ${rows.length} rows to ${outputPath}`);
  console.log(`Rows with named operations contacts: ${named}`);
}

async function researchCompanyContacts(row) {
  const profile = buildCompanyProfile(row);
  const queries = buildContactQueries(profile).slice(0, QUERY_LIMIT_PER_COMPANY);
  const allResults = [];
  for (const query of queries) {
    const results = await cachedSearch(query);
    for (const result of results) {
      allResults.push({ ...result, query });
    }
  }
  const contacts = [];
  for (const result of dedupeResults(allResults)) {
    if (!looksRelevantToCompany(result, profile)) continue;
    contacts.push(...extractContactsFromSearchResult(result, profile));
  }
  return dedupeContacts(contacts).slice(0, CONTACTS_PER_COMPANY);
}

function buildCompanyProfile(row) {
  const notes = cleanText(row.notes || "");
  const address = fieldFromNotes(notes, "Address");
  const city = cityFromAddress(address);
  const website = fieldFromNotes(notes, "Website");
  const legalName = (notes.match(/legal name\s+([^;]+);/i) || [])[1] || "";
  const endProduct = fieldFromNotes(notes, "End product/capability");
  const aliases = uniqueOrdered([
    row.company,
    simplifyCompanyAlias(row.company),
    legalName,
    simplifyCompanyAlias(legalName),
    ...splitCompanyAliases(row.company),
    ...splitCompanyAliases(legalName)
  ].flatMap((alias) => [alias, simplifyCompanyAlias(alias)]))
    .filter((alias) => alias && !/^\d+\s+(?:ontario|canada)\b/i.test(alias));
  return {
    company: cleanText(row.company),
    aliases: aliases.slice(0, 5),
    city,
    address,
    website,
    websiteHost: hostname(website),
    endProduct,
    identityTokens: uniqueOrdered(aliases.flatMap(companyIdentityTokens))
  };
}

function buildContactQueries(profile) {
  const roleQueries = [
    "operations manager",
    "production manager",
    "plant manager",
    "maintenance manager",
    "quality manager",
    "director of operations",
    "general manager",
    "head brewer"
  ];
  const queries = [];
  for (const alias of profile.aliases.slice(0, 3)) {
    for (const role of roleQueries.slice(0, 6)) {
      queries.push(`site:ca.linkedin.com/in "${alias}" "${role}"`);
      queries.push(`"${alias}" "${role}" "${profile.city || "Ontario"}"`);
    }
    queries.push(`site:linkedin.com/in "${alias}" "Ontario" "operations"`);
    queries.push(`site:linkedin.com/in "${alias}" "Canada" "production"`);
    queries.push(`"${alias}" "plant manager"`);
    queries.push(`"${alias}" "operations" "LinkedIn"`);
  }
  if (profile.websiteHost) {
    const host = profile.websiteHost.replace(/^www\./, "");
    queries.push(`site:${host} "operations manager"`);
    queries.push(`site:${host} "production manager"`);
    queries.push(`site:${host} "plant manager"`);
    queries.push(`site:${host} "team" "operations"`);
  }
  return uniqueOrdered(queries);
}

async function cachedSearch(query) {
  const cachePath = path.join(cacheDir, `${slugFilename(query)}.json`);
  try {
    const parsed = JSON.parse(await fs.readFile(cachePath, "utf8"));
    if (Date.now() - parsed.createdAt < 7 * 24 * 60 * 60 * 1000) {
      return parsed.results || [];
    }
  } catch {
    // Cache miss.
  }

  const results = [];
  const settled = await Promise.allSettled([
    searchBing(query),
    searchYahoo(query),
    searchDuckDuckGo(query)
  ]);
  for (const result of settled) {
    if (result.status === "fulfilled") results.push(...result.value);
  }
  const unique = dedupeResults(results).slice(0, 12);
  await fs.writeFile(cachePath, JSON.stringify({ createdAt: Date.now(), query, results: unique }, null, 2), "utf8");
  return unique;
}

async function searchBing(query) {
  const url = new URL("https://www.bing.com/search");
  url.searchParams.set("q", query);
  url.searchParams.set("cc", "ca");
  url.searchParams.set("setlang", "en-CA");
  const response = await fetch(url, {
    headers: defaultHeaders(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  if (!response.ok) return [];
  return parseBingResults(await response.text());
}

async function searchDuckDuckGo(query) {
  const url = new URL("https://html.duckduckgo.com/html/");
  url.searchParams.set("q", query);
  const response = await fetch(url, {
    headers: defaultHeaders(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  if (!response.ok) return [];
  return parseDuckDuckGoResults(await response.text());
}

async function searchYahoo(query) {
  const url = new URL("https://search.yahoo.com/search");
  url.searchParams.set("p", query);
  const response = await fetch(url, {
    headers: defaultHeaders(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  if (!response.ok) return [];
  return parseYahooResults(await response.text());
}

function looksRelevantToCompany(result, profile) {
  const url = cleanText(result.url);
  if (!url || BAD_SOURCE_PATTERN.test(url)) return false;
  const text = normalizeSearchText(`${result.title || ""} ${result.snippet || ""} ${result.url || ""}`);
  const aliases = profile.aliases.map(normalizeSearchText).filter(Boolean);
  const exactAliasHit = aliases.some((alias) => alias.length >= 6 && text.includes(alias));
  const identityHits = profile.identityTokens.filter((token) => text.includes(token));
  const sourceHost = hostname(url);
  const officialSource = profile.websiteHost && sourceHost && (sourceHost === profile.websiteHost || sourceHost.endsWith(`.${profile.websiteHost}`));
  if (!exactAliasHit && identityHits.length < Math.min(2, profile.identityTokens.length || 2) && !officialSource) {
    return false;
  }
  if (/linkedin\.com\/in\//i.test(url)) {
    return /ca\.linkedin\.com/i.test(url) || /\b(?:canada|ontario)\b/i.test(text) || (profile.city && text.includes(normalizeSearchText(profile.city)));
  }
  return officialSource || exactAliasHit;
}

function extractContactsFromSearchResult(result, profile) {
  const text = cleanText(`${result.title || ""}. ${result.snippet || ""}`);
  const contacts = [];
  const source = cleanText(result.url);
  const titleNoSuffix = cleanText(String(result.title || "").replace(/\s*\|\s*LinkedIn.*$/i, ""));

  for (const candidate of [
    ...extractDashContacts(titleNoSuffix, source),
    ...extractAtContacts(text, source),
    ...extractCommaContacts(text, source),
    ...extractSentenceContacts(text, source)
  ]) {
    if (!isValidContact(candidate, profile)) continue;
    contacts.push(candidate);
  }
  return contacts;
}

function extractDashContacts(text, source) {
  const parts = cleanText(text).split(/\s+-\s+/).map(cleanText).filter(Boolean);
  if (parts.length < 2) return [];
  const contacts = [];
  for (let index = 0; index < parts.length - 1; index += 1) {
    const name = cleanPersonName(parts[index]);
    const title = normalizeRole(parts[index + 1]);
    if (name && title) contacts.push({ name, title, source });
  }
  return contacts;
}

function extractAtContacts(text, source) {
  const contacts = [];
  const role = "(chief operating officer|chief operations officer|coo|director of operations|operations director|operations manager|operations supervisor|plant manager|plant supervisor|production manager|production supervisor|manufacturing manager|maintenance manager|maintenance supervisor|quality assurance manager|quality manager|food safety manager|warehouse manager|logistics manager|supply chain manager|procurement manager|purchasing manager|general manager|head brewer|brewmaster|owner|founder|president|vice president|vp)";
  const patterns = [
    new RegExp(`([A-Z][A-Za-z'.-]+(?:\\s+[A-Z][A-Za-z'.-]+){1,4})\\s+(?:is\\s+)?(?:the\\s+)?(${role})\\s+(?:at|with|for)\\s+`, "gi"),
    new RegExp(`([A-Z][A-Za-z'.-]+(?:\\s+[A-Z][A-Za-z'.-]+){1,4}).{0,80}?\\b(${role})\\b`, "gi")
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const name = cleanPersonName(match[1]);
      const title = normalizeRole(match[2]);
      if (name && title) contacts.push({ name, title, source });
    }
  }
  return contacts;
}

function extractCommaContacts(text, source) {
  const contacts = [];
  const pattern = /([A-Z][A-Za-z'.-]+(?:\s+[A-Z][A-Za-z'.-]+){1,4})\s*,\s*([^.,;|]{0,80}?(?:operations|production|plant|maintenance|quality|manufacturing|warehouse|logistics|supply chain|procurement|purchasing|general manager|head brewer|brewmaster|owner|founder|president|vice president|vp)[^.,;|]{0,80})/gi;
  for (const match of text.matchAll(pattern)) {
    const name = cleanPersonName(match[1]);
    const title = normalizeRole(match[2]);
    if (name && title) contacts.push({ name, title, source });
  }
  return contacts;
}

function extractSentenceContacts(text, source) {
  const contacts = [];
  const pattern = /\b(?:operations manager|production manager|plant manager|maintenance manager|quality manager|general manager|head brewer|brewmaster|owner|founder|president)\s+([A-Z][A-Za-z'.-]+(?:\s+[A-Z][A-Za-z'.-]+){1,4})/gi;
  for (const match of text.matchAll(pattern)) {
    const name = cleanPersonName(match[1]);
    const title = normalizeRole(match[0].replace(match[1], ""));
    if (name && title) contacts.push({ name, title, source });
  }
  return contacts;
}

function isValidContact(contact, profile) {
  if (!contact.name || !contact.title || !ROLE_PATTERN.test(contact.title)) return false;
  const normalizedName = normalizeSearchText(contact.name);
  if (/\b(?:inc|ltd|limited|corp|corporation|company|group|tools?|poultry|foods?|bakery|dairy|print)\b/i.test(contact.name)) return false;
  if (profile.identityTokens.some((token) => normalizedName.includes(token))) return false;
  if (TITLE_EXCLUDE_PATTERN.test(contact.title) && !/\boperations|production|plant|maintenance|quality|manufacturing\b/i.test(contact.title)) return false;
  const sourceText = normalizeSearchText(contact.source);
  if (/linkedin\.com\/in\//i.test(contact.source) && !/ca\.linkedin\.com/i.test(contact.source) && !sourceText.includes("canada")) {
    const companyContext = profile.identityTokens.some((token) => sourceText.includes(token));
    if (!companyContext) return false;
  }
  return true;
}

function normalizeRole(value) {
  const text = cleanText(value)
    .replace(/\s+at\s+.*$/i, "")
    .replace(/\s+\|\s+.*$/i, "")
    .replace(/\s+-\s+.*$/i, "");
  if (!ROLE_PATTERN.test(text)) return "";
  for (const [pattern, label] of ROLE_CLEANUPS) {
    if (pattern.test(text)) return label;
  }
  return titleCase(text);
}

function formatContacts(contacts) {
  if (!contacts.length) {
    return "No named operations/production/maintenance contact found in Codex public research pass.";
  }
  return contacts.map((contact) => {
    const label = /linkedin\.com\/in\//i.test(contact.source) ? "LinkedIn" : "Source";
    return `${contact.name} - ${contact.title} | ${label}: ${contact.source}`;
  }).join("\n");
}

function dedupeContacts(contacts) {
  const seen = new Set();
  const output = [];
  for (const contact of contacts.sort((left, right) => contactPriority(right) - contactPriority(left))) {
    const key = normalizeSearchText(contact.name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(contact);
  }
  return output;
}

function contactPriority(contact) {
  let score = 0;
  if (/linkedin\.com\/in\//i.test(contact.source)) score += 20;
  if (/\bdirector|operations manager|plant manager|production manager|maintenance manager|quality manager\b/i.test(contact.title)) score += 20;
  if (/\boperations|plant|production|maintenance|manufacturing|quality\b/i.test(contact.title)) score += 15;
  if (/\bowner|founder|president|general manager\b/i.test(contact.title)) score += 5;
  return score;
}

function parseBingResults(html) {
  const results = [];
  const blocks = html.match(/<li class="b_algo"[\s\S]*?<\/li>/gi) || [];
  for (const block of blocks) {
    const headingMatch = block.match(/<h2[^>]*><a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!headingMatch) continue;
    const url = unwrapBingUrl(decodeHtml(headingMatch[1]));
    const title = cleanText(stripTags(decodeHtml(headingMatch[2])));
    if (!/^https?:\/\//i.test(url)) continue;
    const snippetMatch = block.match(/<div class="b_caption"[\s\S]*?<p>([\s\S]*?)<\/p>/i) || block.match(/<p>([\s\S]*?)<\/p>/i);
    results.push({ title, url, snippet: snippetMatch ? cleanText(stripTags(decodeHtml(snippetMatch[1]))) : "" });
  }
  return dedupeResults(results);
}

function parseDuckDuckGoResults(html) {
  const results = [];
  const anchorRegex = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchorRegex.exec(html))) {
    const url = unwrapDuckDuckGoUrl(decodeHtml(match[1]));
    const title = cleanText(stripTags(decodeHtml(match[2])));
    const nearby = html.slice(match.index, match.index + 1600);
    const snippetMatch = nearby.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div)>/i);
    if (!/^https?:\/\//i.test(url)) continue;
    results.push({ title, url, snippet: snippetMatch ? cleanText(stripTags(decodeHtml(snippetMatch[1]))) : "" });
  }
  return dedupeResults(results);
}

function parseYahooResults(html) {
  const results = [];
  const blocks = html.match(/<div class="dd(?:[^"]*)algo-sr(?:[^"]*)"[\s\S]*?<\/li>/gi) || [];
  for (const block of blocks) {
    const headingMatch =
      block.match(/<a[^>]+href="([^"]+)"[^>]*>[\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>/i) ||
      block.match(/<h3[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!headingMatch) continue;
    const url = unwrapYahooUrl(decodeHtml(headingMatch[1]));
    const title = cleanText(stripTags(decodeHtml(headingMatch[2])));
    if (!/^https?:\/\//i.test(url)) continue;
    const snippetMatch =
      block.match(/<div class="compText[^"]*"[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i) ||
      block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    results.push({ title, url, snippet: snippetMatch ? cleanText(stripTags(decodeHtml(snippetMatch[1]))) : "" });
  }
  return dedupeResults(results);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (quoted) {
      if (char === "\"" && next === "\"") {
        field += "\"";
        index += 1;
      } else if (char === "\"") {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === "\"") {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  const headers = rows.shift() || [];
  return rows.filter((values) => values.some(Boolean)).map((values) =>
    Object.fromEntries(headers.map((header, index) => [cleanText(header), values[index] || ""]))
  );
}

function toCsv(rows) {
  const headers = ["company", "notes", "contacts"];
  return [headers.join(","), ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(","))].join("\n") + "\n";
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, "\"\"")}"` : text;
}

function fieldFromNotes(notes, field) {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = notes.match(new RegExp(`(?:^|\\n)${escaped}:\\s*([^\\n]+)`, "i"));
  return cleanText(match?.[1] || "");
}

function cityFromAddress(address) {
  const parts = cleanText(address).split(",").map((part) => part.trim()).filter(Boolean);
  const provinceIndex = parts.findIndex((part) => /^Ontario$/i.test(part));
  return provinceIndex >= 1 ? parts[provinceIndex - 1] : "";
}

function splitCompanyAliases(value) {
  return cleanText(value)
    .split(/\s+(?:and|\/)\s+|,\s+/i)
    .map((part) => cleanText(part))
    .filter((part) => part.length >= 4);
}

function simplifyCompanyAlias(value) {
  return cleanText(value)
    .replace(/\b(?:incorporated|inc|ltd|limited|corp|corporation|company|co|ulc|lp|llc)\.?\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function companyIdentityTokens(value) {
  return normalizeSearchText(value)
    .split(/\s+/)
    .filter((token) => token.length >= 4 && !GENERIC_COMPANY_TOKENS.has(token));
}

function cleanPersonName(value) {
  const cleaned = cleanText(value)
    .replace(/^.*?\.\s+(?=[A-Z][a-z]+\s+[A-Z])/, "")
    .replace(/\bEmail\b/gi, "")
    .replace(/\b(?:MBA|CPA|P\.?Eng\.?|LinkedIn|Profile|Canada|Ontario)\b/gi, "")
    .replace(/[^A-Za-z'.\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!/^[A-Z][A-Za-z'.-]+(?:\s+[A-Z][A-Za-z'.-]+){1,4}$/.test(cleaned)) return "";
  if (/\b(?:company|foods?|beverage|bakery|operations|manager|director|production|plant|maintenance|quality|owner|founder|president|profile|linkedin)\b/i.test(cleaned)) return "";
  return cleaned;
}

function cleanText(value) {
  return decodeHtml(String(value || "")).replace(/\s+/g, " ").trim();
}

function normalizeSearchText(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\b(?:incorporated|inc|ltd|limited|corp|corporation|company|co|ulc|lp|llc|the)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueOrdered(values) {
  const seen = new Set();
  const output = [];
  for (const value of values) {
    const cleaned = cleanText(value);
    const key = cleaned.toLowerCase();
    if (!cleaned || seen.has(key)) continue;
    seen.add(key);
    output.push(cleaned);
  }
  return output;
}

function dedupeResults(results) {
  const seen = new Set();
  const output = [];
  for (const result of results) {
    const key = cleanText(result.url).replace(/[?#].*$/, "");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(result);
  }
  return output;
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, limit) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function defaultHeaders() {
  return {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36"
  };
}

function hostname(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
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
      return decodeBingUrl(resolved.searchParams.get("u"));
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
  if (!value) return "";
  const candidate = /^a\d/i.test(value) ? value.slice(2) : value;
  try {
    return Buffer.from(candidate, "base64").toString("utf8");
  } catch {
    return "";
  }
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

function stripTags(value) {
  return String(value || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

function slugFilename(value) {
  return normalizeSearchText(value).replace(/\s+/g, "-").slice(0, 170) || "query";
}

function titleCase(value) {
  return cleanText(value).toLowerCase().replace(/\b[a-z]/g, (char) => char.toUpperCase());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
