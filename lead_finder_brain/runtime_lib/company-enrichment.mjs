import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { enrichPlantLead } from "../plant-enrichment.mjs";
import { loadLocalEnv } from "../plant-verifier.mjs";
import { normalizeLeadCompanyName } from "./lead-records.mjs";
import { enrichFromWebsite } from "./enrich.mjs";
import { searchWeb, toCanonicalWebsiteUrl } from "./web-search.mjs";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const DEFAULT_CONTACT_SEARCH_MODEL = process.env.OPENAI_CONTACT_SEARCH_MODEL || process.env.PLANT_ENRICHMENT_MODEL || "gpt-5-nano";
const TARGET_TITLE_TERMS = [
  "site director of manufacturing",
  "director of manufacturing",
  "manufacturing manager",
  "manufacturing supervisor",
  "manufacturing leader",
  "manufacturing and operations leader",
  "plant manager",
  "plant supervisor",
  "plant superintendent",
  "operations manager",
  "operations supervisor",
  "operations leader",
  "operations",
  "operator",
  "acquirer",
  "owner",
  "partner",
  "board member",
  "production manager",
  "production supervisor",
  "production lead",
  "team lead",
  "lead hand",
  "maintenance manager",
  "maintenance supervisor",
  "maintenance mechanic",
  "millwright",
  "maintenance technician",
  "industrial mechanic",
  "engineering manager",
  "quality manager",
  "quality assurance",
  "quality control",
  "qa manager",
  "qa supervisor",
  "qa specialist",
  "qa technician",
  "quality assurance specialist",
  "haccp coordinator",
  "food safety",
  "technical services",
  "materials and processing supervisor",
  "site supervisor",
  "warehouse manager",
  "warehouse supervisor",
  "logistics supervisor",
  "logistics manager",
  "shipping manager",
  "receiving manager",
  "inventory manager",
  "dispatch manager",
  "dispatch\\s*&\\s*logistics manager",
  "purchas(?:er|ing)",
  "purchasing manager",
  "buyer",
  "procurement",
  "procurement manager",
  "supply chain",
  "supply chain manager",
  "facilities manager",
  "facility manager",
  "supervisor",
  "sanitation worker",
  "machine operator",
  "general manager"
];
const TARGET_TITLE_PATTERN = new RegExp(`\\b(?:${TARGET_TITLE_TERMS.join("|")})\\b`, "i");
const NON_PERSON_NAME_PATTERN = /\b(facility|facilities|plant|products?|services?|operations|manufacturing|company|team|careers?|contact|locations?|site|shop|home|office|virtual|tour|website|auto parts|food|water|healthcare|technology|aggregates?|construction|solutions|equipment)\b/i;
const DIRECTORY_DOMAIN_PATTERN = /(?:yellowpages|pagesjaunes|canada411|facebook|instagram|x\.com|twitter|yelp|zoominfo|dnb|opencorporates|glassdoor)\./i;
const PEOPLE_DIRECTORY_DOMAINS = ["wiza.co", "signalhire.com", "clodura.ai", "adapt.io", "contactout.com", "rocketreach.co", "zoominfo.com", "apollo.io", "lusha.com", "theorg.com"];
const PEOPLE_DIRECTORY_PRIORITY_DOMAINS = ["wiza.co", "rocketreach.co", "signalhire.com", "zoominfo.com", "apollo.io"];
const OPERATIONS_CONTACT_SEARCH_TITLES = [
  "operations manager",
  "operations supervisor",
  "plant manager",
  "plant supervisor",
  "production manager",
  "production supervisor",
  "production lead",
  "manufacturing manager",
  "manufacturing supervisor",
  "maintenance manager",
  "maintenance supervisor",
  "maintenance technician",
  "millwright",
  "quality assurance manager",
  "qa manager",
  "haccp coordinator",
  "food safety manager",
  "quality control manager",
  "quality technician",
  "technical services manager",
  "warehouse manager",
  "warehouse supervisor",
  "logistics manager",
  "supply chain manager",
  "procurement manager",
  "purchasing manager",
  "buyer",
  "supervisor",
  "general manager"
];
const OPEN_WEB_CONTACT_SOURCE_HINTS = ["Bakers Journal", "Food in Canada", "Canadian Manufacturing", "webinar", "speaker"];
const MAX_CONTACTS_PER_COMPANY = 20;
const MAX_PEOPLE_SEARCH_QUERIES = 0;
const PEOPLE_SEARCH_BATCH_SIZE = 6;
const OPENAI_WEB_CONTACT_SEARCH_ENABLED = process.env.OPENAI_WEB_CONTACT_SEARCH !== "off";
const SIGNAL_INCLUDE_PATTERN = /\b(hiring|hire|job opening|job posting|careers?|recruiting|recruitment|seeking|millwright|maintenance mechanic|maintenance technician|production operator|production supervisor|plant manager|operations manager|expansion|expand|expanding|expanded|new facility|new plant|new site|new production line|production line|capacity|permit|approval|environmental compliance approval|eca|construction|investment|investing|planned expansion)\b/i;
const SIGNAL_STRONG_PATTERN = /\b(hiring|job opening|job posting|careers?|millwright|maintenance|production|plant|operations|expansion|expanded|expanding|new facility|new plant|new site|new production line|capacity|permit|approval|eca|construction|investment|planned expansion)\b/i;
const SIGNAL_NOISE_PATTERN = /\b(address|phone|official site|about|located|product list|products?|capabilities|independent craft|proudly located|built in|refurbished|facility address|contact page|store hours|taproom|tour|brewery tours?|charity|award|ambassador|walk a mile|sponsor|sponsorship|fundraiser|customer review|excellent service|newsletter|recipe|holiday hours|giveaway|webinar|conference|podcast|blog)\b/i;
const SIGNAL_NOISE_OVERRIDE_PATTERN = /\b(hiring|hire|job opening|job posting|careers?|recruiting|expansion|expanded|expanding|planned expansion|new facility|new plant|new site|new production line|capacity|permit|approval|eca|construction|investment)\b/i;
const SIGNAL_STALE_OR_GENERIC_PATTERN = /\b(gradually expanding|established by founder|for more than three decades|overview, news|similar companies|employee directory)\b/i;
const PAST_ROLE_DATE_RANGE_PATTERN = /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+20\d{2}\s*[-–]\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+20\d{2}\b/i;
const UNVERIFIED_OR_STALE_CONTACT_PATTERN = /\b(historical|alleged|outdated|not verified|may be outdated|not verified as current)\b/i;
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
    dryRun,
    ...(dryRun && process.env.DEBUG_ENRICHMENT ? {
      debug: {
        companyHints: evidence.companyHints,
        peopleResults: evidence.peopleResults.slice(0, 40).map((result) => ({
          title: cleanText(result?.title),
          snippet: cleanText(result?.snippet),
          url: cleanText(result?.url)
        }))
      }
    } : {})
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
  const localMatch = rows.find((row) => normalizeCompanyKey(row.company) === needle) ||
    rows.find((row) => normalizeCompanyKey(row.company).includes(needle) || needle.includes(normalizeCompanyKey(row.company))) ||
    null;
  if (localMatch) {
    return localMatch;
  }

  const directRows = await client.select("manufacturers", {
    select: "id,company,stage,industry,end_product,signals,tags,last_enriched",
    filters: { company: `ilike.*${escapePostgrestLike(cleanText(company))}*` },
    limit: 25
  });
  return directRows.find((row) => normalizeCompanyKey(row.company) === needle) ||
    directRows.find((row) => normalizeCompanyKey(row.company).includes(needle) || needle.includes(normalizeCompanyKey(row.company))) ||
    directRows[0] ||
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
  ].flatMap(expandCompanySearchAliases).filter(Boolean));
  const peopleResults = await collectPeopleResults({ companyHints, city });
  const relevantPeopleResults = filterPeopleResultsByCompany(peopleResults, companyHints, { city });

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
    ...relevantPeopleResults.slice(0, 60).map((result) => [cleanText(result.title), cleanText(result.snippet), cleanText(result.url)].filter(Boolean).join(" | "))
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

function filterPeopleResultsByCompany(results, companyHints, { city } = {}) {
  const phrases = buildCompanyPhrases(companyHints);
  const tokens = buildCompanyTokenSets(companyHints);
  return toArray(results).filter((result) =>
    matchesCompanyContext({
      titleText: cleanText(result?.title),
      snippet: cleanText(result?.snippet),
      companyPhrases: phrases,
      companyTokenSets: tokens
    }) && matchesExpectedMarket(result, { city })
  );
}

async function findOperationsContacts(evidence, { model }) {
  const heuristicContacts = dedupeContacts([
    ...extractWebsiteContacts(evidence.profile, evidence.websiteUrl),
    ...extractLinkedInContacts(evidence.peopleResults, evidence.companyHints),
    ...extractDirectoryContacts(evidence.peopleResults, evidence.companyHints),
    ...extractOpenWebContacts(evidence.peopleResults, evidence.companyHints),
    ...extractAcquisitionPartnerContacts(evidence.peopleResults, evidence.companyHints)
  ]);
  const linkedInFallbackContacts = extractLinkedInFallbackContacts(evidence.peopleResults, evidence.companyHints);

  let openAiWebContacts = [];
  if (OPENAI_WEB_CONTACT_SEARCH_ENABLED && process.env.OPENAI_API_KEY) {
    try {
      openAiWebContacts = await findOperationsContactsWithOpenAIWebSearch(evidence, {
        model: process.env.OPENAI_CONTACT_SEARCH_MODEL || model || DEFAULT_CONTACT_SEARCH_MODEL
      });
    } catch {
      openAiWebContacts = [];
    }
  }

  let modelContacts = [];
  if (process.env.OPENAI_API_KEY && heuristicContacts.length && !openAiWebContacts.length) {
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

  return dedupeContacts([...heuristicContacts, ...openAiWebContacts, ...modelContacts, ...linkedInFallbackContacts].filter(isUsefulContact))
    .slice(0, MAX_CONTACTS_PER_COMPANY);
}

async function findOperationsContactsWithOpenAIWebSearch(evidence, {
  apiKey = process.env.OPENAI_API_KEY,
  model = DEFAULT_CONTACT_SEARCH_MODEL,
  timeoutMs = 90000
} = {}) {
  if (!apiKey) {
    return [];
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(OPENAI_RESPONSES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        reasoning: { effort: "low" },
        tools: [{
          type: "web_search",
          user_location: {
            type: "approximate",
            country: "CA",
            region: "Ontario",
            city: evidence.city || "Toronto",
            timezone: "America/Toronto"
          }
        }],
        tool_choice: "auto",
        include: ["web_search_call.action.sources"],
        text: {
          format: {
            type: "json_schema",
            name: "operations_contact_search",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                contacts: {
                  type: "array",
                  maxItems: MAX_CONTACTS_PER_COMPANY,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      name: { type: "string" },
                      title: { type: "string" },
                      linkedin: { type: "string" },
                      source_url: { type: "string" },
                      notes: { type: "string" }
                    },
                    required: ["name", "title", "linkedin", "source_url", "notes"]
                  }
                }
              },
              required: ["contacts"]
            }
          }
        },
        input: buildOpenAIContactSearchPrompt(evidence)
      }),
      signal: controller.signal
    });

    const body = await response.text();
    if (!response.ok) {
      throw new Error(`OpenAI contact search failed ${response.status}: ${body.slice(0, 1000)}`);
    }

    const data = JSON.parse(body);
    const content = extractOpenAIResponseText(data);
    if (!content) {
      return [];
    }

    const parsed = JSON.parse(content);
    return dedupeContacts(
      toArray(parsed.contacts)
        .map((contact) => normalizeOpenAiWebContact(contact, evidence))
        .filter(Boolean)
    );
  } finally {
    clearTimeout(timer);
  }
}

function normalizeOpenAiWebContact(contact, evidence) {
  const sourceUrl = cleanText(contact?.source_url);
  const linkedin = normalizeLinkedInUrl(contact?.linkedin) || normalizeLinkedInUrl(sourceUrl);
  const name = cleanPersonName(contact?.name) || cleanText(contact?.name);
  let title = cleanRoleText(contact?.title);
  if (!name || !title) {
    return null;
  }
  if (!linkedin && isWeakGenericOpenAiTitle(title)) {
    return null;
  }
  if (linkedin && shouldDowngradeLinkedInInferredTitle({ linkedin, title, evidence })) {
    title = "Operations contact (title not public)";
  }
  return {
    name,
    title,
    linkedin,
    source_url: sourceUrl || linkedin,
    notes: cleanText(contact?.notes || "OpenAI web search")
  };
}

function buildOpenAIContactSearchPrompt(evidence) {
  const company = evidence.searchCompany || evidence.manufacturer?.company || "";
  const aliases = uniqueOrdered([
    company,
    ...toArray(evidence.companyHints)
  ]).slice(0, 8);
  const searchHints = toArray(evidence.peopleResults).slice(0, 30).map((result) =>
    [cleanText(result?.title), cleanText(result?.snippet), cleanText(result?.url)].filter(Boolean).join(" | ")
  ).filter(Boolean);
  return `Find operations-tied contacts for this Ontario company: ${company}

Company aliases to search:
${aliases.map((alias) => `- ${alias}`).join("\n")}

Known website: ${evidence.websiteUrl || "unknown"}
Known city/region: ${evidence.city || "Ontario"}

Public search evidence already collected:
${searchHints.length ? searchHints.map((hint) => `- ${hint}`).join("\n") : "- none"}

Use live web search. Search broadly across LinkedIn public profiles, Wiza, RocketReach, ZoomInfo, SignalHire, Apollo, company pages, trade articles, conference/webinar speaker pages, association pages, and credible public snippets.

Return only people tied to the company with operations-adjacent roles:
- acquirer/operator, owner/operator, partner, board member, founder, general manager
- operations, plant, production, manufacturing
- maintenance, millwright, engineering
- quality, QA, QA specialist, HACCP, food safety, technical services
- warehouse, logistics, supply chain, procurement, purchasing
- supervisor, machine operator, sanitation worker, plant-floor roles when tied to the company

Rules:
- Return JSON only.
- Do not include job postings as contacts.
- Do not include departments, companies, or roles as names.
- Do not guess LinkedIn URLs. Use a full /in/ LinkedIn URL only if a source shows it.
- If a credible non-LinkedIn source proves name/title/company, include the contact with linkedin as an empty string.
- Do not include stale contacts if the source clearly says the role ended or is historical.
- If a LinkedIn profile proves the person works at the company but does not expose the exact title, use the best role implied by the search evidence, such as Acquirer / operator, Operator, Supervisor, QA Specialist, Machine Operator, or Sanitation Worker.
- source_url must be the URL that proves the person/title/company connection.`;
}

function extractOpenAIResponseText(data) {
  if (typeof data?.output_text === "string") {
    return data.output_text.trim();
  }
  for (const item of toArray(data?.output)) {
    if (item?.type !== "message") continue;
    for (const content of toArray(item?.content)) {
      if (typeof content?.text === "string") return content.text.trim();
      if (typeof content?.value === "string") return content.value.trim();
    }
  }
  return "";
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
      .map((result) => normalizeSignalResult(result, evidence))
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

function normalizeSignalResult(result, evidence) {
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
  if (SIGNAL_STALE_OR_GENERIC_PATTERN.test(text) && !/\b(hiring|job opening|job posting|careers?|planned expansion|new facility|new plant|new site|new production line|permit|approval|eca|construction|investment)\b/i.test(text)) {
    return null;
  }
  if (!matchesSignalCompanyContext({ titleText: title, snippet, evidence }) && !isOfficialCompanyHost(url, evidence.websiteUrl)) {
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
  const publicSourceQueries = buildPublicSourcePeopleSearchQueries(companyHints);
  const priorityQueries = buildPriorityPeopleSearchQueries(companyHints)
    .filter((query) => !publicSourceQueries.includes(query));
  const queries = buildPeopleSearchQueries(companyHints, city);

  const collected = [];
  for (const query of publicSourceQueries) {
    try {
      collected.push(...await searchPeopleQuery(query));
    } catch {
      continue;
    }
  }

  for (const batch of chunkArray(priorityQueries, 4)) {
    const settled = await Promise.allSettled(batch.map((query) => searchPeopleQuery(query)));
    for (const result of settled) {
      if (result.status === "fulfilled") {
        collected.push(...result.value);
      }
    }
  }

  const remainingQueries = queries.filter((query) => !priorityQueries.includes(query));
  for (const batch of chunkArray(remainingQueries.slice(0, MAX_PEOPLE_SEARCH_QUERIES), PEOPLE_SEARCH_BATCH_SIZE)) {
    const settled = await Promise.allSettled(batch.map((query) => searchPeopleQuery(query)));
    for (const result of settled) {
      if (result.status === "fulfilled") {
        collected.push(...result.value);
      }
    }
  }

  return dedupeResultsByUrl(collected).slice(0, 100);
}

function buildPublicSourcePeopleSearchQueries(companyHints = []) {
  const hints = uniqueOrdered(toArray(companyHints).flatMap(expandCompanySearchAliases)).slice(0, 3);
  const queries = [];
  for (const hint of hints) {
    queries.push(`"${hint}" "Operations Manager" "Bakers Journal"`);
    queries.push(`"${hint}" "Quality Assurance Manager" "Bakers Journal"`);
  }
  return uniqueOrdered(queries);
}

function buildPriorityPeopleSearchQueries(companyHints = []) {
  const hints = uniqueOrdered(toArray(companyHints).flatMap(expandCompanySearchAliases)).slice(0, 3);
  const topLinkedInTitles = [
    "acquired",
    "owner",
    "operator",
    "partner",
    "board member",
    "operations manager",
    "production manager",
    "maintenance supervisor",
    "quality assurance manager",
    "quality assurance specialist",
    "qa manager",
    "qa specialist",
    "supervisor",
    "machine operator",
    "sanitation worker",
    "plant manager"
  ];
  const queries = [];
  for (const hint of hints) {
    queries.push(`"${hint}" "acquired"`);
    queries.push(`"${hint}" "operator"`);
    queries.push(`"${hint}" "owner"`);
    queries.push(`site:linkedin.com/in "${hint}" "acquired"`);
    queries.push(`site:ca.linkedin.com/in "${hint}" "acquired"`);
    queries.push(`site:linkedin.com/in "${hint}" "operator"`);
    queries.push(`site:ca.linkedin.com/in "${hint}" "operator"`);
    queries.push(`site:linkedin.com/in "${hint}"`);
    queries.push(`site:ca.linkedin.com/in "${hint}"`);
    queries.push(`site:rocketreach.co "${hint}"`);
    queries.push(`site:zoominfo.com "${hint}"`);
    queries.push(`site:wiza.co "${hint}"`);
    queries.push(`"${hint}" "Operations Manager" "Bakers Journal"`);
    queries.push(`"${hint}" "Quality Assurance Manager" "Bakers Journal"`);
    for (const title of topLinkedInTitles) {
      queries.push(`site:linkedin.com/in "${hint}" "${title}"`);
    }
  }
  return uniqueOrdered(queries);
}

function buildPeopleSearchQueries(companyHints = [], city) {
  const queries = [];
  const hints = uniqueOrdered(toArray(companyHints).flatMap(expandCompanySearchAliases)).slice(0, 5);
  const locationHints = uniqueOrdered([city, "Ontario", "Canada"].filter(Boolean));

  for (const hint of hints) {
    queries.push(`site:linkedin.com/in "${hint}"`);
    queries.push(`site:ca.linkedin.com/in "${hint}"`);
    for (const domain of PEOPLE_DIRECTORY_PRIORITY_DOMAINS) {
      queries.push(`site:${domain} "${hint}"`);
    }
  }

  for (const sourceHint of OPEN_WEB_CONTACT_SOURCE_HINTS) {
    for (const hint of hints) {
      queries.push(`"${hint}" "Operations Manager" "${sourceHint}"`);
      queries.push(`"${hint}" "Quality Assurance Manager" "${sourceHint}"`);
      queries.push(`"${hint}" "Production Manager" "${sourceHint}"`);
      queries.push(`"${hint}" "Plant Manager" "${sourceHint}"`);
    }
  }

  for (const title of OPERATIONS_CONTACT_SEARCH_TITLES.slice(0, 16)) {
    for (const hint of hints) {
      queries.push(`"${hint}" "${title}"`);
    }
  }

  for (const title of OPERATIONS_CONTACT_SEARCH_TITLES) {
    for (const hint of hints) {
      queries.push(`site:linkedin.com/in "${hint}" "${title}"`);
    }
  }

  for (const title of OPERATIONS_CONTACT_SEARCH_TITLES.slice(0, 22)) {
    for (const hint of hints) {
      queries.push(`site:ca.linkedin.com/in "${hint}" "${title}"`);
    }
  }

  for (const title of OPERATIONS_CONTACT_SEARCH_TITLES) {
    for (const hint of hints) {
      queries.push(`site:wiza.co "${hint}" "${title}"`);
    }
  }

  for (const title of OPERATIONS_CONTACT_SEARCH_TITLES.slice(0, 18)) {
    for (const hint of hints) {
      for (const domain of PEOPLE_DIRECTORY_PRIORITY_DOMAINS.filter((domain) => domain !== "wiza.co")) {
        queries.push(`site:${domain} "${hint}" "${title}"`);
      }
    }
  }

  for (const title of OPERATIONS_CONTACT_SEARCH_TITLES.slice(0, 16)) {
    for (const hint of hints) {
      queries.push(`"${hint}" "${title}" "LinkedIn"`);
      queries.push(`"${hint}" "${title}" "Wiza"`);
    }
  }

  for (const locationHint of locationHints.slice(0, 2)) {
    for (const title of OPERATIONS_CONTACT_SEARCH_TITLES.slice(0, 16)) {
      for (const hint of hints) {
        queries.push(`site:linkedin.com/in "${hint}" "${title}" "${locationHint}"`);
      }
    }
  }

  return uniqueOrdered(queries);
}

async function searchPeopleQuery(query) {
  const isDirectoryQuery = PEOPLE_DIRECTORY_DOMAINS.some((domain) => query.includes(domain)) ||
    /\b(?:wiza|signalhire|clodura|adapt|contactout|rocketreach|zoominfo|apollo|lusha|theorg)\b/i.test(query);
  const isScopedPeopleQuery = /site:(?:ca\.)?linkedin\.com|site:[a-z0-9.-]*(?:wiza|signalhire|clodura|adapt|contactout|rocketreach|zoominfo|apollo|lusha|theorg)/i.test(query) ||
    /\b(?:linkedin|wiza|signalhire|clodura|adapt|contactout|rocketreach|zoominfo|apollo|lusha|theorg)\b/i.test(query);
  const results = await searchWeb(query, {
    limit: isScopedPeopleQuery ? 8 : 5,
    allowedDomains: isScopedPeopleQuery ? ["linkedin.com", ...PEOPLE_DIRECTORY_DOMAINS] : [],
    allowBlockedDomains: isDirectoryQuery || !isScopedPeopleQuery,
    keepUrlPath: true,
    skipPatterns: ["salary estimate", "resume", "job alert"],
    timeoutMs: 6000
  });
  return results.map((result) => ({ ...result, query }));
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
      const title = parseLinkedInRole(titleText, snippet, result, companyHints);
      if (isPastRoleSnippet(snippet)) {
        return null;
      }
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

function extractLinkedInFallbackContacts(results, companyHints) {
  return dedupeContacts(
    toArray(results).map((result) => {
      const titleText = cleanText(result?.title);
      const snippet = cleanText(result?.snippet);
      const url = normalizeLinkedInUrl(result?.url);
      if (!url || !matchesStrictCompanyContext({ titleText, snippet, companyHints })) {
        return null;
      }
      const name = parseLinkedInName(titleText);
      if (
        !name ||
        isPastRoleSnippet(snippet) ||
        !matchesCompanyTitlePart(cleanText(titleText).replace(/\s*\|\s*LinkedIn\s*$/i, "").split(/\s+-\s+/), companyHints) ||
        parseLinkedInRole(titleText, snippet, result, companyHints)
      ) {
        return null;
      }
      return {
        name,
        title: "Operations contact (title not public)",
        linkedin: url,
        source_url: url,
        notes: "LinkedIn profile shows current company, but the public search snippet does not expose the exact title."
      };
    }).filter(Boolean)
  );
}

function extractAcquisitionPartnerContacts(results, companyHints) {
  return dedupeContacts(
    toArray(results).flatMap((result) => {
      const titleText = cleanText(result?.title);
      const snippet = cleanText(result?.snippet);
      if (!matchesStrictCompanyContext({ titleText, snippet, companyHints }) || !/\bacquir(?:ed|es|ing|er)\b/i.test(snippet)) {
        return [];
      }
      const match = snippet.match(/\bin partnership with\s+(.+?)(?:[.;]|$)/i);
      if (!match) {
        return [];
      }
      return splitPersonList(match[1]).map((name) => ({
        name,
        title: "Partner / operator",
        linkedin: "",
        source_url: cleanText(result?.url),
        notes: "Public acquisition snippet names this person as a partner in the company acquisition."
      }));
    })
  );
}

function extractDirectoryContacts(results, companyHints) {
  const phrases = buildCompanyPhrases(companyHints);
  const tokens = buildCompanyTokenSets(companyHints);
  return dedupeContacts(
    toArray(results).map((result) => {
      const domain = normalizeHostname(result?.url);
      if (!isPeopleDirectoryDomain(domain)) {
        return null;
      }
      const titleText = cleanText(result?.title);
      const snippet = cleanText(result?.snippet);
      if (!matchesCompanyContext({ titleText, snippet, companyPhrases: phrases, companyTokenSets: tokens })) {
        return null;
      }
      const parsed = parseDirectoryContact(titleText, snippet);
      if (!parsed.name || !parsed.title) {
        return null;
      }
      return {
        ...parsed,
        linkedin: extractLinkedInUrl(`${titleText} ${snippet}`),
        source_url: cleanText(result?.url),
        notes: `People-directory public search result from ${domain}`
      };
    }).filter(Boolean)
  );
}

function extractOpenWebContacts(results, companyHints) {
  const phrases = buildCompanyPhrases(companyHints);
  const tokens = buildCompanyTokenSets(companyHints);
  return dedupeContacts(
    toArray(results).flatMap((result) => {
      const domain = normalizeHostname(result?.url);
      if (!domain || domain.includes("linkedin.com") || isPeopleDirectoryDomain(domain)) {
        return [];
      }
      const titleText = cleanText(result?.title);
      const snippet = cleanText(result?.snippet);
      if (!matchesCompanyContext({ titleText, snippet, companyPhrases: phrases, companyTokenSets: tokens })) {
        return [];
      }
      return parseContactsFromOpenText(`${titleText}. ${snippet}`).map((contact) => ({
        ...contact,
        linkedin: "",
        source_url: cleanText(result?.url),
        notes: "Public web result"
      }));
    })
  );
}

function parseDirectoryContact(title, snippet) {
  const titleText = cleanText(title);
  const snippetText = cleanText(snippet);
  const wizaTitleMatch = titleText.match(/^(.+?)\s+-\s+(.+?)\s+at\s+.+?\s+-\s+Wiza$/i);
  if (wizaTitleMatch) {
    return buildParsedContact(wizaTitleMatch[1], wizaTitleMatch[2]);
  }

  const worksAsMatch = snippetText.match(/\b([A-Z][A-Za-z'`.-]+(?:\s+[A-Z][A-Za-z'`.-]+){1,4})\s+works\s+at\s+.+?\s+as\s+(.+?)(?:\.|,|\s+and\s+|$)/i);
  if (worksAsMatch) {
    return buildParsedContact(worksAsMatch[1], worksAsMatch[2]);
  }

  const roleAtMatch = titleText.match(/^([A-Z][A-Za-z'`.-]+(?:\s+[A-Z][A-Za-z'`.-]+){1,4})\s+-\s+(.+?)\s+(?:at|@)\s+/i);
  if (roleAtMatch) {
    return buildParsedContact(roleAtMatch[1], roleAtMatch[2]);
  }

  const pipeRoleMatch = titleText.match(/^([A-Z][A-Za-z'`.-]+(?:\s+[A-Z][A-Za-z'`.-]+){1,4}).*?\|\s+(.+?)\s+(?:at|@)\s+/i);
  if (pipeRoleMatch) {
    return buildParsedContact(pipeRoleMatch[1], pipeRoleMatch[2]);
  }

  const currentlyRoleMatch = snippetText.match(/\b([A-Z][A-Za-z'`.-]+(?:\s+[A-Z][A-Za-z'`.-]+){1,4}).{0,140}?\bis currently\s+(?:a|an|the)?\s*(.{4,120}?)\s+at\s+/i);
  if (currentlyRoleMatch) {
    return buildParsedContact(currentlyRoleMatch[1], currentlyRoleMatch[2]);
  }

  const businessProfileMatch = snippetText.match(/\bView\s+([A-Z][A-Za-z'`.-]+(?:\s+[A-Z][A-Za-z'`.-]+){1,4})(?:'s|’s)\s+business profile as\s+(.+?)\s+at\s+/i);
  if (businessProfileMatch) {
    return buildParsedContact(businessProfileMatch[1], businessProfileMatch[2]);
  }

  const sentenceRoleMatch = `${titleText}. ${snippetText}`.match(/\b([A-Z][A-Za-z'`.-]+(?:\s+[A-Z][A-Za-z'`.-]+){1,4}),?\s+(?:is|was)?\s*(?:a|an|the)?\s*(.{4,120}?)\s+(?:at|with)\s+/i);
  if (sentenceRoleMatch) {
    return buildParsedContact(sentenceRoleMatch[1], sentenceRoleMatch[2]);
  }

  return { name: "", title: "" };
}

function parseContactsFromOpenText(value) {
  const text = cleanText(value);
  const contacts = [];
  const commaRolePattern = /\b([A-Z][A-Za-z'`.-]+(?:\s+[A-Z][A-Za-z'`.-]+){1,4}),\s+([^.;|]{4,120}?)(?=,\s+(?:and\s+)?[A-Z][A-Za-z'`.-]+(?:\s+[A-Z][A-Za-z'`.-]+){1,4},|,\s+[A-Z][A-Za-z'`.-]+|\.|;|\s+-\s+|$)/g;
  for (const match of text.matchAll(commaRolePattern)) {
    const parsed = buildParsedContact(match[1], match[2]);
    if (parsed.name && parsed.title) {
      contacts.push(parsed);
    }
  }

  const currentlyRolePattern = /\b([A-Z][A-Za-z'`.-]+(?:\s+[A-Z][A-Za-z'`.-]+){1,4}).{0,140}?\bis currently\s+(?:a|an|the)?\s*(.{4,120}?)\s+at\s+/gi;
  for (const match of text.matchAll(currentlyRolePattern)) {
    const parsed = buildParsedContact(match[1], match[2]);
    if (parsed.name && parsed.title) {
      contacts.push(parsed);
    }
  }

  return dedupeContacts(contacts);
}

function buildParsedContact(nameValue, titleValue) {
  const name = cleanPersonName(nameValue);
  const title = cleanRoleText(titleValue);
  if (!name || !isUsefulContactTitle(title)) {
    return { name: "", title: "" };
  }
  return { name, title };
}

function isPeopleDirectoryDomain(domain) {
  return PEOPLE_DIRECTORY_DOMAINS.some((allowed) => domain === allowed || domain.endsWith(`.${allowed}`));
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
  const notes = cleanText(contact?.notes);
  if (!looksLikePersonName(name) || !isUsefulContactTitle(title)) {
    return false;
  }
  if (NON_PERSON_NAME_PATTERN.test(name)) {
    return false;
  }
  if (UNVERIFIED_OR_STALE_CONTACT_PATTERN.test(`${title} ${notes}`)) {
    return false;
  }
  return Boolean(contact.linkedin || contact.source_url || contact.notes);
}

function isUsefulContactTitle(title) {
  const text = cleanText(title);
  return !!text && text.length <= 140 && TARGET_TITLE_PATTERN.test(text);
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

function parseLinkedInRole(title, snippet, result = {}, companyHints = []) {
  const cleanTitle = cleanText(title).replace(/\s*\|\s*LinkedIn\s*$/i, "");
  const parts = cleanTitle.split(/\s+-\s+/);
  const visibleRole = inferRoleFromVisibleText(`${cleanTitle} ${cleanText(snippet)}`);
  if (visibleRole && matchesCompanyTitlePart(parts, companyHints)) {
    return visibleRole;
  }
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

function inferRoleFromVisibleText(value) {
  const text = cleanText(value);
  const roleHints = [
    [/\bmachine operator\b/i, "Machine Operator"],
    [/\bsanitation worker\b/i, "Sanitation Worker"],
    [/\bquality assurance specialist\b/i, "Quality Assurance Specialist"],
    [/\bqa specialist\b/i, "QA Specialist"],
    [/\bquality assurance manager\b/i, "Quality Assurance Manager"],
    [/\bqa manager\b/i, "QA Manager"],
    [/\bmaintenance supervisor\b/i, "Maintenance Supervisor"],
    [/\bproduction manager\b/i, "Production Manager"],
    [/\boperations manager\b/i, "Operations Manager"],
    [/\bplant manager\b/i, "Plant Manager"],
    [/\bsupervisor\b/i, "Supervisor"],
    [/\bboard member\b/i, "Board Member"],
    [/\bpartner\b/i, "Partner / operator"],
    [/\bowner\b/i, "Owner / operator"],
    [/\bacquir(?:ed|er)\b/i, "Acquirer / operator"],
    [/\boperator\b/i, "Operator"]
  ];
  const match = roleHints.find(([pattern]) => pattern.test(text));
  return match?.[1] || "";
}

function matchesCompanyTitlePart(parts, companyHints = []) {
  if (parts.length <= 1) return false;
  const companyText = parts.slice(1).join(" ");
  return matchesCompanyContext({
    titleText: companyText,
    snippet: "",
    companyPhrases: buildCompanyPhrases(companyHints),
    companyTokenSets: buildCompanyTokenSets(companyHints)
  });
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

function cleanPersonName(value) {
  const name = cleanText(value).replace(/\s+-\s+.*$/, "").trim();
  return looksLikePersonName(name) ? name : "";
}

function splitPersonList(value) {
  return uniqueOrdered(
    cleanText(value)
      .replace(/\band\s+I\s+acquired.*$/i, "")
      .split(/\s+(?:and|&)\s+|,\s*/)
      .map((name) => cleanPersonName(name.replace(/\s+(?:and|with)\s+.*$/i, "")))
      .filter(Boolean)
  );
}

function isWeakGenericOpenAiTitle(title) {
  return /\b(?:operations?\s*\/\s*(?:manufacturing|maintenance|plant)?\s*staff|staff|employee|owner-adjacent|operations-related role|plant floor|title not public|title not disclosed|exact role|exact title|not stated|not disclosed)\b/i.test(cleanText(title));
}

function shouldDowngradeLinkedInInferredTitle({ linkedin, title, evidence }) {
  const text = cleanText(title);
  if (/\btitle not public\b/i.test(text)) {
    return false;
  }
  if (!/\b(?:owner|operator|supervisor|quality|qa|maintenance|machine|sanitation|plant floor|staff|partner)\b/i.test(text)) {
    return false;
  }
  return !hasVisibleLinkedInTitleEvidence({ linkedin, title: text, peopleResults: evidence.peopleResults });
}

function hasVisibleLinkedInTitleEvidence({ linkedin, title, peopleResults }) {
  const targetUrl = normalizeLinkedInUrl(linkedin);
  if (!targetUrl) {
    return false;
  }
  const visibleText = toArray(peopleResults)
    .filter((result) => normalizeLinkedInUrl(result?.url) === targetUrl)
    .map((result) => `${cleanText(result?.title)} ${cleanText(result?.snippet)}`)
    .join(" ");
  if (!visibleText) {
    return false;
  }
  const titleText = cleanText(title);
  if (/\bacquirer|acquir(?:ed|es|ing)\b/i.test(titleText)) {
    return /\bacquir(?:ed|es|ing|er)\b/i.test(visibleText);
  }
  if (/\bqa|quality\b/i.test(titleText)) {
    return /\bqa|quality\b/i.test(visibleText);
  }
  if (/\bsupervisor\b/i.test(titleText)) {
    return /\bsupervisor\b/i.test(visibleText);
  }
  if (/\bmachine operator\b/i.test(titleText)) {
    return /\bmachine operator\b/i.test(visibleText);
  }
  if (/\bsanitation\b/i.test(titleText)) {
    return /\bsanitation\b/i.test(visibleText);
  }
  if (/\bowner|operator|partner\b/i.test(titleText)) {
    return /\bowner|operator|partner|acquir(?:ed|es|ing|er)\b/i.test(visibleText);
  }
  return TARGET_TITLE_PATTERN.test(visibleText);
}

function extractLinkedInUrl(value) {
  return normalizeLinkedInUrl((cleanText(value).match(/https?:\/\/[^\s"'<>|,)]+linkedin\.com\/in\/[^\s"'<>|,)]+/i) || [])[0] || "");
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
  const seenLinkedIn = new Set();
  const seenNames = new Set();
  const unique = [];
  for (const contact of toArray(contacts)) {
    const name = cleanText(contact?.name);
    const title = cleanText(contact?.title);
    const linkedin = normalizeLinkedInUrl(contact?.linkedin);
    const key = `${normalizeCompanyKey(name)}::${normalizeCompanyKey(title)}::${linkedin}`;
    const nameKey = normalizeCompanyKey(name);
    if (!name || !title || seen.has(key) || seenNames.has(nameKey) || (linkedin && seenLinkedIn.has(linkedin))) {
      continue;
    }
    seen.add(key);
    seenNames.add(nameKey);
    if (linkedin) {
      seenLinkedIn.add(linkedin);
    }
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

function isPastRoleSnippet(value) {
  const text = cleanText(value);
  return PAST_ROLE_DATE_RANGE_PATTERN.test(text) && !/\b(?:present|current)\b/i.test(text);
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

function expandCompanySearchAliases(value) {
  const clean = normalizeCompanySearchName(value)
    .replace(/[®™©]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) {
    return [];
  }

  const aliases = [clean];
  const withoutLegal = clean
    .replace(/\b(?:inc|incorporated|ltd|limited|corp|corporation|company|co)\.?$/i, "")
    .trim();
  if (withoutLegal && withoutLegal !== clean) {
    aliases.push(withoutLegal);
  }

  if (/\band\b/i.test(clean)) {
    aliases.push(clean.replace(/\band\b/gi, "&"));
  }
  if (clean.includes("&")) {
    aliases.push(clean.replace(/&/g, "and"));
  }

  const brandWords = clean
    .replace(/[()]/g, " ")
    .split(/\s+/)
    .filter((word) => word && !/^(inc|incorporated|ltd|limited|corp|corporation|company|co|and|the)$/i.test(word));
  if (brandWords.length >= 2) {
    aliases.push(brandWords.slice(0, 2).join(" "));
  }

  return uniqueOrdered(aliases.map((alias) => alias.replace(/\s+/g, " ").trim()).filter((alias) => alias.length >= 3));
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

function matchesExpectedMarket(result, { city } = {}) {
  const titleText = cleanText(result?.title);
  const snippet = cleanText(result?.snippet);
  const url = cleanText(result?.url);
  const host = normalizeHostname(url);
  const text = `${titleText} ${snippet}`;
  const localTerms = ["Canada", "Canadian", "Ontario", "ON", "Greater Toronto", "GTA", "Toronto", "Vaughan", "Woodbridge"];
  if (city) {
    localTerms.push(city);
  }
  const localPattern = new RegExp(`\\b(?:${uniqueOrdered(localTerms).map(escapeRegExp).join("|")})\\b`, "i");
  if (localPattern.test(text)) {
    return true;
  }
  if (host === "ca.linkedin.com") {
    return true;
  }
  if (host.endsWith(".linkedin.com") || host === "linkedin.com") {
    return false;
  }
  return localPattern.test(url);
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchesStrictCompanyContext({ titleText, snippet, companyHints = [] }) {
  const haystack = normalizeCompanyKey(`${cleanText(titleText)} ${cleanText(snippet)}`);
  if (!haystack.trim()) return false;
  const primaryHints = uniqueOrdered(toArray(companyHints).slice(0, 2));
  for (const hint of primaryHints) {
    const phrase = normalizeCompanyKey(hint);
    if (phrase.length >= 4 && haystack.includes(phrase)) {
      return true;
    }
  }
  for (const hint of primaryHints) {
    const tokens = tokenizeCompanyName(hint).filter((token) => token.length >= 4);
    if (tokens.length >= 2 && tokens.every((token) => haystack.includes(token))) {
      return true;
    }
  }
  return false;
}

function matchesSignalCompanyContext({ titleText, snippet, evidence }) {
  const haystack = normalizeCompanyKey(`${cleanText(titleText)} ${cleanText(snippet)}`);
  if (!haystack.trim()) return false;
  const hints = uniqueOrdered([
    evidence.searchCompany,
    ...toArray(evidence.searchNameHints)
  ].filter(Boolean));

  for (const hint of hints) {
    const phrase = normalizeCompanyKey(hint);
    if (phrase.length >= 4 && haystack.includes(phrase)) {
      return true;
    }
  }

  for (const hint of hints) {
    const tokens = tokenizeCompanyName(hint).filter((token) => token.length >= 4);
    if (tokens.length >= 2 && tokens.every((token) => haystack.includes(token))) {
      return true;
    }
  }

  return false;
}

function isOfficialCompanyHost(url, websiteUrl) {
  const resultHost = normalizeHostname(url);
  const officialHost = normalizeHostname(websiteUrl);
  return Boolean(resultHost && officialHost && (resultHost === officialHost || resultHost.endsWith(`.${officialHost}`)));
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

function escapePostgrestLike(value) {
  return cleanText(value).replace(/([*%_\\])/g, "\\$1");
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

function chunkArray(values, size) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}
