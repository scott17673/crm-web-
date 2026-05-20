import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { loadEnvFile } from "./env-loader.mjs";
import { createCrmClient, resolveCrmConfig } from "./crm-client.mjs";
import { extractDomainForCompany, generatePersonalCandidates } from "./email-finder.mjs";
import { readTemplateByName } from "./template-loader.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");

const DEFAULT_OPTIONS = {
  industry: "Food and Beverage",
  inactiveMonths: 4,
  cutoff: "",
  limit: 50,
  source: "activities",
  template: "",
  json: false,
  includeClosed: false
};

const STRONG_TITLE_RE = /\b(?:plant|maintenance|production|operations?|manufacturing|facility|quality|qa\b|food safety|technical services|engineering|warehouse|logistics|supply chain|procurement|purchasing|buyer|head brewer|lead brewer|brewer|brewery manager|head roaster|roaster|general manager|owner|founder|president|vice president|vp|coo|operator|supervisor|manager|millwright|mechanic)\b/i;
const BAD_TITLE_RE = /\b(?:former|retired|deceased|left|past role|not current|not verified|unverified|unknown|title not public|sales|marketing|human resources|hr\b|finance|accounting|customer service|front office|general inquiries?)\b/i;

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await loadEnvFile(path.join(__dirname, ".env"));
  await loadEnvFile(path.join(repoRoot, ".env"));
  await loadEnvFile(path.join(repoRoot, ".env.local"));

  const crm = createCrmClient(await resolveCrmConfig({ baseDir: __dirname }));
  const template = options.template ? await readTemplateByName(options.template) : null;
  if (options.template && !template) {
    throw new Error(`Template not found: ${options.template}`);
  }

  const [manufacturers, contacts, activities] = await Promise.all([
    crm.selectAll("manufacturers", {
      select: "id,company,stage,industry,last_contact,tags,signals,end_product,created_at",
      order: { column: "created_at", ascending: false }
    }),
    crm.selectAll("manufacturer_contacts", {
      select: "id,manufacturer_id,name,title,linkedin",
      order: { column: "id", ascending: true }
    }),
    crm.selectAll("activities", {
      select: "id,contact_id,contact_type,type,date,note,created_by",
      order: { column: "date", ascending: false }
    })
  ]);

  const contactsByManufacturer = groupBy(contacts, (contact) => String(contact.manufacturer_id));
  const realActivitiesByManufacturer = groupBy(
    activities.filter(isRealManufacturerActivity),
    (activity) => String(activity.contact_id)
  );

  const cutoff = options.cutoff || monthsAgoDate(options.inactiveMonths);
  const eligibleCompanies = manufacturers
    .filter((row) => sameText(row.industry, options.industry))
    .filter((row) => options.includeClosed || !isClosedStage(row.stage))
    .filter((row) => passesLeadQualityGate(row, options.industry))
    .map((row) => {
      const realActivityDate = latestDate(realActivitiesByManufacturer.get(String(row.id)) || []);
      const visibleLastContact = cleanDate(row.last_contact);
      return {
        row,
        realActivityDate,
        visibleLastContact,
        comparisonDate: comparisonDateForSource(options.source, realActivityDate, visibleLastContact)
      };
    })
    .filter((entry) => !entry.comparisonDate || entry.comparisonDate < cutoff)
    .sort((a, b) => String(a.comparisonDate || "").localeCompare(String(b.comparisonDate || "")) || String(a.row.company || "").localeCompare(String(b.row.company || "")));

  const planned = eligibleCompanies.slice(0, options.limit).map((entry) => {
    const companyContacts = (contactsByManufacturer.get(String(entry.row.id)) || [])
      .filter(isUsableOutreachContact)
      .sort((a, b) => contactScore(b) - contactScore(a) || String(a.name || "").localeCompare(String(b.name || "")));
    const bestContact = companyContacts[0] || null;
    const domain = extractDomainForCompany(entry.row.company, entry.row.signals, entry.row.end_product);
    const recipientCandidates = buildRecipientCandidates(bestContact, domain);
    return {
      manufacturer_id: entry.row.id,
      company: entry.row.company,
      stage: entry.row.stage,
      industry: entry.row.industry,
      visible_last_contact: entry.visibleLastContact || null,
      latest_real_activity: entry.realActivityDate || null,
      inactive_source: options.source,
      selected_contact: bestContact ? {
        id: bestContact.id,
        name: cleanText(bestContact.name),
        title: cleanText(bestContact.title),
        linkedin: cleanText(bestContact.linkedin),
        score: contactScore(bestContact)
      } : null,
      contact_count: companyContacts.length,
      domain: domain || null,
      recipient_candidates: recipientCandidates,
      needs_domain_search: !domain,
      needs_contact_search: !bestContact
    };
  });

  const payload = {
    generated_at: new Date().toISOString(),
    cutoff,
    options,
    template: template ? { name: template.name, subject: template.subject } : null,
    totals: {
      manufacturers: manufacturers.length,
      contacts: contacts.length,
      activities: activities.length,
      eligibleCompanies: eligibleCompanies.length,
      planned: planned.length,
      plannedWithNamedContact: planned.filter((row) => row.selected_contact).length,
      plannedWithDomain: planned.filter((row) => row.domain).length
    },
    planned
  };

  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    printTextSummary(payload);
  }
}

function parseArgs(args) {
  const options = { ...DEFAULT_OPTIONS };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = () => args[++i] || "";
    if (arg === "--industry") options.industry = next();
    else if (arg === "--inactive-months") options.inactiveMonths = Number(next() || options.inactiveMonths);
    else if (arg === "--cutoff") options.cutoff = next();
    else if (arg === "--limit") options.limit = Number(next() || options.limit);
    else if (arg === "--source") options.source = next();
    else if (arg === "--template") options.template = next();
    else if (arg === "--json") options.json = true;
    else if (arg === "--include-closed") options.includeClosed = true;
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  if (!["activities", "last_contact", "both"].includes(options.source)) {
    throw new Error('--source must be "activities", "last_contact", or "both".');
  }
  options.limit = Math.max(1, Math.min(500, Number.isFinite(options.limit) ? options.limit : DEFAULT_OPTIONS.limit));
  options.inactiveMonths = Math.max(1, Number.isFinite(options.inactiveMonths) ? options.inactiveMonths : DEFAULT_OPTIONS.inactiveMonths);
  return options;
}

function printHelp() {
  console.log(`Usage: npm run preview -- [options]

Options:
  --industry "Food and Beverage"   CRM industry to target
  --inactive-months 4              Cutoff in whole months before today
  --cutoff YYYY-MM-DD              Exact cutoff date override
  --source activities              activities, last_contact, or both
  --template "Food short"          Existing outreach template name
  --limit 50                       Preview row limit
  --json                           Print JSON
  --include-closed                 Include closed/lost/unqualified stages`);
}

function printTextSummary(payload) {
  console.log(`Campaign preview generated ${payload.generated_at}`);
  console.log(`Industry: ${payload.options.industry}`);
  console.log(`Inactive cutoff: ${payload.cutoff} using ${payload.options.source}`);
  if (payload.template) console.log(`Template: ${payload.template.name}`);
  console.log(`Eligible companies: ${payload.totals.eligibleCompanies}; showing ${payload.totals.planned}`);
  console.log(`Named contacts: ${payload.totals.plannedWithNamedContact}/${payload.totals.planned}; domains found: ${payload.totals.plannedWithDomain}/${payload.totals.planned}`);
  console.log("");
  for (const row of payload.planned) {
    const contact = row.selected_contact ? `${row.selected_contact.name} (${row.selected_contact.title || "no title"})` : "no named contact";
    const recipients = row.recipient_candidates.length ? row.recipient_candidates.join(", ") : "needs domain/contact search";
    console.log(`${row.company} | ${row.stage || "No stage"} | real activity: ${row.latest_real_activity || "none"} | visible last: ${row.visible_last_contact || "none"}`);
    console.log(`  Contact: ${contact}`);
    console.log(`  Candidate email(s): ${recipients}`);
  }
}

function monthsAgoDate(months) {
  const date = new Date();
  date.setMonth(date.getMonth() - months);
  return formatDate(date);
}

function formatDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function latestDate(rows) {
  return rows.map((row) => cleanDate(row.date)).filter(Boolean).sort().at(-1) || "";
}

function cleanDate(value) {
  const text = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
}

function comparisonDateForSource(source, realActivityDate, visibleLastContact) {
  if (source === "last_contact") return visibleLastContact;
  if (source === "both") return [realActivityDate, visibleLastContact].filter(Boolean).sort().at(-1) || "";
  return realActivityDate;
}

function isRealManufacturerActivity(row) {
  return String(row?.contact_type || "manufacturer") === "manufacturer" &&
    !isTaskActivity(row) &&
    !isAskFeedbackActivity(row);
}

function isTaskActivity(row) {
  const raw = String(row?.created_by || "").trim();
  return raw === "__task_open" || raw === "__task_done" || raw.startsWith("__task__|");
}

function isAskFeedbackActivity(row) {
  return String(row?.contact_type || "").trim() === "__ask_feedback__";
}

function looksLikePersonName(value) {
  const text = cleanText(value);
  if (!/^[A-Z][A-Za-z'`.-]+(?:\s+[A-Z][A-Za-z'`.-]+){1,4}$/.test(text)) return false;
  return !/\b(?:team|department|office|staff|contact|info|sales|support|company|inc|ltd|limited|corp|corporation|operations|plant|facility|personnel|public|provided|products?|services?)\b/i.test(text);
}

function isUsableOutreachContact(contact) {
  return looksLikePersonName(contact?.name) && !BAD_TITLE_RE.test(cleanText(contact?.title));
}

function contactScore(contact) {
  const title = cleanText(contact?.title);
  let score = 0;
  if (STRONG_TITLE_RE.test(title)) score += 20;
  if (/\b(?:manager|supervisor|director|lead|chief|head)\b/i.test(title)) score += 5;
  if (BAD_TITLE_RE.test(title)) score -= 20;
  if (contact?.linkedin) score += 2;
  return score;
}

function buildRecipientCandidates(contact, domain) {
  if (!domain) return [];
  if (contact?.name) {
    const personal = generatePersonalCandidates(contact.name, domain);
    if (personal.length) return personal;
  }
  return [`info@${domain}`];
}

function groupBy(rows, keyFn) {
  const map = new Map();
  for (const row of rows || []) {
    const key = keyFn(row);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
}

function sameText(left, right) {
  return cleanText(left).toLowerCase() === cleanText(right).toLowerCase();
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function isClosedStage(stage) {
  return /\b(?:closed|lost|unqualified|do not|duplicate|needs products)\b/i.test(cleanText(stage));
}

function passesLeadQualityGate(row, industry) {
  const company = cleanText(row?.company);
  if (!company || company.length < 2) return false;
  if (/^[-\s]+/.test(company)) return false;
  if (/^(?:about|home|homepage|contact|contact us|products?|services?|locations?|careers?|shop|store)\b/i.test(company)) return false;
  if (/\.[a-z]{2,}(?:\b|$)/i.test(company)) return false;
  if (/\b(?:concrete|sawing|drilling|asphalt|aggregate|metal|steel|plastics?|packaging)\b/i.test(company)) return false;

  const text = `${company}\n${row?.stage || ""}\n${row?.signals || ""}\n${row?.end_product || ""}\n${Array.isArray(row?.tags) ? row.tags.join(" ") : row?.tags || ""}`;
  if (!sameText(industry, "Food and Beverage")) return true;

  if (/\b(?:restaurant|bistro|cafe|pub|grill|bar)\b/i.test(company) && !/\b(?:brewery|brewing|roaster|bakery|foods?|beverage)\b/i.test(company)) return false;

  const foodSignal = /\b(?:food|beverage|brewery|brewing|brewer|cider|distill|bakery|bakeries|baked|meat|poultry|dairy|cheese|coffee|roast|chocolate|candy|snack|sauce|soup|frozen|ingredient|co-?pack|bottl|cann|packag|process|production|manufactur|plant|facility)\b/i.test(text);
  if (!foodSignal) return false;

  const retailOnly = /\b(?:restaurant|bistro|cafe|pub|market|grocery|retail|storefront|caterer|catering)\b/i.test(text);
  const industrialOverride = /\b(?:plant|facility|production|processing|manufactur|brewery|brewing|bottl|cann|co-?pack|industrial|commercial bakery|roaster|packag)\b/i.test(text);
  return !retailOnly || industrialOverride;
}

main().catch((err) => {
  console.error(err.message || String(err));
  process.exit(1);
});
