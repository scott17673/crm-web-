import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { loadLocalEnv } from "./plant-verifier.mjs";
import { enrichPlantLead } from "./plant-enrichment.mjs";
import { normalizeLeadCompanyName } from "./runtime_lib/lead-records.mjs";
import { enrichFromWebsite } from "./runtime_lib/enrich.mjs";
import { searchWeb, toCanonicalWebsiteUrl } from "./runtime_lib/web-search.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const SKIP_STAGES = new Set(["Closed Lost", "Unqualified"]);
const DIRECTORY_DOMAIN_PATTERN = /(?:yellowpages|pagesjaunes|canada411|linkedin|facebook|instagram|x\.com|twitter|yelp|zoominfo|dnb|opencorporates|glassdoor)\./i;
const TARGET_TITLE_PATTERN = /\b(site director of manufacturing|director of manufacturing|manufacturing manager|manufacturing leader|manufacturing and operations leader|plant manager|maintenance manager|maintenance supervisor|maintenance mechanic|millwright|maintenance technician|industrial mechanic|production manager|production supervisor|team lead|operations manager|operations leader|general manager|engineering manager|quality manager|materials and processing supervisor|site supervisor|logistics supervisor|logistics manager|dispatch manager|dispatch\s*&\s*logistics manager|purchas(?:er|ing)|buyer|procurement|supply chain)\b/i;
const GENERIC_COMPANY_WORDS = new Set([
  "and",
  "co",
  "company",
  "corp",
  "corporation",
  "group",
  "inc",
  "incorporated",
  "limited",
  "ltd",
  "manufacturing",
  "solutions",
  "plus",
  "products",
  "product",
  "services",
  "service",
  "the"
]);
const HTML_ENTITY_MAP = {
  "&amp;": "&",
  "&#038;": "&",
  "&#039;": "'",
  "&quot;": "\"",
  "&apos;": "'",
  "&nbsp;": " "
};
const DEFAULTS = {
  sinceUtc: "2026-04-22T04:00:00Z",
  model: process.env.PLANT_ENRICHMENT_MODEL || "gpt-5-nano",
  limit: 0,
  company: "",
  dryRun: false,
  websitePageLimit: 3,
  outDir: path.join(__dirname, "test-output"),
  skipModel: false
};

async function main() {
  await loadLocalEnv({ cwd: repoRoot });
  const options = parseArgs(process.argv.slice(2));
  const crmConfig = await loadCrmConfig(path.join(repoRoot, "crm-config.js"));
  const client = createPostgrestClient(crmConfig);

  const manufacturers = await client.select("manufacturers", {
    select: "id,company,stage,industry,created_at,tags,end_product,signals,last_enriched",
    filters: {
      created_at: `gte.${options.sinceUtc}`
    },
    order: { column: "created_at", ascending: false },
    limit: 5000
  });
  const contacts = await client.select("manufacturer_contacts", {
    select: "id,manufacturer_id,name,title,linkedin",
    limit: 50000
  });

  const validContactIds = new Set();
  const existingContactsByManufacturer = new Map();
  for (const row of toArray(contacts)) {
    if (!existingContactsByManufacturer.has(row.manufacturer_id)) {
      existingContactsByManufacturer.set(row.manufacturer_id, []);
    }
    existingContactsByManufacturer.get(row.manufacturer_id).push(row);
    if (cleanText(row?.name) && cleanText(row?.title)) {
      validContactIds.add(Number(row.manufacturer_id));
    }
  }

  let targets = toArray(manufacturers)
    .filter((row) => !SKIP_STAGES.has(cleanText(row?.stage)))
    .filter((row) => hasPlantVerifiedTag(row?.tags))
    .filter((row) => !validContactIds.has(Number(row.id)));

  if (options.company) {
    const needle = normalizeCompanyKey(options.company);
    targets = targets.filter((row) => normalizeCompanyKey(row.company).includes(needle));
  }
  if (options.limit > 0) {
    targets = targets.slice(0, options.limit);
  }

  console.log(`Target manufacturers missing contacts: ${targets.length}`);

  const summary = [];
  for (let index = 0; index < targets.length; index += 1) {
    const manufacturer = targets[index];
    const label = `${index + 1}/${targets.length} ${manufacturer.company}`;
    console.log(`\nProcessing ${label}`);
    try {
      const evidence = await buildBackfillEvidence(manufacturer, options);
      const heuristicContacts = dedupeContacts([
        ...extractWebsiteContacts(evidence.profile, evidence.websiteUrl),
        ...extractLinkedInContacts(evidence.peopleResults, evidence.searchNameHints)
      ]);

      let modelContacts = [];
      let modelStatus = "skipped";
      if (!options.skipModel && heuristicContacts.length === 0) {
        try {
          const enriched = await enrichPlantLead(evidence.packet, {
            model: options.model
          });
          modelContacts = dedupeContacts(
            toArray(enriched.contacts).map((contact) => ({
              name: cleanText(contact?.name),
              title: cleanText(contact?.title),
              linkedin: normalizeLinkedInUrl(contact?.linkedin_url),
              source_url: cleanText(contact?.source_url),
              notes: cleanText(contact?.notes)
            }))
              .filter((contact) => isUsefulContactTitle(contact.title))
              .filter((contact) => !looksNegativeContactNote(contact.notes))
          );
          modelStatus = enriched.contact_search_status || "done";
        } catch (error) {
          modelStatus = `error: ${error instanceof Error ? error.message : String(error)}`;
        }
      }

      const mergedContacts = dedupeContacts([
        ...heuristicContacts,
        ...modelContacts
      ]).filter((contact) => cleanText(contact.name) && cleanText(contact.title));

      if (!mergedContacts.length) {
        console.log(`  No contacts found. Model: ${modelStatus}`);
        summary.push({
          id: manufacturer.id,
          company: manufacturer.company,
          inserted: 0,
          modelStatus,
          website: evidence.websiteUrl,
          contacts: []
        });
        continue;
      }

      const existingRows = existingContactsByManufacturer.get(manufacturer.id) || [];
      const rowsToInsert = mergedContacts
        .filter((contact) => !hasExistingContact(existingRows, contact))
        .map((contact) => ({
          manufacturer_id: manufacturer.id,
          name: contact.name,
          title: contact.title,
          linkedin: contact.linkedin || ""
        }));

      if (!rowsToInsert.length) {
        console.log(`  Found ${mergedContacts.length} contact(s), but they already exist.`);
        summary.push({
          id: manufacturer.id,
          company: manufacturer.company,
          inserted: 0,
          modelStatus,
          website: evidence.websiteUrl,
          contacts: mergedContacts.map((contact) => `${contact.name} | ${contact.title}`)
        });
        continue;
      }

      if (!options.dryRun) {
        await client.insert("manufacturer_contacts", rowsToInsert, { select: "id,manufacturer_id,name,title,linkedin" });
        await updateManufacturerTags(client, manufacturer, mergedContacts);
      }

      console.log(`  Inserted ${rowsToInsert.length} contact(s). Model: ${modelStatus}`);
      for (const contact of rowsToInsert.slice(0, 5)) {
        console.log(`    - ${contact.name} | ${contact.title}${contact.linkedin ? ` | ${contact.linkedin}` : ""}`);
      }
      summary.push({
        id: manufacturer.id,
        company: manufacturer.company,
        inserted: rowsToInsert.length,
        modelStatus,
        website: evidence.websiteUrl,
        contacts: rowsToInsert.map((contact) => `${contact.name} | ${contact.title}`)
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`  Failed: ${message}`);
      summary.push({
        id: manufacturer.id,
        company: manufacturer.company,
        inserted: 0,
        modelStatus: `failed: ${message}`,
        website: "",
        contacts: []
      });
    }
  }

  await mkdir(options.outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const summaryPath = path.join(options.outDir, `backfill-missing-contacts-${stamp}.json`);
  await writeFile(summaryPath, JSON.stringify({
    ran_at: new Date().toISOString(),
    options,
    processed: summary.length,
    inserted_total: summary.reduce((sum, row) => sum + Number(row.inserted || 0), 0),
    summary
  }, null, 2), "utf8");
  console.log(`\nSummary written to ${summaryPath}`);
}

async function buildBackfillEvidence(manufacturer, options) {
  const searchNameHints = extractSearchNameHints(manufacturer);
  const searchCompany = searchNameHints[0] || normalizeCompanySearchName(manufacturer.company);
  const city = extractLikelyCity(manufacturer.signals);
  const websiteHints = extractUrls(`${manufacturer.signals}\n${manufacturer.end_product || ""}`);
  const websiteUrl = await resolveOfficialWebsite(searchNameHints, city, websiteHints);
  const profile = websiteUrl
    ? await enrichFromWebsite(websiteUrl, {
        pageLimit: options.websitePageLimit,
        expectedCity: city
      })
    : emptyProfile();
  const peopleResults = await collectPeopleResults({
    companyHints: uniqueOrdered([
      ...searchNameHints,
      normalizeCompanySearchName(profile.companyName)
    ]).filter(Boolean),
    city,
  });

  const sourceUrls = new Set([
    ...websiteHints,
    cleanText(websiteUrl),
    ...toArray(profile.linkedInLinkList),
    ...peopleResults.map((result) => cleanText(result.url))
  ].filter(Boolean));

  const evidence = [
    cleanText(manufacturer.signals),
    cleanText(manufacturer.end_product) ? `Existing CRM end products: ${cleanText(manufacturer.end_product)}` : "",
    cleanText(profile.companyName) ? `Official site company name: ${cleanText(profile.companyName)}` : "",
    cleanText(profile.formattedAddress) ? `Official site address: ${cleanText(profile.formattedAddress)}` : "",
    cleanText(profile.phone) ? `Official site phone: ${cleanText(profile.phone)}` : "",
    cleanText(profile.endProducts) ? `Official site products/capabilities: ${cleanText(profile.endProducts)}` : "",
    ...toArray(profile.contacts).slice(0, 8).map((contact) => [cleanText(contact?.name), cleanText(contact?.title), cleanText(contact?.email), normalizeLinkedInUrl(contact?.linkedin)].filter(Boolean).join(" | ")),
    ...toArray(profile.linkedInLinkList).slice(0, 8).map((url) => `LinkedIn URL exposed by company/public page: ${cleanText(url)}`),
    ...peopleResults.slice(0, 18).map((result) => [cleanText(result.title), cleanText(result.snippet), cleanText(result.url)].filter(Boolean).join(" | "))
  ].filter(Boolean);

  return {
    searchCompany,
    searchNameHints,
    city,
    websiteUrl,
    profile,
    peopleResults,
    packet: {
      company: searchCompany,
      source_urls: Array.from(sourceUrls),
      evidence,
      source_query: "contact backfill",
      city,
      website: websiteUrl
    }
  };
}

async function collectPeopleResults({ companyHints = [], city }) {
  const queries = [];
  const locationHints = uniqueOrdered([city, "Ontario", "Canada", ""]);

  for (const hint of toArray(companyHints).slice(0, 3)) {
    for (const locationHint of locationHints) {
      queries.push(`site:linkedin.com/in "${hint}" ${locationHint ? `"${locationHint}"` : ""}`.trim());
      for (const title of [
        "production manager",
        "operations manager",
        "maintenance manager",
        "plant manager",
        "general manager",
        "engineering manager",
        "maintenance supervisor",
        "purchaser"
      ]) {
        queries.push(`site:linkedin.com/in "${hint}" "${title}" ${locationHint ? `"${locationHint}"` : ""}`.trim());
      }
    }
  }

  const collected = [];
  for (const query of uniqueOrdered(queries).slice(0, 18)) {
    try {
      const results = await searchWeb(query, {
        limit: 3,
        allowedDomains: ["linkedin.com"],
        keepUrlPath: true,
        skipPatterns: ["jobs", "/company/", "job opening"]
      });
      collected.push(...results);
    } catch {
      continue;
    }
  }

  return dedupeResultsByUrl(collected).slice(0, 20);
}

function extractWebsiteContacts(profile, websiteUrl) {
  return dedupeContacts(
    toArray(profile?.contacts)
      .map((contact) => ({
        name: cleanText(contact?.name),
        title: cleanText(contact?.title),
        linkedin: normalizeLinkedInUrl(contact?.linkedin),
        source_url: cleanText(websiteUrl),
        notes: "Official site contact/team page"
      }))
      .filter((contact) => cleanText(contact.name) && isUsefulContactTitle(contact.title))
  );
}

function extractLinkedInContacts(results, companyHints) {
  const phrases = buildCompanyPhrases(companyHints);
  const tokens = buildCompanyTokenSets(companyHints);
  return dedupeContacts(
    toArray(results).map((result) => {
      const titleText = cleanText(result?.title);
      const snippet = cleanText(result?.snippet);
      const url = normalizeLinkedInUrl(result?.url);
      if (!matchesCompanyContext({ titleText, snippet, companyPhrases: phrases, companyTokenSets: tokens })) {
        return null;
      }
      const name = parseLinkedInName(titleText);
      const parsedTitle = parseLinkedInRole(titleText, snippet, null);
      return {
        name,
        title: parsedTitle,
        linkedin: url,
        source_url: url,
        notes: "LinkedIn public search result"
      };
    }).filter(Boolean).filter((contact) => cleanText(contact.name) && isUsefulContactTitle(contact.title))
  );
}

async function resolveOfficialWebsite(company, city, urls) {
  const direct = toArray(urls).find((url) => !DIRECTORY_DOMAIN_PATTERN.test(url));
  if (direct) {
    return toCanonicalWebsiteUrl(direct);
  }

  const companyPhrases = buildCompanyPhrases(company);
  const companyTokenSets = buildCompanyTokenSets(company);

  const queries = uniqueOrdered([
    ...toArray(company).flatMap((name) => [
      `"${name}" ${city ? `"${city}"` : "\"Ontario\""} official site`,
      `"${name}" ${city ? `"${city}"` : "\"Ontario\""}`,
      `"${name}" contact`
    ])
  ]);

  for (const query of queries) {
    try {
      const results = await searchWeb(query, {
        limit: 5,
        skipPatterns: ["yellowpages", "pagesjaunes", "directory", "linkedin", "facebook", "instagram"]
      });
      const match = results.find((result) =>
        !DIRECTORY_DOMAIN_PATTERN.test(cleanText(result?.url)) &&
        matchesCompanyContext({
          titleText: cleanText(result?.title),
          snippet: cleanText(result?.snippet),
          companyPhrases,
          companyTokenSets
        })
      );
      if (match?.url) {
        return toCanonicalWebsiteUrl(match.url);
      }
    } catch {
      continue;
    }
  }

  return "";
}

async function updateManufacturerTags(client, manufacturer, contacts) {
  const tagList = normalizeTagArray(manufacturer.tags).filter((tag) =>
    tag !== "contact:missing" &&
    tag !== "contact:public-named" &&
    tag !== "contact:linkedin-direct"
  );
  const hasLinkedIn = contacts.some((contact) => cleanText(contact.linkedin));
  tagList.push(hasLinkedIn ? "contact:linkedin-direct" : "contact:public-named");
  const uniqueTags = uniqueOrdered(tagList);
  await client.patch("manufacturers", {
    id: `eq.${manufacturer.id}`
  }, {
    tags: uniqueTags,
    last_enriched: new Date().toISOString()
  });
}

function hasExistingContact(existingRows, nextContact) {
  const nextName = normalizeCompanyKey(nextContact.name);
  const nextTitle = normalizeCompanyKey(nextContact.title);
  const nextLinkedIn = normalizeLinkedInUrl(nextContact.linkedin);
  return toArray(existingRows).some((row) => {
    const sameName = normalizeCompanyKey(row?.name) === nextName;
    const sameTitle = normalizeCompanyKey(row?.title) === nextTitle;
    const sameLinkedIn = normalizeLinkedInUrl(row?.linkedin) === nextLinkedIn;
    return (sameName && sameTitle) || (nextLinkedIn && sameLinkedIn);
  });
}

function parseLinkedInName(title) {
  const clean = cleanText(title).replace(/\s*\|\s*LinkedIn\s*$/i, "");
  const name = clean.split(/\s+-\s+/)[0] || "";
  return looksLikePersonName(name) ? name : "";
}

function parseLinkedInRole(title, snippet, companyPattern) {
  const cleanTitle = cleanText(title).replace(/\s*\|\s*LinkedIn\s*$/i, "");
  const parts = cleanTitle.split(/\s+-\s+/);
  if (parts.length > 1) {
    const rolePart = cleanLinkedInRoleText(parts.slice(1).join(" - "), companyPattern);
    if (isUsefulContactTitle(rolePart)) {
      return rolePart;
    }
  }

  const snippetMatch = cleanText(snippet).match(/^([^.|]{4,120}?)\s+at\s+/i);
  if (snippetMatch) {
    const rolePart = cleanLinkedInRoleText(snippetMatch[1], companyPattern);
    if (isUsefulContactTitle(rolePart)) {
      return rolePart;
    }
  }

  return "";
}

function cleanLinkedInRoleText(value, companyPattern) {
  let text = cleanText(value)
    .replace(/\s*\|\s*LinkedIn.*$/i, "")
    .replace(/\s+[·|].*$/, "")
    .replace(/^experience:\s*/i, "")
    .replace(/\s+at\s+.*$/i, "")
    .trim();
  if (companyPattern) {
    text = text.replace(companyPattern, "").trim();
  }
  text = text.replace(/^[-,|]+|[-,|]+$/g, "").trim();
  if (!text || text.length > 120) {
    return "";
  }
  return text;
}

function isUsefulContactTitle(title) {
  const text = cleanText(title);
  if (!text) return false;
  if (text.length > 90) return false;
  return TARGET_TITLE_PATTERN.test(text);
}

function looksNegativeContactNote(note) {
  return /\b(unrelated|not aligned|wrong company|unclear|uncertain|not verified|stale)\b/i.test(cleanText(note));
}

function looksLikePersonName(value) {
  const text = cleanText(value);
  return /^[A-Z][A-Za-z'`.-]+(?:\s+[A-Z][A-Za-z'`.-]+){1,4}$/.test(text);
}

function buildCompanyPattern(company) {
  const parts = buildCompanyTokens(company).map((part) => escapeRegex(part));
  if (!parts.length) return null;
  return new RegExp(`\\b(?:${parts.join("|")})\\b`, "ig");
}

function buildCompanyTokens(company) {
  return normalizeCompanySearchName(company)
    .toLowerCase()
    .split(/\s+/)
    .map((part) => part.replace(/[^a-z0-9]/g, ""))
    .filter((part) => part.length >= 3)
    .filter((part) => !GENERIC_COMPANY_WORDS.has(part));
}

function buildCompanyPhrases(companyHints) {
  return uniqueOrdered(
    toArray(companyHints)
      .map((hint) => normalizeCompanyKey(hint))
      .filter((phrase) => phrase.length >= 8)
  );
}

function buildCompanyTokenSets(companyHints) {
  return uniqueOrdered(
    toArray(companyHints)
      .map((hint) => buildCompanyTokens(hint))
      .filter((tokens) => tokens.length >= 2)
      .map((tokens) => tokens.join(" "))
  ).map((joined) => joined.split(" "));
}

function matchesCompanyContext({ titleText, snippet, companyPhrases = [], companyTokenSets = [] }) {
  const haystack = normalizeCompanyKey(`${cleanText(titleText)} ${cleanText(snippet)}`);
  if (!haystack.trim()) return false;
  for (const phrase of companyPhrases) {
    if (haystack.includes(phrase)) {
      return true;
    }
  }
  for (const tokens of companyTokenSets) {
    if (tokens.every((token) => haystack.includes(token))) {
      return true;
    }
  }
  return false;
}

function normalizeCompanySearchName(value) {
  return decodeHtmlEntities(
    normalizeLeadCompanyName(String(value || ""))
      .replace(/^(contact|contacts|product|products|about|location|locations|home|homepage)\s*-\s*/i, "")
      .replace(/\s+-\s+\d{1,6}\s+.*$/i, "")
      .replace(/^[-"' ]+|[-"' ]+$/g, "")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function extractSearchNameHints(manufacturer) {
  const hints = [
    normalizeCompanySearchName(manufacturer?.company)
  ];
  const lines = String(manufacturer?.signals || "").split(/\r?\n/);
  for (const rawLine of lines.slice(0, 14)) {
    const left = cleanText(rawLine.split("|")[0]);
    if (!left) continue;
    const stripped = normalizeCompanySearchName(
      left
        .replace(/\s+-\s+(?:[^|]*?)\b(facility|plant|operations|warehouse|site|location)\b.*$/i, "")
        .replace(/\(([^)]+)\)/g, " $1 ")
    );
    if (stripped && stripped.length >= 4) {
      hints.push(stripped);
    }
  }
  return uniqueOrdered(hints).slice(0, 4);
}

function extractLikelyCity(text) {
  const match = String(text || "").match(/\b(Toronto|Mississauga|Brampton|Vaughan|Markham|Pickering|Oshawa|Cambridge|Guelph|Hamilton|Kitchener|Waterloo|Burlington|Oakville|Whitby|Ajax|Aurora|Bradford|Milton|Welland|St\.?\s*Catharines|Thorold|Niagara Falls|Richmond Hill|Scarborough|North York|Etobicoke|Concord|Woodbridge|Gormley|Burlington)\b/i);
  return cleanText(match?.[0]);
}

function extractUrls(text) {
  return uniqueOrdered(
    Array.from(String(text || "").matchAll(/https?:\/\/[^\s)]+/gi))
      .map((match) => cleanText(match[0]).replace(/[.,;]+$/, ""))
      .filter(Boolean)
  );
}

function decodeHtmlEntities(value) {
  let output = String(value || "");
  for (const [entity, replacement] of Object.entries(HTML_ENTITY_MAP)) {
    output = output.split(entity).join(replacement);
  }
  return output.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code) || 0));
}

function normalizeLinkedInUrl(value) {
  const url = cleanText(value);
  if (!/linkedin\.com\/in\//i.test(url)) {
    return "";
  }
  try {
    const parsed = new URL(url);
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

function hasPlantVerifiedTag(tags) {
  return normalizeTagArray(tags).includes("plant-verified");
}

function normalizeTagArray(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => cleanText(entry)).filter(Boolean);
  }
  return String(value || "")
    .split("|")
    .map((entry) => cleanText(entry))
    .filter(Boolean);
}

function dedupeContacts(contacts) {
  const seen = new Set();
  const unique = [];
  for (const contact of toArray(contacts)) {
    const name = cleanText(contact?.name);
    const title = cleanText(contact?.title);
    const linkedin = normalizeLinkedInUrl(contact?.linkedin);
    if (!name || !title) continue;
    const key = `${normalizeCompanyKey(name)}::${normalizeCompanyKey(title)}::${linkedin}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({
      name,
      title,
      linkedin,
      source_url: cleanText(contact?.source_url),
      notes: cleanText(contact?.notes)
    });
  }
  return unique;
}

function dedupeResultsByUrl(results) {
  const seen = new Set();
  const unique = [];
  for (const result of toArray(results)) {
    const url = cleanText(result?.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    unique.push(result);
  }
  return unique;
}

function normalizeCompanyKey(value) {
  return decodeHtmlEntities(String(value || ""))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cleanText(value) {
  return decodeHtmlEntities(String(value || "").replace(/\s+/g, " ")).trim();
}

function toArray(value) {
  return Array.isArray(value) ? value : (value ? [value] : []);
}

function uniqueOrdered(values) {
  return Array.from(new Set(toArray(values).filter(Boolean)));
}

function emptyProfile() {
  return {
    companyName: "",
    formattedAddress: "",
    phone: "",
    endProducts: "",
    contacts: [],
    linkedInLinkList: []
  };
}

async function loadCrmConfig(filePath) {
  const text = await readFile(filePath, "utf8");
  const match = text.match(/(?:window\.)?CRM_CONFIG\s*=\s*(\{[\s\S]*\})\s*;?\s*$/);
  if (!match?.[1]) {
    throw new Error(`Unsupported CRM config format in ${filePath}`);
  }
  const config = JSON.parse(match[1]);
  const supabaseUrl = cleanText(config?.supabaseUrl).replace(/\/+$/, "");
  const apiKey = cleanText(config?.supabaseServiceRoleKey || config?.supabaseKey || config?.supabaseAnonKey);
  if (!supabaseUrl || !apiKey) {
    throw new Error("CRM config is missing a Supabase URL or key.");
  }
  return {
    supabaseUrl,
    apiKey
  };
}

function createPostgrestClient(config) {
  const baseUrl = `${config.supabaseUrl}/rest/v1`;
  const headers = {
    apikey: config.apiKey,
    Authorization: `Bearer ${config.apiKey}`
  };

  return {
    async select(table, { select = "*", filters = {}, order = null, limit = 1000 } = {}) {
      const url = new URL(`${baseUrl}/${table}`);
      url.searchParams.set("select", select);
      if (limit) {
        url.searchParams.set("limit", String(limit));
      }
      for (const [key, value] of Object.entries(filters || {})) {
        url.searchParams.set(key, value);
      }
      if (order?.column) {
        url.searchParams.set("order", `${order.column}.${order.ascending === false ? "desc" : "asc"}`);
      }
      return requestJson(url, {
        method: "GET",
        headers: {
          ...headers,
          Accept: "application/json"
        }
      });
    },
    async insert(table, rows, { select = "" } = {}) {
      const url = new URL(`${baseUrl}/${table}`);
      if (select) {
        url.searchParams.set("select", select);
      }
      return requestJson(url, {
        method: "POST",
        headers: {
          ...headers,
          Accept: "application/json",
          "Content-Type": "application/json",
          Prefer: "return=representation"
        },
        body: JSON.stringify(rows)
      });
    },
    async patch(table, filters, payload) {
      const url = new URL(`${baseUrl}/${table}`);
      for (const [key, value] of Object.entries(filters || {})) {
        url.searchParams.set(key, value);
      }
      return requestJson(url, {
        method: "PATCH",
        headers: {
          ...headers,
          Accept: "application/json",
          "Content-Type": "application/json",
          Prefer: "return=representation"
        },
        body: JSON.stringify(payload)
      });
    }
  };
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message = cleanText(data?.message || data?.error_description || text) || `${response.status} ${response.statusText}`;
    throw new Error(message);
  }
  return data;
}

function parseArgs(args) {
  const parsed = { ...DEFAULTS };
  for (const arg of args) {
    if (arg.startsWith("--since=")) parsed.sinceUtc = cleanText(arg.slice("--since=".length));
    else if (arg.startsWith("--limit=")) parsed.limit = Number(arg.slice("--limit=".length)) || 0;
    else if (arg.startsWith("--company=")) parsed.company = cleanText(arg.slice("--company=".length));
    else if (arg.startsWith("--model=")) parsed.model = cleanText(arg.slice("--model=".length)) || parsed.model;
    else if (arg === "--dry-run") parsed.dryRun = true;
    else if (arg === "--skip-model") parsed.skipModel = true;
  }
  return parsed;
}

await main();
