import { readFile } from "node:fs/promises";
import path from "node:path";

import { normalizeEnrichmentResult } from "./plant-enrichment.mjs";

const DEFAULT_MODEL = process.env.PLANT_VERIFIER_MODEL || "gpt-5-mini";
const OPENAI_CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions";

export async function loadLocalEnv({
  cwd = process.cwd(),
  filenames = [".env.local", ".env"]
} = {}) {
  for (const filename of filenames) {
    const filePath = path.resolve(cwd, filename);
    let text = "";
    try {
      text = await readFile(filePath, "utf8");
    } catch {
      continue;
    }

    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const equals = line.indexOf("=");
      if (equals < 1) continue;
      const key = line.slice(0, equals).trim();
      const value = line.slice(equals + 1).trim().replace(/^["']|["']$/g, "");
      if (key && !(key in process.env)) process.env[key] = value;
    }
  }
}

export function buildPlantVerifierMessages(candidate) {
  return [
    {
      role: "system",
      content: `You are a strict industrial plant qualification analyst for Ontario sales prospecting.

Your job is to prevent junk leads from entering a CRM.

Return only valid JSON. Do not use markdown.

QUALIFY ONLY IF ALL ARE PROVEN FROM THE EVIDENCE PACKET:
1. The result is an actual company, not a page title, article, directory, recipe, search result category, association, or generic phrase.
2. The company is the operator/owner of the production or processing site. Reject vendors, contractors, consultants, distributors, wholesalers, retailers, pest control, software, engineering-only, equipment suppliers, service providers, associations, and pages merely serving manufacturers.
3. There is at least one real facility address in the GTA or roughly 2 hours driving radius from the GTA.
4. The company manufactures, processes, produces, packages, recycles, casts, molds, mixes, mills, stamps, coats, roasts, brews, bakes, crushes, extrudes, or otherwise physically transforms products/materials at the facility.
5. The operation is industrial enough to plausibly use plant equipment such as pumps, conveyors, mixers, packaging lines, compressors, crushers, kilns, ovens, tanks, boilers, hydraulics, motors, gearboxes, dust collection, chillers, dryers, screens, presses, molding machines, extruders, furnaces, finishing lines, or similar machinery.
6. The proof can be cited from the provided evidence.

DEFAULT TO REJECT when proof is missing or ambiguous. Do not qualify a lead just because the search query contains plant/manufacturer words.

Accepted industries include food processors, meat/poultry plants, commercial bakery production plants, breweries/cideries with brewing and packaging, commercial coffee roasters, ready-mix/precast concrete plants, asphalt plants, aggregate/quarry operations, recycling/material recovery plants, metal processors/stampers/coaters/foundries, plastics molding/extrusion/thermoforming plants, packaging manufacturers, and building product manufacturers.

Return this exact shape:
{
  "qualified": boolean,
  "is_real_company": boolean,
  "is_plant_operator": boolean,
  "facility_in_range": boolean,
  "manufactures_or_processes": boolean,
  "industrial_scale": boolean,
  "reject_reason": string,
  "confidence": "high" | "medium" | "low",
  "proof": [{"claim": string, "source_type": string, "source_url": string, "evidence": string}],
  "confirmed_facilities": [{"name": string, "address": string, "city": string, "phone": string, "source_url": string, "facility_type": string}],
  "end_products": string[],
  "production_related_names": string[],
  "likely_equipment": string[],
  "people": [],
  "people_search_status": "not_searched"
}

The people field is enrichment-only and must stay empty in this first gate. Missing people never affects qualification.`
        + `

If qualified is true:
- proof must contain at least one cited evidence item.
- confirmed_facilities must contain at least one in-range facility.
- end_products must contain at least one physical output. If the evidence proves a process/capability but not a named SKU, use a concrete product category such as "fabricated steel components", "machined metal parts", "fiberglass composite products", "hot mix asphalt", "precast concrete products", "roasted coffee", or "packaged food products".
- Do not leave end_products empty for a qualified plant.

Important calibration:
- If the packet explicitly says "manufacturing facility", "production facility", "processing facility", "plant", "asphalt plant", "ready-mix plant", "precast plant", "roastery", "brewery", "recycling facility", "fabrication facility", or similar next to an in-range address, and the company makes physical products, count that as facility/operator proof.
- Do not reject solely because the evidence packet does not list exact equipment. If the process is industrial, infer likely equipment from the process.
- Metal fabrication, welding, machining, assembly, composite molding/fabrication, and similar operations qualify when tied to a real facility and physical products/components.
- Still reject if there is only a generic office/address with no manufacturing or processing language.`
    },
    {
      role: "user",
      content: `Candidate evidence packet:
${JSON.stringify(candidate, null, 2)}`
    }
  ];
}

export async function verifyPlantCandidate(candidate, {
  apiKey = process.env.OPENAI_API_KEY,
  model = DEFAULT_MODEL,
  timeoutMs = 30000
} = {}) {
  if (!apiKey) {
    throw new Error("Missing OPENAI_API_KEY. Put it in .env.local or the environment.");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const requestBody = {
      model,
      messages: buildPlantVerifierMessages(candidate),
      response_format: { type: "json_object" }
    };
    if (/^gpt-5/i.test(model)) {
      requestBody.max_completion_tokens = 4000;
      requestBody.reasoning_effort = "minimal";
    } else {
      requestBody.max_tokens = 1800;
      requestBody.temperature = 0.05;
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
      throw new Error(`OpenAI request failed ${response.status}: ${body.slice(0, 500)}`);
    }

    const data = JSON.parse(body);
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error("OpenAI response had no message content.");

    return normalizeVerifierResult(JSON.parse(content));
  } finally {
    clearTimeout(timer);
  }
}

export function buildPlantVerifierEnrichmentMessages(candidate) {
  return [
    {
      role: "system",
      content: `You are the strict industrial plant qualification and enrichment brain for Ontario sales prospecting.

Return only valid JSON. Do not use markdown.

You must do this in order:
1. First decide whether the company qualifies as a real in-range industrial plant lead.
2. If qualified is false, stop there: return the reject fields and leave all enrichment arrays empty.
3. Only if qualified is true, fill the lead enrichment fields and operations-tied contacts from the same evidence packet.

QUALIFY ONLY IF ALL ARE PROVEN FROM THE EVIDENCE PACKET:
1. The result is an actual company, not a page title, article, directory, recipe, search result category, association, or generic phrase.
2. The company is the operator/owner of the production or processing site. Reject vendors, contractors, consultants, distributors, wholesalers, retailers, pest control, software, engineering-only, equipment suppliers, service providers, associations, and pages merely serving manufacturers.
3. There is at least one real facility address in the GTA or roughly 2 hours driving radius from the GTA.
4. The company manufactures, processes, produces, packages, recycles, casts, molds, mixes, mills, stamps, coats, roasts, brews, bakes, crushes, extrudes, or otherwise physically transforms products/materials at the facility.
5. The operation is industrial enough to plausibly use plant equipment such as pumps, conveyors, mixers, packaging lines, compressors, crushers, kilns, ovens, tanks, boilers, hydraulics, motors, gearboxes, dust collection, chillers, dryers, screens, presses, molding machines, extruders, furnaces, finishing lines, or similar machinery.
6. The proof can be cited from the provided evidence.

DEFAULT TO REJECT when proof is missing or ambiguous.

When qualified is true, enrich the CRM row with:
- confirmed facilities/site addresses
- end products or product categories
- likely plant equipment/process clues
- production, maintenance, operations, quality, general management, purchasing, supply chain, warehouse/logistics, owner/operator, or plant-adjacent contacts
- full personal LinkedIn profile URLs when the evidence provides them
- recent hiring, expansion, planned expansion, new facility, new production line, capacity, permit, ECA, construction, or operational-growth signals
- cited proof

Contact rules:
- Do not invent names, titles, emails, phone numbers, or LinkedIn links.
- Include a LinkedIn URL only when evidence gives a full /in/ profile URL.
- Never use company LinkedIn pages as a person's linkedin_url.
- Do not output job titles, departments, or job postings as contact names.
- Missing contacts must not reject the lead.
- Similar-name companies are not enough. Contacts must tie to the exact verified company identity, location, website, or facility.

Recent signal rules:
- Only include hiring or expansion-type signals.
- Ignore awards, charity, generic marketing, ordinary about-page facts, addresses, product lists, and unrelated expansion news.

Return this exact JSON shape:
{
  "qualified": boolean,
  "is_real_company": boolean,
  "is_plant_operator": boolean,
  "facility_in_range": boolean,
  "manufactures_or_processes": boolean,
  "industrial_scale": boolean,
  "reject_reason": string,
  "confidence": "high" | "medium" | "low",
  "company": string,
  "proof": [{"claim": string, "source_type": string, "source_url": string, "evidence": string}],
  "confirmed_facilities": [{"name": string, "address": string, "city": string, "phone": string, "source_url": string, "facility_type": string}],
  "facilities": [
    {
      "name": string,
      "facility_type": string,
      "address": string,
      "city": string,
      "province": string,
      "postal_code": string,
      "phone": string,
      "fax": string,
      "email": string,
      "source_url": string,
      "notes": string
    }
  ],
  "end_products": string[],
  "production_related_names": string[],
  "likely_equipment": string[],
  "contacts": [
    {
      "name": string,
      "title": string,
      "role_match": string,
      "phone": string,
      "email": string,
      "linkedin_url": string,
      "source_url": string,
      "confidence": "high" | "medium" | "low",
      "notes": string
    }
  ],
  "recent_signals": [
    {
      "type": "hiring" | "expansion" | "planned_expansion" | "permit" | "capacity",
      "title": string,
      "date": string,
      "source_url": string,
      "evidence": string,
      "why_it_matters": string
    }
  ],
  "people": [],
  "people_search_status": "not_searched",
  "contact_search_status": "contacts_found" | "partial_contacts" | "no_target_contacts_found" | "not_searched"
}

If qualified is false, confirmed_facilities, facilities, end_products, production_related_names, likely_equipment, contacts, recent_signals, and proof must be empty unless the proof directly explains rejection.`
    },
    {
      role: "user",
      content: `Candidate and enrichment evidence packet:
${JSON.stringify(candidate, null, 2)}`
    }
  ];
}

export async function verifyAndEnrichPlantLead(candidate, {
  apiKey = process.env.OPENAI_API_KEY,
  model = DEFAULT_MODEL,
  timeoutMs = 60000
} = {}) {
  if (!apiKey) {
    throw new Error("Missing OPENAI_API_KEY. Put it in .env.local or the environment.");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const requestBody = {
      model,
      messages: buildPlantVerifierEnrichmentMessages(candidate),
      response_format: { type: "json_object" }
    };
    if (/^gpt-5/i.test(model)) {
      requestBody.max_completion_tokens = 7000;
      requestBody.reasoning_effort = "minimal";
    } else {
      requestBody.max_tokens = 3500;
      requestBody.temperature = 0.05;
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
      throw new Error(`OpenAI request failed ${response.status}: ${body.slice(0, 1000)}`);
    }

    const data = JSON.parse(body);
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error("OpenAI response had no message content.");

    return normalizeVerifierEnrichmentResult(JSON.parse(content), candidate);
  } finally {
    clearTimeout(timer);
  }
}

export function normalizeVerifierEnrichmentResult(raw, candidate) {
  const result = raw && typeof raw === "object" ? { ...raw } : {};
  if (!Array.isArray(result.confirmed_facilities) || !result.confirmed_facilities.length) {
    result.confirmed_facilities = arrayValue(result.facilities).map((facility) => ({
      name: stringValue(facility?.name),
      address: stringValue(facility?.address),
      city: stringValue(facility?.city),
      phone: stringValue(facility?.phone),
      source_url: stringValue(facility?.source_url),
      facility_type: stringValue(facility?.facility_type)
    }));
  }

  const verifierResult = normalizeVerifierResult(result);
  if (!verifierResult.qualified) {
    return {
      verifierResult,
      enrichmentResult: null
    };
  }

  const enrichmentRaw = {
    ...result,
    company: stringValue(result.company) || stringValue(candidate?.company) || stringValue(candidate?.company_hint),
    facilities: arrayValue(result.facilities).length
      ? result.facilities
      : verifierResult.confirmed_facilities.map((facility) => ({
        name: facility.name,
        facility_type: facility.facility_type,
        address: facility.address,
        city: facility.city,
        province: "ON",
        postal_code: "",
        phone: facility.phone,
        fax: "",
        email: "",
        source_url: facility.source_url,
        notes: "Confirmed by verifier/enrichment pass."
      }))
  };

  return {
    verifierResult,
    enrichmentResult: normalizeEnrichmentResult(enrichmentRaw, candidate)
  };
}

export function verifyPlantCandidateHeuristic(candidate) {
  const text = candidateText(candidate);
  const lower = text.toLowerCase();
  const companyName = String(candidate?.company_hint || "").trim();
  const isPageOrContent =
    /\b(recipe|blog|article|guide|directory|near me|best meat loaf|plastic pollution|getting started showing|home \|)\b/i.test(companyName) ||
    /\b(recipe article|no company name|directory designed to help|find a cafe near me)\b/i.test(text);
  const vendorOrService =
    /\b(pest control|extermination|contractor|consulting|software|engineering services|distributor only|wholesale only|retail|cafe|restaurant|bistro|storefront|serving manufacturers|serves .*plants)\b/i.test(text);
  const hasAddress = /\b\d{1,6}\s+[A-Za-z0-9.'#&/\- ]+?\b(?:st|street|ave|avenue|rd|road|dr|drive|blvd|boulevard|lane|ln|court|ct|way|pkwy|parkway|circle|cir|highway|hwy|cres|crescent)\b[^.\n]*,\s*[A-Za-z .'-]+,\s*(?:ON|Ontario)\b/i.test(text);
  const hasPlantOperatorLanguage =
    /\b(operates?|manufactures?|produces?|processes?|packages?|facility|plant|production|processing|roastery|brewery|asphalt production|ready[- ]mix|precast|fabrication|molding|extrusion|recycling facility|quarry)\b/i.test(text);
  const hasPhysicalProducts =
    /\b(products?|asphalt|aggregates?|concrete|steel|metal|plastic|composite|fiberglass|food|meat|poultry|beer|cider|coffee|packaging|parts|components)\b/i.test(text);

  const is_real_company = Boolean(companyName && !isPageOrContent);
  const is_plant_operator = Boolean(is_real_company && hasPlantOperatorLanguage && !vendorOrService);
  const facility_in_range = Boolean(hasAddress);
  const manufactures_or_processes = Boolean(is_plant_operator && hasPhysicalProducts);
  const industrial_scale = Boolean(
    manufactures_or_processes &&
    /\b(plant|facility|production|manufacturing|hot mix|precast|fabrication|molded|industrial|capabilities|products include)\b/i.test(text)
  );

  const raw = {
    qualified: Boolean(is_real_company && is_plant_operator && facility_in_range && manufactures_or_processes && industrial_scale),
    is_real_company,
    is_plant_operator,
    facility_in_range,
    manufactures_or_processes,
    industrial_scale,
    reject_reason: "",
    confidence: "low",
    proof: [],
    confirmed_facilities: [],
    end_products: [],
    production_related_names: [],
    likely_equipment: [],
    people: [],
    people_search_status: "not_searched"
  };

  if (raw.qualified) {
    raw.confidence = "medium";
    raw.proof = [{
      claim: "Evidence packet describes a company operating an industrial production or processing facility.",
      source_type: "evidence_packet",
      source_url: String(candidate?.source_url || ""),
      evidence: firstUsefulSnippet(candidate)
    }];
    raw.confirmed_facilities = [extractFacility(candidate)];
    raw.end_products = inferEndProducts(text);
    raw.production_related_names = inferProductionNames(text);
    raw.likely_equipment = inferLikelyEquipment(text);
  }

  return normalizeVerifierResult(raw);
}

export function normalizeVerifierResult(raw) {
  const result = raw && typeof raw === "object" ? raw : {};
  const normalized = {
    qualified: Boolean(result.qualified),
    is_real_company: Boolean(result.is_real_company),
    is_plant_operator: Boolean(result.is_plant_operator),
    facility_in_range: Boolean(result.facility_in_range),
    manufactures_or_processes: Boolean(result.manufactures_or_processes),
    industrial_scale: Boolean(result.industrial_scale),
    reject_reason: stringValue(result.reject_reason),
    confidence: normalizeConfidence(result.confidence),
    proof: normalizeProof(result.proof),
    confirmed_facilities: normalizeFacilities(result.confirmed_facilities),
    end_products: stringArray(result.end_products),
    production_related_names: stringArray(result.production_related_names),
    likely_equipment: stringArray(result.likely_equipment),
    people: [],
    people_search_status: "not_searched"
  };

  const requiredBooleans = [
    normalized.is_real_company,
    normalized.is_plant_operator,
    normalized.facility_in_range,
    normalized.manufactures_or_processes,
    normalized.industrial_scale
  ];

  const hasMinimumProof = normalized.proof.length > 0 &&
    normalized.confirmed_facilities.length > 0 &&
    normalized.end_products.length > 0;

  if (!requiredBooleans.every(Boolean) || !hasMinimumProof) {
    normalized.qualified = false;
    if (!normalized.reject_reason) {
      normalized.reject_reason = buildDefaultRejectReason(normalized, hasMinimumProof);
    }
  }

  if (normalized.qualified) {
    normalized.reject_reason = "";
  }

  return normalized;
}

function candidateText(candidate) {
  return [
    candidate?.company_hint,
    candidate?.search_query,
    candidate?.source_title,
    candidate?.source_url,
    ...(Array.isArray(candidate?.snippets) ? candidate.snippets : [])
  ].filter(Boolean).join("\n");
}

function firstUsefulSnippet(candidate) {
  return (Array.isArray(candidate?.snippets) ? candidate.snippets : [])
    .find((snippet) => /\b(operates?|manufactures?|facility|plant|products include|capabilities)\b/i.test(snippet)) ||
    String(candidate?.source_title || candidate?.company_hint || "");
}

function extractFacility(candidate) {
  const text = candidateText(candidate);
  const address = text.match(/\b\d{1,6}\s+[A-Za-z0-9.'#&/\- ]+?\b(?:st|street|ave|avenue|rd|road|dr|drive|blvd|boulevard|lane|ln|court|ct|way|pkwy|parkway|circle|cir|highway|hwy|cres|crescent)\b[^.\n]*,\s*[A-Za-z .'-]+,\s*(?:ON|Ontario)[^.\n]*/i)?.[0] || "";
  const city = address.match(/,\s*([A-Za-z .'-]+),\s*(?:ON|Ontario)\b/i)?.[1]?.trim() || "";
  const phone = text.match(/\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/)?.[0] || "";
  return {
    name: city ? `${city} production facility` : "confirmed production facility",
    address,
    city,
    phone,
    source_url: String(candidate?.source_url || ""),
    facility_type: inferProductionNames(text)[0] || "manufacturing or processing facility"
  };
}

function inferEndProducts(text) {
  const lower = text.toLowerCase();
  const products = [];
  if (/\basphalt\b/.test(lower)) products.push("hot mix asphalt");
  if (/\baggregate/.test(lower)) products.push("aggregates");
  if (/\bconcrete\b/.test(lower)) products.push("concrete products");
  if (/\bcomposite|fiberglass/.test(lower)) products.push("fiberglass reinforced plastic/composite products");
  if (/\bmetal|steel|fabrication/.test(lower)) products.push("metal fabricated products");
  return products.length ? products : ["physical manufactured or processed products"];
}

function inferProductionNames(text) {
  const lower = text.toLowerCase();
  const names = [];
  if (/\basphalt\b/.test(lower)) names.push("hot mix asphalt plant");
  if (/\bprecast\b/.test(lower)) names.push("precast concrete plant");
  if (/\bconcrete\b/.test(lower)) names.push("concrete plant");
  if (/\bfabrication\b/.test(lower)) names.push("metal fabrication plant");
  if (/\bcomposite|fiberglass/.test(lower)) names.push("composites manufacturing facility");
  if (/\bmanufactur/.test(lower)) names.push("manufacturing facility");
  return names.length ? names : ["production facility"];
}

function inferLikelyEquipment(text) {
  const lower = text.toLowerCase();
  if (/\basphalt\b/.test(lower)) return ["aggregate conveyors", "dryer drum", "burner", "baghouse", "screens", "loadout silos"];
  if (/\bconcrete|precast\b/.test(lower)) return ["batch plant", "mixers", "aggregate bins", "conveyors", "silos", "forms"];
  if (/\bmetal|fabrication|steel\b/.test(lower)) return ["saws", "presses", "welding stations", "cranes", "compressors", "dust collection"];
  if (/\bcomposite|fiberglass\b/.test(lower)) return ["molds", "mixing equipment", "ovens", "cutting tools", "dust collection", "compressors"];
  return ["pumps", "conveyors", "motors", "gearboxes", "compressors"];
}

function buildDefaultRejectReason(result, hasMinimumProof) {
  if (!result.is_real_company) return "Not proven to be an actual company.";
  if (!result.is_plant_operator) return "Not proven to be the operator of a manufacturing or processing plant.";
  if (!result.facility_in_range) return "No confirmed facility address in the target area.";
  if (!result.manufactures_or_processes) return "Not proven to manufacture or process physical products.";
  if (!result.industrial_scale) return "Not proven to be industrial-scale.";
  if (!hasMinimumProof) return "Missing minimum proof, confirmed facility, or end product.";
  return "Missing required qualification proof.";
}

function normalizeProof(value) {
  return arrayValue(value).map((entry) => ({
    claim: stringValue(entry?.claim),
    source_type: stringValue(entry?.source_type),
    source_url: stringValue(entry?.source_url),
    evidence: stringValue(entry?.evidence)
  })).filter((entry) => entry.claim || entry.evidence || entry.source_url);
}

function normalizeFacilities(value) {
  return arrayValue(value).map((entry) => ({
    name: stringValue(entry?.name),
    address: stringValue(entry?.address),
    city: stringValue(entry?.city),
    phone: stringValue(entry?.phone),
    source_url: stringValue(entry?.source_url),
    facility_type: stringValue(entry?.facility_type)
  })).filter((entry) => entry.address || entry.name);
}

function normalizeConfidence(value) {
  const confidence = stringValue(value).toLowerCase();
  return ["high", "medium", "low"].includes(confidence) ? confidence : "low";
}

function stringArray(value) {
  return arrayValue(value)
    .map((entry) => stringValue(entry))
    .filter(Boolean);
}

function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}
