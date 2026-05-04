import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { enrichPlantLead } from "../plant-enrichment.mjs";
import { loadLocalEnv } from "../plant-verifier.mjs";
import { normalizeLeadCompanyName } from "./lead-records.mjs";
import { enrichFromWebsite } from "./enrich.mjs";
import { searchWeb, toCanonicalWebsiteUrl } from "./web-search.mjs";

const TARGET_TITLE_PATTERN = /\b(site director of manufacturing|director of manufacturing|manufacturing manager|manufacturing leader|manufacturing and operations leader|plant manager|plant superintendent|maintenance manager|maintenance supervisor|maintenance mechanic|millwright|maintenance technician|industrial mechanic|production manager|production supervisor|team lead|operations manager|operations leader|general manager|engineering manager|quality manager|materials and processing supervisor|site supervisor|logistics supervisor|logistics manager|dispatch manager|dispatch\s*&\s*logistics manager|purchas(?:er|ing)|buyer|procurement|supply chain|facilities manager|facility manager)\b/i;
const NON_PERSON_NAME_PATTERN = /\b(facility|facilities|plant|products?|services?|operations|manufacturing|company|team|careers?|contact|locations?|site|shop|home|office|virtual|tour|website|auto parts|food|water|healthcare|technology|aggregates?|construction|solutions|equipment)\b/i;
const DIRECTORY_DOMAIN_PATTERN = /(?:yellowpages|pagesjaunes|canada411|facebook|instagram|x\.com|twitter|yelp|zoominfo|dnb|opencorporates|glassdoor)\./i;
const SIGNAL_INCLUDE_PATTERN = /\b(hiring|hire|job opening|job posting|careers?|recruiting|recruitment|seeking|millwright|maintenance mechanic|maintenance technician|production operator|production supervisor|plant manager|operations manager|expansion|expand|expanding|expanded|new facility|new plant|new site|new production line|production line|capacity|permit|approval|environmental compliance approval|eca|construction|investment|investing|planned expansion)\b/i;
const SIGNAL_STRONG_PATTERN = /\b(hiring|job opening|job posting|careers?|millwright|maintenance|production|plant|operations|expansion|expanded|expanding|new facility|new plant|new site|new production line|capacity|permit|approval|eca|construction|investment|planned expansion)\b/i;
const SIGNAL_NOISE_PATTERN = /\b(address|phone|official site|about|located|product list|products?|capabilities|independent craft|proudly located|built in|refurbished|facility address|contact page|store hours|taproom|tour|brewery tours?|charity|award|ambassador|walk a mile|sponsor|sponsorship|fundraiser|customer review|excellent service|newsletter|recipe|holiday hours|giveaway|webinar|conference|podcast|blog)\b/i;
const SIGNAL_NOISE_OVERRIDE_PATTERN = /\b(hiring|hire|job opening|job posting|careers?|recruiting|expansion|expanded|expanding|planned expansion|new facility|new plant|new site|new production line|capacity|permit|approval|eca|construction|investment)\b/i;
const HTML_ENTITY_MAP = {
  "&amp;": "&",
  "&#038;": "&",
  "&#039;": "'",
  "&quot;": "\"",
  "&apos;": "'",
  "&nbsp;": " "
};
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function runCompanyEnrichment({
  manufacturerId,
  company,
  crmConfigPath,
  repoRoot,
  model = process.env.PLANT_ENRICHMENT_MODEL || "gpt-5-nano",
  websitePageLimit = 3,
  dryRun = false
} = {}) {
  const root = repoRoot || path.resolve(__dirname, "..", "..");
  await loadLocalEnv({ cwd: root });
  const configPath = crmConfigPath || path.join(root, "crm-config.js");
  const client = createPostgrestClient(await loadCrmConfig(configPath));
  const manufacturer = await resolveManufacturer(client, { manufacturerId, company });
  if (!manufacturer) {
    throw new Error("Company was not found in manufacturers.");
  }

  const existingContacts = await client.select("manufacturer_contacts", {
    select: "id,manufacturer_id,name,title,linkedin",
    filters: { manufacturer_id: `eq.${manufacturer.id}` },
    limit: 1000
  });

  const evidence = await buildCompanyEvidence(manufacturer, { websitePageLimit });
  const contacts = await findOperationsContacts(evidence, { model });
  const signals = await findHiringExpansionSignals(evidence);

  const newContactRows = contacts
    .filter((contact) => !hasExistingContact(existingContacts, contact))
    .map((contact) => ({
      manufacturer_id: manufacturer.id,
      name: contact.name,
      title: contact.title,
      linkedin: contact.linkedin || ""
    }));

  const nextTags = updateContactTags(manufacturer.tags, contacts);
  const nextSignals = upsertRecentSignalsSection(
    manufacturer.signals,
    formatRecentSignalsSection(signals)
  );

  if (!dryRun) {
    if (newContactRows.length) {
      await client.insert("manufacturer_contacts", newContactRows, {
        select: "id,manufacturer_id,name,title,linkedin"
      });
    }
    await client.patch("manufacturers", { id: `eq.${manufacturer.id}` }, {
      tags: nextTags,
      signals: nextSignals,
      last_enriched: new Date().toISOString()
    });
  }

  return {
    id: manufacturer.id,
    company: manufacturer.company,
    website: evidence.websiteUrl,
    contactsFound: contacts.length,
    contactsInserted: dryRun ? 0 : newContactRows.length,
    contactsToInsert: newContactRows.length,
    contacts,
    recentSignalsFound: signals.length,
    recentSignals: signals,
    tags: nextTags,
    signalsText: nextSignals,
    dryRun
  };
}

async function resolveManufacturer(client, { manufacturerId, company }) {
  if (manufacturerId !== undefined && manufacturerId !== null && String(manufacturerId).trim()) {
    const rows = await client.select("manufacturers", {
      select: "id,company,stage,industry,end_product,signals,tags,last_enriched",
      filters: { id: `eq.${manufacturerId}` },
      limit: 1
    });
    return rows[0] || null;
  }

  const needle = normalizeCompanyKey(company);
  if (!needle) {
    return null;
  }
  const rows = await client.select("manufacturers", {
    select: "id,company,stage,industry,end_product,signals,tags,last_enriched",
    limit: 5000
  });
  return rows.find((row) => normalizeCompanyKey(row.company) === needle) ||
    rows.find((row) => normalizeCompanyKey(row.company).includes(needle) || needle.includes(normalizeCompanyKey(row.company))) ||
    null;
}

async function buildCompanyEvidence(manufacturer, options) {
  const searchNameHints = extractSearchNameHints(manufacturer);
  const searchCompany = searchNameHints[0] || normalizeCompanySearchName(manufacturer.company);
  const city = extractLikelyCity(manufacturer.signals);
  const websiteHints = extractUrls(`${manufacturer.signals || ""}\n${manufacturer.end_product || ""}`);
  const websiteUrl = await resolveOfficialWebsite(searchNameHints, city, websiteHints);
  const profile = websiteUrl
    ? await enrichFromWebsite(websiteUrl, {
      pageLimit: options.websitePageLimit,
      expectedCity: city
    })
    : emptyProfile();

  const companyHints = uniqueOrdered([
    ...searchNameHints,
    normalizeCompanySearchName(profile.companyName)
  ].filter(Boolean));
  const peopleResults = await collectPeopleResults({ companyHints, city });
  const relevantPeopleResults = filterPeopleResultsByCompany(peopleResults, companyHints);

  const sourceUrls = new Set([
    ...websiteHints,
    cleanText(websiteUrl),
    ...toArray(profile.linkedInLinkList),
    ...relevantPeopleResults.map((result) => cleanText(result.url))
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
    ...relevantPeopleResults.slice(0, 24).map((result) => [cleanText(result.title), cleanText(result.snippet), cleanText(result.url)].filter(Boolean).join(" | "))
  ].filter(Boolean);

  return {
    manufacturer,
    searchCompany,
    searchNameHints,
    companyHints,
    city,
    websiteUrl,
    profile,
    peopleResults: relevantPeopleResults,
    packet: {
      company: searchCompany,
      source_urls: Array.from(sourceUrls),
      evidence,
      source_query: "per-company contacts and recent signals search",
      city,
      website: websiteUrl
    }
  };
}

function filterPeopleResultsByCompany(results, companyHints) {
  const phrases = buildCompanyPhrases(companyHints);
  const tokens = buildCompanyTokenSets(companyHints);
  return toArray(results).filter((result) =>
    matchesCompanyContext({
      titleText: cleanText(result?.title),
      snippet: cleanText(result?.snippet),
      companyPhrases: phrases,
      companyTokenSets: tokens
    })
  );
}

async function findOperationsContacts(evidence, { model }) {
  const heuristicContacts = dedupeContacts([
    ...extractWebsiteContacts(evidence.profile, evidence.websiteUrl),
    ...extractLinkedInContacts(evidence.peopleResults, evidence.companyHints)
  ]);

  let modelContacts = [];
  if (process.env.OPENAI_API_KEY) {
    try {
      const enriched = await enrichPlantLead(evidence.packet, { model, timeoutMs: 30000 });
      modelContacts = dedupeContacts(
        toArray(enriched.contacts).map((contact) => ({
          name: cleanText(contact?.name),
          title: cleanText(contact?.title || contact?.role_match),
          linkedin: normalizeLinkedInUrl(contact?.linkedin_url),
          source_url: cleanText(contact?.source_url),
          notes: cleanText(contact?.notes)
        }))
      );
    } catch {
      modelContacts = [];
    }
  }

  return dedupeContacts([...heuristicContacts, ...modelContacts])
    .filter(isUsefulContact)
    .slice(0, 8);
}

async function findHiringExpansionSignals(evidence) {
  const queries = buildRecentSignalQueries(evidence);
  const collected = [];

  for (const query of queries.slice(0, 14)) {
    try {
      const results = await searchWeb(query, {
        limit: 3,
        keepUrlPath: true,
        allowBlockedDomains: true,
        timeoutMs: 12000,
        skipPatterns: ["salary estimate", "resume", "charity", "award", "review"]
      });
      collected.push(...results.map((result) => ({ ...result, query })));
    } catch {
      continue;
    }
  }

  return dedupeSignals(
    collected
      .map((result) => normalizeSignalResult(result, evidence.companyHints))
      .filter(Boolean)
  ).slice(0, 5);
}

function buildRecentSignalQueries(evidence) {
  const company = evidence.searchCompany;
  const city = evidence.city || "Ontario";
  const host = normalizeHostname(evidence.websiteUrl);
  return uniqueOrdered([
    `"${company}" hiring maintenance ${city}`,
    `"${company}" hiring production ${city}`,
    `"${company}" hiring operations ${city}`,
    `"${company}" millwright ${city}`,
    `"${company}" plant manager ${city} hiring`,
    `"${company}" expansion ${city}`,
    `"${company}" "planned expansion" ${city}`,
    `"${company}" "new facility" ${city}`,
    `"${company}" "new plant" ${city}`,
    `"${company}" "production line" ${city}`,
    `"${company}" "capacity" ${city}`,
    `"${company}" "environmental compliance approval"`,
    `"${company}" ECA Ontario expansion`,
    host ? `site:${host} careers maintenance production operations` : "",
    host ? `site:${host} expansion "new facility" "new plant"` : ""
  ].filter(Boolean));
}

function normalizeSignalResult(result, companyHints) {
  const title = cleanText(result?.title);
  const snippet = cleanText(result?.snippet);
  const url = cleanText(result?.url);
  const text = `${title} ${snippet}`;
  if (!url || !SIGNAL_INCLUDE_PATTERN.test(text) || !SIGNAL_STRONG_PATTERN.test(text)) {
    return null;
  }
  if (SIGNAL_NOISE_PATTERN.test(text) && !SIGNAL_NOISE_OVERRIDE_PATTERN.test(text)) {
    return null;
  }
  if (!matchesCompanyContext({ titleText: title, snippet, companyPhrases: buildCompanyPhrases(companyHints), companyTokenSets: buildCompanyTokenSets(companyHints) })) {
    return null;
  }

  const type = /\b(hiring|job opening|career|recruit|millwright|maintenance mechanic|production operator|plant manager)\b/i.test(text)
    ? "Hiring"
    : "Expansion";
  return {
    type,
    title,
    snippet,
    url,
    date: extractDateHint(text),
    why: type === "Hiring"
      ? "Hiring signal tied to plant, maintenance, production, or operations capacity."
      : "Expansion/capacity signal tied to facilities, permits, production lines, or planned growth."
  };
}

function formatRecentSignalsSection(signals) {
  if (!signals.length) {
    return "No relevant hiring or expansion signal found after targeted search.";
  }

  return signals.map((signal) => [
    `Signal - ${signal.type}: ${signal.title}`,
    signal.date ? `Date - ${signal.date}` : "",
    signal.url ? `Source - ${signal.url}` : "",
    signal.snippet ? `Evidence - ${signal.snippet}` : "",
    `Why it matters - ${signal.why}`
  ].filter(Boolean).join("\n")).join("\n\n");
}

function upsertRecentSignalsSection(notes, sectionBody) {
  const heading = "**recent hiring / expansion signals**";
  const text = String(notes || "").trim();
  const replacement = `${heading}\n${sectionBody}`;
  const sectionPattern = /(?:\n\n)?\*\*(?:recent hiring \/ expansion signals|recent signals \/ changes \/ hiring\?)\*\*\s*[\s\S]*?(?=\n\n\*\*|$)/i;
  if (sectionPattern.test(text)) {
    return text.replace(sectionPattern, `\n\n${replacement}`).replace(/^\n+/, "").trim();
  }
  return [text, replacement].filter(Boolean).join("\n\n");
}

async function collectPeopleResults({ companyHints = [], city }) {
  const titles = [
    "operations manager",
    "maintenance manager",
    "plant manager",
    "production manager",
    "production supervisor",
    "general manager",
    "engineering manager",
    "maintenance supervisor",
    "millwright",
    "purchaser",
    "buyer",
    "procurement",
    "supply chain",
    "logistics manager"
  ];
  const queries = [];
  const locationHints = uniqueOrdered([city, "Ontario", "Canada", ""]);

  for (const hint of toArray(companyHints).slice(0, 3)) {
    for (const locationHint of locationHints) {
      queries.push(`site:linkedin.com/in "${hint}" ${locationHint ? `"${locationHint}"` : ""}`.trim());
      for (const title of titles) {
        queries.push(`site:linkedin.com/in "${hint}" "${title}" ${locationHint ? `"${locationHint}"` : ""}`.trim());
      }
    }
  }

  const collected = [];
  for (const query of uniqueOrdered(queries).slice(0, 22)) {
    try {
      const results = await searchWeb(query, {
        limit: 3,
        allowedDomains: ["linkedin.com"],
        keepUrlPath: true,
        skipPatterns: ["jobs", "/company/", "job opening"],
        timeoutMs: 12000
      });
      collected.push(...results);
    } catch {
      continue;
    }
  }

  return dedupeResultsByUrl(collected).slice(0, 28);
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
      if (!url || !matchesCompanyContext({ titleText, snippet, companyPhrases: phrases, companyTokenSets: tokens })) {
        return null;
      }
      const name = parseLinkedInName(titleText);
      const title = parseLinkedInRole(titleText, snippet);
      return {
        name,
        title,
        linkedin: url,
        source_url: url,
        notes: "LinkedIn public search result"
      };
    }).filter(Boolean)
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

function isUsefulContact(contact) {
  const name = cleanText(contact?.name);
  const title = cleanText(contact?.title);
  if (!looksLikePersonName(name) || !isUsefulContactTitle(title)) {
    return false;
  }
  if (NON_PERSON_NAME_PATTERN.test(name)) {
    return false;
  }
  return Boolean(contact.linkedin || contact.source_url || contact.notes);
}

function isUsefulContactTitle(title) {
  const text = cleanText(title);
  return !!text && text.length <= 110 && TARGET_TITLE_PATTERN.test(text);
}

function looksLikePersonName(value) {
  const text = cleanText(value);
  if (!/^[A-Z][A-Za-z'`.-]+(?:\s+[A-Z][A-Za-z'`.-]+){1,4}$/.test(text)) {
    return false;
  }
  return !NON_PERSON_NAME_PATTERN.test(text);
}

function parseLinkedInName(title) {
  const clean = cleanText(title).replace(/\s*\|\s*LinkedIn\s*$/i, "");
  const name = clean.split(/\s+-\s+/)[0] || "";
  return looksLikePersonName(name) ? name : "";
}

function parseLinkedInRole(title, snippet) {
  const cleanTitle = cleanText(title).replace(/\s*\|\s*LinkedIn\s*$/i, "");
  const parts = cleanTitle.split(/\s+-\s+/);
  if (parts.length > 1) {
    const role = cleanRoleText(parts.slice(1).join(" - "));
    if (isUsefulContactTitle(role)) {
      return role;
    }
  }

  const snippetMatch = cleanText(snippet).match(/^([^.|]{4,120}?)\s+at\s+/i);
  if (snippetMatch) {
    const role = cleanRoleText(snippetMatch[1]);
    if (isUsefulContactTitle(role)) {
      return role;
    }
  }

  return "";
}

function cleanRoleText(value) {
  return cleanText(value)
    .replace(/\s*\|\s*LinkedIn.*$/i, "")
    .replace(/\s+[Â·|].*$/, "")
    .replace(/^experience:\s*/i, "")
    .replace(/\s+at\s+.*$/i, "")
    .replace(/^[-,|]+|[-,|]+$/g, "")
    .trim();
}

function updateContactTags(existingTags, contacts) {
  const tagList = normalizeTagArray(existingTags).filter((tag) =>
    tag !== "contact:missing" &&
    tag !== "contact:public-named" &&
    tag !== "contact:linkedin-direct" &&
    tag !== "needs-contact-backfill"
  );
  if (!contacts.length) {
    tagList.push("contact:missing", "needs-contact-backfill");
  } else if (contacts.some((contact) => cleanText(contact.linkedin))) {
    tagList.push("contact:linkedin-direct");
  } else {
    tagList.push("contact:public-named");
  }
  return uniqueOrdered(tagList);
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

function dedupeContacts(contacts) {
  const seen = new Set();
  const unique = [];
  for (const contact of toArray(contacts)) {
    const name = cleanText(contact?.name);
    const title = cleanText(contact?.title);
    const linkedin = normalizeLinkedInUrl(contact?.linkedin);
    const key = `${normalizeCompanyKey(name)}::${normalizeCompanyKey(title)}::${linkedin}`;
    if (!name || !title || seen.has(key)) {
      continue;
    }
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

function dedupeSignals(signals) {
  const seen = new Set();
  const unique = [];
  for (const signal of signals) {
    const key = normalizeResultUrl(signal.url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(signal);
  }
  return unique;
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

function buildCompanyPhrases(companyHints = []) {
  return uniqueOrdered(toArray(companyHints).map((hint) => normalizeCompanyKey(hint)).filter((hint) => hint.length >= 4));
}

function buildCompanyTokenSets(companyHints = []) {
  return uniqueOrdered(toArray(companyHints).map((hint) => normalizeCompanySearchName(hint)).filter(Boolean))
    .map((hint) => tokenizeCompanyName(hint).filter((token) => token.length >= 4))
    .filter((tokens) => tokens.length >= 1);
}

function tokenizeCompanyName(value) {
  return normalizeCompanyKey(value)
    .split(" ")
    .filter((token) => token.length > 1)
    .filter((token) => !["and", "the", "inc", "ltd", "limited", "corp", "company", "group", "products", "services", "solutions"].includes(token));
}

function extractLikelyCity(text) {
  const match = String(text || "").match(/\b(Toronto|Mississauga|Brampton|Vaughan|Markham|Pickering|Oshawa|Cambridge|Guelph|Hamilton|Kitchener|Waterloo|Burlington|Oakville|Whitby|Ajax|Aurora|Bradford|Milton|Welland|St\.?\s*Catharines|Thorold|Niagara Falls|Richmond Hill|Scarborough|North York|Etobicoke|Concord|Woodbridge|Gormley)\b/i);
  return cleanText(match?.[0]);
}

function extractUrls(text) {
  return uniqueOrdered(
    Array.from(String(text || "").matchAll(/https?:\/\/[^\s)]+/gi))
      .map((match) => cleanText(match[0]).replace(/[.,;]+$/, ""))
      .filter(Boolean)
  );
}

function extractDateHint(text) {
  const value = cleanText(text);
  const monthMatch = value.match(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+20\d{2}\b/i);
  if (monthMatch) return monthMatch[0];
  const yearMatch = value.match(/\b20(?:24|25|26)\b/);
  return yearMatch?.[0] || "";
}

function normalizeHostname(value) {
  try {
    return new URL(value).hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
}

function normalizeResultUrl(value) {
  try {
    const parsed = new URL(value);
    parsed.hash = "";
    parsed.search = "";
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return cleanText(value);
  }
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

function normalizeTagArray(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => cleanText(entry)).filter(Boolean);
  }
  return String(value || "")
    .split("|")
    .map((entry) => cleanText(entry))
    .filter(Boolean);
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
  return { supabaseUrl, apiKey };
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
      if (limit) url.searchParams.set("limit", String(limit));
      for (const [key, value] of Object.entries(filters || {})) {
        url.searchParams.set(key, value);
      }
      if (order?.column) {
        url.searchParams.set("order", `${order.column}.${order.ascending === false ? "desc" : "asc"}`);
      }
      return requestJson(url, {
        method: "GET",
        headers: { ...headers, Accept: "application/json" }
      });
    },
    async insert(table, rows, { select = "" } = {}) {
      const url = new URL(`${baseUrl}/${table}`);
      if (select) url.searchParams.set("select", select);
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
  const data = parseJsonResponseBody(text, response);
  if (!response.ok) {
    const message = cleanText(data?.message || data?.error_description || text) || `${response.status} ${response.statusText}`;
    throw new Error(message);
  }
  return data;
}

function parseJsonResponseBody(text, response) {
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    const preview = cleanText(text).slice(0, 240);
    throw new Error(`Supabase returned non-JSON (${response.status} ${response.statusText}): ${preview || "empty response"}`);
  }
}

function decodeHtmlEntities(value) {
  let output = String(value || "");
  for (const [entity, replacement] of Object.entries(HTML_ENTITY_MAP)) {
    output = output.split(entity).join(replacement);
  }
  return output.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code) || 0));
}

function normalizeCompanyKey(value) {
  return decodeHtmlEntities(String(value || ""))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function cleanText(value) {
  return decodeHtmlEntities(String(value || "").replace(/\s+/g, " ")).trim();
}

function uniqueOrdered(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}
