import "jsr:@supabase/functions-js@2.110.4/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.110.4";

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, x-edi-crm-key",
  "access-control-allow-methods": "POST, OPTIONS",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function requiredText(value: unknown, name: string, maxLength: number): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`${name} is required`);
  if (normalized.length > maxLength) throw new Error(`${name} exceeds ${maxLength} characters`);
  return normalized;
}

function optionalText(value: unknown, maxLength: number): string | null {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  if (!normalized) return null;
  if (normalized.length > maxLength) throw new Error(`text value exceeds ${maxLength} characters`);
  return normalized;
}

function positiveInteger(value: unknown, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function optionalPositiveInteger(value: unknown, name: string): number | null {
  if (value === null || value === undefined || value === "") return null;
  return positiveInteger(value, name);
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  const contentLength = Number(req.headers.get("content-length") ?? "0");
  if (contentLength > 100_000) throw new Error("request body is too large");
  try {
    return object(await req.json(), "request body");
  } catch {
    throw new Error("request body must be a JSON object");
  }
}

Deno.serve(async req => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return json(405, { ok: false, error: "method not allowed" });

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) return json(500, { ok: false, error: "server configuration is incomplete" });

  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: settings, error: settingsError } = await admin
    .from("crm_action_settings")
    .select("api_key_sha256, enabled")
    .eq("id", 1)
    .maybeSingle();
  if (settingsError || !settings?.enabled) return json(503, { ok: false, error: "CRM action is unavailable" });

  const suppliedKey = req.headers.get("x-edi-crm-key") ?? "";
  const suppliedHash = suppliedKey ? await sha256Hex(suppliedKey) : "";
  if (!settings.api_key_sha256 || !constantTimeEqual(suppliedHash, settings.api_key_sha256)) {
    return json(401, { ok: false, error: "unauthorized" });
  }

  const route = new URL(req.url).pathname.split("/").filter(Boolean).at(-1) ?? "";
  try {
    const body = await readBody(req);
    const requestedBy = optionalText(body.requested_by, 100) ?? "Scott Dumont";
    let data: unknown = null;
    let error: { message: string } | null = null;

    if (route === "lookup") {
      const entity = requiredText(body.entity, "entity", 50);
      const query = optionalText(body.query, 300);
      const recordId = optionalPositiveInteger(body.record_id, "record_id");
      const parentId = optionalPositiveInteger(body.parent_id, "parent_id");

      if (entity === "manufacturer") {
        let request = admin.from("manufacturers").select("id,company,stage,industry,last_contact,signals").limit(20);
        if (recordId) request = request.eq("id", recordId);
        else if (query) request = request.ilike("company", `%${query.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`);
        else throw new Error("query or record_id is required");
        ({ data, error } = await request.order("company"));
      } else if (entity === "vendor") {
        let request = admin.from("vendors").select("id,company,name,title,email,phone,industry,region,stage,notes,last_contact").limit(20);
        if (recordId) request = request.eq("id", recordId);
        else if (query) request = request.ilike("company", `%${query.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`);
        else throw new Error("query or record_id is required");
        ({ data, error } = await request.order("company"));
      } else if (entity === "manufacturer_contact") {
        let request = admin.from("manufacturer_contacts").select("id,manufacturer_id,name,title,linkedin").limit(30);
        if (recordId) request = request.eq("id", recordId);
        if (parentId) request = request.eq("manufacturer_id", parentId);
        if (query) request = request.ilike("name", `%${query.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`);
        if (!recordId && !parentId && !query) throw new Error("query, record_id, or parent_id is required");
        ({ data, error } = await request.order("id"));
      } else if (entity === "activity" || entity === "task") {
        let request = admin.from("activities").select("id,contact_id,contact_type,type,note,date,created_by,created_at").limit(50);
        if (recordId) request = request.eq("id", recordId);
        if (parentId) request = request.eq("contact_id", parentId);
        if (query) request = request.ilike("note", `%${query.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`);
        if (entity === "task") request = request.like("created_by", "__task__|%");
        else request = request.not("created_by", "like", "__task__|%");
        if (!recordId && !parentId && !query) throw new Error("query, record_id, or parent_id is required");
        ({ data, error } = await request.order("created_at", { ascending: false }));
      } else {
        throw new Error("entity must be manufacturer, vendor, manufacturer_contact, activity, or task");
      }
    } else if (route === "update-activity-note") {
      ({ data, error } = await admin.rpc("update_crm_activity_note", {
        p_activity_id: positiveInteger(body.activity_id, "activity_id"),
        p_note: requiredText(body.note, "note", 20_000),
        p_requested_by: requestedBy,
      }));
    } else if (route === "create-activity") {
      ({ data, error } = await admin.rpc("create_crm_activity", {
        p_contact_id: positiveInteger(body.contact_id, "contact_id"),
        p_contact_type: requiredText(body.contact_type, "contact_type", 30),
        p_activity_type: requiredText(body.activity_type, "activity_type", 30),
        p_note: requiredText(body.note, "note", 20_000),
        p_date: optionalText(body.date, 10),
        p_created_by: optionalText(body.created_by, 100) ?? "Scott",
      }));
    } else if (route === "update-manufacturer") {
      ({ data, error } = await admin.rpc("update_crm_manufacturer_details", {
        p_manufacturer_id: positiveInteger(body.manufacturer_id, "manufacturer_id"),
        p_patch: object(body.patch, "patch"),
        p_requested_by: requestedBy,
      }));
    } else if (route === "update-vendor") {
      ({ data, error } = await admin.rpc("update_crm_vendor_details", {
        p_vendor_id: positiveInteger(body.vendor_id, "vendor_id"),
        p_patch: object(body.patch, "patch"),
        p_requested_by: requestedBy,
      }));
    } else if (route === "upsert-manufacturer-contact") {
      ({ data, error } = await admin.rpc("upsert_crm_manufacturer_contact", {
        p_manufacturer_id: positiveInteger(body.manufacturer_id, "manufacturer_id"),
        p_name: requiredText(body.name, "name", 300),
        p_title: optionalText(body.title, 500),
        p_linkedin: optionalText(body.linkedin, 2_000),
        p_contact_id: optionalPositiveInteger(body.contact_id, "contact_id"),
        p_requested_by: requestedBy,
      }));
    } else if (route === "create-task") {
      ({ data, error } = await admin.rpc("create_crm_task", {
        p_contact_id: positiveInteger(body.contact_id, "contact_id"),
        p_contact_type: requiredText(body.contact_type, "contact_type", 30),
        p_title: requiredText(body.title, "title", 20_000),
        p_due_date: optionalText(body.due_date, 10),
        p_owner: optionalText(body.owner, 100) ?? "Scott",
      }));
    } else if (route === "update-task") {
      ({ data, error } = await admin.rpc("update_crm_task", {
        p_task_id: positiveInteger(body.task_id, "task_id"),
        p_patch: object(body.patch, "patch"),
        p_requested_by: requestedBy,
      }));
    } else if (route === "complete-task") {
      ({ data, error } = await admin.rpc("set_crm_task_completed", {
        p_task_id: positiveInteger(body.task_id, "task_id"),
        p_completed: body.completed === undefined ? true : body.completed === true,
        p_requested_by: requestedBy,
      }));
    } else {
      return json(404, { ok: false, error: "route not found" });
    }

    if (error) return json(400, { ok: false, error: error.message });
    return json(200, { ok: true, records: data ?? [] });
  } catch (error) {
    return json(400, { ok: false, error: error instanceof Error ? error.message : "invalid request" });
  }
});
