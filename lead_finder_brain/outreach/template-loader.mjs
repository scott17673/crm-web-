import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const templatesDir = path.join(__dirname, "templates");

export async function listTemplates() {
  let entries;
  try {
    entries = await readdir(templatesDir);
  } catch {
    return [];
  }

  const files = entries.filter((name) => name.toLowerCase().endsWith(".txt")).sort();
  const templates = [];
  for (const file of files) {
    const parsed = await readTemplate(file).catch(() => null);
    if (parsed) templates.push(parsed);
  }
  return templates;
}

export async function readTemplateByName(name) {
  const all = await listTemplates();
  return all.find((t) => t.name === name) || null;
}

async function readTemplate(filename) {
  const full = path.join(templatesDir, filename);
  const raw = await readFile(full, "utf8");
  return parseTemplate(raw, filename);
}

export function parseTemplate(raw, filename = "") {
  const text = String(raw || "").replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n")) {
    return { filename, name: filename || "(unnamed)", category: "", subject: "", body: text.trim() };
  }
  const end = text.indexOf("\n---\n", 4);
  if (end < 0) {
    return { filename, name: filename || "(unnamed)", category: "", subject: "", body: text.trim() };
  }
  const front = text.slice(4, end);
  const body = text.slice(end + 5);
  const meta = parseFrontmatter(front);
  return {
    filename,
    name: meta.name || filename,
    category: meta.category || "",
    subject: meta.subject || "",
    body: body.replace(/^\n+/, "").replace(/\s+$/, "")
  };
}

function parseFrontmatter(block) {
  const out = {};
  for (const line of block.split("\n")) {
    const eq = line.indexOf(":");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    const value = line.slice(eq + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

export function renderTemplate(template, vars) {
  const replace = (text) => String(text || "").replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => {
    const v = vars[key];
    return v === undefined || v === null ? "" : String(v);
  });

  const subject = replace(template.subject || "").trim() || `Hi ${vars.first_name || vars.contact_name || ""}`.trim();
  const body = replace(template.body || "");
  return { subject, body };
}
