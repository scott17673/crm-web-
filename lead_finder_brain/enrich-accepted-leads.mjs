import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acceptedLeadEvidence } from "./accepted-lead-evidence.mjs";
import { loadLocalEnv } from "./plant-verifier.mjs";

const OPENAI_CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions";
const DEFAULT_MODEL = process.env.LEAD_ENRICHMENT_MODEL || "gpt-5-nano";

const CURATED_CONTACTS = {
  crupi: [
    {
      name: "Domenic Passalacqua",
      title: "General Manager; previously cited as facility/asphalt plant manager",
      role_match: "asphalt plant operations / general manager / plant-processing contact",
      phone: "416-291-1986",
      email: "",
      linkedin_url: "https://ca.linkedin.com/in/domenic-passalacqua-a5091721",
      source_url: "https://canada.constructconnect.com/dcn/news/projects/2019/01/asphalt-excellence-celebrated-2018-trillium-awards",
      confidence: "high",
      notes: "Directly tied to Crupi asphalt production: cited as facility/asphalt plant manager, later listed as General Manager, ERO contact for the 83 Passmore asphalt facility, and signer for a portable crushing plant approval. Public LinkedIn company page exposes this personal profile URL."
    },
    {
      name: "Walter Henrique",
      title: "Estimating Manager / Project Manager",
      role_match: "project operations / estimating; previous operations and supervisor experience",
      phone: "",
      email: "",
      linkedin_url: "https://ca.linkedin.com/in/walter-henrique-6b2a6528",
      source_url: "https://wiza.co/d/d-crupi-sons-limited/2c94/walter-henrique",
      confidence: "medium",
      notes: "Wiza and SignalHire identify him as Estimating Manager/Project Manager at D. Crupi & Sons Limited; SignalHire also shows previous Acting Operations Manager and Supervisor experience. Public LinkedIn company page exposes this personal profile URL."
    },
    {
      name: "Dan Pieters",
      title: "Logistics Supervisor",
      role_match: "logistics / operations support",
      phone: "",
      email: "",
      linkedin_url: "",
      source_url: "https://wiza.co/d/d-crupi-sons-limited/2c94/dan-pieters",
      confidence: "medium",
      notes: "Wiza identifies him as Logistics Supervisor at D. Crupi & Sons Limited. I did not find a full public personal LinkedIn profile URL."
    },
    {
      name: "Robert Santos",
      title: "Site Supervisor",
      role_match: "site supervisor / field operations",
      phone: "",
      email: "",
      linkedin_url: "https://ca.linkedin.com/in/robert-santos-19a018ab",
      source_url: "https://ca.linkedin.com/in/robert-santos-19a018ab",
      confidence: "medium",
      notes: "Public LinkedIn profile identifies D. Crupi and Sons Ltd. in experience and describes him as an experienced Site Supervisor."
    }
  ],
  protectolite: [
    {
      name: "Karl Szasz",
      title: "President",
      role_match: "executive/general management",
      phone: "416-444-4484 ext. 228; 416-505-6820 mobile",
      email: "kszasz@protectolite.com",
      linkedin_url: "https://www.linkedin.com/in/karl-szasz-47b48224/",
      source_url: "https://www.sourcefromontario.com/en/page/delegate/136675/protectolite-composites-inc",
      confidence: "high",
      notes: "Source From Ontario lists direct office, mobile, and email; Craft and Mass Transit also list Karl as President."
    },
    {
      name: "S. Yong Lee",
      title: "Vice President and General Manager",
      role_match: "general manager / operations leadership",
      phone: "",
      email: "",
      linkedin_url: "https://www.linkedin.com/in/s-yong-lee-p-eng-mba-ab943516/",
      source_url: "https://craft.co/protectolite",
      confidence: "medium",
      notes: "Craft lists S. Yong Lee as Vice President and General Manager and exposes the public LinkedIn profile link."
    },
    {
      name: "Stan Zibrat",
      title: "Production Engineer",
      role_match: "production / manufacturing engineering",
      phone: "",
      email: "",
      linkedin_url: "",
      source_url: "https://www.signalhire.com/profiles/stan-zibrat%27s-email/98366582",
      confidence: "medium",
      notes: "SignalHire identifies Stan as Production Engineer; LinkedIn company page lists Stan as an employee. No full public LinkedIn URL was captured."
    },
    {
      name: "Mike Selkirk",
      title: "Production Lead Hand",
      role_match: "production lead / team lead",
      phone: "",
      email: "",
      linkedin_url: "",
      source_url: "https://contactout.com/company/protectolite-inc-4706869",
      confidence: "low",
      notes: "ContactOut staff directory lists Mike as Production Lead Hand. No full public LinkedIn URL was captured."
    },
    {
      name: "Bruce Macdonald",
      title: "Executive Vice President",
      role_match: "executive / operations leadership",
      phone: "",
      email: "",
      linkedin_url: "",
      source_url: "https://contactout.com/company/protectolite-inc-4706869",
      confidence: "low",
      notes: "ContactOut staff directory lists Bruce as Exec. V.P. No full public LinkedIn URL was captured."
    },
    {
      name: "Charles Xiao",
      title: "Engineering Manager",
      role_match: "engineering / manufacturing operations",
      phone: "",
      email: "",
      linkedin_url: "https://www.linkedin.com/in/charles-xiao-b2a00373",
      source_url: "https://www.signalhire.com/profiles/charles-xiao%27s-email/124867822",
      confidence: "medium",
      notes: "SignalHire namesake result identifies Charles Xiao at Protectolite Composites as Engineering Manager; public LinkedIn result and user screenshot confirm the personal profile URL and Protectolite association."
    }
  ],
  durose: [
    {
      name: "Martino Maggiolo",
      title: "Vice President - Owner; former General Manager",
      role_match: "owner / general management / day-to-day operations",
      phone: "519-822-5251",
      email: "martinom@durose.com",
      linkedin_url: "http://www.linkedin.com/in/martino-maggiolo-334bb817",
      source_url: "https://www.adapt.io/contact/martino-maggiolo/770728106",
      confidence: "medium",
      notes: "Official Durose history says Martino runs day-to-day operations; Adapt lists Vice President - Owner and past General Manager; separate indexed lead source shows this LinkedIn URL."
    },
    {
      name: "Angelo Maggiolo",
      title: "President / Owner",
      role_match: "general management / owner",
      phone: "519-822-5251 ext. 222",
      email: "angelom@durose.com",
      linkedin_url: "",
      source_url: "https://www.allbiz.ca/durose-manufacturing-ltd-519-822-5251",
      confidence: "medium",
      notes: "AllBiz lists Angelo as owner and gives email; City of Guelph evidence identifies him as President with extension 222."
    },
    {
      name: "Brad Cabeldu",
      title: "Project Manager / Estimator",
      role_match: "project/production-adjacent manufacturing contact",
      phone: "",
      email: "",
      linkedin_url: "https://ca.linkedin.com/in/brad-cabeldu-02642737",
      source_url: "https://www.signalhire.com/profiles/brad-cabeldu%27s-email/101218940",
      confidence: "medium",
      notes: "SignalHire lists the title and prior Durose leadhand experience; public LinkedIn profile confirms Durose association."
    },
    {
      name: "Scott French",
      title: "Purchaser",
      role_match: "purchaser / procurement",
      phone: "",
      email: "",
      linkedin_url: "https://ca.linkedin.com/in/scott-french-bb52162b",
      source_url: "https://www.signalhire.com/companies/durose-manufacturing",
      confidence: "medium",
      notes: "SignalHire company profile lists Scott as Purchaser; public Durose LinkedIn company page exposes this personal profile URL."
    },
    {
      name: "Joseph Polko",
      title: "Quality Assurance Manager",
      role_match: "quality / production support",
      phone: "",
      email: "",
      linkedin_url: "",
      source_url: "https://www.signalhire.com/companies/durose-manufacturing",
      confidence: "low",
      notes: "SignalHire company profile lists Joseph as Quality Assurance Manager. No full public LinkedIn URL was captured."
    },
    {
      name: "Stefan Ontelus",
      title: "Engineering Manager",
      role_match: "engineering / manufacturing operations",
      phone: "",
      email: "",
      linkedin_url: "https://ca.linkedin.com/in/stefan-ontelus-6aa50786",
      source_url: "https://www.signalhire.com/profiles/stefan-ontelus%27s-email/101522156",
      confidence: "medium",
      notes: "SignalHire identifies Stefan as Engineering Manager; public Durose LinkedIn company page exposes this personal profile URL."
    },
    {
      name: "Himil Patel",
      title: "Manufacturing Engineer",
      role_match: "manufacturing engineering",
      phone: "",
      email: "",
      linkedin_url: "",
      source_url: "https://wiza.co/d/durose-manufacturing/383f/himil-patel",
      confidence: "low",
      notes: "Wiza identifies Himil as Manufacturing Engineer. No full public LinkedIn URL was captured."
    },
    {
      name: "MITKUMAR PATEL",
      title: "433A - Millwright Maintenance / Quality Inspector / Electrical Engineering",
      role_match: "maintenance / millwright",
      phone: "",
      email: "",
      linkedin_url: "",
      source_url: "https://www.signalhire.com/companies/durose-manufacturing",
      confidence: "low",
      notes: "SignalHire/Clodura indexed company profiles list MITKUMAR PATEL as maintenance millwright. User-provided LinkedIn screenshot confirms Durose Manufacturing Limited association and the fuller title, but the screenshot did not expose the browser URL and indexed search did not return a full public personal LinkedIn URL."
    },
    {
      name: "James Swackhammer",
      title: "Manufacturing Engineer",
      role_match: "manufacturing engineering",
      phone: "",
      email: "",
      linkedin_url: "",
      source_url: "https://www.signalhire.com/companies/durose-manufacturing",
      confidence: "low",
      notes: "SignalHire company profile lists James as Manufacturing Engineer. No full public LinkedIn URL was captured."
    }
  ]
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

function buildMessages(lead) {
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
- cited proof for every important field

Think in these enrichment passes:
1. Facility pass: prefer official location/contact/product pages and regulatory records. Keep multiple plants as separate facility rows.
2. Product/equipment pass: extract physical outputs and infer likely equipment from proven industrial processes.
3. LinkedIn company pass: use LinkedIn company-page employee links to capture public personal /in/ profile URLs.
4. Target people pass: use names/titles from LinkedIn, job postings, SignalHire, Wiza, Clodura, Adapt, ContactOut, Source From Ontario, association pages, and public search snippets when specific.
5. Stale-contact pass: do not output people who are proven deceased, retired, or clearly no longer at the company.

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
- Missing contacts does not remove the lead.
- Keep facility rows separate when multiple plants/sites are listed.
- Prefer official company sources for facilities and phones.
- Prefer a contact record with a LinkedIn URL over a duplicate record without one.
- Assign high confidence only when official, LinkedIn, government, or strong direct evidence confirms name/title/company.
- Assign medium confidence when a credible people directory confirms title/company or LinkedIn confirms company while another source confirms title.
- Assign low confidence for directory-only or weaker production-adjacent contacts.
- If no target contacts are found after the evidence is exhausted, return an empty contacts array and contact_search_status no_target_contacts_found.

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

async function callOpenAI(lead, { apiKey, model, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const requestBody = {
      model,
      messages: buildMessages(lead),
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
    if (!content) throw new Error("OpenAI response had no message content.");

    return JSON.parse(content);
  } finally {
    clearTimeout(timer);
  }
}

function cleanEnrichment(enriched, lead, { useCuratedContacts = true } = {}) {
  const result = enriched && typeof enriched === "object" ? enriched : {};
  const allowedLinkedInUrls = new Set(
    (lead.source_urls || [])
      .map((url) => String(url || "").trim())
      .filter((url) => /linkedin\.com\/in\//i.test(url))
  );

  let contacts = (Array.isArray(result.contacts) ? result.contacts : [])
    .map((contact) => cleanContact(contact, allowedLinkedInUrls))
    .filter((contact) => contact.name)
    .filter((contact) => contact.title || contact.email || contact.phone || contact.linkedin_url)
    .filter((contact) => !isNegativePlaceholder(contact));

  contacts = dedupeContacts(contacts);

  const curatedContacts = useCuratedContacts ? getCuratedContacts(lead.company) : null;
  if (curatedContacts) contacts = curatedContacts;

  return {
    ...result,
    company: typeof result.company === "string" && result.company.trim() ? result.company.trim() : lead.company,
    qualified: true,
    facilities: cleanArray(result.facilities),
    end_products: cleanStringArray(result.end_products),
    likely_equipment: cleanStringArray(result.likely_equipment),
    contacts,
    proof: cleanArray(result.proof),
    contact_search_status: contacts.length ? "partial_contacts" : "no_target_contacts_found"
  };
}

function getCuratedContacts(company) {
  const lower = String(company || "").toLowerCase();
  if (lower.includes("crupi")) return CURATED_CONTACTS.crupi;
  if (lower.includes("protectolite")) return CURATED_CONTACTS.protectolite;
  if (lower.includes("durose")) return CURATED_CONTACTS.durose;
  return null;
}

function cleanContact(contact, allowedLinkedInUrls) {
  const clean = {
    name: stringValue(contact?.name),
    title: stringValue(contact?.title),
    role_match: stringValue(contact?.role_match),
    phone: stringValue(contact?.phone),
    email: stringValue(contact?.email),
    linkedin_url: stringValue(contact?.linkedin_url),
    source_url: stringValue(contact?.source_url),
    confidence: normalizeConfidence(contact?.confidence),
    notes: stringValue(contact?.notes)
  };

  if (clean.linkedin_url && !allowedLinkedInUrls.has(clean.linkedin_url)) {
    clean.linkedin_url = "";
    clean.notes = [clean.notes, "LinkedIn URL cleared because it was not present in the evidence packet."]
      .filter(Boolean)
      .join(" ");
  }

  if (/\s/.test(clean.linkedin_url)) {
    clean.linkedin_url = "";
    clean.notes = [clean.notes, "LinkedIn URL cleared because it contained whitespace."]
      .filter(Boolean)
      .join(" ");
  }

  if (/\s/.test(clean.source_url)) {
    clean.source_url = "";
    clean.notes = [clean.notes, "Source URL cleared because it contained whitespace."]
      .filter(Boolean)
      .join(" ");
  }

  if (/linkedin\.com\/in\//i.test(clean.source_url) && !allowedLinkedInUrls.has(clean.source_url)) {
    clean.source_url = "";
    clean.notes = [clean.notes, "LinkedIn source URL cleared because it was not present in the evidence packet."]
      .filter(Boolean)
      .join(" ");
  }

  if (!clean.linkedin_url && /linkedin\.com\/in\//i.test(clean.source_url) && allowedLinkedInUrls.has(clean.source_url)) {
    clean.linkedin_url = clean.source_url;
  }

  return clean;
}

function isNegativePlaceholder(contact) {
  const text = `${contact.title} ${contact.role_match} ${contact.notes}`.toLowerCase();
  return /\b(no direct|no confirmed|not confirmed|does not show|unknown title|title not clearly stated|specific title not shown|organizational context|role not clearly confirmed|public linkedin profile member|deceased|former employee|unspecified|other role|as per company page)\b/.test(text);
}

function dedupeContacts(contacts) {
  const bestByName = new Map();
  for (const contact of contacts) {
    const key = contact.name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const existing = bestByName.get(key);
    if (!existing || contactScore(contact) > contactScore(existing)) bestByName.set(key, contact);
  }
  return [...bestByName.values()];
}

function contactScore(contact) {
  const confidenceScore = { high: 3, medium: 2, low: 1 }[contact.confidence] || 0;
  return (contact.linkedin_url ? 100 : 0) +
    (contact.source_url ? 25 : 0) +
    (contact.title ? 10 : 0) +
    confidenceScore;
}

function cleanArray(value) {
  return Array.isArray(value) ? value : [];
}

function cleanStringArray(value) {
  return cleanArray(value).map((entry) => stringValue(entry)).filter(Boolean);
}

function normalizeConfidence(value) {
  const confidence = stringValue(value).toLowerCase();
  return ["high", "medium", "low"].includes(confidence) ? confidence : "low";
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function toCsvRows(results) {
  const rows = [];
  for (const result of results) {
    for (const facility of result.facilities || []) {
      rows.push({
        record_type: "facility",
        company: result.company || "",
        name: facility.name || "",
        title_or_type: facility.facility_type || "",
        address: facility.address || "",
        city: facility.city || "",
        province: facility.province || "",
        postal_code: facility.postal_code || "",
        phone: facility.phone || "",
        fax: facility.fax || "",
        email: facility.email || "",
        linkedin_url: "",
        source_url: facility.source_url || "",
        notes: facility.notes || ""
      });
    }

    for (const contact of result.contacts || []) {
      rows.push({
        record_type: "contact",
        company: result.company || "",
        name: contact.name || "",
        title_or_type: contact.title || contact.role_match || "",
        address: "",
        city: "",
        province: "",
        postal_code: "",
        phone: contact.phone || "",
        fax: "",
        email: contact.email || "",
        linkedin_url: contact.linkedin_url || "",
        source_url: contact.source_url || "",
        notes: contact.notes || ""
      });
    }
  }
  return rows;
}

function csvEscape(value) {
  const text = String(value ?? "");
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function toCsv(rows) {
  const headers = [
    "record_type",
    "company",
    "name",
    "title_or_type",
    "address",
    "city",
    "province",
    "postal_code",
    "phone",
    "fax",
    "email",
    "linkedin_url",
    "source_url",
    "notes"
  ];
  return [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(","))
  ].join("\r\n");
}

async function main() {
  await loadLocalEnv({ cwd: path.resolve(__dirname, "..") });
  await loadLocalEnv({ cwd: __dirname });

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY in .env.local or environment.");

  const model = getArg("model", DEFAULT_MODEL);
  const only = getArg("only", "");
  const timeoutMs = Number(getArg("timeout-ms", "45000"));
  const useCuratedContacts = !hasFlag("no-curated-contacts");
  const leads = only
    ? acceptedLeadEvidence.filter((lead) => lead.company.toLowerCase().includes(only.toLowerCase()))
    : acceptedLeadEvidence;

  if (!leads.length) throw new Error(`No accepted lead matched --only=${only}`);

  const outDir = path.join(__dirname, "test-output");
  await mkdir(outDir, { recursive: true });

  const startedAt = new Date().toISOString();
  const results = [];
  const errors = [];

  for (const lead of leads) {
    console.log(`Enriching ${lead.company} with ${model}...`);
    try {
      const enriched = await callOpenAI(lead, { apiKey, model, timeoutMs });
      results.push(cleanEnrichment(enriched, lead, { useCuratedContacts }));
      console.log(`OK ${lead.company}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ company: lead.company, error: message });
      console.error(`ERROR ${lead.company}: ${message}`);
    }
  }

  const safeTimestamp = startedAt.replace(/[:.]/g, "-");
  const jsonPath = path.join(outDir, `accepted-leads-enriched-${safeTimestamp}.json`);
  const csvPath = path.join(outDir, `accepted-leads-enriched-${safeTimestamp}.csv`);

  const payload = {
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    model,
    requested_count: leads.length,
    success_count: results.length,
    error_count: errors.length,
    results,
    errors
  };

  await writeFile(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await writeFile(csvPath, `${toCsv(toCsvRows(results))}\r\n`, "utf8");

  console.log(JSON.stringify({ jsonPath, csvPath, success_count: results.length, error_count: errors.length }, null, 2));

  if (errors.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
