import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadLocalEnv } from "../plant-verifier.mjs";
import { normalizeLeadCompanyName } from "./lead-records.mjs";
import { enrichFromWebsite } from "./enrich.mjs";
import { searchWeb, toCanonicalWebsiteUrl } from "./web-search.mjs";

const OPENAI_CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions";
const CONFIGURED_CONTACT_EXTRACT_MODEL = String(process.env.OPENAI_CONTACT_EXTRACT_MODEL || "").trim();
const DEFAULT_CONTACT_EXTRACT_MODEL = /nano/i.test(CONFIGURED_CONTACT_EXTRACT_MODEL) ? CONFIGURED_CONTACT_EXTRACT_MODEL : "gpt-5-nano";
const CONFIGURED_SIGNAL_EXTRACT_MODEL = String(process.env.OPENAI_SIGNAL_EXTRACT_MODEL || "").trim();
const DEFAULT_SIGNAL_EXTRACT_MODEL = /nano/i.test(CONFIGURED_SIGNAL_EXTRACT_MODEL) ? CONFIGURED_SIGNAL_EXTRACT_MODEL : DEFAULT_CONTACT_EXTRACT_MODEL;
const TARGET_TITLE_TERMS = [
  "site director of manufacturing",
  "director of manufacturing",
  "manufacturing manager",
  "manufacturing supervisor",
  "manufacturing leader",
  "production and manufacturing leader",
  "manufacturing and operations leader",
  "chief operating officer",
  "chief operations officer",
  "coo",
  "director of operations",
  "operations director",
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
  "founder",
  "president",
  "vice president",
  "vp",
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
  "head brewer",
  "lead brewer",
  "brewer",
  "brewing assistant",
  "brewery manager",
  "cellar(?:man|person)",
  "roast master",
  "head roaster",
  "roaster",
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
  "supply chain director",
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
  "chief operating officer",
  "chief operations officer",
  "coo",
  "director of operations",
  "operations director",
  "plant manager",
  "plant supervisor",
  "production manager",
  "production supervisor",
  "production lead",
  "head brewer",
  "lead brewer",
  "brewer",
  "brewing assistant",
  "brewery manager",
  "head roaster",
  "roaster",
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
  "supply chain director",
  "procurement manager",
  "purchasing manager",
  "buyer",
  "owner",
  "founder",
  "president",
  "vice president",
  "vp",
  "supervisor",
  "general manager"
];
const OPEN_WEB_CONTACT_SOURCE_HINTS = ["Bakers Journal", "Food in Canada", "Canadian Manufacturing", "webinar", "speaker"];
const MAX_CONTACTS_PER_COMPANY = 20;
const MAX_PRIORITY_PEOPLE_SEARCH_QUERIES = Number(process.env.PEOPLE_SEARCH_PRIORITY_QUERY_LIMIT || 48);
const MAX_PEOPLE_SEARCH_QUERIES = Number(process.env.PEOPLE_SEARCH_QUERY_LIMIT || 0);
const PEOPLE_SEARCH_BATCH_SIZE = 6;
const WIDE_PEOPLE_SEARCH_QUERY_LIMIT = Number(process.env.PEOPLE_SEARCH_WIDE_QUERY_LIMIT || 12);
const NARROW_PEOPLE_RETRY_QUERY_LIMIT = Number(process.env.PEOPLE_SEARCH_NARROW_RETRY_LIMIT || 24);
const TITLE_REPAIR_SEARCH_QUERY_LIMIT = Number(process.env.PEOPLE_SEARCH_TITLE_REPAIR_LIMIT || 36);
const NAME_ONLY_CONTACT_CANDIDATE_LIMIT = Number(process.env.CONTACT_NAME_CANDIDATE_LIMIT || 14);
const PEOPLE_SEARCH_TIMEOUT_MS = Number(process.env.PEOPLE_SEARCH_TIMEOUT_MS || 3000);
const MIN_TARGET_CONTACTS = Number(process.env.CONTACT_SEARCH_MIN_TARGETS || 3);
const NANO_CONTACT_BATCH_SIZE = Number(process.env.OPENAI_CONTACT_EXTRACT_BATCH_SIZE || 18);
const NANO_CONTACT_MAX_BATCHES = Number(process.env.OPENAI_CONTACT_EXTRACT_MAX_BATCHES || 4);
const NANO_CONTACT_TIMEOUT_MS = Number(process.env.OPENAI_CONTACT_EXTRACT_TIMEOUT_MS || 30000);
const NANO_CONTACT_EXTRACT_ENABLED = process.env.OPENAI_CONTACT_EXTRACT !== "off";
const NANO_SIGNAL_EXTRACT_ENABLED = process.env.OPENAI_SIGNAL_EXTRACT !== "off";
const SIGNAL_INCLUDE_PATTERN = /\b(hiring|hire|job opening|job posting|careers?|recruiting|recruitment|seeking|millwright|maintenance mechanic|maintenance technician|production operator|production supervisor|plant manager|operations manager|head brewer|brewer|brewing assistant|roaster|head roaster|expansion|expand|expanding|expanded|new facility|new plant|new site|new production line|production line|capacity|permit|approval|environmental compliance approval|eca|construction|investment|investing|planned expansion)\b/i;
const SIGNAL_STRONG_PATTERN = /\b(hiring|job opening|job posting|careers?|millwright|maintenance|production|plant|operations|head brewer|brewer|roaster|expansion|expanded|expanding|new facility|new plant|new site|new production line|capacity|permit|approval|eca|construction|investment|planned expansion)\b/i;
const SIGNAL_NOISE_PATTERN = /\b(address|phone|official site|about|located|product list|products?|capabilities|independent craft|proudly located|built in|refurbished|facility address|contact page|store hours|taproom|tour|brewery tours?|charity|award|ambassador|walk a mile|sponsor|sponsorship|fundraiser|customer review|excellent service|newsletter|recipe|holiday hours|giveaway|webinar|conference|podcast|blog)\b/i;
const SIGNAL_NOISE_OVERRIDE_PATTERN = /\b(hiring|hire|job opening|job posting|careers?|recruiting|expansion|expanded|expanding|planned expansion|new facility|new plant|new site|new production line|capacity|permit|approval|eca|construction|investment)\b/i;
const SIGNAL_STALE_OR_GENERIC_PATTERN = /\b(gradually expanding|established by founder|for more than three decades|overview, news|similar companies|employee directory)\b/i;
const SIGNAL_HIRING_ACTION_PATTERN = /\b(hiring|hire|job opening|job posting|job ad|jobs?|careers?|employment|recruiting|recruitment|seeking|apply|now hiring)\b/i;
const SIGNAL_HIRING_ROLE_PATTERN = /\b(millwright|maintenance mechanic|maintenance technician|industrial mechanic|production operator|production worker|production associate|production supervisor|production manager|plant manager|plant supervisor|operations manager|operations supervisor|warehouse|logistics|quality assurance|quality control|qa\b|food safety|sanitation|packaging|machine operator|head brewer|brewer|brewing assistant|roaster|head roaster)\b/i;
const SIGNAL_EXPANSION_EVIDENCE_PATTERN = /\b(expansion|expand|expanding|expanded|planned expansion|new facility|new plant|new site|new location|opening|opened|relocat(?:e|ing|ed)|larger facility|production line|capacity|capacity increase|permit|approval|environmental compliance approval|eca|construction|building permit|investment|investing|invested|capital project|equipment upgrade|plant upgrade)\b/i;
const SIGNAL_GENERIC_BREADCRUMB_PATTERN = /\b(careers and employment|careers in|career opportunities|company profile|company overview|employee reviews?|salaries|interview questions|overview, news|similar companies)\b/i;
const SIGNAL_JOB_BOARD_PATTERN = /(?:indeed|glassdoor|workopolis|jobbank|monster|ziprecruiter|simplyhired|eluta)\./i;
const SIGNAL_NON_OPERATIONAL_ROLE_PATTERN = /\b(barista|server|cashier|retail associate|sales associate|store associate|customer service|front of house|restaurant|cook|brand ambassador)\b/i;
const SIGNAL_NEGATIVE_CHANGE_PATTERN = /\b(permanently clos(?:e|es|ed|ing)|plant closure|closed plants?|shut(?:ter| down)|recall|outbreak|listeria|bankrupt|layoff|lawsuit|for sale|sell(?:ing)? (?:two )?plants?)\b/i;
const SIGNAL_ROLE_LABELS = [
  ["Head Brewer", /\bhead brewer\b/i],
  ["Brewer", /\b(?:lead brewer|brewer|brewing assistant)\b/i],
  ["Head Roaster", /\bhead roaster\b/i],
  ["Roaster", /\broaster\b/i],
  ["Maintenance Mechanic", /\bmaintenance mechanic\b/i],
  ["Maintenance Technician", /\bmaintenance technician\b/i],
  ["Millwright", /\bmillwright\b/i],
  ["Industrial Mechanic", /\bindustrial mechanic\b/i],
  ["Production Supervisor", /\bproduction supervisor\b/i],
  ["Production Manager", /\bproduction manager\b/i],
  ["Production Operator", /\bproduction operator\b/i],
  ["Production Worker", /\bproduction worker\b/i],
  ["Plant Manager", /\bplant manager\b/i],
  ["Plant Supervisor", /\bplant supervisor\b/i],
  ["Operations Manager", /\boperations manager\b/i],
  ["Operations Supervisor", /\boperations supervisor\b/i],
  ["Warehouse/Logistics", /\b(?:warehouse|logistics)\b/i],
  ["Quality/QA", /\b(?:quality assurance|quality control|qa\b|food safety)\b/i],
  ["Sanitation", /\bsanitation\b/i],
  ["Machine Operator", /\bmachine operator\b/i]
];
const PAST_ROLE_DATE_RANGE_PATTERN = /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+20\d{2}\s*[-–]\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+20\d{2}\b/i;
const UNVERIFIED_OR_STALE_CONTACT_PATTERN = /\b(historical|alleged|outdated|not verified|may be outdated|not verified as current)\b/i;
const EXCLUDED_CONTACT_TITLE_PATTERN = /\b(?:chief financial officer|cfo\b|finance|accounting|controller|sales|marketing|human resources|hr\b|front of house|software developer|it support|information technology|consultant|customer service|intake executive)\b/i;
const EXCLUDED_CONTACT_OVERRIDE_PATTERN = /\b(?:operations|production|plant|maintenance|manufacturing|facility|quality|qa\b|technical services|engineering|warehouse|logistics|supply chain|procurement|purchasing|buyer|owner|founder)\b/i;
const GENERIC_COMPANY_HINT_TOKEN_PATTERN = /\b(?:recent|hiring|expansion|signal|signals|relevant|targeted|search|verified|plant|lead|manufacturing|facilities|southern|ontario|products|capabilities|official|source|evidence|matters)\b/i;
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
  model = DEFAULT_CONTACT_EXTRACT_MODEL,
  websitePageLimit = 3,
  dryRun = false,
  includeSignals = true,
  allowContactUpdates = true
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
  const contacts = await findOperationsContacts(evidence, { model, existingContacts });
  let signals = [];
  if (includeSignals) {
    try {
      signals = await findHiringExpansionSignals(evidence);
    } catch {
      signals = [];
    }
  }

  const contactUpgrades = contacts
    .map((contact) => {
      const existing = findExistingContact(existingContacts, contact);
      if (!existing || !shouldUpgradeContactTitle(existing, contact)) {
        return null;
      }
      return { existing, contact };
    })
    .filter(Boolean);

  const newContactRows = contacts
    .filter((contact) => !findExistingContact(existingContacts, contact))
    .map((contact) => ({
      manufacturer_id: manufacturer.id,
      name: contact.name,
      title: contact.title,
      linkedin: contact.linkedin || contact.source_url || ""
    }));

  const nextTags = updateContactTags(manufacturer.tags, contacts);
  const nextSignals = includeSignals
    ? upsertRecentSignalsSection(manufacturer.signals, formatRecentSignalsSection(signals))
    : manufacturer.signals;

  if (!dryRun) {
    if (newContactRows.length) {
      await client.insert("manufacturer_contacts", newContactRows, {
        select: "id,manufacturer_id,name,title,linkedin"
      });
    }
    if (allowContactUpdates) {
      for (const upgrade of contactUpgrades) {
        await client.patch("manufacturer_contacts", { id: `eq.${upgrade.existing.id}` }, {
          name: upgrade.contact.name,
          title: upgrade.contact.title,
          linkedin: upgrade.contact.linkedin || upgrade.contact.source_url || upgrade.existing.linkedin || ""
        });
      }
    }
    await client.patch("manufacturers", { id: `eq.${manufacturer.id}` }, {
      tags: nextTags,
      ...(includeSignals ? { signals: nextSignals } : {}),
      last_enriched: new Date().toISOString()
    });
  }

  return {
    id: manufacturer.id,
    company: manufacturer.company,
    website: evidence.websiteUrl,
    contactsFound: contacts.length,
    contactsInserted: dryRun ? 0 : newContactRows.length,
    contactsUpdated: dryRun || !allowContactUpdates ? 0 : contactUpgrades.length,
    contactsToInsert: newContactRows.length,
    contactsToUpdate: allowContactUpdates ? contactUpgrades.length : 0,
    contactUpdatesSkipped: allowContactUpdates ? 0 : contactUpgrades.length,
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

export async function runCompanyPreInsertEnrichment({
  company,
  signals = "",
  endProduct = "",
  tags = [],
  repoRoot,
  model = DEFAULT_CONTACT_EXTRACT_MODEL,
  websitePageLimit = 3
} = {}) {
  const root = repoRoot || path.resolve(__dirname, "..", "..");
  await loadLocalEnv({ cwd: root });
  const manufacturer = {
    id: "",
    company: cleanText(company),
    signals: cleanText(signals),
    end_product: cleanText(endProduct),
    tags: normalizeTagArray(tags)
  };
  if (!manufacturer.company) {
    throw new Error("Cannot enrich a lead before insert without a company name.");
  }

  const evidence = await buildCompanyEvidence(manufacturer, { websitePageLimit });
  const contacts = await findOperationsContacts(evidence, { model, existingContacts: [] });
  let signalsFound = [];
  try {
    signalsFound = await findHiringExpansionSignals(evidence);
  } catch {
    signalsFound = [];
  }
  const nextTags = updateContactTags(manufacturer.tags, contacts);
  const nextSignals = upsertRecentSignalsSection(
    manufacturer.signals,
    formatRecentSignalsSection(signalsFound)
  );

  return {
    company: manufacturer.company,
    website: evidence.websiteUrl,
    contactsFound: contacts.length,
    contacts,
    recentSignalsFound: signalsFound.length,
    recentSignals: signalsFound,
    tags: nextTags,
    signalsText: nextSignals
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
  const directRows = await client.select("manufacturers", {
    select: "id,company,stage,industry,end_product,signals,tags,last_enriched",
    filters: { company: `ilike.*${escapePostgrestLike(cleanText(company))}*` },
    limit: 50
  });
  const directMatch = directRows.find((row) => normalizeCompanyKey(row.company) === needle) ||
    directRows.find((row) => isLooseCompanyMatch(row.company, company)) ||
    directRows[0] ||
    null;
  if (directMatch) {
    return directMatch;
  }

  const rows = await client.select("manufacturers", {
    select: "id,company,stage,industry,end_product,signals,tags,last_enriched",
    limit: 5000
  });
  const localMatch = rows.find((row) => normalizeCompanyKey(row.company) === needle) ||
    rows.find((row) => isLooseCompanyMatch(row.company, company)) ||
    null;
  return localMatch;
}

async function buildCompanyEvidence(manufacturer, options) {
  const searchNameHints = extractSearchNameHints(manufacturer);
  const searchCompany = searchNameHints[0] || normalizeCompanySearchName(manufacturer.company);
  const city = extractLikelyCity(manufacturer.signals);
  const websiteHints = extractUrls(`${manufacturer.signals || ""}\n${manufacturer.end_product || ""}`);
  const websiteUrl = await resolveOfficialWebsite(searchNameHints, city, websiteHints);
  let profile = emptyProfile();
  if (websiteUrl) {
    try {
      profile = await enrichFromWebsite(websiteUrl, {
        pageLimit: options.websitePageLimit,
        expectedCity: city
      });
    } catch {
      profile = emptyProfile();
    }
  }

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
    contactCandidates: [],
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

async function findOperationsContacts(evidence, { model = DEFAULT_CONTACT_EXTRACT_MODEL, existingContacts = [] }) {
  const nanoModel = resolveNanoOnlyModel(model, DEFAULT_CONTACT_EXTRACT_MODEL);
  const existingUsefulContacts = normalizeExistingCrmContacts(existingContacts);
  let heuristicContacts = extractHeuristicOperationContacts(evidence);
  let contactCandidates = extractContactNameCandidates(evidence);
  evidence.contactCandidates = contactCandidates;
  let seedContacts = dedupeContacts([...existingUsefulContacts, ...heuristicContacts]);
  let contacts = dedupeContacts(seedContacts.filter(isUsefulContact));

  if (!hasEnoughTargetContacts(contacts)) {
    try {
      const retryResults = await collectNarrowPeopleResults(evidence, contacts);
      if (retryResults.length) {
        mergePeopleResultsIntoEvidence(evidence, retryResults);
        heuristicContacts = extractHeuristicOperationContacts(evidence);
        contactCandidates = dedupeContactCandidates([...contactCandidates, ...extractContactNameCandidates(evidence)]);
        evidence.contactCandidates = contactCandidates;
        seedContacts = dedupeContacts([...existingUsefulContacts, ...heuristicContacts]);
        contacts = dedupeContacts(seedContacts.filter(isUsefulContact));
      }
    } catch {
      // Keep the wider first-pass result if the narrow retry search is flaky.
    }
  }

  if (!hasEnoughTargetContacts(contacts)) {
    try {
      const repairResults = await collectTitleRepairPeopleResults(evidence, {
        contacts,
        candidates: contactCandidates
      });
      if (repairResults.length) {
        mergePeopleResultsIntoEvidence(evidence, repairResults);
        heuristicContacts = extractHeuristicOperationContacts(evidence);
        contactCandidates = dedupeContactCandidates([...contactCandidates, ...extractContactNameCandidates(evidence)]);
        evidence.contactCandidates = contactCandidates;
        seedContacts = dedupeContacts([...existingUsefulContacts, ...heuristicContacts]);
        contacts = dedupeContacts(seedContacts.filter(isUsefulContact));
      }
    } catch {
      // Title repair is a best-effort public search phase; the nano pass can still use the existing evidence.
    }
  }

  let nanoContacts = [];
  if (NANO_CONTACT_EXTRACT_ENABLED && process.env.OPENAI_API_KEY && !hasEnoughTargetContacts(contacts)) {
    try {
      nanoContacts = await extractContactsWithNanoBatches(evidence, {
        existingContacts,
        seedContacts,
        model: nanoModel,
        timeoutMs: NANO_CONTACT_TIMEOUT_MS
      });
      contacts = dedupeContacts([...contacts, ...nanoContacts].filter(isUsefulContact));
    } catch {
      nanoContacts = [];
    }
  }

  if (NANO_CONTACT_EXTRACT_ENABLED && process.env.OPENAI_API_KEY) {
    try {
      const reviewedContacts = await reviewContactsWithNano(evidence, {
        candidateContacts: dedupeContacts([...seedContacts, ...nanoContacts]),
        existingContacts,
        model: nanoModel,
        timeoutMs: NANO_CONTACT_TIMEOUT_MS
      });
      contacts = dedupeContacts([...contacts, ...reviewedContacts].filter(isUsefulContact));
    } catch {
      // The first nano pass still gives us the best cheap result if review fails.
    }
  }

  return contacts.slice(0, MAX_CONTACTS_PER_COMPANY);
}

function extractHeuristicOperationContacts(evidence) {
  return dedupeContacts([
    ...extractWebsiteContacts(evidence.profile, evidence.websiteUrl),
    ...extractLinkedInContacts(evidence.peopleResults, evidence.companyHints),
    ...extractRepairedNameContacts(evidence.peopleResults, evidence.contactCandidates, evidence.companyHints),
    ...extractDirectoryContacts(evidence.peopleResults, evidence.companyHints),
    ...extractOpenWebContacts(evidence.peopleResults, evidence.companyHints),
    ...extractAcquisitionPartnerContacts(evidence.peopleResults, evidence.companyHints)
  ]);
}

async function extractContactsWithNanoBatches(evidence, {
  apiKey = process.env.OPENAI_API_KEY,
  model = DEFAULT_CONTACT_EXTRACT_MODEL,
  existingContacts = [],
  seedContacts = [],
  timeoutMs = 45000
} = {}) {
  if (!apiKey) {
    return [];
  }

  const snippets = buildNanoContactEvidenceSnippets(evidence, existingContacts);
  if (!snippets.length) {
    return [];
  }

  let contacts = dedupeContacts(seedContacts);
  const extracted = [];
  const batches = chunkArray(snippets, NANO_CONTACT_BATCH_SIZE).slice(0, NANO_CONTACT_MAX_BATCHES);
  for (const batch of batches) {
    if (hasEnoughTargetContacts(contacts)) {
      break;
    }
    const batchContacts = await extractContactsWithNanoBatch(evidence, batch, {
      apiKey,
      model,
      existingContacts,
      knownContacts: contacts,
      timeoutMs
    });
    extracted.push(...batchContacts);
    contacts = dedupeContacts([...contacts, ...batchContacts].filter(isUsefulContact));
  }
  return dedupeContacts(extracted);
}

async function extractContactsWithNanoBatch(evidence, snippets, {
  apiKey,
  model,
  existingContacts = [],
  knownContacts = [],
  timeoutMs = 45000
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const requestBody = {
      model,
      messages: buildNanoContactExtractMessages(evidence, snippets, { existingContacts, knownContacts }),
      response_format: { type: "json_object" }
    };
    if (/^gpt-5/i.test(model)) {
      requestBody.max_completion_tokens = 2500;
      requestBody.reasoning_effort = "minimal";
    } else {
      requestBody.max_tokens = 1200;
      requestBody.temperature = 0;
    }

    const response = await fetch(OPENAI_CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`OpenAI nano contact extraction failed ${response.status}: ${body.slice(0, 500)}`);
    }
    const data = JSON.parse(body);
    const content = cleanText(data?.choices?.[0]?.message?.content);
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

async function reviewContactsWithNano(evidence, {
  apiKey = process.env.OPENAI_API_KEY,
  model = DEFAULT_CONTACT_EXTRACT_MODEL,
  candidateContacts = [],
  existingContacts = [],
  timeoutMs = 45000
} = {}) {
  if (!apiKey) {
    return [];
  }

  const candidates = dedupeContacts(candidateContacts).slice(0, MAX_CONTACTS_PER_COMPANY);
  const snippets = buildNanoContactEvidenceSnippets(evidence, existingContacts).slice(0, NANO_CONTACT_BATCH_SIZE * 2);
  if (!candidates.length && !snippets.length) {
    return [];
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const requestBody = {
      model: resolveNanoOnlyModel(model, DEFAULT_CONTACT_EXTRACT_MODEL),
      messages: buildNanoContactReviewMessages(evidence, { candidates, snippets }),
      response_format: { type: "json_object" }
    };
    if (/^gpt-5/i.test(requestBody.model)) {
      requestBody.max_completion_tokens = 2800;
      requestBody.reasoning_effort = "minimal";
    } else {
      requestBody.max_tokens = 1400;
      requestBody.temperature = 0;
    }

    const response = await fetch(OPENAI_CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`OpenAI nano contact review failed ${response.status}: ${body.slice(0, 500)}`);
    }
    const data = JSON.parse(body);
    const content = cleanText(data?.choices?.[0]?.message?.content);
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

function buildNanoContactExtractMessages(evidence, snippets, { existingContacts = [], knownContacts = [] } = {}) {
  const company = evidence.searchCompany || evidence.manufacturer?.company || "";
  const aliases = uniqueOrdered([company, ...toArray(evidence.companyHints)]).slice(0, 8);
  const weakExistingContacts = toArray(existingContacts)
    .filter((contact) => isWeakContactTitle(contact?.title) && (cleanText(contact?.name) || normalizeLinkedInUrl(contact?.linkedin)))
    .slice(0, MAX_CONTACTS_PER_COMPANY)
    .map((contact) => ({
      name: cleanText(contact?.name),
      title: cleanText(contact?.title),
      link: normalizeLinkedInUrl(contact?.linkedin) || cleanText(contact?.linkedin)
    }));
  const known = toArray(knownContacts).slice(0, MAX_CONTACTS_PER_COMPANY).map((contact) => ({
    name: cleanText(contact?.name),
    title: cleanText(contact?.title),
    link: normalizeLinkedInUrl(contact?.linkedin) || cleanText(contact?.source_url)
  }));

  return [
    {
      role: "system",
      content: `You extract manufacturing outreach contacts from public search snippets. Return JSON only: {"contacts":[{"name":"","title":"","linkedin":"","source_url":"","notes":""}]}.

Keep only people tied to the target company with production, plant, maintenance, operations, quality/QA, warehouse/logistics, procurement/purchasing, supervisor, or owner/operator relevance.
Use the exact title visible in the snippet/page title when available. Do not infer a title from the search query alone.
Never use filler titles like "operations contact", "title not public", "employee", or "staff".
Every contact must include source_url: the URL where the name/title/company evidence was found. Use a personal LinkedIn /in/ URL in linkedin only when present.`
    },
    {
      role: "user",
      content: JSON.stringify({
        target_company: company,
        aliases,
        minimum_goal: `Find up to ${MIN_TARGET_CONTACTS} strong contacts if present, especially plant manager, maintenance manager/supervisor, production manager/supervisor, operations manager/supervisor, QA/quality manager, procurement/purchasing.`,
        existing_weak_contacts_to_repair: weakExistingContacts,
        already_known_contacts: known,
        public_search_snippets: snippets
      }, null, 2)
    }
  ];
}

function buildNanoContactReviewMessages(evidence, { candidates = [], snippets = [] } = {}) {
  const company = evidence.searchCompany || evidence.manufacturer?.company || "";
  const aliases = uniqueOrdered([company, ...toArray(evidence.companyHints)]).slice(0, 8);
  return [
    {
      role: "system",
      content: `You are the second-pass reviewer for cheap manufacturing contact enrichment. Return JSON only: {"contacts":[{"name":"","title":"","linkedin":"","source_url":"","notes":""}]}.

Keep every real person tied to the target company who is useful for production, maintenance, plant, operations, quality/QA, warehouse/logistics, procurement/purchasing, general management, owner/operator, or small-plant leadership outreach.
For breweries, cideries, roasteries, bakeries, and small food plants, Head Brewer, Brewer, Brewing Assistant, Head Roaster, Roaster, Owner, Founder, President, VP, General Manager, and similar plant-adjacent leaders are valid operations contacts.
Repair weak titles only when a snippet or page title supports the role. Do not infer a title from the search query alone. Keep the source_url where the name/title/company evidence was found. Use linkedin only for personal /in/ links.
Do not invent people. Do not output departments, job openings, company pages, or filler titles like "operations contact" or "title not public".`
    },
    {
      role: "user",
      content: JSON.stringify({
        target_company: company,
        aliases,
        candidate_contacts: candidates.map((contact) => ({
          name: cleanText(contact?.name),
          title: cleanText(contact?.title),
          linkedin: normalizeLinkedInUrl(contact?.linkedin),
          source_url: cleanText(contact?.source_url),
          notes: cleanText(contact?.notes)
        })),
        public_search_snippets: snippets
      }, null, 2)
    }
  ];
}

function buildNanoContactEvidenceSnippets(evidence, existingContacts = []) {
  const existingHints = toArray(existingContacts)
    .filter((contact) => isWeakContactTitle(contact?.title) && (cleanText(contact?.name) || normalizeLinkedInUrl(contact?.linkedin)))
    .map((contact) => ({
      priority: 0,
      title: cleanText(contact?.name),
      snippet: [cleanText(contact?.title), "existing CRM weak-title contact to repair"].filter(Boolean).join(" | "),
      url: normalizeLinkedInUrl(contact?.linkedin) || cleanText(contact?.linkedin),
      query: ""
    }));
  const nameCandidates = toArray(evidence?.contactCandidates)
    .map((contact) => ({
      priority: 0,
      title: cleanText(contact?.name),
      snippet: [cleanText(contact?.title), "public LinkedIn/name candidate to repair"].filter(Boolean).join(" | "),
      url: normalizeLinkedInUrl(contact?.linkedin) || cleanText(contact?.source_url),
      query: ""
    }));

  const searchSnippets = toArray(evidence.peopleResults).map((result) => ({
    priority: contactEvidencePriority(result),
    title: cleanText(result?.title),
    snippet: cleanText(result?.snippet),
    url: cleanText(result?.url),
    query: ""
  }));

  return [...existingHints, ...nameCandidates, ...searchSnippets]
    .filter((item) => item.title || item.snippet || item.url)
    .sort((left, right) => left.priority - right.priority)
    .slice(0, NANO_CONTACT_BATCH_SIZE * NANO_CONTACT_MAX_BATCHES);
}

function contactEvidencePriority(result) {
  const text = `${cleanText(result?.title)} ${cleanText(result?.snippet)} ${cleanText(result?.url)}`;
  if (/\b(?:plant manager|maintenance manager|maintenance supervisor|production manager|production supervisor|operations manager|operations supervisor|quality assurance manager|qa manager|procurement manager|purchasing manager|head brewer|lead brewer|brewery manager|head roaster|owner|founder|president|vice president|vp)\b/i.test(text)) {
    return 1;
  }
  if (/\b(?:signalhire|wiza|rocketreach|zoominfo|apollo|allbiz|linkedin\.com\/in)\b/i.test(text)) {
    return 2;
  }
  if (TARGET_TITLE_PATTERN.test(text)) {
    return 3;
  }
  return 4;
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
  if (isWeakGenericOpenAiTitle(title)) {
    return null;
  }
  if (!sourceSupportsContactTitle({ name, title, linkedin, source_url: sourceUrl }, evidence)) {
    return null;
  }
  return {
    name,
    title,
    linkedin,
    source_url: sourceUrl || linkedin,
    notes: cleanText(contact?.notes || "gpt-5-nano contact extraction")
  };
}

function sourceSupportsContactTitle(contact, evidence) {
  const title = cleanText(contact?.title);
  if (!title) return false;
  const supportText = contactSupportText(contact, evidence);
  if (!supportText) return false;
  return roleTitleAppearsInText(title, supportText);
}

function contactSupportText(contact, evidence) {
  const sourceUrl = normalizeResultUrl(contact?.source_url || contact?.linkedin);
  const nameKey = normalizePersonNameKey(contact?.name);
  const lines = [];

  for (const result of toArray(evidence?.peopleResults)) {
    const resultUrl = normalizeResultUrl(result?.url);
    const text = [cleanText(result?.title), cleanText(result?.snippet), cleanText(result?.url)].filter(Boolean).join(" ");
    if ((sourceUrl && resultUrl === sourceUrl) || (nameKey && normalizeCompanyKey(text).includes(nameKey))) {
      lines.push(text);
    }
  }

  for (const entry of toArray(evidence?.packet?.evidence)) {
    const text = cleanText(entry);
    if (!text) continue;
    if ((sourceUrl && normalizeCompanyKey(text).includes(normalizeCompanyKey(sourceUrl))) || (nameKey && normalizeCompanyKey(text).includes(nameKey))) {
      lines.push(text);
    }
  }

  return lines.join(" ");
}

function roleTitleAppearsInText(title, text) {
  const role = normalizeCompanyKey(title);
  const haystack = normalizeCompanyKey(text);
  if (!role || !haystack) return false;
  if (haystack.includes(role)) return true;
  const synonyms = [
    [/^vice president$/, /\b(?:vice president|vp)\b/i],
    [/^chief operating officer$/, /\b(?:chief operating officer|chief operations officer|coo)\b/i],
    [/^director of operations$/, /\b(?:director of operations|operations director)\b/i],
    [/^brewing assistant$/, /\bbrewing assist(?:ant|\.)?\b/i],
    [/^production and manufacturing leader$/, /\bproduction and manufacturing leader\b/i],
    [/^manufacturing leader$/, /\bmanufacturing leader\b/i]
  ];
  return synonyms.some(([rolePattern, textPattern]) => rolePattern.test(role) && textPattern.test(text));
}

async function findHiringExpansionSignals(evidence) {
  const queries = buildRecentSignalQueries(evidence);
  const collected = [];

  for (const query of queries.slice(0, 14)) {
    try {
      const results = await searchWeb(query, {
        limit: 3,
        keepUrlPath: true,
        keepJobResults: true,
        allowBlockedDomains: true,
        timeoutMs: 12000,
        skipPatterns: ["salary estimate", "resume", "charity", "award", "review"]
      });
      collected.push(...results.map((result) => ({ ...result, query })));
    } catch {
      continue;
    }
  }

  let signals = normalizeSignalResults(collected, evidence);
  if (signals.length < 2) {
    const breadcrumbQueries = buildBreadcrumbSignalQueries(evidence, collected);
    for (const query of breadcrumbQueries.slice(0, 8)) {
      try {
        const results = await searchWeb(query, {
          limit: 2,
          keepUrlPath: true,
          keepJobResults: true,
          allowBlockedDomains: true,
          timeoutMs: 12000,
          skipPatterns: ["salary estimate", "resume", "charity", "award", "review"]
        });
        collected.push(...results.map((result) => ({ ...result, query })));
      } catch {
        continue;
      }
    }
    signals = normalizeSignalResults(collected, evidence);
  }

  if (NANO_SIGNAL_EXTRACT_ENABLED && process.env.OPENAI_API_KEY && signals.length < 2 && collected.length) {
    try {
      const nanoSignals = await extractSignalsWithNano(evidence, collected, {
        seedSignals: signals,
        model: DEFAULT_SIGNAL_EXTRACT_MODEL
      });
      signals = dedupeSignals([...signals, ...nanoSignals]);
    } catch {
      // Keep the rule-based signal result when the cheap model pass fails.
    }
  }

  return signals.slice(0, 5);
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
    `"${company}" brewer job ${city}`,
    `"${company}" roaster job ${city}`,
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

function buildBreadcrumbSignalQueries(evidence, results) {
  const breadcrumbs = results.filter((result) => isRecentSignalBreadcrumb(result, evidence)).slice(0, 4);
  if (!breadcrumbs.length) {
    return [];
  }

  const company = evidence.searchCompany;
  const city = evidence.city || "Ontario";
  const host = normalizeHostname(evidence.websiteUrl);
  const breadcrumbHosts = uniqueOrdered(
    breadcrumbs
      .map((result) => normalizeHostname(result?.url))
      .filter((hostname) => hostname && SIGNAL_JOB_BOARD_PATTERN.test(hostname))
  ).slice(0, 2);

  return uniqueOrdered([
    `"${company}" "maintenance mechanic" job ${city}`,
    `"${company}" millwright job ${city}`,
    `"${company}" "production operator" job ${city}`,
    `"${company}" "production supervisor" job ${city}`,
    `"${company}" "plant manager" job ${city}`,
    `"${company}" brewer job ${city}`,
    `"${company}" roaster job ${city}`,
    `"${company}" "new facility" OR expansion ${city}`,
    `"${company}" permit construction expansion ${city}`,
    `"${company}" investment capacity production ${city}`,
    host ? `site:${host} careers "maintenance" OR "production"` : "",
    host ? `site:${host} "new facility" OR expansion OR investment` : "",
    ...breadcrumbHosts.flatMap((hostname) => [
      `site:${hostname} "${company}" "maintenance mechanic"`,
      `site:${hostname} "${company}" "production operator"`,
      `site:${hostname} "${company}" "production supervisor"`
    ])
  ].filter(Boolean));
}

async function extractSignalsWithNano(evidence, results, {
  apiKey = process.env.OPENAI_API_KEY,
  model = DEFAULT_SIGNAL_EXTRACT_MODEL,
  seedSignals = [],
  timeoutMs = 35000
} = {}) {
  if (!apiKey) {
    return [];
  }

  const snippets = dedupeResultsByUrl(results)
    .slice(0, 48)
    .map((result) => ({
      title: cleanText(result?.title),
      snippet: cleanText(result?.snippet),
      url: cleanText(result?.url),
      query: cleanText(result?.query)
    }))
    .filter((result) => result.title || result.snippet || result.url);
  if (!snippets.length) {
    return [];
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const requestBody = {
      model: resolveNanoOnlyModel(model, DEFAULT_SIGNAL_EXTRACT_MODEL),
      messages: buildNanoSignalMessages(evidence, snippets, seedSignals),
      response_format: { type: "json_object" }
    };
    if (/^gpt-5/i.test(requestBody.model)) {
      requestBody.max_completion_tokens = 2200;
      requestBody.reasoning_effort = "minimal";
    } else {
      requestBody.max_tokens = 1100;
      requestBody.temperature = 0;
    }

    const response = await fetch(OPENAI_CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`OpenAI nano signal extraction failed ${response.status}: ${body.slice(0, 500)}`);
    }
    const data = JSON.parse(body);
    const content = cleanText(data?.choices?.[0]?.message?.content);
    if (!content) {
      return [];
    }
    const parsed = JSON.parse(content);
    return dedupeSignals(
      toArray(parsed.signals)
        .map((signal) => normalizeNanoSignal(signal, evidence))
        .filter(Boolean)
    );
  } finally {
    clearTimeout(timer);
  }
}

function buildNanoSignalMessages(evidence, snippets, seedSignals = []) {
  const company = evidence.searchCompany || evidence.manufacturer?.company || "";
  const aliases = uniqueOrdered([company, ...toArray(evidence.companyHints)]).slice(0, 8);
  return [
    {
      role: "system",
      content: `You judge recent manufacturing hiring or expansion signals from public search snippets. Return JSON only: {"signals":[{"type":"","title":"","date":"","source_url":"","evidence":"","why_it_matters":""}]}.

Keep only signals tied to the target company and plant/production/maintenance/warehouse/QA/operations hiring, or real expansion/planned expansion/new facility/new production line/capacity/permit/ECA/construction/investment evidence.
Generic careers pages, Indeed company profiles, LinkedIn company pages, directory profiles, awards, about-page facts, product pages, and old founding/opening history are not final signals.
If a careers/job-board result names a relevant role like millwright, maintenance, production, packaging, warehouse, QA, sanitation, brewer, roaster, or plant/operations supervisor, keep it.
Prefer 2024, 2025, or 2026 signals. Reject clearly old-only results before 2024 unless they say planned/current/now hiring.
Make why_it_matters specific to the evidence.`
    },
    {
      role: "user",
      content: JSON.stringify({
        target_company: company,
        aliases,
        already_kept_signals: toArray(seedSignals).map((signal) => ({
          type: cleanText(signal?.type),
          title: cleanText(signal?.title),
          source_url: cleanText(signal?.url),
          evidence: cleanText(signal?.snippet)
        })),
        public_search_snippets: snippets
      }, null, 2)
    }
  ];
}

function normalizeSignalResults(results, evidence) {
  return dedupeSignals(
    results
      .map((result) => normalizeSignalResult(result, evidence))
      .filter(Boolean)
  );
}

function normalizeNanoSignal(signal, evidence) {
  const title = cleanText(signal?.title);
  const snippet = cleanText(signal?.evidence || signal?.snippet);
  const url = cleanText(signal?.source_url || signal?.url);
  const text = snippet;
  if (!title && !snippet) return null;
  if (!url || isStaleSignalText(text)) return null;
  if (!matchesSignalCompanyContext({ titleText: "", snippet, evidence }) && !isOfficialCompanyHost(url, evidence.websiteUrl)) {
    return null;
  }
  const typeText = cleanText(signal?.type).toLowerCase();
  let classification = classifyRecentSignalResult({ title: "", snippet, url });
  if (!classification) {
    const hasHiringEvidence = /hiring|job|career|recruit/i.test(typeText) && SIGNAL_HIRING_ACTION_PATTERN.test(text) && SIGNAL_HIRING_ROLE_PATTERN.test(text);
    const hasExpansionEvidence = /expansion|facility|plant|construction|investment|permit|eca|approval|capacity|line|upgrade|planned/i.test(typeText) && SIGNAL_EXPANSION_EVIDENCE_PATTERN.test(text);
    if (!hasHiringEvidence && !hasExpansionEvidence) {
      return null;
    }
    classification = {
      type: /permit|eca|approval/i.test(typeText) ? "Permit"
        : /capacity|line|upgrade/i.test(typeText) ? "Capacity"
        : /planned/i.test(typeText) ? "Planned expansion"
        : /expansion|facility|plant|construction|investment/i.test(typeText) ? "Expansion"
        : "Hiring"
    };
  }
  if (!classification?.type) return null;
  if (isInvalidRecentSignal({ title, snippet, url, classification })) return null;
  return {
    type: classification.type,
    title,
    snippet,
    url,
    date: cleanText(signal?.date) || extractDateHint(text),
    why: cleanText(signal?.why_it_matters) || buildRecentSignalWhy(classification)
  };
}

function normalizeSignalResult(result, evidence) {
  const title = cleanText(result?.title);
  const snippet = cleanText(result?.snippet);
  const url = cleanText(result?.url);
  const text = `${title} ${snippet}`;
  if (!url) {
    return null;
  }
  if (isStaleSignalText(text)) {
    return null;
  }
  const classification = classifyRecentSignalResult({ title, snippet, url });
  if (!classification) {
    return null;
  }
  if (isInvalidRecentSignal({ title, snippet, url, classification })) {
    return null;
  }
  if (SIGNAL_NOISE_PATTERN.test(text) && !classification.isHardEvidence && !SIGNAL_NOISE_OVERRIDE_PATTERN.test(text)) {
    return null;
  }
  if (SIGNAL_STALE_OR_GENERIC_PATTERN.test(text) && !classification.isHardEvidence) {
    return null;
  }
  if (!matchesSignalCompanyContext({ titleText: title, snippet, evidence }) && !isOfficialCompanyHost(url, evidence.websiteUrl)) {
    return null;
  }

  return {
    type: classification.type,
    title,
    snippet,
    url,
    date: extractDateHint(text),
    why: buildRecentSignalWhy(classification)
  };
}

function isInvalidRecentSignal({ title, snippet, url, classification }) {
  const text = `${cleanText(title)} ${cleanText(snippet)}`;
  const sourceUrl = cleanText(url);
  if (/linkedin\.com\/company\//i.test(sourceUrl)) {
    return true;
  }
  if (SIGNAL_NEGATIVE_CHANGE_PATTERN.test(text)) {
    return true;
  }
  if (SIGNAL_NON_OPERATIONAL_ROLE_PATTERN.test(text) && !SIGNAL_HIRING_ROLE_PATTERN.test(text)) {
    return true;
  }
  if (SIGNAL_JOB_BOARD_PATTERN.test(sourceUrl) && SIGNAL_HIRING_ACTION_PATTERN.test(text) && !SIGNAL_HIRING_ROLE_PATTERN.test(text)) {
    return true;
  }
  if (classification?.type === "Hiring" && !SIGNAL_HIRING_ROLE_PATTERN.test(text)) {
    return true;
  }
  return false;
}

function classifyRecentSignalResult({ title, snippet, url }) {
  const text = `${title} ${snippet}`;
  if (!SIGNAL_INCLUDE_PATTERN.test(text) && !SIGNAL_HIRING_ACTION_PATTERN.test(text) && !SIGNAL_EXPANSION_EVIDENCE_PATTERN.test(text)) {
    return null;
  }

  const hasHiringAction = SIGNAL_HIRING_ACTION_PATTERN.test(text);
  const role = extractSignalRole(text);
  const hasExpansionEvidence = SIGNAL_EXPANSION_EVIDENCE_PATTERN.test(text);
  const isGenericBreadcrumb = isRecentSignalBreadcrumb({ title, snippet, url });

  if (hasHiringAction && role) {
    return {
      type: "Hiring",
      role,
      isHardEvidence: true
    };
  }
  if (hasExpansionEvidence) {
    return {
      type: classifyExpansionSignalType(text),
      isHardEvidence: true
    };
  }
  if (isGenericBreadcrumb) {
    return null;
  }
  return null;
}

function isRecentSignalBreadcrumb(result) {
  const title = cleanText(result?.title);
  const snippet = cleanText(result?.snippet);
  const url = cleanText(result?.url);
  const text = `${title} ${snippet}`;
  const isJobBoardProfile = SIGNAL_JOB_BOARD_PATTERN.test(url) && /\/(?:cmp|company|locations)\//i.test(url);
  return (SIGNAL_GENERIC_BREADCRUMB_PATTERN.test(text) || isJobBoardProfile || /\bcareers?\b/i.test(text))
    && !SIGNAL_HIRING_ROLE_PATTERN.test(text)
    && !SIGNAL_EXPANSION_EVIDENCE_PATTERN.test(text);
}

function extractSignalRole(text) {
  const match = SIGNAL_ROLE_LABELS.find(([, pattern]) => pattern.test(text));
  return match ? match[0] : "";
}

function classifyExpansionSignalType(text) {
  if (/\b(permit|approval|environmental compliance approval|eca|building permit)\b/i.test(text)) {
    return "Permit";
  }
  if (/\b(capacity|production line|equipment upgrade|plant upgrade)\b/i.test(text)) {
    return "Capacity";
  }
  if (/\b(planned expansion|planning to expand|proposed expansion)\b/i.test(text)) {
    return "Planned expansion";
  }
  return "Expansion";
}

function buildRecentSignalWhy(classification) {
  if (classification.type === "Hiring") {
    return classification.role
      ? `They are publicly hiring for ${classification.role}, which points to active plant, maintenance, production, or operations capacity needs.`
      : "They are publicly hiring for a plant-related role, which points to active operational capacity needs.";
  }
  if (classification.type === "Permit") {
    return "A permit, approval, or ECA result can indicate facility work, process changes, or plant expansion activity.";
  }
  if (classification.type === "Capacity") {
    return "The result mentions capacity, a production line, or plant equipment changes, which can point to operational growth.";
  }
  if (classification.type === "Planned expansion") {
    return "The result mentions planned expansion, which can point to upcoming facility, staffing, or production needs.";
  }
  return "The result mentions facility, construction, investment, or expansion activity tied to operational growth.";
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
  const wideQueries = buildWidePeopleSearchQueries(companyHints);
  const publicSourceQueries = buildPublicSourcePeopleSearchQueries(companyHints);
  const priorityQueries = buildPriorityPeopleSearchQueries(companyHints)
    .filter((query) => !publicSourceQueries.includes(query) && !wideQueries.includes(query));
  const queries = buildPeopleSearchQueries(companyHints, city);

  const collected = [];
  for (const batch of chunkArray(wideQueries.slice(0, WIDE_PEOPLE_SEARCH_QUERY_LIMIT), 4)) {
    const settled = await Promise.allSettled(batch.map((query) => searchPeopleQuery(query)));
    for (const result of settled) {
      if (result.status === "fulfilled") {
        collected.push(...result.value);
      }
    }
    if (hasEnoughContactsFromCollectedResults(collected, companyHints, city)) {
      return dedupeResultsByUrl(collected).slice(0, 100);
    }
  }

  for (const query of publicSourceQueries) {
    try {
      collected.push(...await searchPeopleQuery(query));
      if (hasEnoughContactsFromCollectedResults(collected, companyHints, city)) {
        return dedupeResultsByUrl(collected).slice(0, 100);
      }
    } catch {
      continue;
    }
  }

  for (const batch of chunkArray(priorityQueries.slice(0, MAX_PRIORITY_PEOPLE_SEARCH_QUERIES), 4)) {
    const settled = await Promise.allSettled(batch.map((query) => searchPeopleQuery(query)));
    for (const result of settled) {
      if (result.status === "fulfilled") {
        collected.push(...result.value);
      }
    }
    if (hasEnoughContactsFromCollectedResults(collected, companyHints, city)) {
      return dedupeResultsByUrl(collected).slice(0, 100);
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
    if (hasEnoughContactsFromCollectedResults(collected, companyHints, city)) {
      return dedupeResultsByUrl(collected).slice(0, 100);
    }
  }

  return dedupeResultsByUrl(collected).slice(0, 100);
}

function hasEnoughContactsFromCollectedResults(results, companyHints = [], city = "") {
  const filtered = filterPeopleResultsByCompany(dedupeResultsByUrl(results), companyHints, { city });
  const contacts = dedupeContacts([
    ...extractLinkedInContacts(filtered, companyHints),
    ...extractDirectoryContacts(filtered, companyHints),
    ...extractOpenWebContacts(filtered, companyHints)
  ]).filter(isUsefulContact);
  return hasEnoughTargetContacts(contacts);
}

function buildWidePeopleSearchQueries(companyHints = []) {
  const hints = buildCompanySearchAliases(companyHints, 5);
  const queries = [];
  for (const hint of hints) {
    queries.push(`"${hint}" LinkedIn`);
    queries.push(`"${hint}" employees`);
    queries.push(`"${hint}" employee directory`);
    queries.push(`"${hint}" management team`);
    queries.push(`site:linkedin.com/in "${hint}"`);
    queries.push(`site:ca.linkedin.com/in "${hint}"`);
    queries.push(`site:wiza.co "${hint}"`);
    queries.push(`site:rocketreach.co "${hint}"`);
    queries.push(`site:zoominfo.com "${hint}"`);
    queries.push(`site:signalhire.com "${hint}"`);
    queries.push(`site:apollo.io "${hint}"`);
    queries.push(`site:theorg.com "${hint}"`);
  }
  return uniqueOrdered(queries);
}

async function collectNarrowPeopleResults(evidence, contacts = []) {
  const queries = buildNarrowPeopleRetryQueries(evidence, contacts);
  const collected = [];
  for (const batch of chunkArray(queries.slice(0, NARROW_PEOPLE_RETRY_QUERY_LIMIT), 5)) {
    const settled = await Promise.allSettled(batch.map((query) => searchPeopleQuery(query)));
    for (const result of settled) {
      if (result.status === "fulfilled") {
        collected.push(...result.value);
      }
    }
    const filtered = filterPeopleResultsByCompany(collected, evidence.companyHints, { city: evidence.city });
    const candidateContacts = dedupeContacts([
      ...extractLinkedInContacts(filtered, evidence.companyHints),
      ...extractDirectoryContacts(filtered, evidence.companyHints),
      ...extractOpenWebContacts(filtered, evidence.companyHints)
    ]).filter(isUsefulContact);
    if (hasEnoughTargetContacts(dedupeContacts([...contacts, ...candidateContacts]))) {
      break;
    }
  }
  return filterPeopleResultsByCompany(dedupeResultsByUrl(collected), evidence.companyHints, { city: evidence.city });
}

async function collectTitleRepairPeopleResults(evidence, { contacts = [], candidates = [] } = {}) {
  const queries = buildTitleRepairPeopleQueries(evidence, { contacts, candidates });
  const collected = [];
  for (const batch of chunkArray(queries.slice(0, TITLE_REPAIR_SEARCH_QUERY_LIMIT), 5)) {
    const settled = await Promise.allSettled(batch.map((query) => searchPeopleQuery(query)));
    for (const result of settled) {
      if (result.status === "fulfilled") {
        collected.push(...result.value);
      }
    }
    const filtered = filterPeopleResultsByCompany(collected, evidence.companyHints, { city: evidence.city });
    const repairedContacts = dedupeContacts([
      ...extractLinkedInContacts(filtered, evidence.companyHints),
      ...extractRepairedNameContacts(filtered, candidates, evidence.companyHints),
      ...extractDirectoryContacts(filtered, evidence.companyHints),
      ...extractOpenWebContacts(filtered, evidence.companyHints)
    ]).filter(isUsefulContact);
    if (hasEnoughTargetContacts(dedupeContacts([...contacts, ...repairedContacts]))) {
      break;
    }
  }
  return filterPeopleResultsByCompany(dedupeResultsByUrl(collected), evidence.companyHints, { city: evidence.city });
}

function buildNarrowPeopleRetryQueries(evidence, contacts = []) {
  const aliases = buildCompanySearchAliases([
    evidence.searchCompany,
    ...toArray(evidence.companyHints),
    companyAliasFromWebsite(evidence.websiteUrl)
  ].filter(Boolean), 6);
  const foundRoles = new Set(toArray(contacts).map((contact) => normalizeCompanyKey(contact?.title)));
  const retryTitles = [
    "maintenance manager",
    "maintenance supervisor",
    "maintenance technician",
    "millwright",
    "plant manager",
    "facility manager",
    "production manager",
    "production supervisor",
    "operations manager",
    "director of operations",
    "chief operating officer",
    "quality assurance manager",
    "quality manager",
    "technical services manager",
    "engineering manager",
    "warehouse manager",
    "logistics manager",
    "supply chain manager",
    "procurement manager",
    "purchasing manager",
    "head brewer",
    "brewing assistant",
    "brewer",
    "head roaster",
    "roaster",
    "owner",
    "president"
  ].filter((title) => !foundRoles.has(normalizeCompanyKey(title)));

  const queries = [];
  for (const alias of aliases) {
    for (const title of retryTitles) {
      queries.push(`"${alias}" "${title}"`);
      queries.push(`site:linkedin.com/in "${alias}" "${title}"`);
      queries.push(`site:ca.linkedin.com/in "${alias}" "${title}"`);
      queries.push(`site:wiza.co "${alias}" "${title}"`);
      queries.push(`site:rocketreach.co "${alias}" "${title}"`);
      queries.push(`site:zoominfo.com "${alias}" "${title}"`);
    }
  }
  return uniqueOrdered(queries);
}

function buildTitleRepairPeopleQueries(evidence, { contacts = [], candidates = [] } = {}) {
  const aliases = buildCompanySearchAliases([
    evidence.searchCompany,
    ...toArray(evidence.companyHints),
    companyAliasFromWebsite(evidence.websiteUrl)
  ].filter(Boolean), 4);
  const people = dedupeContactCandidates([
    ...toArray(candidates),
    ...toArray(contacts)
      .filter((contact) => !isUsefulContact(contact) || isWeakContactTitle(contact?.title))
      .map((contact) => ({
        name: cleanText(contact?.name),
        title: cleanText(contact?.title),
        linkedin: normalizeLinkedInUrl(contact?.linkedin),
        source_url: cleanText(contact?.source_url)
      }))
  ]).slice(0, NAME_ONLY_CONTACT_CANDIDATE_LIMIT);
  const titleRepairTerms = [
    "plant manager",
    "maintenance manager",
    "production manager",
    "operations manager",
    "quality manager",
    "quality assurance",
    "technical services",
    "facility manager",
    "warehouse manager",
    "procurement",
    "purchasing",
    "owner",
    "president",
    "vice president",
    "general manager"
  ];
  const queries = [];
  for (const person of people) {
    const name = cleanText(person.name);
    if (!name) continue;
    for (const alias of aliases) {
      queries.push(`"${name}" "${alias}" LinkedIn`);
      queries.push(`site:linkedin.com/in "${name}" "${alias}"`);
      queries.push(`site:ca.linkedin.com/in "${name}" "${alias}"`);
      queries.push(`site:rocketreach.co "${name}" "${alias}"`);
      queries.push(`site:zoominfo.com "${name}" "${alias}"`);
      queries.push(`site:wiza.co "${name}" "${alias}"`);
      for (const title of titleRepairTerms) {
        queries.push(`"${name}" "${alias}" "${title}"`);
        queries.push(`site:linkedin.com/in "${name}" "${alias}" "${title}"`);
        queries.push(`site:ca.linkedin.com/in "${name}" "${alias}" "${title}"`);
      }
    }
  }
  return uniqueOrdered(queries);
}

function mergePeopleResultsIntoEvidence(evidence, results) {
  const mergedResults = dedupeResultsByUrl([
    ...toArray(evidence.peopleResults),
    ...toArray(results)
  ]).slice(0, 140);
  evidence.peopleResults = mergedResults;

  if (evidence.packet) {
    evidence.packet.source_urls = uniqueOrdered([
      ...toArray(evidence.packet.source_urls),
      ...mergedResults.map((result) => cleanText(result?.url))
    ].filter(Boolean));
    evidence.packet.evidence = uniqueOrdered([
      ...toArray(evidence.packet.evidence),
      ...toArray(results).slice(0, 60).map((result) => [
        cleanText(result?.title),
        cleanText(result?.snippet),
        cleanText(result?.url)
      ].filter(Boolean).join(" | "))
    ].filter(Boolean)).slice(0, 140);
  }
}

function companyAliasFromWebsite(websiteUrl) {
  const hostname = normalizeHostname(websiteUrl);
  if (!hostname) return "";
  return hostname
    .replace(/\.(?:com|ca|net|org|co)$/i, "")
    .replace(/inc$/i, "")
    .replace(/[-_]+/g, " ")
    .trim();
}

function buildPublicSourcePeopleSearchQueries(companyHints = []) {
  const hints = buildCompanySearchAliases(companyHints, 3);
  const queries = [];
  for (const hint of hints) {
    queries.push(`"${hint}" "Operations Manager" "Bakers Journal"`);
    queries.push(`"${hint}" "Quality Assurance Manager" "Bakers Journal"`);
  }
  return uniqueOrdered(queries);
}

function buildPriorityPeopleSearchQueries(companyHints = []) {
  const hints = buildCompanySearchAliases(companyHints, 3);
  const topLinkedInTitles = [
    "head brewer",
    "brewing assistant",
    "brewer",
    "head roaster",
    "roaster",
    "plant manager",
    "operations manager",
    "production manager",
    "maintenance supervisor",
    "maintenance manager",
    "quality assurance manager",
    "quality assurance specialist",
    "qa manager",
    "qa specialist",
    "supervisor",
    "machine operator",
    "sanitation worker",
    "operator",
    "owner",
    "president",
    "vice president",
    "vp",
    "founder",
    "partner",
    "board member",
    "acquired"
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
    queries.push(`site:signalhire.com "${hint}" employees`);
    queries.push(`site:allbiz.ca "${hint}"`);
    queries.push(`site:wiza.co "${hint}"`);
    queries.push(`"${hint}" "Operations Manager" "Bakers Journal"`);
    queries.push(`"${hint}" "Quality Assurance Manager" "Bakers Journal"`);
  }
  for (const title of topLinkedInTitles) {
    for (const hint of hints) {
      queries.push(`"${hint}" "${title}"`);
      queries.push(`site:linkedin.com/in "${hint}" "${title}"`);
      queries.push(`site:ca.linkedin.com/in "${hint}" "${title}"`);
      queries.push(`site:signalhire.com "${hint}" "${title}"`);
      queries.push(`site:allbiz.ca "${hint}" "${title}"`);
    }
  }
  return uniqueOrdered(queries);
}

function buildPeopleSearchQueries(companyHints = [], city) {
  const queries = [];
  const hints = buildCompanySearchAliases(companyHints, 5);
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
    timeoutMs: PEOPLE_SEARCH_TIMEOUT_MS
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

function normalizeExistingCrmContacts(existingContacts) {
  return dedupeContacts(
    toArray(existingContacts).flatMap((contact) => [
      {
        name: cleanText(contact?.name),
        title: cleanText(contact?.title),
        linkedin: normalizeLinkedInUrl(contact?.linkedin) || cleanText(contact?.linkedin),
        source_url: cleanText(contact?.linkedin),
        notes: "Existing CRM contact"
      },
      ...parseEmbeddedExistingContacts(contact)
    ])
  );
}

function parseEmbeddedExistingContacts(contact) {
  const raw = String(contact?.name || "");
  const link = normalizeLinkedInUrl(contact?.linkedin) || cleanText(contact?.linkedin);
  const chunks = raw
    .split(/\t+|\s{2,}|\s+\|\s+/)
    .map((chunk) => cleanText(chunk).replace(/^\d+\s*[-.)]?\s*/, "").trim())
    .filter(Boolean);
  const contacts = [];

  for (let index = 0; index < chunks.length; index += 1) {
    const name = cleanPersonNameVariant(chunks[index]);
    if (!name || isUsefulContactTitle(chunks[index])) continue;
    const title = cleanRoleText(chunks[index + 1] || "");
    if (!title || !isUsefulContactTitle(title)) continue;
    contacts.push({
      name,
      title,
      linkedin: link,
      source_url: link,
      notes: "Repaired from existing CRM pasted contact text"
    });
  }

  return contacts;
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

function extractContactNameCandidates(evidence) {
  const phrases = buildCompanyPhrases(evidence?.companyHints);
  const tokens = buildCompanyTokenSets(evidence?.companyHints);
  return dedupeContactCandidates([
    ...toArray(evidence?.profile?.contacts).map((contact) => ({
      name: cleanPersonName(contact?.name) || cleanText(contact?.name),
      title: cleanRoleText(contact?.title),
      linkedin: normalizeLinkedInUrl(contact?.linkedin),
      source_url: cleanText(evidence?.websiteUrl),
      notes: "company website contact candidate"
    })),
    ...toArray(evidence?.peopleResults).map((result) => {
      const titleText = cleanText(result?.title);
      const snippet = cleanText(result?.snippet);
      const url = normalizeLinkedInUrl(result?.url);
      if (!url || isPastRoleSnippet(snippet) || !matchesCompanyContext({ titleText, snippet, companyPhrases: phrases, companyTokenSets: tokens })) {
        return null;
      }
      const name = parseLinkedInName(titleText);
      if (!name) {
        return null;
      }
      return {
        name,
        title: parseLinkedInRole(titleText, snippet, result, evidence?.companyHints) || "",
        linkedin: url,
        source_url: url,
        notes: "LinkedIn profile candidate"
      };
    }).filter(Boolean)
  ]).slice(0, NAME_ONLY_CONTACT_CANDIDATE_LIMIT);
}

function extractRepairedNameContacts(results, candidates = [], companyHints = []) {
  const candidateList = dedupeContactCandidates(candidates);
  if (!candidateList.length) {
    return [];
  }
  return dedupeContacts(
    toArray(results).flatMap((result) => {
      const titleText = cleanText(result?.title);
      const snippet = cleanText(result?.snippet);
      const url = cleanText(result?.url);
      const linkedInUrl = normalizeLinkedInUrl(url);
      const resultText = [titleText, snippet, url].filter(Boolean).join(" ");
      return candidateList.map((candidate) => {
        const name = cleanPersonName(candidate?.name);
        if (!name || isPastRoleSnippet(snippet)) {
          return null;
        }
        const sameLinkedIn = linkedInUrl && normalizeLinkedInUrl(candidate?.linkedin) === linkedInUrl;
        const mentionsName = normalizeCompanyKey(resultText).includes(normalizePersonNameKey(name));
        if (!sameLinkedIn && !mentionsName) {
          return null;
        }
        if (!matchesCompanyContext({
          titleText,
          snippet,
          companyPhrases: buildCompanyPhrases(companyHints),
          companyTokenSets: buildCompanyTokenSets(companyHints)
        })) {
          return null;
        }
        const title = parseLinkedInRole(titleText, snippet, result, companyHints) ||
          inferRoleFromVisibleText(resultText);
        if (!isUsefulContactTitle(title)) {
          return null;
        }
        return {
          name,
          title,
          linkedin: normalizeLinkedInUrl(candidate?.linkedin) || linkedInUrl,
          source_url: url || cleanText(candidate?.source_url),
          notes: "title repaired from public people search"
        };
      }).filter(Boolean);
    })
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

  const titleBeforeAtMatch = snippetText.match(/\b([A-Z][A-Za-z'`.-]+(?:\s+[A-Z][A-Za-z'`.-]+){1,4})\s+(chief operating officer|chief operations officer|coo|director of operations|operations director|production manager|production supervisor|plant manager|maintenance manager|maintenance supervisor|quality assurance manager|supply chain manager|supply chain director)\s+at\s+/i);
  if (titleBeforeAtMatch) {
    const nameValue = /\bPeople Like\b/i.test(snippetText)
      ? lastNameWords(titleBeforeAtMatch[1], 2)
      : titleBeforeAtMatch[1];
    return buildParsedContact(nameValue, titleBeforeAtMatch[2]);
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

function lastNameWords(value, count = 2) {
  const words = cleanText(value).split(/\s+/).filter(Boolean);
  return words.slice(Math.max(0, words.length - count)).join(" ");
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

function hasEnoughTargetContacts(contacts) {
  const useful = dedupeContacts(toArray(contacts).filter(isUsefulContact));
  const strong = useful.filter(isStrongProductionContact);
  return strong.length >= MIN_TARGET_CONTACTS || useful.length >= MIN_TARGET_CONTACTS || useful.length >= MAX_CONTACTS_PER_COMPANY;
}

function isStrongProductionContact(contact) {
  const text = `${cleanText(contact?.title)} ${cleanText(contact?.notes)}`;
  return /\b(?:plant manager|plant supervisor|maintenance manager|maintenance supervisor|production manager|production supervisor|operations manager|operations supervisor|quality assurance manager|qa manager|quality manager|procurement manager|purchasing manager|warehouse manager|logistics manager|head brewer|lead brewer|brewery manager|head roaster|owner|founder|president|vice president|vp)\b/i.test(text);
}

function isUsefulContactTitle(title) {
  const text = cleanText(title);
  return !!text &&
    text.length <= 140 &&
    !isWeakGenericOpenAiTitle(text) &&
    !(EXCLUDED_CONTACT_TITLE_PATTERN.test(text) && !EXCLUDED_CONTACT_OVERRIDE_PATTERN.test(text)) &&
    TARGET_TITLE_PATTERN.test(text);
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
  if (visibleRole && matchesStrictCompanyContext({ titleText: cleanTitle, snippet, companyHints })) {
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
    [/\bchief operating officer\b|\bchief operations officer\b|\bcoo\b/i, "Chief Operating Officer"],
    [/\bdirector of operations\b|\boperations director\b/i, "Director of Operations"],
    [/\bproduction and manufacturing leader\b/i, "Production and Manufacturing Leader"],
    [/\bmanufacturing leader\b/i, "Manufacturing Leader"],
    [/\bhead brewer\b/i, "Head Brewer"],
    [/\blead brewer\b/i, "Lead Brewer"],
    [/\bbrewing assist(?:ant|\.)?\b/i, "Brewing Assistant"],
    [/\bbrewery manager\b/i, "Brewery Manager"],
    [/\bbrewer\b/i, "Brewer"],
    [/\bhead roaster\b/i, "Head Roaster"],
    [/\broast master\b/i, "Roast Master"],
    [/\broaster\b/i, "Roaster"],
    [/\bmachine operator\b/i, "Machine Operator"],
    [/\bsanitation worker\b/i, "Sanitation Worker"],
    [/\bquality assurance specialist\b/i, "Quality Assurance Specialist"],
    [/\bqa specialist\b/i, "QA Specialist"],
    [/\bquality assurance manager\b/i, "Quality Assurance Manager"],
    [/\bqa manager\b/i, "QA Manager"],
    [/\bmaintenance supervisor\b/i, "Maintenance Supervisor"],
    [/\bproduction manager\b/i, "Production Manager"],
    [/\boperations manager\b/i, "Operations Manager"],
    [/\bfacilit(?:y|ies) manager\b/i, "Facility Manager"],
    [/\bplant manager\b/i, "Plant Manager"],
    [/\bsupervisor\b/i, "Supervisor"],
    [/\bboard member\b/i, "Board Member"],
    [/\bpartner\b/i, "Partner / operator"],
    [/\bowner\b/i, "Owner / operator"],
    [/\bfounder\b/i, "Founder / operator"],
    [/\bvice president\b|\bvp\b/i, "Vice President"],
    [/\bpresident\b/i, "President"],
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
  const rawRoleText = cleanText(value);
  const profileRoleMatch = rawRoleText.match(/\b(?:about\s+.+?\s+)?(?:is|works as)\s+(?:currently\s+)?(?:a|an|the)?\s*([^.,|]{3,100})(?:$|\s+at\s+)/i);
  if (/phone number|zoominfo|rocketreach|about\s+/i.test(rawRoleText) && profileRoleMatch) {
    return cleanText(profileRoleMatch[1]).replace(/^[-,|]+|[-,|]+$/g, "").trim();
  }
  return cleanText(value)
    .replace(/\bBrewing\s+Assist\.?\.?/i, "Brewing Assistant")
    .replace(/\s*\|\s*LinkedIn.*$/i, "")
    .replace(/\s+-\s+(?:Wiza|RocketReach|ZoomInfo).*$/i, "")
    .replace(/\s+[Â·|].*$/, "")
    .replace(/^experience:\s*/i, "")
    .replace(/\s+\.{3,}.*$/, "")
    .replace(/\s+at\s+.*$/i, "")
    .replace(/\s+(?:and|&)\s*$/i, "")
    .replace(/^[-,|]+|[-,|]+$/g, "")
    .trim();
}

function cleanPersonName(value) {
  const name = cleanText(value)
    .replace(/\s+-\s+.*$/, "")
    .replace(/\s+(?:email|e-mail|phone|summary|profile|linkedin)\b.*$/i, "")
    .trim();
  if (looksLikePersonName(name)) {
    return name;
  }
  const casedName = toPersonNameCase(name);
  return looksLikePersonName(casedName) ? casedName : "";
}

function toPersonNameCase(value) {
  const text = cleanText(value);
  if (!text || /[A-Z]/.test(text)) {
    return text;
  }
  return text
    .split(/\s+/)
    .map((part) => part.replace(/^([a-z])([a-z'`.-]*)$/i, (_, first, rest) => `${first.toUpperCase()}${String(rest || "").toLowerCase()}`))
    .join(" ");
}

function cleanPersonNameVariant(value) {
  const direct = cleanPersonName(value);
  if (direct) return direct;
  return cleanText(value)
    .split(/\s*\/\s*|\s+or\s+/i)
    .map((part) => cleanPersonName(part))
    .find(Boolean) || "";
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
    tagList.push("contact:missing");
  } else if (contacts.some((contact) => cleanText(contact.linkedin))) {
    tagList.push("contact:linkedin-direct");
  } else {
    tagList.push("contact:public-named");
  }
  return uniqueOrdered(tagList);
}

function findExistingContact(existingRows, nextContact) {
  const nextName = normalizePersonNameKey(nextContact.name);
  const nextTitle = normalizeCompanyKey(nextContact.title);
  const nextLinkedIn = normalizeLinkedInUrl(nextContact.linkedin);
  return toArray(existingRows).find((row) => {
    const sameName = normalizePersonNameKey(row?.name) === nextName;
    const sameTitle = normalizeCompanyKey(row?.title) === nextTitle;
    const sameLinkedIn = normalizeLinkedInUrl(row?.linkedin) === nextLinkedIn;
    return (nextLinkedIn && sameLinkedIn) || (sameName && (sameTitle || isWeakContactTitle(row?.title)));
  }) || null;
}

function shouldUpgradeContactTitle(existingContact, nextContact) {
  const existingTitle = cleanText(existingContact?.title);
  const nextTitle = cleanText(nextContact?.title);
  if (!existingContact?.id || !nextTitle || existingTitle === nextTitle || !isUsefulContactTitle(nextTitle)) {
    return false;
  }
  return isWeakContactTitle(existingTitle);
}

function isWeakContactTitle(title) {
  const text = cleanText(title);
  return !text || isWeakGenericOpenAiTitle(text);
}

function dedupeContacts(contacts) {
  const seen = new Set();
  const seenLinkedIn = new Set();
  const seenNames = new Set();
  const unique = [];
  for (const contact of toArray(contacts).sort((left, right) => contactScore(right) - contactScore(left))) {
    const name = cleanText(contact?.name);
    const title = cleanText(contact?.title);
    const linkedin = normalizeLinkedInUrl(contact?.linkedin);
    const key = `${normalizeCompanyKey(name)}::${normalizeCompanyKey(title)}::${linkedin}`;
    const nameKey = normalizePersonNameKey(name);
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

function dedupeContactCandidates(candidates) {
  const seen = new Set();
  const seenLinkedIn = new Set();
  const unique = [];
  for (const candidate of toArray(candidates).sort((left, right) => contactScore(right) - contactScore(left))) {
    const name = cleanPersonName(candidate?.name);
    if (!name) {
      continue;
    }
    const linkedin = normalizeLinkedInUrl(candidate?.linkedin);
    const key = linkedin || normalizePersonNameKey(name);
    if (!key || seen.has(key) || (linkedin && seenLinkedIn.has(linkedin))) {
      continue;
    }
    seen.add(key);
    if (linkedin) {
      seenLinkedIn.add(linkedin);
    }
    unique.push({
      name,
      title: cleanRoleText(candidate?.title),
      linkedin,
      source_url: cleanText(candidate?.source_url),
      notes: cleanText(candidate?.notes)
    });
  }
  return unique;
}

function normalizePersonNameKey(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/\bsteve\b/g, "steven")
    .replace(/\bmike\b/g, "michael")
    .replace(/\bjoe\b/g, "joseph")
    .replace(/\bbob\b/g, "robert")
    .replace(/\brob\b/g, "robert")
    .replace(/\bliz\b/g, "elizabeth")
    .replace(/\b[a-z]\.?\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function contactScore(contact) {
  const title = cleanText(contact?.title);
  const link = normalizeLinkedInUrl(contact?.linkedin) || cleanText(contact?.source_url);
  let score = 0;
  if (normalizeLinkedInUrl(contact?.linkedin)) score += 30;
  if (link) score += 8;
  if (isStrongProductionContact(contact)) score += 20;
  if (/\b(?:plant|maintenance|production|operations|quality|qa|head brewer|brewer|roaster|owner|founder|president|vice president|vp|general manager)\b/i.test(title)) score += 8;
  if (isWeakGenericOpenAiTitle(title)) score -= 30;
  if (/phone number|zoominfo|rocketreach|about\s+/i.test(title)) score -= 8;
  return score;
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
  const baseName = normalizeCompanySearchName(manufacturer?.company);
  const baseTokens = tokenizeCompanyName(baseName).filter((token) => token.length >= 4);
  const hints = [
    baseName
  ];
  const lines = String(manufacturer?.signals || "").split(/\r?\n/);
  for (const rawLine of lines.slice(0, 14)) {
    const left = sanitizeCompanyHintLine(rawLine.split("|")[0]);
    if (!left) continue;
    const stripped = normalizeCompanySearchName(
      left
        .replace(/\s+-\s+(?:[^|]*?)\b(facility|plant|operations|warehouse|site|location)\b.*$/i, "")
        .replace(/\(([^)]+)\)/g, " $1 ")
    );
    if (stripped && stripped.length >= 4 && companyHintMatchesBase(stripped, baseName, baseTokens)) {
      hints.push(stripped);
    }
  }
  return uniqueOrdered(hints).slice(0, 4);
}

function sanitizeCompanyHintLine(value) {
  const text = cleanText(value)
    .replace(/\*\*/g, "")
    .replace(/\bverified plant lead\b.*$/i, "")
    .replace(/\bmanufacturing facilities\b.*$/i, "")
    .replace(/\brecent hiring\s*\/\s*expansion signals\b.*$/i, "")
    .trim();
  if (
    !text ||
    /^(?:signal\s*-|source\s*-|evidence\s*-|why it matters\s*-|no relevant|recent hiring|recent signal|recent expansion)/i.test(text)
  ) {
    return "";
  }
  return text;
}

function companyHintMatchesBase(candidate, baseName, baseTokens = []) {
  const candidateKey = normalizeCompanyKey(candidate);
  const baseKey = normalizeCompanyKey(baseName);
  if (!candidateKey || !baseKey) return false;
  if (candidateKey.includes(baseKey) || baseKey.includes(candidateKey)) return true;
  const candidateTokens = tokenizeCompanyName(candidate).filter((token) => token.length >= 4);
  const overlap = candidateTokens.filter((token) => baseTokens.includes(token));
  return overlap.length >= Math.min(2, baseTokens.length);
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

function buildCompanySearchAliases(companyHints = [], limit = 5) {
  return uniqueOrdered(toArray(companyHints).flatMap(expandCompanySearchAliases))
    .map((alias, index) => ({ alias, index, score: scoreCompanySearchAlias(alias) }))
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .slice(0, limit)
    .map((entry) => entry.alias);
}

function scoreCompanySearchAlias(alias) {
  const text = cleanText(alias);
  let score = 0;
  if (!/\s/.test(text)) score += 12;
  if (/\b(?:verified|manufacturing|facilities|southern|ontario|contact|products?|homepage|home)\b/i.test(text)) score += 40;
  if (text.length > 45) score += 12;
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length >= 2 && words.length <= 5) score -= 8;
  if (/[&]/.test(text)) score -= 2;
  return score;
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
    .filter((tokens) =>
      tokens.length >= 2 ||
      (tokens.length === 1 && tokens[0].length >= 6 && !GENERIC_COMPANY_HINT_TOKEN_PATTERN.test(tokens[0]))
    );
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

function isLooseCompanyMatch(rowCompany, requestedCompany) {
  const rowKey = normalizeCompanyKey(rowCompany);
  const requestedKey = normalizeCompanyKey(requestedCompany);
  if (!rowKey || !requestedKey) return false;
  if (rowKey === requestedKey) return true;
  const rowTokens = tokenizeCompanyName(rowCompany).filter((token) => !["com", "ca", "www"].includes(token));
  const requestedTokens = tokenizeCompanyName(requestedCompany).filter((token) => !["com", "ca", "www"].includes(token));
  if (rowTokens.length < 2 || requestedTokens.length < 2) return false;
  const rowInRequested = rowTokens.every((token) => requestedTokens.includes(token));
  const requestedInRow = requestedTokens.every((token) => rowTokens.includes(token));
  return rowInRequested || requestedInRow;
}

function resolveNanoOnlyModel(model, fallback = DEFAULT_CONTACT_EXTRACT_MODEL) {
  const preferred = String(model || "").trim();
  if (/nano/i.test(preferred)) {
    return preferred;
  }
  const configured = String(process.env.OPENAI_CONTACT_EXTRACT_MODEL || "").trim();
  if (/nano/i.test(configured)) {
    return configured;
  }
  return fallback || "gpt-5-nano";
}

function isStaleSignalText(text) {
  const value = cleanText(text);
  return /\b20(?:0\d|1\d|20|21|22|23)\b/.test(value) && !/\b20(?:24|25|26)\b/.test(value) && !/\b(?:current|now hiring|actively hiring|planned|proposed|upcoming)\b/i.test(value);
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
