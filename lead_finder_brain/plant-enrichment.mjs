const OPENAI_CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions";
const DEFAULT_MODEL = process.env.PLANT_ENRICHMENT_MODEL || "gpt-5-nano";
const RECENT_SIGNAL_INCLUDE_PATTERN = /\b(hiring|hire|job opening|job posting|careers?|recruiting|recruitment|seeking|millwright|maintenance mechanic|maintenance technician|production operator|production supervisor|plant manager|operations manager|expansion|expand|expanding|expanded|planned expansion|new facility|new plant|new site|new production line|production line|capacity|permit|approval|environmental compliance approval|eca|construction|investment|investing)\b/i;
const RECENT_SIGNAL_STRONG_PATTERN = /\b(hiring|job opening|job posting|careers?|recruiting|millwright|maintenance|production|plant|operations|expansion|expanded|expanding|new facility|new plant|new site|new production line|capacity|permit|approval|eca|construction|investment|planned expansion)\b/i;
const RECENT_SIGNAL_NOISE_PATTERN = /\b(address|phone|official site|about|located|product list|products?|capabilities|independent craft|proudly located|built in|refurbished|facility address|contact page|store hours|taproom|tour|brewery tours?)\b/i;
const RECENT_SIGNAL_NOISE_OVERRIDE_PATTERN = /\b(hiring|hire|job opening|job posting|careers?|recruiting|expansion|expanded|expanding|planned expansion|new facility|new plant|new site|new production line|capacity|permit|approval|eca|construction|investment)\b/i;
const NON_PERSON_CONTACT_NAME_PATTERN = /\b(manager|supervisor|operator|technician|mechanic|millwright|team|department|contact|careers?|production|maintenance|operations|purchasing|procurement|job|posting|role|opening)\b/i;

export function buildPlantEnrichmentMessages(lead) {
  return [
    {
      role: "system",
      content: `You are the industrial plant enrichment brain for Ontario sales prospecting.

Return only valid JSON. Do not use markdown.

The company has already passed the strict yes/no plant verifier. Do not reject the company just because contact data is incomplete.

Your job is to turn the verified plant lead into useful CRM rows by extracting and organizing:
- all relevant in-range facility/site addresses
- facility/head office phone numbers, fax numbers, and useful emails where available
- end products or product categories
- likely plant equipment/process clues
- production, maintenance, operations, general management, purchasing, and plant-adjacent contacts
- full personal LinkedIn profile URLs when the evidence provides them
- recent hiring, expansion, planned expansion, new facility, new production line, capacity, permit, ECA, construction, or operational-growth signals when the evidence provides them
- cited proof for every important field

Think in these enrichment passes:
1. Facility pass: prefer official location/contact/product pages and regulatory records. Keep multiple plants as separate facility rows.
2. Product/equipment pass: extract physical outputs and infer likely equipment from proven industrial processes.
3. LinkedIn company pass: use LinkedIn company-page employee links to capture public personal /in/ profile URLs.
4. Target people pass: use names/titles from LinkedIn, job postings, SignalHire, Wiza, Clodura, Adapt, ContactOut, Source From Ontario, association pages, and public search snippets when specific.
5. Stale-contact pass: do not output people who are proven deceased, retired, or clearly no longer at the company.
6. Recent-signal pass: only capture hiring or expansion-type signals. Ignore awards, charity posts, generic marketing, customer reviews, and unrelated social announcements.

Target people roles:
- plant manager
- maintenance manager
- maintenance supervisor
- maintenance mechanic, millwright, industrial mechanic, maintenance technician
- production manager
- production supervisor
- team lead
- general manager
- operations manager
- purchaser, buyer, procurement, supply chain
- similar plant, maintenance, production, facility, or operations role

Rules:
- Do not invent names, titles, phone numbers, emails, or LinkedIn links.
- Include a full LinkedIn profile URL only when the evidence gives a full public profile URL.
- Personal LinkedIn URLs must contain /in/. Do not use company pages, search URLs, or guessed URLs as linkedin_url.
- If a LinkedIn screenshot or snippet confirms a profile but not the exact URL, include the contact with linkedin_url as an empty string and explain in notes.
- If a useful person is proven by non-LinkedIn evidence but no LinkedIn URL is available, include the person with linkedin_url as an empty string and cite the source URL.
- Do not include generic company LinkedIn pages as a person's linkedin_url.
- Do not include placeholder contacts. Every contact object must have a non-empty person name.
- Do not include a person whose title/role is unknown unless the notes clearly explain why they are still useful.
- Do not output a job title, open role, department, or job posting as a contact name. Job openings without a named person belong in recent_signals only.
- If evidence says the company is hiring a production, maintenance, plant, operations, warehouse, or supervisor role, output that as a recent_signals entry even when no named person appears.
- Missing contacts does not remove the lead.
- Keep facility rows separate when multiple plants/sites are listed.
- Prefer official company sources for facilities and phones.
- Prefer a contact record with a LinkedIn URL over a duplicate record without one.
- Assign high confidence only when official, LinkedIn, government, or strong direct evidence confirms name/title/company.
- Assign medium confidence when a credible people directory confirms title/company or LinkedIn confirms company while another source confirms title.
- Assign low confidence for directory-only or weaker production-adjacent contacts.
- If no target contacts are found after the evidence is exhausted, return an empty contacts array and contact_search_status no_target_contacts_found.
- If no hiring/expansion-type signal is found, return an empty recent_signals array. Do not fill it with unrelated announcements.
- Never put ordinary company proof in recent_signals. Official address, phone, product list, about-page language, current facility existence, brewery/tour pages, or "built in a refurbished building" facts belong in proof unless they explicitly mention current hiring, expansion, planned expansion, new capacity, new production line, permit/ECA, construction, or investment.

Return this exact shape:
{
  "company": string,
  "qualified": true,
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
  "proof": [
    {
      "claim": string,
      "source_url": string,
      "evidence": string
    }
  ],
  "contact_search_status": "contacts_found" | "partial_contacts" | "no_target_contacts_found"
}`
    },
    {
      role: "user",
      content: `Accepted lead evidence packet:
${JSON.stringify(lead, null, 2)}`
    }
  ];
}

export async function enrichPlantLead(lead, {
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
      messages: buildPlantEnrichmentMessages(lead),
      response_format: { type: "json_object" }
    };

    if (/^gpt-5/i.test(model)) {
      requestBody.max_completion_tokens = 5000;
      requestBody.reasoning_effort = "minimal";
    } else {
      requestBody.max_tokens = 2500;
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
    if (!content) {
      throw new Error("OpenAI response had no message content.");
    }

    return normalizeEnrichmentResult(JSON.parse(content), lead);
  } finally {
    clearTimeout(timer);
  }
}

export function normalizeEnrichmentResult(raw, lead) {
  const result = raw && typeof raw === "object" ? raw : {};
  const sourceUrls = Array.isArray(lead?.source_urls) ? lead.source_urls : [];
  const allowedLinkedInUrls = new Set(
    sourceUrls
      .map((url) => normalizeLinkedInUrl(url))
      .filter(Boolean)
  );

  const contacts = dedupeContacts(
    cleanArray(result.contacts)
      .map((contact) => cleanContact(contact, allowedLinkedInUrls))
      .filter((contact) => contact.name)
      .filter((contact) => isLikelyPersonName(contact.name))
      .filter((contact) => contact.title || contact.email || contact.phone || contact.linkedin_url)
      .filter((contact) => !isNegativePlaceholder(contact))
  );

  const facilities = cleanArray(result.facilities)
    .map((facility) => ({
      name: stringValue(facility?.name),
      facility_type: stringValue(facility?.facility_type),
      address: stringValue(facility?.address),
      city: stringValue(facility?.city),
      province: stringValue(facility?.province) || "ON",
      postal_code: stringValue(facility?.postal_code),
      phone: stringValue(facility?.phone),
      fax: stringValue(facility?.fax),
      email: stringValue(facility?.email),
      source_url: stringValue(facility?.source_url),
      notes: stringValue(facility?.notes)
    }))
    .filter((facility) => facility.address || facility.name);

  const proof = cleanArray(result.proof)
    .map((entry) => ({
      claim: stringValue(entry?.claim),
      source_url: stringValue(entry?.source_url),
      evidence: stringValue(entry?.evidence)
    }))
    .filter((entry) => entry.claim || entry.evidence || entry.source_url);

  const hasFacility = facilities.length > 0;
  const hasContact = contacts.length > 0;
  const contact_search_status = hasContact
    ? contacts.some((contact) => !contact.linkedin_url || !contact.source_url) ? "partial_contacts" : "contacts_found"
    : "no_target_contacts_found";

  return {
    company: stringValue(result.company) || stringValue(lead?.company),
    qualified: true,
    facilities,
    end_products: cleanStringArray(result.end_products),
    likely_equipment: cleanStringArray(result.likely_equipment),
    contacts,
    recent_signals: cleanArray(result.recent_signals)
      .map((signal) => ({
        type: stringValue(signal?.type),
        title: stringValue(signal?.title),
        date: stringValue(signal?.date),
        source_url: stringValue(signal?.source_url),
        evidence: stringValue(signal?.evidence),
        why_it_matters: stringValue(signal?.why_it_matters)
      }))
      .filter((signal) => signal.title || signal.evidence || signal.source_url)
      .filter(isRecentOperationalSignal),
    proof,
    contact_search_status,
    has_facility_data: hasFacility
  };
}

function cleanContact(contact, allowedLinkedInUrls) {
  const linkedin_url = normalizeLinkedInUrl(contact?.linkedin_url);
  const source_url = stringValue(contact?.source_url);
  const preferredLinkedIn = linkedin_url && (!allowedLinkedInUrls.size || allowedLinkedInUrls.has(linkedin_url))
    ? linkedin_url
    : "";

  return {
    name: stringValue(contact?.name),
    title: stringValue(contact?.title),
    role_match: stringValue(contact?.role_match),
    phone: stringValue(contact?.phone),
    email: stringValue(contact?.email),
    linkedin_url: preferredLinkedIn,
    source_url,
    confidence: normalizeConfidence(contact?.confidence),
    notes: stringValue(contact?.notes)
  };
}

function normalizeLinkedInUrl(value) {
  const url = stringValue(value);
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

function isNegativePlaceholder(contact) {
  const text = `${contact?.name || ""} ${contact?.title || ""} ${contact?.notes || ""}`.toLowerCase();
  return /\b(unknown|not publicly listed|contact us|none found|n\/a|null)\b/.test(text);
}

function isLikelyPersonName(value) {
  const text = stringValue(value);
  if (!text || /@|https?:\/\//i.test(text) || NON_PERSON_CONTACT_NAME_PATTERN.test(text)) {
    return false;
  }
  const tokens = text.replace(/[^A-Za-z'. -]/g, " ").split(/\s+/).filter(Boolean);
  if (tokens.length < 2 || tokens.length > 5) {
    return false;
  }
  return tokens.every((token) => /[A-Za-z]/.test(token));
}

function dedupeContacts(contacts) {
  const sorted = [...contacts].sort((left, right) => contactScore(right) - contactScore(left));
  const seen = new Set();
  const unique = [];

  for (const contact of sorted) {
    const key = `${contact.name.toLowerCase()}::${contact.title.toLowerCase()}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(contact);
  }

  return unique;
}

function contactScore(contact) {
  let score = 0;
  if (contact.linkedin_url) score += 10;
  if (contact.source_url) score += 6;
  if (contact.email) score += 3;
  if (contact.phone) score += 2;
  if (contact.confidence === "high") score += 4;
  if (contact.confidence === "medium") score += 2;
  return score;
}

function cleanArray(value) {
  return Array.isArray(value) ? value : [];
}

function cleanStringArray(value) {
  return cleanArray(value)
    .map((entry) => stringValue(entry))
    .filter(Boolean);
}

function normalizeConfidence(value) {
  const confidence = stringValue(value).toLowerCase();
  return ["high", "medium", "low"].includes(confidence) ? confidence : "low";
}

function isRecentOperationalSignal(signal) {
  const text = [
    signal?.title,
    signal?.evidence,
    signal?.why_it_matters,
    signal?.source_url
  ].map((value) => stringValue(value)).join(" ");

  if (!RECENT_SIGNAL_INCLUDE_PATTERN.test(text) || !RECENT_SIGNAL_STRONG_PATTERN.test(text)) {
    return false;
  }
  if (RECENT_SIGNAL_NOISE_PATTERN.test(text) && !RECENT_SIGNAL_NOISE_OVERRIDE_PATTERN.test(text)) {
    return false;
  }
  return true;
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}
