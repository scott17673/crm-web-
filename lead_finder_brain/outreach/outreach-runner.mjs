import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { extractDomainFromText, generatePersonalCandidates, searchDomainViaDuckDuckGo } from "./email-finder.mjs";
import { renderTemplate } from "./template-loader.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_PATH = path.join(__dirname, "log.jsonl");

const SENT_MARKER = "Result: sent";
const FAILED_MARKER = "Result: all failed";

export async function runOutreach({ contactId, template, crm, mailer, env, emit }) {
  const log = (line) => emit?.({ type: "log", text: line });

  const dailyLimit = Number(env.DAILY_SEND_LIMIT || 30);
  const todaySends = await countSendsToday();

  log(`Loading contact #${contactId}...`);
  const contact = await loadContact(crm, contactId);
  if (!contact) {
    return finish({ ok: false, error: "Contact not found." });
  }

  log(`Contact: ${contact.name} — ${contact.company}`);

  if (await contactAlreadyContacted(crm, contactId)) {
    return finish({ ok: false, error: "This contact already has a 'Result: sent' outreach activity. Skipping to avoid duplicates." });
  }

  log("Resolving company domain from notes...");
  let domain = extractDomainFromText(contact.signals, contact.endProduct);
  if (!domain && contact.company) {
    log(`No domain in notes; searching DuckDuckGo for "${contact.company}"...`);
    domain = await searchDomainViaDuckDuckGo(contact.company);
  }
  if (!domain) {
    return finish({ ok: false, error: "No domain found for this company (notes have none and DuckDuckGo had no usable result)." });
  }
  log(`Domain: ${domain}`);

  const candidates = generatePersonalCandidates(contact.name, domain);
  if (!candidates.length) {
    return finish({ ok: false, error: `Could not generate personal email candidates for "${contact.name}" @ ${domain}.` });
  }
  log(`Candidates: ${candidates.join(", ")}`);

  const senderName = String(env.SENDER_NAME || "").trim();
  const senderCompany = String(env.SENDER_COMPANY || "").trim();
  const { firstName, lastName } = splitName(contact.name);

  const rendered = renderTemplate(template, {
    first_name: firstName,
    last_name: lastName,
    contact_name: contact.name,
    company_name: contact.company,
    sender_name: senderName,
    sender_company: senderCompany
  });

  if (!rendered.body.trim()) {
    return finish({ ok: false, error: `Template "${template.name}" has an empty body.` });
  }

  log(`Subject: ${rendered.subject}`);

  const runId = `run_${Date.now().toString(36)}`;
  const results = []; // [{address, status: "seemed-sent"|"failed"|"skipped-limit"}]
  let sendsRemaining = Math.max(0, dailyLimit - todaySends);

  for (let i = 0; i < candidates.length; i++) {
    const address = candidates[i];

    if (sendsRemaining <= 0) {
      log(`Daily send limit (${dailyLimit}) reached — skipping remaining candidates.`);
      results.push({ address, status: "skipped-limit" });
      for (let j = i + 1; j < candidates.length; j++) results.push({ address: candidates[j], status: "skipped-limit" });
      break;
    }

    const tag = `${runId}:${i + 1}`;
    log(`→ Sending to ${address}...`);
    let sentAt;
    try {
      const info = await mailer.send({ to: address, subject: rendered.subject, text: rendered.body, tag });
      sentAt = info.sentAt;
    } catch (err) {
      log(`SMTP error sending to ${address}: ${err.message || err}`);
      results.push({ address, status: "failed" });
      await appendLog({ contact_id: contactId, company: contact.company, address, result: "failed", reason: "smtp-error" });
      continue;
    }

    sendsRemaining -= 1;
    await appendLog({ contact_id: contactId, company: contact.company, address, result: "sent-pending-bounce" });

    log("Waiting 45s for a bounce...");
    await sleep(45_000);

    let bounceResult;
    try {
      bounceResult = await mailer.checkBounce({ candidate: address, sentAt, tag, subject: rendered.subject });
    } catch (err) {
      log(`IMAP bounce check failed for ${address}: ${err.message || err}`);
      bounceResult = { bounced: false, error: err.message || String(err) };
    }

    if (bounceResult.bounced) {
      log(`Bounce detected for ${address}.`);
      results.push({ address, status: "failed" });
      await appendLog({ contact_id: contactId, company: contact.company, address, result: "bounced" });
    } else {
      log(`No bounce within 45s for ${address} — seemed to go through.`);
      results.push({ address, status: "seemed-sent" });
      await appendLog({ contact_id: contactId, company: contact.company, address, result: "seemed-sent" });
    }

    const isLast = i === candidates.length - 1;
    if (!isLast && sendsRemaining > 0) {
      const waitMs = randomBetween(60_000, 120_000);
      log(`Waiting ${Math.round(waitMs / 1000)}s before next attempt...`);
      await sleep(waitMs);
    }
  }

  const summary = buildSummary({
    template,
    results,
    candidatesAttempted: results.filter((r) => r.status !== "skipped-limit").map((r) => r.address)
  });

  log("Writing summary to CRM...");
  try {
    await crm.insert("activities", [{
      contact_id: contactId,
      contact_type: "manufacturer",
      type: "Email",
      date: todayDateString(),
      created_by: senderName || env.SMTP_USER || null,
      note: summary.note
    }]);
  } catch (err) {
    log(`CRM activity insert failed: ${err.message || err}`);
    return finish({ ok: false, error: `Run completed but CRM write failed: ${err.message || err}`, summary });
  }

  return finish({ ok: true, summary });

  function finish(payload) {
    emit?.({ type: "done", payload });
    return payload;
  }
}

async function loadContact(crm, contactId) {
  const contacts = await crm.select("manufacturer_contacts", {
    select: "id,manufacturer_id,name,title,linkedin",
    filters: { id: `eq.${contactId}` },
    limit: 1
  });
  const contact = (contacts || [])[0];
  if (!contact) return null;

  const manufacturers = await crm.select("manufacturers", {
    select: "id,company,signals,end_product",
    filters: { id: `eq.${contact.manufacturer_id}` },
    limit: 1
  });
  const manufacturer = (manufacturers || [])[0];

  return {
    id: contact.id,
    manufacturerId: contact.manufacturer_id,
    name: contact.name || "",
    title: contact.title || "",
    company: manufacturer?.company || "",
    signals: manufacturer?.signals || "",
    endProduct: manufacturer?.end_product || ""
  };
}

async function contactAlreadyContacted(crm, contactId) {
  const rows = await crm.select("activities", {
    select: "id,note",
    filters: { contact_id: `eq.${contactId}`, contact_type: "eq.manufacturer", type: "eq.Email" },
    limit: 100
  });
  return (rows || []).some((row) => String(row.note || "").includes(SENT_MARKER));
}

function buildSummary({ template, results, candidatesAttempted }) {
  const seemed = results.filter((r) => r.status === "seemed-sent").map((r) => r.address);
  const failed = results.filter((r) => r.status === "failed").map((r) => r.address);

  const lines = [];
  lines.push(formatStamp(new Date()));
  lines.push(`Template: ${template.name}`);

  if (seemed.length) {
    lines.push("Result: sent");
    lines.push(`Emails that seemed to go through: ${seemed.join(", ")}`);
    if (failed.length) lines.push(`Failed: ${failed.join(", ")}`);
  } else if (candidatesAttempted.length) {
    lines.push("Result: all failed");
    lines.push(`Emails tried: ${candidatesAttempted.join(", ")}`);
  } else {
    lines.push("Result: nothing sent (daily limit or empty candidate list)");
  }

  return { note: lines.join("\n"), seemed, failed, candidatesAttempted };
}

function formatStamp(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  let hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const period = hours >= 12 ? "PM" : "AM";
  hours = hours % 12 || 12;
  return `${y}-${m}-${d} ${hours}:${minutes} ${period}`;
}

function todayDateString() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function splitName(fullName) {
  const parts = String(fullName || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { firstName: "", lastName: "" };
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  return { firstName: parts[0], lastName: parts[parts.length - 1] };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomBetween(min, max) {
  return Math.floor(min + Math.random() * (max - min));
}

async function appendLog(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
  try {
    await appendFile(LOG_PATH, line, "utf8");
  } catch {
    // best-effort; not fatal
  }
}

async function countSendsToday() {
  let text;
  try {
    text = await readFile(LOG_PATH, "utf8");
  } catch {
    return 0;
  }
  const today = todayDateString();
  let count = 0;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    let entry;
    try { entry = JSON.parse(raw); } catch { continue; }
    if (!entry?.ts) continue;
    if (!String(entry.ts).startsWith(today)) continue;
    if (entry.result === "smtp-error") continue;
    count += 1;
  }
  return count;
}

export const __test__ = { buildSummary, splitName, formatStamp };
