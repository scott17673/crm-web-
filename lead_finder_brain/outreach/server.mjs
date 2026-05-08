import { createReadStream } from "node:fs";
import { access, stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { loadEnvFile } from "./env-loader.mjs";
import { createCrmClient, resolveCrmConfig } from "./crm-client.mjs";
import { listTemplates, readTemplateByName } from "./template-loader.mjs";
import { buildMailerConfig, createMailer } from "./mailer.mjs";
import { runOutreach } from "./outreach-runner.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const webRoot = path.join(__dirname, "web");

await loadEnvFile(path.join(__dirname, ".env"));
await loadEnvFile(path.join(repoRoot, ".env"));
await loadEnvFile(path.join(repoRoot, ".env.local"));

const host = String(process.env.OUTREACH_HOST || "127.0.0.1").trim() || "127.0.0.1";
const port = Number(process.env.OUTREACH_PORT || 8781);

const CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8"
};

let crm;
let mailerConfig;
let setupErrorMessage = "";

try {
  const config = await resolveCrmConfig({ baseDir: __dirname });
  crm = createCrmClient(config);
} catch (err) {
  setupErrorMessage = `CRM setup failed: ${err.message || err}`;
  console.error(setupErrorMessage);
}

try {
  mailerConfig = buildMailerConfig();
} catch (err) {
  setupErrorMessage = setupErrorMessage || `Mailer config error: ${err.message || err}`;
  console.error(`Mailer config error: ${err.message || err}`);
}

let preflightStatus = { smtp: "unknown", imap: "unknown", error: setupErrorMessage };
if (mailerConfig && !setupErrorMessage) {
  try {
    const probe = createMailer(mailerConfig);
    await probe.verify();
    probe.close();
    preflightStatus = { smtp: "ready", imap: "ready", error: "" };
    console.log("SMTP and IMAP preflight OK.");
  } catch (err) {
    preflightStatus = {
      smtp: err.code === "SMTP_SETUP_ERROR" ? "failed" : (err.code === "IMAP_SETUP_ERROR" ? "ready" : "failed"),
      imap: err.code === "IMAP_SETUP_ERROR" ? "failed" : (err.code === "SMTP_SETUP_ERROR" ? "unknown" : "failed"),
      error: err.message || String(err)
    };
    setupErrorMessage = preflightStatus.error;
    console.error(`Preflight failed: ${preflightStatus.error}`);
  }
}

createServer(async (req, res) => {
  const requestUrl = new URL(req.url || "/", `http://${host}:${port}`);

  try {
    if (requestUrl.pathname === "/api/status" && req.method === "GET") {
      return sendJson(res, 200, {
        preflight: preflightStatus,
        sender: mailerConfig?.sender || null,
        dailyLimit: Number(process.env.DAILY_SEND_LIMIT || 30)
      });
    }

    if (requestUrl.pathname === "/api/templates" && req.method === "GET") {
      const templates = await listTemplates();
      return sendJson(res, 200, { templates });
    }

    if (requestUrl.pathname === "/api/contacts" && req.method === "GET") {
      if (!crm) return sendJson(res, 500, { error: setupErrorMessage || "CRM not configured." });
      const contacts = await loadEligibleContacts(crm);
      return sendJson(res, 200, { contacts });
    }

    if (requestUrl.pathname === "/api/send" && req.method === "POST") {
      if (!crm) return sendJson(res, 500, { error: setupErrorMessage || "CRM not configured." });
      if (!mailerConfig) return sendJson(res, 500, { error: setupErrorMessage || "Mailer not configured." });
      if (preflightStatus.error) return sendJson(res, 500, { error: preflightStatus.error });
      return handleSend(req, res);
    }

    return serveStatic(res, requestUrl.pathname);
  } catch (err) {
    console.error("Request failed:", err);
    return sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}).listen(port, host, () => {
  console.log(`Outreach UI on http://${host}:${port}`);
});

async function handleSend(req, res) {
  const body = await readJsonBody(req);
  const contactId = body.contact_id;
  const templateName = String(body.template_name || "").trim();

  if (!contactId) return sendJson(res, 400, { error: "contact_id required." });
  if (!templateName) return sendJson(res, 400, { error: "template_name required." });

  const template = await readTemplateByName(templateName);
  if (!template) return sendJson(res, 404, { error: `Template not found: ${templateName}` });
  if (!String(template.body || "").trim()) return sendJson(res, 400, { error: `Template "${templateName}" has empty body.` });

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });

  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const heartbeat = setInterval(() => {
    res.write(": ping\n\n");
  }, 20_000);

  let mailer;
  try {
    mailer = createMailer(mailerConfig);
    await runOutreach({
      contactId,
      template,
      crm,
      mailer,
      env: process.env,
      emit: (msg) => {
        if (msg.type === "log") send("log", { line: msg.text });
        if (msg.type === "done") send("done", msg.payload);
      }
    });
  } catch (err) {
    send("error", { message: err.message || String(err) });
  } finally {
    clearInterval(heartbeat);
    try { mailer?.close(); } catch { /* ignore */ }
    res.end();
  }
}

async function loadEligibleContacts(crm) {
  const [contacts, manufacturers, activities] = await Promise.all([
    crm.select("manufacturer_contacts", { select: "id,manufacturer_id,name,title,linkedin", limit: 5000 }),
    crm.select("manufacturers", { select: "id,company", limit: 5000 }),
    crm.select("activities", { select: "contact_id,contact_type,type,note", filters: { contact_type: "eq.manufacturer", type: "eq.Email" }, limit: 20000 })
  ]);

  const companyById = new Map((manufacturers || []).map((m) => [m.id, m.company || ""]));
  const sentByContactId = new Set();
  for (const row of (activities || [])) {
    if (String(row.note || "").includes("Result: sent")) sentByContactId.add(row.contact_id);
  }

  return (contacts || [])
    .filter((c) => c.name && c.manufacturer_id)
    .filter((c) => !sentByContactId.has(c.id))
    .map((c) => ({
      id: c.id,
      name: c.name,
      title: c.title || "",
      manufacturer_id: c.manufacturer_id,
      company: companyById.get(c.manufacturer_id) || ""
    }))
    .sort((a, b) => (a.company || "").localeCompare(b.company || "") || (a.name || "").localeCompare(b.name || ""));
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON body: ${text.slice(0, 120)}`);
  }
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(`${JSON.stringify(payload)}\n`);
}

async function serveStatic(res, pathname) {
  const relative = pathname === "/" ? "/index.html" : pathname;
  const resolved = path.resolve(webRoot, `.${relative}`);
  const root = path.resolve(webRoot);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    res.writeHead(403); res.end("Forbidden"); return;
  }
  try {
    await access(resolved);
    const details = await stat(resolved);
    if (!details.isFile()) { res.writeHead(404); res.end("Not found"); return; }
    res.writeHead(200, {
      "Content-Type": CONTENT_TYPES[path.extname(resolved).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    createReadStream(resolved).pipe(res);
  } catch {
    res.writeHead(404); res.end("Not found");
  }
}
