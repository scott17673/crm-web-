import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { enrichPlantLead } from "./plant-enrichment.mjs";
import { loadLocalEnv, verifyPlantCandidate, verifyPlantCandidateHeuristic } from "./plant-verifier.mjs";
import { createCrmSync, syncQualifiedLeadToCrm } from "./runtime_lib/crm-sync.mjs";
import { parseCsv, stringifyCsv } from "./runtime_lib/csv.mjs";
import { buildExistingIndex, createEmptyIndex, isDuplicate, normalizeName, rememberCandidate } from "./runtime_lib/dedupe.mjs";
import { enrichFromWebsite } from "./runtime_lib/enrich.mjs";
import { DEFAULT_INDUSTRY_IDS, inferIndustryLabel } from "./runtime_lib/industries.mjs";
import { normalizeSavedLeadRecord } from "./runtime_lib/lead-records.mjs";
import { NEARBY_CITIES } from "./runtime_lib/nearby-cities.mjs";
import { buildCityQueries, normalizeSiteKey, searchWeb, searchYellowPagesListings, toCanonicalWebsiteUrl } from "./runtime_lib/web-search.mjs";

export const OUTPUT_COLUMNS = [
  "company",
  "stage",
  "industry",
  "notes",
  "contacts",
  "tags",
  "last_activity"
];

export const DEFAULTS = {
  province: "Ontario",
  cityLimit: 12,
  resultsPerQuery: 5,
  websitePageLimit: 3,
  searchDelayMs: 1200,
  out: "output/milton-manufacturers.csv",
  progressOut: "",
  industries: [...DEFAULT_INDUSTRY_IDS],
  minEmployees: 10,
  existing: "",
  crmConfigPath: "",
  cities: [],
  verifierModel: process.env.PLANT_VERIFIER_MODEL || "gpt-5-mini",
  enrichmentModel: process.env.PLANT_ENRICHMENT_MODEL || "gpt-5-nano",
  heuristicVerifier: false
};

const STRICT_REJECT_HINTS = [
  "no confirmed southern ontario manufacturing plant found",
  "no verified southern ontario manufacturing site",
  "no confirmed manufacturing plant",
  "no confirmed production facility",
  "not a manufacturer",
  "not a manufacturing",
  "service / vendor page",
  "vendor / integrator",
  "retail or restaurant",
  "shop bakery specials",
  "request custom cake quote",
  "order our most popular custom cake"
];
const OUT_OF_RANGE_HINTS = [
  "new jersey",
  " nj ",
  " united states",
  " usa",
  "massachusetts"
];
const MISSING_PRODUCT_HINTS = [
  "not confidently confirmed from public pages yet",
  "products:missing",
  "needs products"
];
const STRICT_ADDRESS_PATTERN = /\b\d{1,6}\s+[A-Za-z0-9.'#&/\- ]+?\b(?:st|street|ave|avenue|rd|road|dr|drive|blvd|boulevard|lane|ln|court|ct|way|pkwy|parkway|circle|cir|highway|hwy|cres|crescent)\b/i;
const STRICT_PHONE_PATTERN = /(?:\+?1[-.\s]*)?(?:\(?\d{3}\)?[-.\s]*)\d{3}[-.\s]*\d{4}/;
const STRICT_PLANT_LANGUAGE_PATTERN = /\b(manufactur|processing|production|plant|facility|brewery|roastery|asphalt plant|ready[- ]mix|precast|quarry|recycling facility|molding|extrusion|fabricat|machin|packag)\b/i;
const EVIDENCE_KEYWORD_PATTERN = /\b(address|location|facility|plant|manufactur|processing|production|products?|capabilities|asphalt|aggregate|quarry|precast|concrete|brewery|roastery|coffee|bakery|meat|poultry|recycling|molding|extrusion|fabrication|composite|steel|plastic|packaging)\b/i;
const RECENT_SIGNAL_INCLUDE_PATTERN = /\b(hiring|hire|job opening|job posting|careers?|recruiting|recruitment|seeking|millwright|maintenance mechanic|maintenance technician|production operator|production supervisor|plant manager|operations manager|expansion|expand|expanding|expanded|planned expansion|new facility|new plant|new site|new production line|production line|capacity|permit|approval|environmental compliance approval|eca|construction|investment|investing)\b/i;
const RECENT_SIGNAL_STRONG_PATTERN = /\b(hiring|job opening|job posting|careers?|recruiting|millwright|maintenance|production|plant|operations|expansion|expanded|expanding|new facility|new plant|new site|new production line|capacity|permit|approval|eca|construction|investment|planned expansion)\b/i;
const RECENT_SIGNAL_NOISE_PATTERN = /\b(address|phone|official site|about|located|product list|products?|capabilities|independent craft|proudly located|built in|refurbished|facility address|contact page|store hours|taproom|tour|brewery tours?)\b/i;
const RECENT_SIGNAL_NOISE_OVERRIDE_PATTERN = /\b(hiring|hire|job opening|job posting|careers?|recruiting|expansion|expanded|expanding|planned expansion|new facility|new plant|new site|new production line|capacity|permit|approval|eca|construction|investment)\b/i;
const CONTACT_TITLE_QUERIES = [
  "plant manager",
  "maintenance manager",
  "maintenance supervisor",
  "millwright",
  "maintenance mechanic",
  "production manager",
  "production supervisor",
  "operations manager",
  "general manager",
  "purchaser",
  "engineering manager",
  "quality manager"
];

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

export async function runFinder(rawOptions = {}, hooks = {}) {
  const options = normalizeOptions(rawOptions);
  const log = hooks.logger || ((message) => console.log(message));
  const crmSync = await createCrmSync(options);
  const crmExistingRecords = crmSync ? await crmSync.loadExistingRecords() : [];
  const existingRecords = options.existing ? await loadExistingRecords(options.existing) : [];
  const existingIndex = buildExistingIndex([...existingRecords, ...crmExistingRecords]);
  const crmExistingIndex = buildExistingIndex(crmExistingRecords);
  const crmSeen = createEmptyIndex();
  const outputSeen = createEmptyIndex();
  const searchSeen = new Set();
  const savedLeads = await loadSavedLeads(options);
  const rows = [...savedLeads];

  for (const record of rows) {
    rememberCandidate(record, outputSeen);
  }

  const cities = options.cities.length ? options.cities : NEARBY_CITIES.slice(0, options.cityLimit);

  log(`Searching ${cities.length} nearby cities with the plant verifier + enrichment flow...`);
  if (rows.length) {
    log(`Loaded ${rows.length} saved leads from previous runs.`);
  }
  if (existingRecords.length) {
    log(`Loaded ${existingRecords.length} existing CSV row(s) for dedupe.`);
  }
  if (crmSync) {
    log(`Loaded ${crmExistingRecords.length} existing CRM manufacturer(s) from ${crmSync.config.label}.`);
  }

  for (const city of cities) {
    const queries = buildCityQueries(city, options.province, options.industries);
    for (const query of queries) {
      log(`  Search: ${query}`);
      let results = [];
      try {
        results = await searchYellowPagesListings(query, city, options.province, {
          limit: options.resultsPerQuery
        });
      } catch (error) {
        log(`  Search failed: ${error instanceof Error ? error.message : String(error)}`);
        await sleep(options.searchDelayMs);
        continue;
      }

      for (const hit of results) {
        const siteKey = normalizeSiteKey(hit.websiteUrl || hit.url || "");
        if (!siteKey || searchSeen.has(siteKey)) {
          continue;
        }
        searchSeen.add(siteKey);

        const companyLabel = cleanText(hit.companyName || hit.title || hit.url);
        log(`  Deep qualifying: ${companyLabel}`);

        try {
          const processed = await processHit({
            hit,
            city,
            query,
            options,
            log
          });

          if (!processed) {
            continue;
          }

          const { intelligence, record } = processed;
          if (!passesStrictPlantVerifierGuard(record)) {
            log(`  Skipped: ${record.company} | failed strict plant verifier guard`);
            continue;
          }

          if (isDuplicate(record, existingIndex, outputSeen)) {
            log(`  Skipped: ${record.company} | already in your CSV or shadow CRM`);
            continue;
          }

          rememberCandidate(record, outputSeen);
          rows.push(record);
          await writeOutputCsv(options.out, rows);
          if (options.progressOut) {
            await writeOutputCsv(options.progressOut, rows);
          }

          log(`  Added row ${rows.length}: ${record.company} | ${record.stage}`);

          if (crmSync) {
            try {
              const crmResult = await syncQualifiedLeadToCrm({
                crmSync,
                record,
                intelligence,
                existingIndex: crmExistingIndex,
                seenIndex: crmSeen
              });
              if (crmResult.action === "inserted") {
                log(`  CRM sync: inserted ${record.company} (${crmResult.contactsInserted} contact(s))`);
              } else if (crmResult.action === "duplicate") {
                log(`  CRM sync skipped: ${record.company} | already in shadow CRM`);
              }
            } catch (error) {
              log(`  CRM sync failed: ${record.company} | ${error instanceof Error ? error.message : String(error)}`);
            }
          }
        } catch (error) {
          log(`  Skipped: ${companyLabel} | ${error instanceof Error ? error.message : String(error)}`);
        }

        await sleep(options.searchDelayMs);
      }
    }
  }

  await writeOutputCsv(options.out, rows);
  if (options.progressOut) {
    await writeOutputCsv(options.progressOut, rows);
  }

  log(`Finished. ${rows.length} kept prospect(s).`);
  return rows;
}

async function processHit({ hit, city, query, options, log }) {
  const websiteUrl = toCanonicalWebsiteUrl(hit.websiteUrl || hit.url || "");
  const profile = websiteUrl
    ? await enrichFromWebsite(websiteUrl, {
        pageLimit: options.websitePageLimit,
        expectedCity: city
      })
    : null;

  const verifierPacket = await buildVerifierPacket({
    hit,
    city,
    query,
    websiteUrl,
    profile
  });

  const verifierResult = options.heuristicVerifier
    ? verifyPlantCandidateHeuristic(verifierPacket)
    : await verifyPlantCandidate(verifierPacket, { model: options.verifierModel });

  const companyName = cleanText(
    verifierResult?.confirmed_facilities?.[0]?.name ||
    profile?.companyName ||
    hit.companyName ||
    hit.title
  ) || cleanText(hit.companyName || hit.title || hit.url);

  if (!verifierResult.qualified) {
    log(`  Skipped: ${companyName} | ${verifierResult.reject_reason || "failed plant verifier"}`);
    return null;
  }

  const evidencePacket = await buildEnrichmentEvidencePacket({
    verifierResult,
    hit,
    city,
    query,
    websiteUrl,
    profile
  });

  let enrichmentResult;
  try {
    enrichmentResult = await enrichPlantLead(evidencePacket, {
      model: options.enrichmentModel
    });
  } catch (error) {
    log(`  Enrichment fallback: ${companyName} | ${error instanceof Error ? error.message : String(error)}`);
    enrichmentResult = fallbackEnrichment(verifierResult, evidencePacket);
  }

  const intelligence = buildLeadIntelligence({
    verifierResult,
    enrichmentResult,
    hit,
    city,
    query,
    websiteUrl,
    profile
  });
  const record = buildCsvRecord({
    intelligence,
    sourceQuery: query
  });

  return { intelligence, record };
}

async function buildVerifierPacket({ hit, city, query, websiteUrl, profile }) {
  const snippets = uniqueOrdered([
    cleanText(hit.snippet),
    cleanText(hit.title),
    ...summarizeWebsiteProfile(profile),
    ...extractEvidenceSnippets(profile?.combinedText || "", 10),
    ...(await collectOfficialSiteEvidence({
      companyName: cleanText(profile?.companyName || hit.companyName || hit.title),
      city,
      query,
      websiteUrl
    }))
  ]).slice(0, 24);

  return {
    company_hint: cleanText(profile?.companyName || hit.companyName || hit.title),
    search_query: cleanText(query),
    source_title: cleanText(hit.title),
    source_url: cleanText(hit.sourceUrl || hit.url || websiteUrl),
    snippets
  };
}

async function buildEnrichmentEvidencePacket({ verifierResult, hit, city, query, websiteUrl, profile }) {
  const company = cleanText(profile?.companyName || hit.companyName || hit.title);
  const source_urls = new Set([
    cleanText(hit.sourceUrl),
    cleanText(hit.url),
    cleanText(websiteUrl),
    ...cleanArray(verifierResult.proof).map((entry) => cleanText(entry?.source_url))
  ].filter(Boolean));

  const evidence = [];

  for (const proof of cleanArray(verifierResult.proof)) {
    if (proof?.claim || proof?.evidence) {
      evidence.push([cleanText(proof.claim), cleanText(proof.evidence)].filter(Boolean).join(" | "));
    }
  }

  for (const line of summarizeWebsiteProfile(profile)) {
    evidence.push(line);
  }

  for (const snippet of extractEvidenceSnippets(profile?.combinedText || "", 16)) {
    evidence.push(snippet);
  }

  const companyQueries = await collectCompanySearchEvidence({
    company,
    city,
    query,
    websiteUrl
  });

  for (const result of companyQueries) {
    if (result.url) {
      source_urls.add(result.url);
    }
    evidence.push(buildSearchEvidenceLine(result));
  }

  const peopleQueries = await collectPeopleSearchEvidence({
    company,
    city
  });

  for (const result of peopleQueries) {
    if (result.url) {
      source_urls.add(result.url);
    }
    evidence.push(buildSearchEvidenceLine(result));
  }

  const recentSignalQueries = await collectRecentSignalEvidence({
    company,
    city,
    websiteUrl
  });

  for (const result of recentSignalQueries) {
    if (result.url) {
      source_urls.add(result.url);
    }
    evidence.push(`Recent hiring/expansion signal candidate | ${buildSearchEvidenceLine(result)}`);
  }

  return {
    company,
    source_urls: Array.from(source_urls),
    evidence: uniqueOrdered(evidence.filter(Boolean)).slice(0, 80),
    verifier_result: verifierResult,
    source_query: query,
    city,
    website: websiteUrl
  };
}

function fallbackEnrichment(verifierResult, evidencePacket) {
  return {
    company: cleanText(evidencePacket.company),
    qualified: true,
    facilities: cleanArray(verifierResult.confirmed_facilities).map((facility) => ({
      name: cleanText(facility?.name),
      facility_type: cleanText(facility?.facility_type),
      address: cleanText(facility?.address),
      city: cleanText(facility?.city),
      province: "ON",
      postal_code: "",
      phone: cleanText(facility?.phone),
      fax: "",
      email: "",
      source_url: cleanText(facility?.source_url),
      notes: "Fallback from plant verifier."
    })),
    end_products: cleanArray(verifierResult.end_products).map((entry) => cleanText(entry)).filter(Boolean),
    likely_equipment: cleanArray(verifierResult.likely_equipment).map((entry) => cleanText(entry)).filter(Boolean),
    contacts: [],
    proof: cleanArray(verifierResult.proof).map((entry) => ({
      claim: cleanText(entry?.claim),
      source_url: cleanText(entry?.source_url),
      evidence: cleanText(entry?.evidence)
    })).filter((entry) => entry.claim || entry.evidence || entry.source_url),
    contact_search_status: "no_target_contacts_found"
  };
}

function buildLeadIntelligence({ verifierResult, enrichmentResult, hit, city, query, websiteUrl, profile }) {
  const companyName = cleanText(enrichmentResult.company || profile?.companyName || hit.companyName || hit.title);
  const facilities = enrichmentResult.facilities.length
    ? enrichmentResult.facilities
    : fallbackEnrichment(verifierResult, { company: companyName }).facilities;
  const contacts = cleanArray(enrichmentResult.contacts).map((contact) => ({
    name: cleanText(contact?.name),
    title: cleanText(contact?.title),
    linkedin: cleanText(contact?.linkedin_url),
    source_url: cleanText(contact?.source_url),
    confidence: cleanText(contact?.confidence),
    notes: cleanText(contact?.notes)
  })).filter((contact) => contact.name && contact.title);
  const endProducts = uniqueOrdered([
    ...cleanArray(enrichmentResult.end_products).map((entry) => cleanText(entry)),
    ...cleanArray(verifierResult.end_products).map((entry) => cleanText(entry))
  ].filter(Boolean)).join(", ");
  const likelyEquipment = uniqueOrdered([
    ...cleanArray(enrichmentResult.likely_equipment).map((entry) => cleanText(entry)),
    ...cleanArray(verifierResult.likely_equipment).map((entry) => cleanText(entry))
  ].filter(Boolean));
  const proof = uniqueOrdered([
    ...cleanArray(enrichmentResult.proof).map(formatProofLine),
    ...cleanArray(verifierResult.proof).map(formatProofLine)
  ].filter(Boolean));
  const recentSignals = cleanArray(enrichmentResult.recent_signals)
    .map((signal) => ({
      type: cleanText(signal?.type),
      title: cleanText(signal?.title),
      date: cleanText(signal?.date),
      source_url: cleanText(signal?.source_url),
      evidence: cleanText(signal?.evidence),
      why_it_matters: cleanText(signal?.why_it_matters)
    }))
    .filter((signal) => signal.title || signal.evidence || signal.source_url)
    .filter(looksLikeRecentSignalEntry);
  const stage = determineLeadStage({
    hasContacts: contacts.length > 0,
    hasProducts: Boolean(endProducts)
  });

  return {
    companyName,
    website: cleanText(websiteUrl || profile?.website || hit.url),
    sourceUrl: cleanText(hit.sourceUrl || hit.url || websiteUrl),
    sourceTitle: cleanText(hit.title),
    sourceQuery: cleanText(query),
    city: cleanText(city),
    province: "Ontario",
    facilityList: facilities,
    endProducts: endProducts || "Not confidently confirmed from public pages yet.",
    likelyEquipment,
    maintenanceContacts: contacts,
    recentSignals,
    proof,
    contact_search_status: cleanText(enrichmentResult.contact_search_status),
    leadStage: stage,
    tags: buildLeadTags({
      contacts,
      endProducts,
      stage
    })
  };
}

function buildCsvRecord({ intelligence, sourceQuery }) {
  return {
    company: intelligence.companyName,
    stage: intelligence.leadStage,
    industry: inferIndustryLabel(sourceQuery),
    notes: formatNotesField(intelligence),
    contacts: formatContactsField(intelligence),
    tags: intelligence.tags,
    last_activity: new Date().toISOString().slice(0, 10)
  };
}

function formatNotesField(intelligence) {
  const facilityLines = intelligence.facilityList.length
    ? intelligence.facilityList.map((facility) => formatFacilityLine(facility))
    : ["No confirmed southern Ontario manufacturing plant found."];
  const proofSection = intelligence.proof.length
    ? intelligence.proof.join("\n")
    : "No additional cited proof captured yet.";
  const recentSignalsSection = intelligence.recentSignals.length
    ? intelligence.recentSignals.map(formatRecentSignalLine).join("\n\n")
    : "No relevant hiring or expansion signal found after targeted search.";

  return [
    `${intelligence.companyName} (verified plant lead)`,
    "",
    "**manufacturing facilities (southern ontario)**",
    facilityLines.join("\n"),
    "",
    "**end products manufactured**",
    intelligence.endProducts || "Not confidently confirmed from public pages yet.",
    "",
    "**major production machinery**",
    intelligence.likelyEquipment.length
      ? intelligence.likelyEquipment.join(", ")
      : "Not confidently confirmed from public pages yet.",
    "",
    "**recent hiring / expansion signals**",
    recentSignalsSection,
    "",
    "**public proof / source notes**",
    proofSection
  ].join("\n");
}

function formatContactsField(intelligence) {
  if (!intelligence.maintenanceContacts.length) {
    return "No named maintenance / operations / plant contact found yet after the current public search.";
  }

  return intelligence.maintenanceContacts
    .map((contact) => [
      `Name - ${contact.name}`,
      `Title - ${contact.title}`,
      contact.linkedin ? `LinkedIn - ${contact.linkedin}` : "",
      contact.source_url ? `Source - ${contact.source_url}` : "",
      contact.notes ? `Notes - ${contact.notes}` : ""
    ].filter(Boolean).join("\n"))
    .join("\n\n");
}

function formatFacilityLine(facility) {
  return [
    cleanText(facility?.name || facility?.facility_type),
    cleanText(facility?.address),
    cleanText(facility?.phone) ? `phone ${cleanText(facility.phone)}` : "",
    cleanText(facility?.email) ? `email ${cleanText(facility.email)}` : "",
    cleanText(facility?.source_url)
  ].filter(Boolean).join(" | ");
}

function formatProofLine(entry) {
  const claim = cleanText(entry?.claim);
  const evidence = cleanText(entry?.evidence);
  const source = cleanText(entry?.source_url);
  return [claim, evidence, source].filter(Boolean).join(" | ");
}

function formatRecentSignalLine(signal) {
  return [
    signal.type ? `Signal - ${signal.type}: ${signal.title || signal.evidence || signal.source_url}` : `Signal - ${signal.title || signal.evidence || signal.source_url}`,
    signal.date ? `Date - ${signal.date}` : "",
    signal.source_url ? `Source - ${signal.source_url}` : "",
    signal.evidence ? `Evidence - ${signal.evidence}` : "",
    signal.why_it_matters ? `Why it matters - ${signal.why_it_matters}` : ""
  ].filter(Boolean).join("\n");
}

function buildLeadTags({ contacts, endProducts, stage }) {
  const hasLinkedIn = contacts.some((contact) => contact.linkedin);
  const hasPublicNamed = contacts.length > 0;

  return uniqueOrdered([
    "plant-verified",
    stage === "Ready for Outreach" ? "outreach-ready" : "",
    hasLinkedIn ? "contact:linkedin-direct" : hasPublicNamed ? "contact:public-named" : "contact:missing",
    endProducts ? "products:confirmed" : "products:missing"
  ].filter(Boolean)).join(" | ");
}

function determineLeadStage({ hasContacts, hasProducts }) {
  if (!hasContacts && !hasProducts) return "Plant Verified - Needs Contact + Products";
  if (!hasContacts) return "Plant Verified - Needs Contact";
  if (!hasProducts) return "Plant Verified - Needs Products";
  return "Ready for Outreach";
}

async function collectOfficialSiteEvidence({ companyName, city, query, websiteUrl }) {
  const hostname = normalizeHostname(websiteUrl);
  if (!hostname) {
    return [];
  }

  const queries = uniqueOrdered([
    `site:${hostname} "${companyName}"`,
    `site:${hostname} "${city}"`,
    `site:${hostname} ${query}`,
    `site:${hostname} "${companyName}" locations`,
    `site:${hostname} "${companyName}" products`
  ]);

  const snippets = [];
  for (const searchQuery of queries.slice(0, 5)) {
    try {
      const results = await searchWeb(searchQuery, {
        limit: 2,
        skipPatterns: ["jobs", "job opening", "salary"]
      });
      for (const result of results) {
        snippets.push(buildSearchEvidenceLine(result));
      }
    } catch {
      continue;
    }
  }

  return uniqueOrdered(snippets).slice(0, 8);
}

async function collectCompanySearchEvidence({ company, city, query, websiteUrl }) {
  const hostname = normalizeHostname(websiteUrl);
  const searches = uniqueOrdered([
    hostname ? `site:${hostname} "${company}" locations` : "",
    hostname ? `site:${hostname} "${company}" contact` : "",
    hostname ? `site:${hostname} "${company}" products` : "",
    hostname ? `site:${hostname} "${company}" facility` : "",
    `"${company}" "${city}" "${query}"`,
    `site:linkedin.com/company "${company}"`
  ].filter(Boolean));

  const collected = [];
  for (const searchQuery of searches.slice(0, 6)) {
    try {
      const results = await searchWeb(searchQuery, {
        limit: 3,
        skipPatterns: ["jobs", "job opening", "salary"]
      });
      collected.push(...results);
    } catch {
      continue;
    }
  }

  return dedupeByUrl(collected).slice(0, 12);
}

async function collectPeopleSearchEvidence({ company, city }) {
  const searches = CONTACT_TITLE_QUERIES.map((title) => `site:linkedin.com/in "${company}" "${title}" "${city}"`);
  const collected = [];

  for (const searchQuery of searches.slice(0, 8)) {
    try {
      const results = await searchWeb(searchQuery, {
        limit: 2,
        allowedDomains: ["linkedin.com"],
        keepUrlPath: true,
        skipPatterns: ["jobs", "/company/", "job opening"]
      });
      collected.push(...results);
    } catch {
      continue;
    }
  }

  return dedupeByUrl(collected).slice(0, 16);
}

async function collectRecentSignalEvidence({ company, city, websiteUrl }) {
  const hostname = normalizeHostname(websiteUrl);
  const searches = uniqueOrdered([
    `"${company}" hiring maintenance "${city || "Ontario"}"`,
    `"${company}" hiring production "${city || "Ontario"}"`,
    `"${company}" hiring operations "${city || "Ontario"}"`,
    `"${company}" millwright "${city || "Ontario"}"`,
    `"${company}" expansion "${city || "Ontario"}"`,
    `"${company}" "planned expansion" "${city || "Ontario"}"`,
    `"${company}" "new facility" "${city || "Ontario"}"`,
    `"${company}" "new plant" "${city || "Ontario"}"`,
    `"${company}" "production line" "${city || "Ontario"}"`,
    `"${company}" ECA Ontario expansion`,
    hostname ? `site:${hostname} careers maintenance production operations` : "",
    hostname ? `site:${hostname} expansion "new facility" "new plant"` : ""
  ].filter(Boolean));

  const collected = [];
  for (const searchQuery of searches.slice(0, 12)) {
    try {
      const results = await searchWeb(searchQuery, {
        limit: 2,
        keepUrlPath: true,
        allowBlockedDomains: true,
        skipPatterns: ["charity", "award", "review", "salary estimate"]
      });
      collected.push(...results.filter(looksLikeRecentOperationalSignal));
    } catch {
      continue;
    }
  }

  return dedupeByUrl(collected).slice(0, 10);
}

function looksLikeRecentOperationalSignal(result) {
  const text = `${cleanText(result?.title)} ${cleanText(result?.snippet)}`;
  if (!RECENT_SIGNAL_INCLUDE_PATTERN.test(text) || !RECENT_SIGNAL_STRONG_PATTERN.test(text)) {
    return false;
  }
  if (RECENT_SIGNAL_NOISE_PATTERN.test(text) && !RECENT_SIGNAL_NOISE_OVERRIDE_PATTERN.test(text)) {
    return false;
  }
  return true;
}

function looksLikeRecentSignalEntry(signal) {
  const text = [
    signal?.title,
    signal?.evidence,
    signal?.why_it_matters,
    signal?.source_url
  ].map((value) => cleanText(value)).join(" ");

  if (!RECENT_SIGNAL_INCLUDE_PATTERN.test(text) || !RECENT_SIGNAL_STRONG_PATTERN.test(text)) {
    return false;
  }
  if (RECENT_SIGNAL_NOISE_PATTERN.test(text) && !RECENT_SIGNAL_NOISE_OVERRIDE_PATTERN.test(text)) {
    return false;
  }
  return true;
}

function buildSearchEvidenceLine(result) {
  return [
    cleanText(result?.title),
    cleanText(result?.snippet),
    cleanText(result?.url)
  ].filter(Boolean).join(" | ");
}

function summarizeWebsiteProfile(profile) {
  if (!profile) {
    return [];
  }

  return uniqueOrdered([
    cleanText(profile.companyName) ? `Official site company name: ${cleanText(profile.companyName)}` : "",
    cleanText(profile.formattedAddress) ? `Official site address: ${cleanText(profile.formattedAddress)}` : "",
    cleanText(profile.phone) ? `Official site phone: ${cleanText(profile.phone)}` : "",
    cleanText(profile.fax) ? `Official site fax: ${cleanText(profile.fax)}` : "",
    cleanText(profile.endProducts) ? `Official site products/capabilities: ${cleanText(profile.endProducts)}` : "",
    ...cleanArray(profile.addresses).slice(0, 5).map((address) => `Website address: ${cleanText(address)}`),
    ...cleanArray(profile.phones).slice(0, 5).map((phone) => `Website phone: ${cleanText(phone)}`),
    ...cleanArray(profile.contacts).slice(0, 8).map((contact) => [cleanText(contact?.name), cleanText(contact?.title), cleanText(contact?.email), cleanText(contact?.linkedin)].filter(Boolean).join(" | ")),
    ...cleanArray(profile.linkedInLinkList).slice(0, 8).map((url) => `LinkedIn URL exposed by company/public page: ${cleanText(url)}`)
  ].filter(Boolean));
}

function extractEvidenceSnippets(text, limit = 12) {
  return uniqueOrdered(
    String(text || "")
      .replace(/\s+/g, " ")
      .split(/(?<=[.!?])\s+/)
      .map((entry) => cleanText(entry))
      .filter((entry) => entry.length >= 30)
      .filter((entry) => EVIDENCE_KEYWORD_PATTERN.test(entry))
  ).slice(0, limit);
}

function dedupeByUrl(results) {
  const seen = new Set();
  const unique = [];
  for (const result of results) {
    const url = cleanText(result?.url);
    if (!url || seen.has(url)) {
      continue;
    }
    seen.add(url);
    unique.push(result);
  }
  return unique;
}

function normalizeHostname(value) {
  try {
    return new URL(value).hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
}

function passesStrictPlantVerifierGuard(record) {
  const text = [
    record?.company,
    record?.stage,
    record?.industry,
    record?.notes,
    record?.contacts,
    record?.tags,
    record?.end_product
  ].filter(Boolean).join(" ");
  const lower = ` ${text.toLowerCase()} `;
  if (!cleanText(record?.company)) return false;
  if (STRICT_REJECT_HINTS.some((hint) => lower.includes(hint))) return false;
  if (OUT_OF_RANGE_HINTS.some((hint) => lower.includes(hint))) return false;
  if (MISSING_PRODUCT_HINTS.some((hint) => lower.includes(hint))) return false;
  if (/\bneeds products\b/i.test(cleanText(record?.stage))) return false;

  const hasAddress = STRICT_ADDRESS_PATTERN.test(text);
  const hasPhone = STRICT_PHONE_PATTERN.test(text);
  const hasPlantLanguage = STRICT_PLANT_LANGUAGE_PATTERN.test(text);
  const hasProduct = !/\bend products manufactured\*\*\s*(not confidently confirmed|&copy;|copyright|home\b|bakery specials\b|request custom cake quote\b)/i.test(text);

  return hasAddress && hasPhone && hasPlantLanguage && hasProduct;
}

async function loadExistingRecords(filePath) {
  try {
    const text = await readFile(resolveOutputPath(filePath), "utf8");
    return parseCsv(text)
      .map((record) => normalizeSavedLeadRecord(record))
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function loadSavedLeads(options) {
  const candidates = uniqueOrdered([options.out, options.progressOut].filter(Boolean));
  for (const filePath of candidates) {
    try {
      const text = await readFile(resolveOutputPath(filePath), "utf8");
      const records = parseCsv(text)
        .map((record) => normalizeSavedLeadRecord(record))
        .filter(Boolean);
      if (records.length) {
        return records;
      }
    } catch {
      continue;
    }
  }
  return [];
}

async function writeOutputCsv(filePath, records) {
  if (!filePath) {
    return;
  }
  const resolved = resolveOutputPath(filePath);
  await mkdir(path.dirname(resolved), { recursive: true });
  await writeFile(resolved, stringifyCsv(records, OUTPUT_COLUMNS), "utf8");
}

function normalizeOptions(rawOptions = {}) {
  return {
    province: cleanText(rawOptions.province) || DEFAULTS.province,
    cityLimit: toNumber(rawOptions.cityLimit, DEFAULTS.cityLimit),
    resultsPerQuery: toNumber(rawOptions.resultsPerQuery, DEFAULTS.resultsPerQuery),
    websitePageLimit: toNumber(rawOptions.websitePageLimit, DEFAULTS.websitePageLimit),
    searchDelayMs: toNumber(rawOptions.searchDelayMs, DEFAULTS.searchDelayMs),
    out: cleanText(rawOptions.out) || DEFAULTS.out,
    progressOut: cleanText(rawOptions.progressOut),
    industries: parseDelimitedList(rawOptions.industries).length ? parseDelimitedList(rawOptions.industries) : [...DEFAULTS.industries],
    minEmployees: toNumber(rawOptions.minEmployees, DEFAULTS.minEmployees),
    existing: cleanText(rawOptions.existing),
    crmConfigPath: cleanText(rawOptions.crmConfigPath),
    cities: parseDelimitedList(rawOptions.cities),
    verifierModel: cleanText(rawOptions.verifierModel) || DEFAULTS.verifierModel,
    enrichmentModel: cleanText(rawOptions.enrichmentModel) || DEFAULTS.enrichmentModel,
    heuristicVerifier: Boolean(rawOptions.heuristicVerifier)
  };
}

function parseDelimitedList(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => cleanText(entry)).filter(Boolean);
  }

  return String(value || "")
    .split("|")
    .map((entry) => cleanText(entry))
    .filter(Boolean);
}

function resolveOutputPath(filePath) {
  if (!filePath) {
    return "";
  }
  return path.isAbsolute(filePath) ? filePath : path.resolve(repoRoot, filePath);
}

function uniqueOrdered(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function cleanText(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function cleanArray(value) {
  return Array.isArray(value) ? value : [];
}

function toNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getArg(name, fallback = "") {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  return fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

async function main() {
  await loadLocalEnv({ cwd: repoRoot });
  const options = normalizeOptions({
    province: getArg("province", DEFAULTS.province),
    cityLimit: getArg("city-limit", DEFAULTS.cityLimit),
    resultsPerQuery: getArg("results-per-query", DEFAULTS.resultsPerQuery),
    websitePageLimit: getArg("website-page-limit", DEFAULTS.websitePageLimit),
    searchDelayMs: getArg("search-delay-ms", DEFAULTS.searchDelayMs),
    out: getArg("out", DEFAULTS.out),
    progressOut: getArg("progress-out", ""),
    industries: getArg("industries", DEFAULTS.industries.join("|")),
    minEmployees: getArg("min-employees", DEFAULTS.minEmployees),
    existing: getArg("existing", ""),
    crmConfigPath: getArg("crm-config", ""),
    cities: getArg("cities", ""),
    verifierModel: getArg("verifier-model", DEFAULTS.verifierModel),
    enrichmentModel: getArg("enrichment-model", DEFAULTS.enrichmentModel),
    heuristicVerifier: hasFlag("heuristic-verifier")
  });

  await runFinder(options);
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
