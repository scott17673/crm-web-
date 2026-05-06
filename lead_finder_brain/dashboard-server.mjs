import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { access, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseCsv } from "./runtime_lib/csv.mjs";
import { runCompanyEnrichment } from "./runtime_lib/company-enrichment.mjs";
import { DEFAULT_INDUSTRY_IDS, INDUSTRY_PRESETS } from "./runtime_lib/industries.mjs";
import { normalizeSavedLeadRecord } from "./runtime_lib/lead-records.mjs";
import { NEARBY_CITIES } from "./runtime_lib/nearby-cities.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataRoot = path.join(__dirname, "data");
const outputRoot = path.join(__dirname, "output");
const webRoot = path.join(__dirname, "web");
const repoRoot = path.resolve(__dirname, "..");
const settingsPath = path.join(dataRoot, "dashboard-settings.json");
await loadLocalEnvFile(path.join(repoRoot, ".env.local"));
const host = String(process.env.HOST || "0.0.0.0").trim() || "0.0.0.0";
const port = Number(process.env.PORT || 8780);
const cycleDelayMs = Number(process.env.CYCLE_DELAY_MS || 1000 * 60 * 5);
const watchdogMs = Number(process.env.FINDER_WATCHDOG_MS || 1000 * 60 * 10);
const keepAwakeEnabled = process.env.FINDER_KEEP_AWAKE !== "off";
const CSV_COLUMNS = [
  "company",
  "stage",
  "industry",
  "notes",
  "contacts"
];
const STRICT_REJECT_HINTS = [
  "no confirmed southern ontario manufacturing plant found",
  "no verified southern ontario manufacturing site",
  "no confirmed manufacturing plant",
  "no confirmed production facility",
  "not a manufacturer",
  "not a manufacturing",
  "service / vendor page",
  "vendor / integrator",
  "retail or restaurant",
  "shop bakery specials",
  "request custom cake quote",
  "order our most popular custom cake"
];
const OUT_OF_RANGE_HINTS = [
  "new jersey",
  " nj ",
  " united states",
  " usa",
  "massachusetts"
];
const MISSING_PRODUCT_HINTS = [
  "not confidently confirmed from public pages yet",
  "products:missing",
  "needs products"
];
const ADDRESS_PATTERN = /\b\d{1,6}\s+[A-Za-z0-9.'#&/\- ]+?\b(?:st|street|ave|avenue|rd|road|dr|drive|blvd|boulevard|lane|ln|court|ct|way|pkwy|parkway|circle|cir|highway|hwy|cres|crescent)\b/i;
const PHONE_PATTERN = /(?:\+?1[-.\s]*)?(?:\(?\d{3}\)?[-.\s]*)\d{3}[-.\s]*\d{4}/;
const PLANT_LANGUAGE_PATTERN = /\b(manufactur|processing|production|plant|facility|brewery|roastery|asphalt plant|ready[- ]mix|precast|quarry|recycling facility|molding|extrusion|fabricat|machin|packag)\b/i;

const DEFAULT_SETTINGS = {
  enabled: true,
  autoRun: false,
  existingCsvPath: String(process.env.EXISTING_CSV_PATH || "").trim(),
  crmConfigPath: String(process.env.CRM_CONFIG_PATH || "").trim(),
  province: "Ontario",
  cityLimit: 6,
  resultsPerQuery: 3,
  websitePageLimit: 2,
  searchDelayMs: 250,
  minEmployees: 10,
  citiesText: "",
  industries: [...DEFAULT_INDUSTRY_IDS],
  outputName: "milton-manufacturers-dashboard.csv",
  progressName: "milton-manufacturers-live.csv"
};

const CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8"
};

const runtime = {
  running: false,
  cycleRunning: false,
  pid: null,
  startedAt: "",
  finishedAt: "",
  nextRunAt: "",
  exitCode: null,
  stopRequested: false,
  outputPath: "",
  progressPath: "",
  process: null,
  restartTimer: null,
  watchdogTimer: null,
  keepAwakeProcess: null,
  lastLogAt: Date.now(),
  watchdogRestarts: 0,
  logs: ["Dashboard ready."]
};

await mkdir(dataRoot, { recursive: true });
await mkdir(outputRoot, { recursive: true });

let settings = await loadSettings();

createServer(async (req, res) => {
  try {
    const origin = req.headers.origin || "";
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const requestUrl = new URL(req.url || "/", `http://localhost:${port}`);

    if (requestUrl.pathname === "/api/state" && req.method === "GET") {
      return sendJson(res, 200, await buildState());
    }

    if (requestUrl.pathname === "/api/settings" && req.method === "POST") {
      const wasEnabled = settings.enabled;
      const body = await readJsonBody(req);
      settings = normalizeSettings({
        ...settings,
        ...body
      });
      await saveSettings(settings);
      if (wasEnabled && !settings.enabled && runtime.running) {
        stopRun();
      }
      pushLog("Settings saved.");
      return sendJson(res, 200, await buildState());
    }

    if (requestUrl.pathname === "/api/start" && req.method === "POST") {
      if (runtime.running) {
        return sendJson(res, 409, { error: "A run is already in progress." });
      }

      if (!settings.enabled) {
        return sendJson(res, 409, { error: "Finder is turned off. Switch it on before starting." });
      }

      await startRun();
      return sendJson(res, 200, await buildState());
    }

    if (requestUrl.pathname === "/api/stop" && req.method === "POST") {
      stopRun();
      return sendJson(res, 200, await buildState());
    }

    if (requestUrl.pathname === "/api/clear" && req.method === "POST") {
      if (runtime.running) {
        return sendJson(res, 409, { error: "Stop the run before clearing the dashboard rows." });
      }

      await clearDashboardResults();
      return sendJson(res, 200, await buildState());
    }

    if (requestUrl.pathname === "/api/enrich-company" && req.method === "POST") {
      const body = await readJsonBody(req);
      const companyLabel = String(body.company || body.companyName || body.id || "").trim();
      pushLog(`Manual contacts/signals search started for ${companyLabel || "selected company"}.`);
      const result = await runCompanyEnrichment({
        manufacturerId: body.id || body.manufacturerId,
        company: body.company || body.companyName,
        crmConfigPath: settings.crmConfigPath || path.join(repoRoot, "crm-config.js"),
        repoRoot,
        model: process.env.OPENAI_CONTACT_EXTRACT_MODEL || "gpt-5-nano",
        websitePageLimit: Number(body.websitePageLimit || settings.websitePageLimit || 3),
        dryRun: Boolean(body.dryRun)
      });
      pushLog(`Manual contacts/signals search finished for ${result.company}: ${result.contactsFound} contact(s), ${result.recentSignalsFound} signal(s).`);
      return sendJson(res, 200, result);
    }

    if (requestUrl.pathname === "/download/current.csv" && req.method === "GET") {
      const filePath = await resolveCurrentCsvPath();
      if (!filePath) {
        return sendPlain(res, 404, "No CSV is available yet.");
      }
      return serveFile(res, filePath);
    }

    if (requestUrl.pathname === "/download/final.csv" && req.method === "GET") {
      const filePath = getFinalOutputPath(settings);
      return serveFile(res, filePath);
    }

    return serveStatic(res, requestUrl.pathname);
  } catch (error) {
    pushLog(`Dashboard request failed: ${error instanceof Error ? error.message : String(error)}`);
    return sendJson(res, 500, {
      error: error instanceof Error ? error.message : "Unexpected server error."
    });
  }
}).listen(port, host, () => {
  console.log(`Dashboard listening on ${host}:${port}`);
});

if (settings.enabled && settings.autoRun) {
  void startRun({ startup: true }).catch((error) => {
    runtime.running = false;
    runtime.cycleRunning = false;
    pushLog(`Auto-start failed: ${error instanceof Error ? error.message : String(error)}`);
  });
}

// Poll Supabase finder_commands table for remote start/stop commands from the CRM
void startSupabaseCommandPoll();

async function startSupabaseCommandPoll() {
  let supabaseUrl = String(process.env.CRM_SUPABASE_URL || "").trim();
  let supabaseKey = String(process.env.CRM_SUPABASE_KEY || "").trim();

  // Fall back to reading from crm-config.js file if env vars not set
  if (!supabaseUrl || !supabaseKey) {
    const crmConfigPath = settings.crmConfigPath || process.env.CRM_CONFIG_PATH || "";
    if (crmConfigPath) {
      try {
        const text = await readFile(
          path.isAbsolute(crmConfigPath) ? crmConfigPath : path.resolve(__dirname, crmConfigPath),
          "utf8"
        );
        const match = text.match(/(?:window\.)?CRM_CONFIG\s*=\s*(\{[\s\S]*?\})\s*;/) ||
                      [null, text.trim().startsWith("{") ? text.trim() : null];
        if (match[1]) {
          const cfg = JSON.parse(match[1]);
          supabaseUrl = supabaseUrl || (cfg.supabaseUrl || "").replace(/\/+$/, "");
          supabaseKey = supabaseKey || cfg.supabaseServiceRoleKey || cfg.supabaseKey || cfg.supabaseAnonKey || "";
        }
      } catch {
        // ignore
      }
    }
  }

  if (!supabaseUrl || !supabaseKey) {
    pushLog("Supabase command polling disabled — set CRM_SUPABASE_URL and CRM_SUPABASE_KEY to enable remote start/stop.");
    return;
  }

  const baseUrl = `${supabaseUrl}/rest/v1`;
  const headers = {
    apikey: supabaseKey,
    Authorization: `Bearer ${supabaseKey}`,
    "Content-Type": "application/json",
    Prefer: "return=representation"
  };

  const supabaseFetch = async (path, opts = {}) => {
    const res = await fetch(`${baseUrl}${path}`, { ...opts, headers: { ...headers, ...opts.headers } });
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  };

  const updateCommandStatus = async (id, status) => {
    await supabaseFetch(`/finder_commands?id=eq.${id}`, {
      method: "PATCH",
      body: JSON.stringify({ status })
    });
  };

  pushLog("Supabase command polling active.");

  const poll = async () => {
    try {
      const rows = await supabaseFetch(
        `/finder_commands?status=eq.pending&order=created_at.asc&limit=1`
      );
      const job = Array.isArray(rows) ? rows[0] : null;
      if (!job) return;

      const { id, command, settings: jobSettings } = job;
      await updateCommandStatus(id, "running");

      if (command === "start") {
        if (jobSettings?.industries) {
          settings = normalizeSettings({ ...settings, industries: jobSettings.industries });
        }
        if (jobSettings?.citiesText !== undefined) {
          settings = normalizeSettings({ ...settings, citiesText: jobSettings.citiesText });
        }
        await saveSettings(settings);

        if (!runtime.running) {
          await startRun().catch((err) => {
            pushLog(`Remote start failed: ${err.message}`);
          });
        } else {
          pushLog("Remote start: run already in progress.");
        }
      } else if (command === "stop") {
        stopRun();
      }

      await updateCommandStatus(id, "done");
    } catch (err) {
      // silently ignore poll errors — network may be unavailable
    }
  };

  setInterval(poll, 30_000);
  poll();
}

async function loadSettings() {
  try {
    const text = await readFile(settingsPath, "utf8");
    return normalizeSettings(JSON.parse(text));
  } catch {
    const initial = normalizeSettings(DEFAULT_SETTINGS);
    await saveSettings(initial);
    return initial;
  }
}

async function saveSettings(value) {
  await writeFile(settingsPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function normalizeSettings(value = {}) {
  const selectedIndustries = Array.isArray(value.industries)
    ? value.industries.filter((item) => INDUSTRY_PRESETS.some((preset) => preset.id === item))
    : [...DEFAULT_INDUSTRY_IDS];
  const industries = selectedIndustries.length ? selectedIndustries : [...DEFAULT_INDUSTRY_IDS];

  return {
    enabled: Boolean(value.enabled),
    autoRun: Boolean(value.autoRun),
    existingCsvPath: normalizeExistingCsvPath(value.existingCsvPath),
    crmConfigPath: String(value.crmConfigPath || DEFAULT_SETTINGS.crmConfigPath).trim(),
    province: String(value.province || DEFAULT_SETTINGS.province).trim() || DEFAULT_SETTINGS.province,
    cityLimit: toNumber(value.cityLimit, DEFAULT_SETTINGS.cityLimit),
    resultsPerQuery: toNumber(value.resultsPerQuery, DEFAULT_SETTINGS.resultsPerQuery),
    websitePageLimit: toNumber(value.websitePageLimit, DEFAULT_SETTINGS.websitePageLimit),
    searchDelayMs: toNumber(value.searchDelayMs, DEFAULT_SETTINGS.searchDelayMs),
    minEmployees: toNumber(value.minEmployees, DEFAULT_SETTINGS.minEmployees),
    citiesText: String(value.citiesText || "").replace(/\r/g, ""),
    industries,
    outputName: sanitizeFileName(value.outputName || DEFAULT_SETTINGS.outputName),
    progressName: sanitizeFileName(value.progressName || DEFAULT_SETTINGS.progressName)
  };
}

function normalizeExistingCsvPath(value) {
  const envValue = String(process.env.EXISTING_CSV_PATH || "").trim();
  if (envValue) {
    return envValue;
  }

  const configured = String(value || DEFAULT_SETTINGS.existingCsvPath).trim();
  if (!configured) {
    return "";
  }

  if (process.platform !== "win32" && /^[A-Za-z]:[\\/]/.test(configured)) {
    return "";
  }

  return configured;
}

async function buildState() {
  const rows = await loadCurrentRows();
  const currentPath = await resolveCurrentCsvPath();
  const progress = summarizeLogs(runtime.logs);
  const stageCounts = summarizeStageCounts(rows);

  return {
    settings,
    presets: INDUSTRY_PRESETS,
    nearbyCities: NEARBY_CITIES,
    status: {
      running: runtime.running,
      cycleRunning: runtime.cycleRunning,
      enabled: settings.enabled,
      pid: runtime.pid,
      startedAt: runtime.startedAt,
      finishedAt: runtime.finishedAt,
      nextRunAt: runtime.nextRunAt,
      exitCode: runtime.exitCode,
      currentPhase: progress.currentPhase,
      currentQuery: progress.currentQuery,
      currentCompany: progress.currentCompany,
      currentCity: progress.currentCity,
      readyCount: stageCounts.ready,
      partialCount: stageCounts.partial,
      keptCount: stageCounts.total,
      summary: buildRunSummary(progress, stageCounts),
      currentCsvUrl: currentPath ? "/download/current.csv" : "",
      finalCsvUrl: await fileExists(getFinalOutputPath(settings)) ? "/download/final.csv" : "",
      keepAwake: Boolean(runtime.keepAwakeProcess),
      lastProgressAt: new Date(runtime.lastLogAt).toISOString(),
      watchdogMs,
      watchdogRestarts: runtime.watchdogRestarts
    },
    logs: runtime.logs,
    results: {
      headers: CSV_COLUMNS,
      total: rows.length,
      rows: rows.slice(0, 250),
      path: currentPath || "",
      progress,
      stageCounts
    }
  };
}

async function startRun({ startup = false } = {}) {
  if (runtime.running) {
    return;
  }

  await assertRunReady();

  settings = normalizeSettings({
    ...settings,
    autoRun: true
  });
  await saveSettings(settings);

  runtime.running = true;
  runtime.stopRequested = false;
  runtime.exitCode = null;
  runtime.nextRunAt = "";
  clearRestartTimer();
  startRunSupport();

  if (!startup) {
    pushLog("Continuous run armed.");
  }

  await launchRun();
}

async function launchRun() {
  await assertRunReady();

  const parsedCities = parseCitiesText(settings.citiesText);
  const outputPath = getFinalOutputPath(settings);
  const progressPath = getProgressOutputPath(settings);
  const args = ["find-manufacturers.mjs"];

  if (settings.existingCsvPath) {
    args.push("--existing", settings.existingCsvPath);
  }
  if (settings.crmConfigPath) {
    args.push("--crm-config", settings.crmConfigPath);
  }

  args.push(
    "--out",
    outputPath,
    "--progress-out",
    progressPath,
    "--province",
    settings.province,
    "--city-limit",
    String(settings.cityLimit),
    "--results-per-query",
    String(settings.resultsPerQuery),
    "--website-page-limit",
    String(settings.websitePageLimit),
    "--search-delay-ms",
    String(settings.searchDelayMs)
  );

  args.push("--min-employees", String(settings.minEmployees));

  if (settings.industries.length) {
    args.push("--industries", settings.industries.join("|"));
  }

  if (parsedCities.length) {
    args.push("--cities", parsedCities.join("|"));
  }

  const child = spawn(process.execPath, args, {
    cwd: __dirname,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });

  runtime.cycleRunning = true;
  runtime.pid = child.pid;
  runtime.startedAt = new Date().toISOString();
  runtime.finishedAt = "";
  runtime.exitCode = null;
  runtime.outputPath = outputPath;
  runtime.progressPath = progressPath;
  runtime.process = child;
  pushLog(`Run cycle started at ${runtime.startedAt}`);

  hookStream(child.stdout, "out");
  hookStream(child.stderr, "err");

  child.on("error", (error) => {
    pushLog(`Process error: ${error.message}`);
  });

  child.on("close", (code) => {
    runtime.cycleRunning = false;
    runtime.pid = null;
    runtime.finishedAt = new Date().toISOString();
    runtime.exitCode = code;
    runtime.process = null;

    if (runtime.stopRequested || !runtime.running || !settings.enabled || !settings.autoRun) {
      runtime.running = false;
      runtime.nextRunAt = "";
      stopRunSupport();
      pushLog(runtime.stopRequested
        ? `Run stopped with exit code ${code ?? -1}.`
        : `Run finished with exit code ${code ?? -1}.`);
      return;
    }

    if ((code ?? 0) !== 0) {
      pushLog(`Run cycle failed with exit code ${code ?? -1}. Retrying soon.`);
    } else {
      pushLog(`Run cycle finished with exit code ${code ?? -1}.`);
    }

    scheduleNextRun();
  });
}

async function clearDashboardResults() {
  const outputPath = runtime.outputPath || getFinalOutputPath(settings);
  const progressPath = runtime.progressPath || getProgressOutputPath(settings);
  const uniquePaths = Array.from(new Set([outputPath, progressPath].filter(Boolean)));

  for (const filePath of uniquePaths) {
    await rm(filePath, { force: true });
  }

  runtime.startedAt = "";
  runtime.finishedAt = "";
  runtime.exitCode = null;
  runtime.stopRequested = false;
  runtime.outputPath = outputPath;
  runtime.progressPath = progressPath;
  runtime.logs = ["Results cleared."];
}

function stopRun() {
  if (!runtime.running) {
    pushLog("Stop requested, but no run is active.");
    return;
  }

  settings = normalizeSettings({
    ...settings,
    autoRun: false
  });
  void saveSettings(settings);

  runtime.stopRequested = true;
  runtime.nextRunAt = "";
  clearRestartTimer();

  if (!runtime.process || !runtime.cycleRunning) {
    runtime.running = false;
    stopRunSupport();
    pushLog("Continuous run stopped.");
    return;
  }

  runtime.process.kill();
  pushLog("Stop requested.");
}

function hookStream(stream, label) {
  let carry = "";

  stream.on("data", (chunk) => {
    const text = `${carry}${String(chunk)}`;
    const lines = text.split(/\r?\n/);
    carry = lines.pop() || "";

    for (const line of lines) {
      if (line.trim()) {
        pushLog(label === "err" ? `[err] ${line}` : line);
      }
    }
  });

  stream.on("end", () => {
    if (carry.trim()) {
      pushLog(label === "err" ? `[err] ${carry}` : carry);
    }
  });
}

function pushLog(message) {
  runtime.logs.push(message);
  runtime.lastLogAt = Date.now();
}

function startRunSupport() {
  startKeepAwake();
  startWatchdog();
}

function stopRunSupport() {
  stopWatchdog();
  stopKeepAwake();
}

function startWatchdog() {
  if (runtime.watchdogTimer || !watchdogMs) {
    return;
  }

  runtime.watchdogTimer = setInterval(() => {
    if (!runtime.running || runtime.stopRequested || !settings.enabled || !settings.autoRun) {
      stopWatchdog();
      return;
    }

    if (!runtime.cycleRunning || !runtime.process) {
      return;
    }

    const quietMs = Date.now() - runtime.lastLogAt;
    if (quietMs < watchdogMs) {
      return;
    }

    runtime.watchdogRestarts += 1;
    pushLog(`Watchdog: no finder progress for ${Math.round(quietMs / 1000)}s, restarting this cycle.`);
    runtime.process.kill();
  }, Math.min(60_000, Math.max(15_000, Math.floor(watchdogMs / 3))));
}

function stopWatchdog() {
  if (runtime.watchdogTimer) {
    clearInterval(runtime.watchdogTimer);
    runtime.watchdogTimer = null;
  }
}

function startKeepAwake() {
  if (!keepAwakeEnabled || process.platform !== "win32" || runtime.keepAwakeProcess) {
    return;
  }

  const command = [
    "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class SleepGuard { [DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint esFlags); }';",
    "while ($true) { [SleepGuard]::SetThreadExecutionState(0x80000001) | Out-Null; Start-Sleep -Seconds 45 }"
  ].join(" ");

  const child = spawn("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    command
  ], {
    windowsHide: true,
    stdio: "ignore"
  });

  runtime.keepAwakeProcess = child;
  pushLog("Keep-awake guard active while continuous run is on.");
  child.on("close", () => {
    if (runtime.keepAwakeProcess === child) {
      runtime.keepAwakeProcess = null;
    }
  });
  child.on("error", (error) => {
    if (runtime.keepAwakeProcess === child) {
      runtime.keepAwakeProcess = null;
    }
    pushLog(`Keep-awake guard failed: ${error.message}`);
  });
}

function stopKeepAwake() {
  if (!runtime.keepAwakeProcess) {
    return;
  }

  const child = runtime.keepAwakeProcess;
  runtime.keepAwakeProcess = null;
  child.kill();
  pushLog("Keep-awake guard stopped.");
}

function summarizeLogs(logs) {
  let checked = 0;
  let skipped = 0;
  let added = 0;
  let lastDecision = "";
  let currentPhase = "";
  let currentQuery = "";
  let currentCompany = "";
  let currentCity = "";
  const reasonCounts = new Map();

  for (const line of logs) {
    if (line.startsWith("  Phase: ")) {
      const parsed = parsePhaseLine(line);
      currentPhase = parsed.phase || currentPhase;
      currentCompany = parsed.company || currentCompany;
      currentCity = parsed.city || currentCity;
      currentQuery = parsed.query || currentQuery;
    }
    if (line.includes("Enriching ")) {
      checked += 1;
      currentPhase = "Light qualify";
      const match = line.match(/Enriching\s+\d+:\s+(.+?)\s+\|\s+/);
      if (match?.[1]) {
        currentCompany = match[1].trim();
      }
    }
    if (line.includes("Skipped: ")) {
      checked += 1;
      skipped += 1;
      lastDecision = line;
      const parts = line.split(" | ").slice(1);
      for (const part of parts) {
        const reason = String(part || "").trim();
        if (!reason) {
          continue;
        }
        reasonCounts.set(reason, (reasonCounts.get(reason) || 0) + 1);
      }
    }
    if (line.includes("Added row ")) {
      checked += 1;
      added += 1;
      lastDecision = line;
    }
    if (line.includes("Updated row ") || line.includes("Kept row ")) {
      lastDecision = line;
    }
    if (line.startsWith("  Search: ")) {
      currentPhase = "Search";
      currentQuery = line.replace(/^  Search:\s*/, "").trim();
      currentCity = extractCityFromQuery(currentQuery) || currentCity;
    }
    if (line.startsWith("  Deep qualifying: ")) {
      currentPhase = "Deep qualify";
      currentCompany = line.replace(/^  Deep qualifying:\s*/, "").trim();
    }
  }

  const topReasonEntry = Array.from(reasonCounts.entries())
    .sort((left, right) => right[1] - left[1])[0] || null;

  return {
    checked,
    skipped,
    added,
    lastDecision,
    currentPhase,
    currentQuery,
    currentCompany,
    currentCity,
    topSkipReason: topReasonEntry ? topReasonEntry[0] : "",
    topSkipReasonCount: topReasonEntry ? topReasonEntry[1] : 0
  };
}

function summarizeStageCounts(rows) {
  const counts = {};

  for (const row of rows) {
    const stage = String(row?.stage || "Unknown").trim() || "Unknown";
    counts[stage] = (counts[stage] || 0) + 1;
  }

  const total = rows.length;
  const ready = counts.Prospect || 0;

  return {
    counts,
    total,
    ready,
    partial: Math.max(0, total - ready)
  };
}

function buildRunSummary(progress, stageCounts) {
  if (!settings.enabled) {
    return "Finder is off.";
  }

  if (runtime.cycleRunning) {
    return appendTopReason(
      `Running. Kept ${stageCounts.total} prospects. Checked ${progress.checked}, skipped ${progress.skipped}.`,
      progress
    );
  }

  if (runtime.running && runtime.nextRunAt) {
    return appendTopReason(
      `Waiting for the next cycle at ${formatTimestamp(runtime.nextRunAt)}. Kept ${stageCounts.total} prospects so far.`,
      progress
    );
  }

  if (runtime.running) {
    return "Preparing the next cycle.";
  }

  if (runtime.finishedAt) {
    if (runtime.stopRequested) {
      return appendTopReason(
        `Run stopped. Checked ${progress.checked} candidates and found ${progress.added} qualified leads.`,
        progress
      );
    }

    if ((runtime.exitCode ?? 0) !== 0) {
      return appendTopReason(
        `Run failed after checking ${progress.checked} candidates. Kept ${stageCounts.total} prospects before the failure.`,
        progress
      );
    }

    if (!stageCounts.total) {
      return appendTopReason(
        `Run finished. Checked ${progress.checked} candidates and found no prospects.`,
        progress
      );
    }

    return appendTopReason(
      `Run finished. Checked ${progress.checked} candidates and kept ${stageCounts.total} prospects.`,
      progress
    );
  }

  return "Ready to search.";
}

function scheduleNextRun() {
  clearRestartTimer();
  runtime.nextRunAt = new Date(Date.now() + cycleDelayMs).toISOString();
  pushLog(`Next cycle scheduled for ${formatTimestamp(runtime.nextRunAt)}.`);
  runtime.restartTimer = setTimeout(() => {
    runtime.restartTimer = null;
    runtime.nextRunAt = "";
    void launchRun().catch((error) => {
      pushLog(`Next cycle failed to start: ${error instanceof Error ? error.message : String(error)}`);
      if (runtime.running && settings.enabled && settings.autoRun && !runtime.stopRequested) {
        scheduleNextRun();
      } else {
        runtime.running = false;
      }
    });
  }, cycleDelayMs);
}

function clearRestartTimer() {
  if (!runtime.restartTimer) {
    return;
  }

  clearTimeout(runtime.restartTimer);
  runtime.restartTimer = null;
}

function appendTopReason(summary, progress) {
  if (!progress.topSkipReason || !progress.topSkipReasonCount) {
    return summary;
  }

  return `${summary} Biggest skip reason: ${progress.topSkipReason} (${progress.topSkipReasonCount}).`;
}

function parsePhaseLine(line) {
  const parts = line.replace(/^  Phase:\s*/, "").split(" | ").map((part) => part.trim()).filter(Boolean);
  return {
    phase: formatPhaseLabel(parts[0] || ""),
    company: parts[1] || "",
    city: parts[2] || "",
    query: parts.slice(3).join(" | ")
  };
}

function formatPhaseLabel(value) {
  const phase = String(value || "").trim();
  if (!phase) {
    return "";
  }

  return phase
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function extractCityFromQuery(query) {
  const match = String(query || "").match(/in\s+"([^"]+)"/i);
  return match?.[1] || "";
}

function getFinalOutputPath(activeSettings) {
  return path.join(outputRoot, sanitizeFileName(activeSettings.outputName));
}

function getProgressOutputPath(activeSettings) {
  return path.join(outputRoot, sanitizeFileName(activeSettings.progressName));
}

async function resolveCurrentCsvPath() {
  const progressPath = runtime.progressPath || getProgressOutputPath(settings);
  const outputPath = runtime.outputPath || getFinalOutputPath(settings);

  if (runtime.running && await fileExists(progressPath)) {
    return progressPath;
  }

  if (await fileHasContent(outputPath)) {
    return outputPath;
  }

  if (await fileHasContent(progressPath)) {
    return progressPath;
  }

  if (await fileExists(outputPath)) {
    return outputPath;
  }

  if (await fileExists(progressPath)) {
    return progressPath;
  }

  return "";
}

async function loadCurrentRows() {
  const filePath = await resolveCurrentCsvPath();
  if (!filePath) {
    return [];
  }

  try {
    const text = await readFile(filePath, "utf8");
    return parseCsv(text)
      .map((record) => normalizeSavedLeadRecord(record))
      .filter(Boolean)
      .filter(passesStrictPlantVerifierGuard);
  } catch {
    return [];
  }
}

function passesStrictPlantVerifierGuard(row) {
  const text = [
    row?.company,
    row?.stage,
    row?.industry,
    row?.notes,
    row?.contacts,
    row?.tags,
    row?.end_product
  ].filter(Boolean).join(" ");
  const lower = ` ${text.toLowerCase()} `;
  if (!String(row?.company || "").trim()) return false;
  if (STRICT_REJECT_HINTS.some((hint) => lower.includes(hint))) return false;
  if (OUT_OF_RANGE_HINTS.some((hint) => lower.includes(hint))) return false;
  if (MISSING_PRODUCT_HINTS.some((hint) => lower.includes(hint))) return false;
  if (/\bneeds products\b/i.test(String(row?.stage || ""))) return false;

  const hasAddress = ADDRESS_PATTERN.test(text);
  const hasPhone = PHONE_PATTERN.test(text);
  const hasPlantLanguage = PLANT_LANGUAGE_PATTERN.test(text);
  const hasProduct = !/\bend products manufactured\*\*\s*(not confidently confirmed|&copy;|copyright|home\b|bakery specials\b|request custom cake quote\b)/i.test(text);

  return hasAddress && hasPhone && hasPlantLanguage && hasProduct;
}

function parseCitiesText(value) {
  return String(value || "")
    .split(/\r?\n|,/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function sanitizeFileName(value) {
  return String(value || "")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
    .trim() || "output.csv";
}

function toNumber(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function formatTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function fileHasContent(filePath) {
  try {
    const details = await stat(filePath);
    return details.isFile() && details.size > 0;
  } catch {
    return false;
  }
}

async function assertRunReady() {
  if (settings.existingCsvPath && !await fileExists(settings.existingCsvPath)) {
    throw new Error(`Existing CSV not found: ${settings.existingCsvPath}`);
  }
  if (settings.crmConfigPath && !await fileExists(settings.crmConfigPath)) {
    throw new Error(`CRM config not found: ${settings.crmConfigPath}`);
  }
}

async function serveStatic(res, pathname) {
  const relative = pathname === "/" ? "/index.html" : pathname;
  const allowedRepoStatics = new Set(["/index.html", "/crm-config.js"]);
  const candidates = [
    path.resolve(webRoot, `.${relative}`),
    allowedRepoStatics.has(relative) ? path.resolve(repoRoot, `.${relative}`) : ""
  ].filter(Boolean);
  const allowedRoots = [path.resolve(webRoot), path.resolve(repoRoot)];

  for (const resolved of candidates) {
    if (!allowedRoots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`))) {
      continue;
    }
    try {
      await access(resolved);
      return serveFile(res, resolved);
    } catch {
      continue;
    }
  }

  if (!candidates.length) {
    return sendPlain(res, 403, "Forbidden");
  }
  return sendPlain(res, 404, "Not found");
}

async function serveFile(res, filePath) {
  try {
    await access(filePath);
    const details = await stat(filePath);
    if (!details.isFile()) {
      return sendPlain(res, 404, "Not found");
    }

    const extension = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": CONTENT_TYPES[extension] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    createReadStream(filePath).pipe(res);
  } catch {
    return sendPlain(res, 404, "Not found");
  }
}

async function readJsonBody(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(chunk);
  }

  if (!chunks.length) {
    return {};
  }

  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON request body: ${text.slice(0, 120) || "empty body"}`);
  }
}

async function loadLocalEnvFile(filePath) {
  try {
    const text = await readFile(filePath, "utf8");
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) {
        continue;
      }
      const separator = line.indexOf("=");
      if (separator <= 0) {
        continue;
      }
      const key = line.slice(0, separator).trim();
      let value = line.slice(separator + 1).trim();
      if (!key || process.env[key]) {
        continue;
      }
      if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  } catch {
    // Optional local secrets file.
  }
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(`${JSON.stringify(payload)}\n`);
}

function sendPlain(res, statusCode, text) {
  res.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(text);
}
