import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { loadLocalEnv } from "./plant-verifier.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const DEFAULTS = {
  limit: 25,
  offset: 0,
  company: "",
  apply: false,
  full: false,
  everyCompany: false,
  includeAll: false,
  includeSignals: false,
  allowContactUpdates: false,
  countOnly: false,
  minStrongContacts: 3,
  outDir: path.join(__dirname, "test-output")
};

const SKIP_STAGES = new Set(["Closed Lost", "Unqualified"]);
const WEAK_TITLE_PATTERN = /\b(title not public|not public|unknown|operations contact|contact|name not found)\b/i;
const STRONG_OPS_TITLE_PATTERN = /\b(plant|production|operations?|maintenance|millwright|manufacturing|facility|quality|qa\b|food safety|technical services|engineering|warehouse|logistics|supply chain|procurement|purchasing|buyer|head brewer|brewer|head roaster|roaster|general manager|owner|founder|president|vice president|vp|coo)\b/i;
const JUNK_COMPANY_NAME_PATTERN = /^(?:who we are|what we do|home|homepage|about|about us|contact|contact us|products?|services?|locations?|careers?|shop|store|our story|welcome|privacy policy|terms)\b/i;
const JUNK_COMPANY_NAME_CONTAINS_PATTERN = /\b(?:who we are|what we do|request a quote|learn more|read more|view all|click here|official site|homepage)\b/i;

async function main() {
  await loadLocalEnv({ cwd: repoRoot });
  const options = parseArgs(process.argv.slice(2));
  applyBatchSearchProfile(options);
  const { runCompanyEnrichment } = await import("./runtime_lib/company-enrichment.mjs");
  const crmConfig = await loadCrmConfig(path.join(repoRoot, "crm-config.js"));
  const client = createPostgrestClient(crmConfig);

  const [manufacturers, contacts] = await Promise.all([
    client.select("manufacturers", {
      select: "id,company,stage,industry,end_product,signals,tags,last_enriched,created_at",
      order: { column: "created_at", ascending: false },
      limit: 5000
    }),
    client.select("manufacturer_contacts", {
      select: "id,manufacturer_id,name,title,linkedin",
      limit: 50000
    })
  ]);

  const contactsByManufacturer = groupByManufacturerId(contacts);
  let candidates = toArray(manufacturers)
    .filter((row) => cleanText(row?.company))
    .filter((row) => isRealCompanyName(row?.company))
    .filter((row) => options.includeAll || !SKIP_STAGES.has(cleanText(row?.stage)))
    .filter((row) => options.includeAll || isLikelyPlantLead(row))
    .map((row) => ({
      row,
      contacts: contactsByManufacturer.get(Number(row.id)) || [],
      score: targetScore(row, contactsByManufacturer.get(Number(row.id)) || [], options)
    }))
    .filter((entry) => options.everyCompany || entry.score > 0)
    .sort((a, b) => b.score - a.score || String(b.row.created_at || "").localeCompare(String(a.row.created_at || "")));

  if (options.company) {
    const needle = normalizeKey(options.company);
    candidates = candidates.filter((entry) => normalizeKey(entry.row.company).includes(needle));
  }

  const targetEnd = options.limit > 0 ? options.offset + options.limit : undefined;
  const targets = candidates.slice(options.offset, targetEnd);
  console.log(`${options.apply ? "APPLY" : "DRY RUN"} contact enrichment sweep`);
  console.log(`Targets: ${targets.length}/${candidates.length} candidate companies`);
  console.log(`Mode: append-only; existing contacts are kept; contact row updates are ${options.allowContactUpdates ? "enabled" : "disabled"}.`);
  console.log(`Search profile: ${options.full ? "full button search" : "batch capped search"}`);
  console.log(`Signals: ${options.includeSignals ? "same as button" : "off"}`);
  if (options.countOnly) {
    return;
  }

  const startedAt = new Date().toISOString();
  await mkdir(options.outDir, { recursive: true });
  const stamp = startedAt.replace(/[:.]/g, "-");
  const reportPath = path.join(options.outDir, `contact-enrichment-sweep-${options.apply ? "apply" : "dry-run"}-${stamp}.json`);
  const results = [];
  for (let index = 0; index < targets.length; index += 1) {
    const { row, contacts: existingContacts } = targets[index];
    const prefix = `[${index + 1}/${targets.length}]`;
    console.log(`\n${prefix} ${row.company}`);
    try {
      const result = await runCompanyEnrichment({
        manufacturerId: row.id,
        crmConfigPath: path.join(repoRoot, "crm-config.js"),
        repoRoot,
        dryRun: !options.apply,
        includeSignals: options.includeSignals,
        allowContactUpdates: options.allowContactUpdates
      });
      const summary = {
        id: row.id,
        company: row.company,
        stage: row.stage || "",
        industry: row.industry || "",
        existingContacts: existingContacts.length,
        existingStrongContacts: countStrongContacts(existingContacts),
        foundContacts: result.contactsFound,
        contactsToInsert: result.contactsToInsert,
        contactsToUpdate: result.contactsToUpdate,
        recentSignalsFound: result.recentSignalsFound,
        contacts: toArray(result.contacts).map((contact) => ({
          name: contact.name || "",
          title: contact.title || "",
          linkedin: contact.linkedin || "",
          source_url: contact.source_url || ""
        })),
        recentSignals: toArray(result.recentSignals).map((signal) => ({
          type: signal.type || "",
          title: signal.title || "",
          source_url: signal.source_url || "",
          why_it_matters: signal.why_it_matters || ""
        })),
        error: ""
      };
      results.push(summary);
      console.log(`  Existing: ${summary.existingContacts} (${summary.existingStrongContacts} strong)`);
      console.log(`  Found: ${summary.foundContacts}; new: ${summary.contactsToInsert}; title upgrades: ${summary.contactsToUpdate}; signals: ${summary.recentSignalsFound}`);
      for (const contact of summary.contacts.slice(0, 5)) {
        console.log(`   - ${[contact.name, contact.title, contact.linkedin || contact.source_url].filter(Boolean).join(" | ")}`);
      }
      await writeSweepReport(reportPath, { options, startedAt, targetCount: targets.length, results });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        id: row.id,
        company: row.company,
        existingContacts: existingContacts.length,
        existingStrongContacts: countStrongContacts(existingContacts),
        foundContacts: 0,
        contactsToInsert: 0,
        contactsToUpdate: 0,
        recentSignalsFound: 0,
        contacts: [],
        recentSignals: [],
        error: message
      });
      console.log(`  ERROR: ${message}`);
      await writeSweepReport(reportPath, { options, startedAt, targetCount: targets.length, results });
    }
  }

  await writeSweepReport(reportPath, { options, startedAt, targetCount: targets.length, results, finishedAt: new Date().toISOString() });
  console.log(`\nReport: ${reportPath}`);
  console.log(`Totals: ${JSON.stringify(buildTotals({ options, startedAt, targetCount: targets.length, results, finishedAt: new Date().toISOString() }))}`);
}

async function writeSweepReport(reportPath, { options, startedAt, targetCount, results, finishedAt = "" }) {
  const totals = buildTotals({ options, startedAt, targetCount, results, finishedAt });
  await writeFile(reportPath, `${JSON.stringify({ totals, results }, null, 2)}\n`, "utf8");
}

function buildTotals({ options, startedAt, targetCount, results, finishedAt = "" }) {
  const totals = {
    mode: options.apply ? "apply" : "dry-run",
    startedAt,
    finishedAt,
    targetCount,
    completedCount: results.length,
    companiesWithNewContacts: results.filter((row) => row.contactsToInsert > 0).length,
    companiesWithTitleUpgrades: results.filter((row) => row.contactsToUpdate > 0).length,
    totalContactsFound: sum(results, "foundContacts"),
    totalContactsToInsert: sum(results, "contactsToInsert"),
    totalContactsToUpdate: sum(results, "contactsToUpdate"),
    totalSignalsFound: sum(results, "recentSignalsFound"),
    errors: results.filter((row) => row.error).length
  };
  return totals;
}

function parseArgs(args) {
  const parsed = { ...DEFAULTS };
  for (const arg of args) {
    if (arg.startsWith("--limit=")) {
      const value = Number(arg.slice("--limit=".length));
      if (Number.isFinite(value)) parsed.limit = value;
    }
    else if (arg.startsWith("--offset=")) parsed.offset = Number(arg.slice("--offset=".length)) || 0;
    else if (arg.startsWith("--company=")) parsed.company = cleanText(arg.slice("--company=".length));
    else if (arg.startsWith("--min-strong=")) parsed.minStrongContacts = Number(arg.slice("--min-strong=".length)) || parsed.minStrongContacts;
    else if (arg === "--apply") parsed.apply = true;
    else if (arg === "--full") parsed.full = true;
    else if (arg === "--every-company") parsed.everyCompany = true;
    else if (arg === "--include-all") parsed.includeAll = true;
    else if (arg === "--include-signals") parsed.includeSignals = true;
    else if (arg === "--allow-contact-updates") parsed.allowContactUpdates = true;
    else if (arg === "--count-only" || arg === "--dry-count") parsed.countOnly = true;
    else if (arg.startsWith("--out-dir=")) parsed.outDir = path.resolve(arg.slice("--out-dir=".length));
  }
  return parsed;
}

function applyBatchSearchProfile(options) {
  if (options.full) {
    return;
  }
  setDefaultEnv("PEOPLE_SEARCH_PRIORITY_QUERY_LIMIT", "36");
  setDefaultEnv("PEOPLE_SEARCH_WIDE_QUERY_LIMIT", "12");
  setDefaultEnv("PEOPLE_SEARCH_NARROW_RETRY_LIMIT", "16");
  setDefaultEnv("PEOPLE_SEARCH_TIMEOUT_MS", "2500");
  setDefaultEnv("OPENAI_CONTACT_EXTRACT_MAX_BATCHES", "3");
  setDefaultEnv("OPENAI_CONTACT_EXTRACT_TIMEOUT_MS", "25000");
}

function setDefaultEnv(key, value) {
  if (!String(process.env[key] || "").trim()) {
    process.env[key] = value;
  }
}

async function loadCrmConfig(configPath) {
  const text = await readFile(configPath, "utf8");
  const match = text.match(/(?:window\.)?CRM_CONFIG\s*=\s*(\{[\s\S]*?\})\s*;?/);
  if (!match?.[1]) {
    throw new Error(`Could not read CRM_CONFIG from ${configPath}`);
  }
  const config = JSON.parse(match[1]);
  const key = config.supabaseServiceRoleKey || config.supabaseKey || config.supabaseAnonKey;
  if (!config.supabaseUrl || !key) {
    throw new Error("CRM config is missing Supabase URL/key.");
  }
  return {
    supabaseUrl: String(config.supabaseUrl).replace(/\/+$/, ""),
    apiKey: key
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
      url.searchParams.set("limit", String(limit));
      for (const [key, value] of Object.entries(filters || {})) {
        url.searchParams.set(key, value);
      }
      if (order?.column) {
        url.searchParams.set("order", `${order.column}.${order.ascending === false ? "desc" : "asc"}`);
      }
      const response = await fetch(url, { headers: { ...headers, Accept: "application/json" } });
      const text = await response.text();
      const data = text ? JSON.parse(text) : [];
      if (!response.ok) {
        throw new Error(cleanText(data?.message || data?.error_description || text) || `${response.status} ${response.statusText}`);
      }
      return data;
    }
  };
}

function groupByManufacturerId(contacts) {
  const map = new Map();
  for (const contact of toArray(contacts)) {
    const id = Number(contact?.manufacturer_id);
    if (!Number.isFinite(id)) {
      continue;
    }
    if (!map.has(id)) {
      map.set(id, []);
    }
    map.get(id).push(contact);
  }
  return map;
}

function targetScore(row, contacts, options) {
  const tags = normalizeTags(row?.tags);
  const strong = countStrongContacts(contacts);
  const weak = toArray(contacts).length - strong;
  if (strong >= options.minStrongContacts) {
    return weak > 0 ? 5 : 0;
  }
  let score = 10 + (options.minStrongContacts - strong) * 20;
  if (!toArray(contacts).length) score += 40;
  if (weak > 0) score += 15;
  if (tags.includes("contact:missing") || tags.includes("needs-contact-backfill")) score += 35;
  if (tags.includes("plant-verified")) score += 20;
  if (/verified plant lead/i.test(String(row?.signals || ""))) score += 15;
  if (row?.last_enriched) score -= 5;
  return score;
}

function countStrongContacts(contacts) {
  return toArray(contacts).filter((contact) => {
    const name = cleanText(contact?.name);
    const title = cleanText(contact?.title);
    if (!name || !title || WEAK_TITLE_PATTERN.test(title)) {
      return false;
    }
    return STRONG_OPS_TITLE_PATTERN.test(title);
  }).length;
}

function isLikelyPlantLead(row) {
  const tags = normalizeTags(row?.tags);
  if (tags.includes("plant-verified")) {
    return true;
  }
  const text = `${row?.signals || ""}\n${row?.end_product || ""}`;
  return /\bverified plant lead\b|\bmanufactur|\bproduction\b|\bplant\b|\bfacilit/i.test(text);
}

function isRealCompanyName(value) {
  const name = cleanText(value);
  if (!name || name.length < 2) {
    return false;
  }
  if (JUNK_COMPANY_NAME_PATTERN.test(name) || JUNK_COMPANY_NAME_CONTAINS_PATTERN.test(name)) {
    return false;
  }
  const words = name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (words.length > 12) {
    return false;
  }
  const genericWords = new Set(["the", "and", "or", "our", "your", "we", "are", "what", "do", "about", "contact", "products", "services", "company", "website"]);
  const specificWords = words.filter((word) => !genericWords.has(word));
  return specificWords.length > 0;
}

function normalizeTags(value) {
  if (Array.isArray(value)) {
    return value.map((tag) => cleanText(tag).toLowerCase()).filter(Boolean);
  }
  return String(value || "")
    .split(/[|,]/)
    .map((tag) => cleanText(tag).toLowerCase())
    .filter(Boolean);
}

function normalizeKey(value) {
  return cleanText(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function sum(rows, key) {
  return rows.reduce((total, row) => total + (Number(row?.[key]) || 0), 0);
}

await main();
