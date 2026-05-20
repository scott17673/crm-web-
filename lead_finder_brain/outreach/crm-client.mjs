import { readFile } from "node:fs/promises";
import path from "node:path";

export async function resolveCrmConfig({ crmConfigPath, baseDir = process.cwd() } = {}) {
  const envUrl = firstNonBlank(process.env.CRM_SUPABASE_URL);
  const envKey = firstNonBlank(
    process.env.CRM_SUPABASE_SERVICE_ROLE_KEY,
    process.env.CRM_SUPABASE_KEY,
    process.env.CRM_SUPABASE_ANON_KEY
  );

  let fileConfig = {};
  const configPath = firstNonBlank(crmConfigPath, process.env.CRM_CONFIG_PATH);
  if (configPath) {
    const resolved = path.isAbsolute(configPath) ? configPath : path.resolve(baseDir, configPath);
    fileConfig = await loadConfigFile(resolved);
  }

  const supabaseUrl = (envUrl || fileConfig.supabaseUrl || "").replace(/\/+$/, "");
  const apiKey = envKey || fileConfig.supabaseServiceRoleKey || fileConfig.supabaseKey || fileConfig.supabaseAnonKey || "";

  if (!supabaseUrl || !apiKey) {
    throw new Error("CRM Supabase URL or key not configured (set CRM_CONFIG_PATH or CRM_SUPABASE_URL + CRM_SUPABASE_ANON_KEY).");
  }

  return { supabaseUrl, apiKey };
}

async function loadConfigFile(resolvedPath) {
  let text;
  try {
    text = await readFile(resolvedPath, "utf8");
  } catch (err) {
    throw new Error(`CRM config not found at ${resolvedPath}: ${err.message}`);
  }
  const trimmed = String(text || "").trim();
  if (!trimmed) {
    throw new Error(`CRM config file is empty: ${resolvedPath}`);
  }
  if (trimmed.startsWith("{")) {
    return JSON.parse(trimmed);
  }
  const assignmentMatch = trimmed.match(/(?:window\.)?CRM_CONFIG\s*=\s*(\{[\s\S]*\})\s*;?\s*$/);
  if (!assignmentMatch?.[1]) {
    throw new Error(`Unsupported CRM config format in ${resolvedPath}`);
  }
  return JSON.parse(assignmentMatch[1]);
}

export function createCrmClient({ supabaseUrl, apiKey }) {
  const baseUrl = `${supabaseUrl}/rest/v1`;
  const auth = { apikey: apiKey, Authorization: `Bearer ${apiKey}` };
  const buildSelectUrl = (table, { select = "*", filters = {}, order = null, limit = 1000 } = {}) => {
    const url = new URL(`${baseUrl}/${table}`);
    url.searchParams.set("select", select);
    if (limit !== null && limit !== undefined) url.searchParams.set("limit", String(limit));
    if (order?.column) url.searchParams.set("order", `${order.column}.${order.ascending === false ? "desc" : "asc"}`);
    for (const [k, v] of Object.entries(filters)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    return url;
  };

  return {
    async select(table, options = {}) {
      const url = buildSelectUrl(table, options);
      const headers = { ...auth, Accept: "application/json" };
      if (options.range) headers.Range = `${options.range.from}-${options.range.to}`;
      return requestJson(url, { method: "GET", headers });
    },
    async selectAll(table, options = {}) {
      const pageSize = Number(options.pageSize || 1000);
      const rows = [];
      for (let from = 0; ; from += pageSize) {
        const batch = await this.select(table, {
          ...options,
          limit: null,
          range: { from, to: from + pageSize - 1 }
        });
        rows.push(...(Array.isArray(batch) ? batch : []));
        if (!Array.isArray(batch) || batch.length < pageSize) break;
      }
      return rows;
    },
    async insert(table, rows, { select = "" } = {}) {
      const url = new URL(`${baseUrl}/${table}`);
      if (select) url.searchParams.set("select", select);
      return requestJson(url, {
        method: "POST",
        headers: { ...auth, Accept: "application/json", "Content-Type": "application/json", Prefer: "return=representation" },
        body: JSON.stringify(rows)
      });
    },
    async patch(table, filters, values, { select = "" } = {}) {
      const url = new URL(`${baseUrl}/${table}`);
      if (select) url.searchParams.set("select", select);
      for (const [k, v] of Object.entries(filters || {})) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
      return requestJson(url, {
        method: "PATCH",
        headers: {
          ...auth,
          Accept: "application/json",
          "Content-Type": "application/json",
          Prefer: select ? "return=representation" : "return=minimal"
        },
        body: JSON.stringify(values)
      });
    }
  };
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  const data = text ? safeJson(text) : null;
  if (!response.ok) {
    const message = (data && (data.message || data.error_description)) || text || `${response.status} ${response.statusText}`;
    throw new Error(`CRM ${options.method} ${url.pathname} failed: ${message}`);
  }
  return data;
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function firstNonBlank(...values) {
  for (const v of values) {
    const s = typeof v === "string" ? v.trim() : "";
    if (s) return s;
  }
  return "";
}
