const PLANT_FIRST_STAGES = new Set([
  "Ready for Outreach",
  "Plant Verified - Needs Products",
  "Plant Verified - Needs Contact",
  "Plant Verified - Needs Contact + Products"
]);

const CONTACT_MISSING_PATTERNS = [
  /no named maintenance \/ operations \/ plant contact found yet/i,
  /no named individual maintenance \/ operations linkedin contact/i
];

const PRODUCTS_MISSING_PATTERNS = [
  /not confidently confirmed from public pages yet/i,
  /no confirmed end products/i
];

const PLANT_MISSING_PATTERNS = [
  /no confirmed southern ontario manufacturing plant found/i,
  /no verified southern ontario manufacturing site/i
];

export function isPlantFirstStage(stage) {
  return PLANT_FIRST_STAGES.has(String(stage || "").trim());
}

export function normalizeSavedLeadRecord(record = {}) {
  const normalizedCompany = normalizeLeadCompanyName(record.company);
  const normalized = {
    ...record,
    company: normalizedCompany
  };

  if (!normalized.company) {
    return null;
  }

  if (isClearlyInvalidSavedLead(normalized)) {
    return null;
  }

  const hasUsableContact = hasNamedSavedLeadContact(normalized);
  const hasConfirmedProducts = hasSavedLeadProducts(normalized);
  const stage = deriveSavedLeadStage(normalized, {
    hasUsableContact,
    hasConfirmedProducts
  });
  const tags = buildSavedLeadTags(normalized.tags, {
    hasUsableContact,
    hasConfirmedProducts,
    stage
  });

  return {
    ...normalized,
    stage,
    tags
  };
}

export function normalizeLeadCompanyName(value) {
  return String(value || "")
    .replace(/^(about|location|homepage)\s*-\s*/i, "")
    .replace(/\s*,\s*$/, "")
    .trim();
}

export function isClearlyInvalidSavedLead(record = {}) {
  const notes = String(record.notes || "");
  return PLANT_MISSING_PATTERNS.some((pattern) => pattern.test(notes));
}

export function hasNamedSavedLeadContact(record = {}) {
  const contacts = String(record.contacts || "").trim();
  if (!contacts) {
    return false;
  }

  return !CONTACT_MISSING_PATTERNS.some((pattern) => pattern.test(contacts));
}

export function hasSavedLeadProducts(record = {}) {
  const notes = String(record.notes || "");
  const section = extractNotesSection(notes, "end products manufactured");
  if (!section) {
    return false;
  }

  return !PRODUCTS_MISSING_PATTERNS.some((pattern) => pattern.test(section));
}

function deriveSavedLeadStage(record, { hasUsableContact, hasConfirmedProducts }) {
  const currentStage = String(record.stage || "").trim();
  if (isPlantFirstStage(currentStage)) {
    return currentStage;
  }

  if (!hasUsableContact && !hasConfirmedProducts) {
    return "Plant Verified - Needs Contact + Products";
  }

  if (!hasUsableContact) {
    return "Plant Verified - Needs Contact";
  }

  if (!hasConfirmedProducts) {
    return "Plant Verified - Needs Products";
  }

  return "Ready for Outreach";
}

function buildSavedLeadTags(existingTags, { hasUsableContact, hasConfirmedProducts, stage }) {
  const currentTags = splitTags(existingTags);
  const inferredTags = [
    "plant-verified",
    stage === "Ready for Outreach" ? "outreach-ready" : "",
    inferSavedLeadContactTag(existingTags, hasUsableContact),
    hasConfirmedProducts ? "products:confirmed" : "products:missing"
  ];

  return Array.from(new Set([...currentTags, ...inferredTags.filter(Boolean)])).join(" | ");
}

function inferSavedLeadContactTag(existingTags, hasUsableContact) {
  const text = String(existingTags || "");
  if (text.includes("contact:linkedin-direct")) {
    return "contact:linkedin-direct";
  }
  if (text.includes("contact:public-named")) {
    return "contact:public-named";
  }
  if (text.includes("contact:leadership-fallback")) {
    return "contact:leadership-fallback";
  }
  if (!hasUsableContact) {
    return "contact:missing";
  }
  return "contact:public-named";
}

function extractNotesSection(notes, heading) {
  const escapedHeading = escapeForRegex(heading);
  const match = String(notes || "").match(
    new RegExp(`\\*\\*${escapedHeading}\\*\\*\\s*([\\s\\S]*?)(?:\\n\\n\\*\\*|$)`, "i")
  );

  return match?.[1]?.trim() || "";
}

function splitTags(value) {
  return String(value || "")
    .split("|")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function escapeForRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
