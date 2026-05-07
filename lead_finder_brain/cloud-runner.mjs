import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { OUTPUT_COLUMNS } from "./find-manufacturers.mjs";
import { loadLocalEnv } from "./plant-verifier.mjs";
import { parseCsv } from "./runtime_lib/csv.mjs";
import { DEFAULT_INDUSTRY_IDS, INDUSTRY_PRESETS } from "./runtime_lib/industries.mjs";
import { NEARBY_CITIES } from "./runtime_lib/nearby-cities.mjs";

const REMOTE_STATE_COMMAND_ID = "00000000-0000-4000-8000-000000000879";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

await loadLocalEnv({ cwd: repoRoot });

const startedAt = new Date().toISOString();
const outputPath = resolvePath(getSetting("out", "lead_finder_brain/output/github-cloud-manufacturers.csv"));
const progressPath = resolvePath(getSetting("progress-out", "lead_finder_brain/output/github-cloud-live.csv"));
const crmConfigPath = resolvePath(getSetting("crm-config", "crm-config.js"));
const cityLimit = toNumber(getSetting("city-limit", "6"), 6);
const explicitCities = parseDelimited(getSetting("cities", ""));
const activeCities = explicitCities.length ? explicitCities : NEARBY_CITIES.slice(0, cityLimit);

const settings = {
  enabled: true,
  autoRun: true,
  existingCsvPath: "",
  crmConfigPath,
  province: getSetting("province", "Ontario"),
  cityLimit,
  resultsPerQuery: toNumber(getSetting("results-per-query", "3"), 3),
  websitePageLimit: toNumber(getSetting("website-page-limit", "2"), 2),
  searchDelayMs: toNumber(getSetting("search-delay-ms", "250"), 250),
  minEmployees: toNumber(getSetting("min-employees", "10"), 10),
  citiesText: activeCities.join("\n"),
  industries: parseDelimited(getSetting("industries", DEFAULT_INDUSTRY_IDS.join("|"))),
  outputName: path.basename(outputPath),
  progressName: path.basename(progressPath),
  verifierModel: getSetting("verifier-model", process.env.PLANT_VERIFIER_MODEL || "gpt-5-nano"),
  enrichmentModel: getSetting("enrichment-model", process.env.PLANT_ENRICHMENT_MODEL || process.env.PLANT_VERIFIER_MODEL || "gpt-5-nano"),
  cloudAutoRun: process.env.CLOUD_AUTORUN === "true" || process.argv.includes("--cloud-autorun")
};

const runtime = {
  running: true,
  cycleRunning: true,
  enabled: true,
  pid: null,
  startedAt,
  finishedAt: "",
  nextRunAt: "",
  exitCode: null,
  currentPhase: "Starting",
  currentQuery: "",
  currentCompany: "",
  currentCity: "",
  readyCount: 0,
  partialCount: 0,
  keptCount: 0,
  summary: "GitHub cloud run starting.",
  currentCsvUrl: "",
  finalCsvUrl: "",
  keepAwake: false,
  runner: "GitHub Cloud",
  lastProgressAt: startedAt,
  watchdogMs: 0,
  watchdogRestarts: 0
};

const progress = {
  checked: 0,
  skipped: 0,
  added: 0,
  lastDecision: "",
  currentPhase: "",
  currentQuery: "",
  currentCompany: "",
  currentCity: "",
  topSkipReason: "",
  topSkipReasonCount: 0
};

const skipReasons = new Map();
const logs = ["GitHub cloud runner starting."];
let publishTimer = null;
let stopping = false;

await mkdir(path.dirname(outputPath), { recursive: true });
await mkdir(path.dirname(progressPath), { recursive: true });
await publishState();

if (!process.env.OPENAI_API_KEY) {
  pushLog("Missing OPENAI_API_KEY GitHub secret. Cloud run cannot call OpenAI.");
  runtime.running = false;
  runtime.cycleRunning = false;
  runtime.finishedAt = new Date().toISOString();
  runtime.exitCode = 1;
  runtime.summary = "GitHub cloud run failed: missing OPENAI_API_KEY secret.";
  await publishState();
  process.exit(1);
}

const args = [
  "find-manufacturers.mjs",
  "--crm-config", crmConfigPath,
  "--out", outputPath,
  "--progress-out", progressPath,
  "--province", settings.province,
  "--city-limit", String(settings.cityLimit),
  "--results-per-query", String(settings.resultsPerQuery),
  "--website-page-limit", String(settings.websitePageLimit),
  "--search-delay-ms", String(settings.searchDelayMs),
  "--min-employees", String(settings.minEmployees),
  "--industries", settings.industries.join("|"),
  "--cities", activeCities.join("|"),
  "--verifier-model", settings.verifierModel,
  "--enrichment-model", settings.enrichmentModel
];

pushLog(`Launching cloud finder with ${settings.industries.length} industry group(s), ${activeCities.length} city/cities.`);
const child = spawn(process.execPath, args, {
  cwd: __dirname,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    PLANT_VERIFIER_MODEL: settings.verifierModel,
    PLANT_ENRICHMENT_MODEL: settings.enrichmentModel,
    OPENAI_CONTACT_EXTRACT_MODEL: process.env.OPENAI_CONTACT_EXTRACT_MODEL || "gpt-5-nano",
    OPENAI_SIGNAL_EXTRACT_MODEL: process.env.OPENAI_SIGNAL_EXTRACT_MODEL || "gpt-5-nano",
    CRM_DUPLICATE_MODEL: process.env.CRM_DUPLICATE_MODEL || "gpt-5-nano"
  }
});

runtime.pid = child.pid;
publishTimer = setInterval(() => {
  void publishState().catch((error) => console.error(error instanceof Error ? error.message : String(error)));
}, 10000);
const stopPollTimer = setInterval(() => {
  void pollStopCommands().catch((error) => console.error(error instanceof Error ? error.message : String(error)));
}, 15000);

hookStream(child.stdout);
hookStream(child.stderr);

process.on("SIGTERM", () => stopChild("SIGTERM"));
process.on("SIGINT", () => stopChild("SIGINT"));

const exitCode = await new Promise((resolve) => {
  child.on("error", (error) => {
    pushLog(`Process error: ${error.message}`);
  });
  child.on("close", (code) => resolve(code ?? 0));
});

if (publishTimer) {
  clearInterval(publishTimer);
  publishTimer = null;
}
clearInterval(stopPollTimer);

const rows = await readRows();
const counts = buildStageCounts(rows);
runtime.running = false;
runtime.cycleRunning = false;
runtime.pid = null;
runtime.finishedAt = new Date().toISOString();
runtime.exitCode = exitCode;
runtime.readyCount = counts.ready;
runtime.partialCount = counts.total;
runtime.keptCount = counts.total;
runtime.summary = exitCode === 0
  ? `GitHub cloud run finished. Checked ${progress.checked} candidates and kept ${counts.total} prospect(s).`
  : `GitHub cloud run failed with exit code ${exitCode}. Checked ${progress.checked} candidates and kept ${counts.total} prospect(s).`;
pushLog(runtime.summary);
await publishState();
process.exit(exitCode);

function hookStream(stream) {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    const parts = buffer.split(/\r?\n/);
    buffer = parts.pop() || "";
    for (const line of parts) {
      handleFinderLine(line);
    }
  });
  stream.on("end", () => {
    if (buffer.trim()) {
      handleFinderLine(buffer);
    }
  });
}

function handleFinderLine(line) {
  const text = String(line || "").trimEnd();
  if (!text) return;
  pushLog(text);

  const search = text.match(/^\s*Search:\s*(.+)$/i);
  if (search) {
    setPhase("Search", { currentQuery: search[1], currentCompany: "" });
    return;
  }

  const deep = text.match(/^\s*Deep qualifying:\s*(.+)$/i);
  if (deep) {
    setPhase("Deep qualify", { currentCompany: deep[1] });
    return;
  }

  const enrichment = text.match(/^\s*Contact enrichment:\s*(.+)$/i);
  if (enrichment) {
    setPhase("Contact enrichment");
    return;
  }

  const skipped = text.match(/^\s*(?:Skipped|CRM sync skipped):\s*(.+?)(?:\s*\|\s*(.+))?$/i);
  if (skipped) {
    progress.checked += 1;
    progress.skipped += 1;
    progress.lastDecision = text;
    addSkipReason(skipped[2] || "Skipped or duplicate");
    updateSummary();
    return;
  }

  const added = text.match(/^\s*Added row\s+\d+:\s*(.+?)\s*\|/i);
  if (added) {
    progress.checked += 1;
    progress.added += 1;
    progress.lastDecision = text;
    updateSummary();
    return;
  }

  const inserted = text.match(/^\s*CRM sync:\s*inserted\s+(.+?)\s+\(/i);
  if (inserted) {
    setPhase("CRM insert", { currentCompany: inserted[1] });
  }
}

function setPhase(phase, next = {}) {
  runtime.currentPhase = phase;
  progress.currentPhase = phase;
  for (const [key, value] of Object.entries(next)) {
    runtime[key] = value;
    progress[key] = value;
  }
  runtime.currentCity = currentCityFromQuery(runtime.currentQuery);
  progress.currentCity = runtime.currentCity;
  runtime.lastProgressAt = new Date().toISOString();
  updateSummary();
}

function updateSummary() {
  runtime.summary = `GitHub cloud running. Checked ${progress.checked}, skipped ${progress.skipped}, added ${progress.added}.`;
}

function pushLog(message) {
  logs.push(message);
  while (logs.length > 300) logs.shift();
  runtime.lastProgressAt = new Date().toISOString();
}

function addSkipReason(reason) {
  const clean = cleanText(reason);
  if (!clean) return;
  skipReasons.set(clean, (skipReasons.get(clean) || 0) + 1);
  const top = Array.from(skipReasons.entries()).sort((a, b) => b[1] - a[1])[0];
  if (top) {
    progress.topSkipReason = top[0];
    progress.topSkipReasonCount = top[1];
  }
}

async function publishState() {
  const config = await loadCrmConfig();
  if (!config?.supabaseUrl || !config?.apiKey) {
    console.warn("Supabase state publish skipped: CRM config missing.");
    return;
  }

  const rows = await readRows();
  const stageCounts = buildStageCounts(rows);
  runtime.readyCount = stageCounts.ready;
  runtime.partialCount = stageCounts.total;
  runtime.keptCount = stageCounts.total;

  const state = {
    settings,
    presets: INDUSTRY_PRESETS,
    nearbyCities: NEARBY_CITIES,
    status: { ...runtime },
    logs: [...logs],
    results: {
      headers: OUTPUT_COLUMNS,
      total: rows.length,
      rows: rows.slice(0, 250),
      path: progressPath,
      progress: { ...progress },
      stageCounts
    },
    remotePublishedAt: new Date().toISOString(),
    remoteSource: "github-actions",
    cloudAutoRun: Boolean(settings.cloudAutoRun)
  };

  const baseUrl = `${config.supabaseUrl.replace(/\/+$/, "")}/rest/v1`;
  const response = await fetch(`${baseUrl}/finder_commands?on_conflict=id`, {
    method: "POST",
    headers: {
      apikey: config.apiKey,
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal"
    },
    body: JSON.stringify([{
      id: REMOTE_STATE_COMMAND_ID,
      command: "state",
      status: runtime.running ? "live" : "finished",
      settings: state
    }])
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Supabase state publish failed ${response.status}: ${text.slice(0, 300)}`);
  }
}

async function pollStopCommands() {
  if (stopping) return;
  const config = await loadCrmConfig();
  const rows = await supabaseRest(config, "/finder_commands?status=eq.pending&command=eq.stop&order=created_at.asc&limit=20");
  const stopJob = (Array.isArray(rows) ? rows : []).find((row) => row.settings?.target === "cloud" || row.settings?.target === "github-actions");
  if (!stopJob) return;
  await supabaseRest(config, `/finder_commands?id=eq.${stopJob.id}`, {
    method: "PATCH",
    body: JSON.stringify({ status: "running" })
  });
  settings.cloudAutoRun = false;
  stopChild("remote stop");
  await supabaseRest(config, `/finder_commands?id=eq.${stopJob.id}`, {
    method: "PATCH",
    body: JSON.stringify({ status: "done" })
  });
}

async function supabaseRest(config, restPath, options = {}) {
  const response = await fetch(`${config.supabaseUrl.replace(/\/+$/, "")}/rest/v1${restPath}`, {
    ...options,
    headers: {
      apikey: config.apiKey,
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`Supabase request failed ${response.status}: ${text.slice(0, 300)}`);
  }
  return data;
}

async function readRows() {
  try {
    const text = await readFile(progressPath, "utf8");
    return parseCsv(text);
  } catch {
    return [];
  }
}

async function loadCrmConfig() {
  const supabaseUrl = cleanText(process.env.CRM_SUPABASE_URL);
  const explicitKey = cleanText(process.env.CRM_SUPABASE_SERVICE_ROLE_KEY)
    || cleanText(process.env.CRM_SUPABASE_KEY)
    || cleanText(process.env.CRM_SUPABASE_ANON_KEY);
  if (supabaseUrl && explicitKey) {
    return { supabaseUrl, apiKey: explicitKey };
  }

  const text = await readFile(crmConfigPath, "utf8");
  const trimmed = text.trim();
  const json = trimmed.startsWith("{")
    ? trimmed
    : trimmed.match(/(?:window\.)?CRM_CONFIG\s*=\s*(\{[\s\S]*?\})\s*;?/)?.[1];
  const cfg = json ? JSON.parse(json) : {};
  return {
    supabaseUrl: cfg.supabaseUrl,
    apiKey: cfg.supabaseServiceRoleKey || cfg.supabaseKey || cfg.supabaseAnonKey
  };
}

function buildStageCounts(rows) {
  const counts = {};
  for (const row of rows) {
    const stage = cleanText(row.stage) || "Unknown";
    counts[stage] = (counts[stage] || 0) + 1;
  }
  return {
    counts,
    total: rows.length,
    ready: rows.filter((row) => /ready/i.test(cleanText(row.stage))).length,
    partial: rows.length
  };
}

function currentCityFromQuery(query) {
  const match = String(query || "").match(/\bin\s+"([^"]+)"/i);
  return match ? match[1] : runtime.currentCity || "";
}

function stopChild(signal) {
  if (stopping) return;
  stopping = true;
  pushLog(`GitHub cloud runner received ${signal}; stopping child process.`);
  runtime.stopRequested = true;
  if (child && !child.killed) {
    child.kill();
  }
}

function getSetting(name, fallback = "") {
  const envName = `CLOUD_${name.toUpperCase().replace(/-/g, "_")}`;
  const envValue = process.env[envName];
  if (envValue !== undefined && envValue !== "") return envValue;

  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  return fallback;
}

function resolvePath(filePath) {
  return path.isAbsolute(filePath) ? filePath : path.resolve(repoRoot, filePath);
}

function parseDelimited(value) {
  return String(value || "")
    .split(/[|\n,]+/)
    .map((entry) => cleanText(entry))
    .filter(Boolean);
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function toNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}
