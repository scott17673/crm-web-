import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { loadLocalEnv } from "./plant-verifier.mjs";

const CLOUD_STATE_ID = "00000000-0000-4000-8000-000000000879";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

await loadLocalEnv({ cwd: repoRoot });

const runNow = process.argv.includes("--run-now");
const crmConfigPath = resolvePath(process.env.CLOUD_CRM_CONFIG || "crm-config.js");
const config = await loadCrmConfig();
const pending = await fetchPendingCommands();
const cloudCommand = pending.find((row) => isCloudTarget(row.settings));

if (cloudCommand?.command === "stop") {
  const current = await fetchCloudState();
  if (isFreshCloudRunning(current)) {
    console.log("Cloud stop command left pending for the active cloud runner.");
    process.exit(0);
  }
  await updateCommandStatus(cloudCommand.id, "running");
  await publishCloudStoppedState("GitHub cloud run stopped from CRM.");
  await updateCommandStatus(cloudCommand.id, "done");
  console.log("Cloud stop command handled.");
  process.exit(0);
}

const currentCloudState = await fetchCloudState();
if (!cloudCommand && !runNow && !shouldContinueCloudAutoRun(currentCloudState)) {
  console.log("No cloud start command and cloud autorun is off.");
  process.exit(0);
}

if (cloudCommand) {
  await updateCommandStatus(cloudCommand.id, "running");
}

const commandSettings = cloudCommand?.settings || {};
const exitCode = await runCloudFinder({
  industries: commandSettings.industries,
  citiesText: commandSettings.citiesText,
  autoRun: true
});

if (cloudCommand) {
  await updateCommandStatus(cloudCommand.id, exitCode === 0 ? "done" : "failed");
}

process.exit(exitCode);

async function runCloudFinder({ industries, citiesText, autoRun }) {
  const env = {
    ...process.env,
    CLOUD_AUTORUN: autoRun ? "true" : "",
    CLOUD_CRM_CONFIG: process.env.CLOUD_CRM_CONFIG || "crm-config.js"
  };
  if (Array.isArray(industries) && industries.length) {
    env.CLOUD_INDUSTRIES = industries.join("|");
  }
  if (typeof citiesText === "string" && citiesText.trim()) {
    env.CLOUD_CITIES = citiesText.split(/\r?\n|,/).map((entry) => entry.trim()).filter(Boolean).join("|");
  }

  return await new Promise((resolve) => {
    const child = spawn(process.execPath, ["cloud-runner.mjs"], {
      cwd: __dirname,
      stdio: "inherit",
      env
    });
    child.on("close", (code) => resolve(code ?? 0));
    child.on("error", (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      resolve(1);
    });
  });
}

async function fetchPendingCommands() {
  const rows = await supabaseRequest("/finder_commands?status=eq.pending&order=created_at.asc&limit=20");
  return Array.isArray(rows) ? rows : [];
}

async function fetchCloudState() {
  const rows = await supabaseRequest(`/finder_commands?id=eq.${CLOUD_STATE_ID}&select=settings&limit=1`);
  return Array.isArray(rows) ? rows[0]?.settings : null;
}

function shouldContinueCloudAutoRun(state) {
  if (!state?.cloudAutoRun) return false;
  const publishedAt = state.remotePublishedAt ? new Date(state.remotePublishedAt).getTime() : 0;
  const ageMs = Date.now() - publishedAt;
  return !isFreshCloudRunning(state, ageMs);
}

function isFreshCloudRunning(state, knownAgeMs = null) {
  if (!state?.status?.running) return false;
  const ageMs = knownAgeMs ?? (state.remotePublishedAt ? Date.now() - new Date(state.remotePublishedAt).getTime() : Infinity);
  return Number.isFinite(ageMs) && ageMs < 75 * 60 * 1000;
}

function isCloudTarget(settings) {
  return settings?.target === "cloud" || settings?.target === "github-actions";
}

async function updateCommandStatus(id, status) {
  await supabaseRequest(`/finder_commands?id=eq.${id}`, {
    method: "PATCH",
    body: JSON.stringify({ status })
  });
}

async function publishCloudStoppedState(summary) {
  const state = {
    settings: { cloudAutoRun: false },
    presets: [],
    nearbyCities: [],
    status: {
      running: false,
      cycleRunning: false,
      enabled: true,
      pid: null,
      startedAt: "",
      finishedAt: new Date().toISOString(),
      nextRunAt: "",
      exitCode: 0,
      currentPhase: "Stopped",
      currentQuery: "",
      currentCompany: "",
      currentCity: "",
      readyCount: 0,
      partialCount: 0,
      keptCount: 0,
      summary,
      runner: "GitHub Cloud"
    },
    logs: [summary],
    results: {
      headers: ["company", "stage", "industry", "notes", "contacts"],
      total: 0,
      rows: [],
      progress: { checked: 0, skipped: 0, added: 0 },
      stageCounts: { counts: {}, total: 0, ready: 0, partial: 0 }
    },
    remotePublishedAt: new Date().toISOString(),
    remoteSource: "github-actions",
    cloudAutoRun: false
  };
  await supabaseRequest("/finder_commands?on_conflict=id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify([{
      id: CLOUD_STATE_ID,
      command: "state",
      status: "finished",
      settings: state
    }])
  });
}

async function supabaseRequest(restPath, options = {}) {
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

function resolvePath(filePath) {
  return path.isAbsolute(filePath) ? filePath : path.resolve(repoRoot, filePath);
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}
