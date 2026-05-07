import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { isDuplicate, normalizeName, rememberCandidate } from "./dedupe.mjs";

export const CRM_IMPORT_BATCH_PREFIX = "__import_batch_new:";
export const FINDER_SYNC_TAG = "__finder_sync";

const DEFAULT_STAGE = "Prospect";
let _cachedCrmCompanyNames = [];

async function aiCheckDuplicate(newCompanyName, existingNames) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || !newCompanyName || existingNames.length === 0) return null;

  const nameList = existingNames.slice(0, 500).join("\n");
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: process.env.CRM_DUPLICATE_MODEL || "gpt-5-nano",
        messages: [
          {
            role: "system",
            content: `You check if a new company name is a duplicate of any company already in a CRM. Names may differ due to page titles, suffixes (Ltd, Inc), parent companies, location info, or extra text appended to the name.

Respond with JSON: {"isDuplicate": true, "matchedName": "the matching existing name"} or {"isDuplicate": false}.

Examples of duplicates:
- "Oakrun Farm Bakery Ltd. in Ancaster - ON" = "Oakrun Farms Bakery" = "Aryzta/Oakrun Farm Bakery"
- "Sleeman - Homepage" = "Sleeman Breweries LTD"
- "McAsphalt - THE RIGHT MIX" = "McAsphalt Industries"

Only flag as duplicate if you are confident it is the SAME company. Different companies with similar names (e.g. "Hamilton Steel" vs "Hamilton Ready Mix") are NOT duplicates.`
          },
          {
            role: "user",
            content: `New company: ${newCompanyName}\n\nExisting CRM companies:\n${nameList}`
          }
        ],
        max_tokens: 80,
        temperature: 0,
        response_format: { type: "json_object" }
      }),
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!response.ok) return null;
    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    return content ? JSON.parse(content) : null;
  } catch {
    return null;
  }
}
const MANUFACTURER_SELECT = "id,company,stage,industry,end_product,signals,last_contact,tags";
const CONTACT_SELECT = "manufacturer_id,name,title,linkedin";
const END_PRODUCT_MISSING_PATTERN = /not confidently confirmed from public pages yet/i;
const INFERRED_END_PRODUCT_PATTERN = /^inferred from plant\/query context\s*-\s*/i;

export async function createCrmSync(rawOptions = {}, deps = {}) {
  const fetchImpl = deps.fetch || globalThis.fetch;
  const config = await resolveCrmConfig(rawOptions, deps);
  if (!config) {
    return null;
  }

  if (typeof fetchImpl !== "function") {
    throw new Error("Fetch is not available for CRM sync.");
  }

  const nowValue = deps.now instanceof Function ? deps.now() : new Date();
  const now = nowValue instanceof Date ? nowValue : new Date(nowValue);
  const batchId = formatBatchId(now);
  const batchTag = `${CRM_IMPORT_BATCH_PREFIX}${batchId}`;
  const client = createPostgrestClient(config, fetchImpl);

  return {
    config,
    batchId,
    batchTag,
    async loadExistingRecords() {
      const [manufacturers, contacts] = await Promise.all([
        client.select("manufacturers", {
          select: MANUFACTURER_SELECT,
          order: { column: "created_at", ascending: false },
          limit: 5000
        }),
        client.select("manufacturer_contacts", {
          select: CONTACT_SELECT,
          limit: 20000
        })
      ]);

      const contactsByManufacturerId = new Map();
      for (const contact of toArray(contacts)) {
        const manufacturerId = contact?.manufacturer_id;
        if (manufacturerId === undefined || manufacturerId === null) {
          continue;
        }
        if (!contactsByManufacturerId.has(manufacturerId)) {
          contactsByManufacturerId.set(manufacturerId, []);
        }
        contactsByManufacturerId.get(manufacturerId).push(contact);
      }

      const records = toArray(manufacturers)
        .map((row) => mapCrmManufacturerToExistingRecord(row, contactsByManufacturerId.get(row.id) || []))
        .filter(Boolean);

      _cachedCrmCompanyNames = records.map((r) => r.company).filter(Boolean);
      return records;
    },
    async insertLead(record, intelligence) {
      const manufacturerPayload = buildCrmManufacturerPayload(record, intelligence, {
        batchTag,
        today: toDateString(now)
      });
      const insertedManufacturers = await client.insert("manufacturers", [manufacturerPayload], {
        select: "id,company"
      });
      const insertedManufacturer = toArray(insertedManufacturers)[0];
      const manufacturerId = insertedManufacturer?.id;
      if (manufacturerId === undefined || manufacturerId === null) {
        throw new Error("CRM manufacturer insert did not return an id.");
      }

      const contactRows = buildCrmContactRows(manufacturerId, intelligence);
      if (contactRows.length) {
        await client.insert("manufacturer_contacts", contactRows, {
          select: "manufacturer_id,name,title,linkedin"
        });
      }

      return {
        manufacturerId,
        contactsInserted: contactRows.length
      };
    }
  };
}

export function mapCrmManufacturerToExistingRecord(row, contacts = []) {
  const company = cleanText(row?.company);
  if (!company) {
    return null;
  }

  const tags = normalizeTagArray(row?.tags);
  const finderSkip = tags.includes("__finder_skip");

  const notesParts = [
    cleanText(row?.signals),
    cleanText(row?.end_product) ? `End products: ${cleanText(row?.end_product)}` : ""
  ].filter(Boolean);

  const contactLines = contacts
    .map((contact) => [
      cleanText(contact?.name),
      cleanText(contact?.title),
      cleanText(contact?.linkedin)
    ].filter(Boolean).join(", "))
    .filter(Boolean)
    .join("\n");

  return {
    company,
    stage: cleanText(row?.stage) || DEFAULT_STAGE,
    industry: cleanText(row?.industry),
    notes: notesParts.join("\n"),
    contacts: contactLines,
    tags: tags.join(" | "),
    last_activity: normalizeDateValue(row?.last_contact),
    _finderSkip: finderSkip
  };
}

export function buildCrmManufacturerPayload(record, intelligence, { batchTag = "", today = toDateString(new Date()) } = {}) {
  const company = cleanText(record?.company);
  if (!company) {
    throw new Error("Cannot sync a CRM lead without a company name.");
  }

  const tags = uniqueValues([
    ...splitTagText(record?.tags),
    FINDER_SYNC_TAG,
    batchTag
  ]);

  return {
    company,
    stage: DEFAULT_STAGE,
    industry: cleanText(record?.industry),
    end_product: pickConfirmedEndProduct(intelligence),
    signals: cleanText(record?.notes),
    last_contact: normalizeDateValue(record?.last_activity) || today,
    tags
  };
}

export function buildCrmContactRows(manufacturerId, intelligence) {
  const seen = new Set();
  return uniqueContactsFromIntelligence(intelligence)
    .map((contact) => ({
      manufacturer_id: manufacturerId,
      name: cleanText(contact?.name),
      title: cleanText(contact?.title),
      linkedin: cleanText(contact?.linkedin || contact?.source_url)
    }))
    .filter((contact) => contact.name && contact.title)
    .filter((contact) => {
      const key = `${contact.name.toLowerCase()}::${contact.title.toLowerCase()}::${contact.linkedin.toLowerCase()}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
}

export async function checkQualifiedLeadCrmDuplicate({ record, existingIndex, seenIndex, includeAi = true }) {
  if (isDuplicate(record, existingIndex, seenIndex)) {
    return { action: "duplicate", contactsInserted: 0 };
  }

  const name = normalizeName(record.company || record.company_name || record.name);
  if (name && (existingIndex.names.has(name) || seenIndex.names.has(name))) {
    return { action: "duplicate", contactsInserted: 0 };
  }

  const companyName = cleanText(record.company || record.company_name || record.name);
  if (includeAi && companyName && _cachedCrmCompanyNames.length > 0) {
    const aiResult = await aiCheckDuplicate(companyName, _cachedCrmCompanyNames);
    if (aiResult?.isDuplicate) {
      return { action: "duplicate", contactsInserted: 0, aiMatch: aiResult.matchedName || "" };
    }
  }

  return { action: "ok", contactsInserted: 0 };
}

export async function syncQualifiedLeadToCrm({ crmSync, record, intelligence, existingIndex, seenIndex, duplicatePrechecked = false }) {
  if (!crmSync) {
    return { action: "disabled", contactsInserted: 0 };
  }

  const duplicateResult = await checkQualifiedLeadCrmDuplicate({
    record,
    existingIndex,
    seenIndex,
    includeAi: !duplicatePrechecked
  });
  if (duplicateResult.action === "duplicate") {
    return duplicateResult;
  }

  const companyName = cleanText(record.company || record.company_name || record.name);
  const inserted = await crmSync.insertLead(record, intelligence);
  rememberCandidate(record, seenIndex);
  _cachedCrmCompanyNames.push(companyName);
  return {
    action: "inserted",
    manufacturerId: inserted.manufacturerId,
    contactsInserted: inserted.contactsInserted
  };
}

async function resolveCrmConfig(rawOptions, deps) {
  const configPath = firstNonBlank(rawOptions.crmConfigPath, process.env.CRM_CONFIG_PATH);
  const fileConfig = configPath
    ? await loadCrmConfigFile(configPath, deps.readFile || readFile)
    : {};

  const supabaseUrl = firstNonBlank(
    rawOptions.crmSupabaseUrl,
    process.env.CRM_SUPABASE_URL,
    fileConfig.supabaseUrl
  );
  const supabaseAnonKey = firstNonBlank(
    rawOptions.crmSupabaseAnonKey,
    process.env.CRM_SUPABASE_ANON_KEY,
    fileConfig.supabaseAnonKey
  );
  const supabaseKey = firstNonBlank(
    rawOptions.crmSupabaseKey,
    process.env.CRM_SUPABASE_KEY,
    fileConfig.supabaseKey,
    supabaseAnonKey
  );
  const supabaseServiceRoleKey = firstNonBlank(
    rawOptions.crmSupabaseServiceRoleKey,
    process.env.CRM_SUPABASE_SERVICE_ROLE_KEY,
    fileConfig.supabaseServiceRoleKey
  );

  if (!configPath && !supabaseUrl && !supabaseKey && !supabaseServiceRoleKey) {
    return null;
  }

  if (!supabaseUrl || !(supabaseServiceRoleKey || supabaseKey || supabaseAnonKey)) {
    const sourceLabel = configPath
      ? `CRM config ${resolveConfigPath(configPath)}`
      : "CRM Supabase environment settings";
    throw new Error(`${sourceLabel} is missing a Supabase URL or key.`);
  }

  return {
    configPath: configPath ? resolveConfigPath(configPath) : "",
    label: firstNonBlank(fileConfig.appLabel, fileConfig.label, resolveConfigPath(configPath || ""), supabaseUrl),
    supabaseUrl: supabaseUrl.replace(/\/+$/, ""),
    supabaseAnonKey: supabaseAnonKey || supabaseKey || supabaseServiceRoleKey,
    supabaseKey: supabaseKey || supabaseAnonKey || supabaseServiceRoleKey,
    supabaseServiceRoleKey,
    apiKey: supabaseServiceRoleKey || supabaseKey || supabaseAnonKey
  };
}

async function loadCrmConfigFile(configPath, readFileImpl) {
  const resolvedPath = resolveConfigPath(configPath);
  const text = await readFileImpl(resolvedPath, "utf8");
  const trimmed = String(text || "").trim();
  if (!trimmed) {
    throw new Error(`CRM config file is empty: ${resolvedPath}`);
  }

  if (trimmed.startsWith("{")) {
    return JSON.parse(trimmed);
  }

  const assignmentMatch = trimmed.match(/(?:window\.)?CRM_CONFIG\s*=\s*(\{[\s\S]*\})\s*;?\s*$/);
  if (!assignmentMatch?.[1]) {
    throw new Error(`Unsupported CRM config format in ${resolvedPath}`);
  }

  return JSON.parse(assignmentMatch[1]);
}

function createPostgrestClient(config, fetchImpl) {
  const baseUrl = `${config.supabaseUrl}/rest/v1`;
  const authHeaders = {
    apikey: config.apiKey,
    Authorization: `Bearer ${config.apiKey}`
  };

  return {
    async select(table, { select = "*", order = null, limit = 1000 } = {}) {
      const maxRows = Math.max(0, Number(limit) || 1000);
      const pageSize = Math.min(maxRows || 1000, 1000);
      const rows = [];

      for (let offset = 0; offset < maxRows; offset += pageSize) {
        const url = new URL(`${baseUrl}/${table}`);
        url.searchParams.set("select", select);
        url.searchParams.set("limit", String(Math.min(pageSize, maxRows - offset)));
        url.searchParams.set("offset", String(offset));
        if (order?.column) {
          url.searchParams.set("order", `${order.column}.${order.ascending === false ? "desc" : "asc"}`);
        }
        const page = await requestJson(fetchImpl, url, {
          method: "GET",
          headers: {
            ...authHeaders,
            Accept: "application/json"
          }
        });
        const pageRows = toArray(page);
        rows.push(...pageRows);
        if (pageRows.length < pageSize) {
          break;
        }
      }

      return rows;
    },
    async insert(table, rows, { select = "" } = {}) {
      const url = new URL(`${baseUrl}/${table}`);
      if (select) {
        url.searchParams.set("select", select);
      }
      return requestJson(fetchImpl, url, {
        method: "POST",
        headers: {
          ...authHeaders,
          Accept: "application/json",
          "Content-Type": "application/json",
          Prefer: "return=representation"
        },
        body: JSON.stringify(rows)
      });
    }
  };
}

async function requestJson(fetchImpl, url, options) {
  const response = await fetchImpl(url, options);
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message = cleanText(data?.message) || cleanText(data?.error_description) || cleanText(text) || `${response.status} ${response.statusText}`;
    throw new Error(message);
  }
  return data;
}

function uniqueContactsFromIntelligence(intelligence) {
  if (!Array.isArray(intelligence?.maintenanceContacts)) {
    return [];
  }

  return intelligence.maintenanceContacts.filter((contact) => cleanText(contact?.name) && cleanText(contact?.title));
}

function pickConfirmedEndProduct(intelligence) {
  const value = cleanText(intelligence?.endProducts);
  if (!value || END_PRODUCT_MISSING_PATTERN.test(value) || INFERRED_END_PRODUCT_PATTERN.test(value)) {
    return "";
  }
  return value;
}

function splitTagText(value) {
  return String(value || "")
    .split("|")
    .map((entry) => cleanText(entry))
    .filter(Boolean);
}

function normalizeTagArray(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => cleanText(entry)).filter(Boolean);
  }
  return splitTagText(value);
}

function uniqueValues(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function normalizeDateValue(value) {
  const text = cleanText(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
}

function toDateString(value) {
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString().slice(0, 10);
}

function formatBatchId(value) {
  const date = value instanceof Date ? value : new Date(value);
  const year = String(date.getUTCFullYear());
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  const seconds = String(date.getUTCSeconds()).padStart(2, "0");
  return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}

function resolveConfigPath(filePath) {
  if (!filePath) {
    return "";
  }
  return path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
}

function firstNonBlank(...values) {
  for (const value of values) {
    const text = cleanText(value);
    if (text) {
      return text;
    }
  }
  return "";
}

function cleanText(value) {
  return String(value || "").trim();
}

function toArray(value) {
  return Array.isArray(value) ? value : (value ? [value] : []);
}
