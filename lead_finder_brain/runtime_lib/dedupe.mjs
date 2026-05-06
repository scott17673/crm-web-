const NAME_ALIASES = [
  "company",
  "company_name",
  "name",
  "business_name",
  "account_name",
  "facility_name"
];

const ADDRESS_ALIASES = [
  "address",
  "formatted_address",
  "street_address",
  "company_address",
  "location",
  "site_address"
];

const PHONE_ALIASES = [
  "phone",
  "phone_number",
  "telephone",
  "main_phone",
  "company_phone"
];

const WEBSITE_ALIASES = [
  "website",
  "website_url",
  "domain",
  "company_website",
  "url"
];

const GENERIC_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "yahoo.com",
  "icloud.com",
  "rogers.com",
  "sympatico.ca",
  "bell.net"
]);

export function buildExistingIndex(records) {
  const names = new Set();
  const addressIndex = new Set();
  const domains = new Set();
  const phones = new Set();
  const nameAddress = new Set();
  const hardSkipNames = new Set();
  const hardSkipDomains = new Set();

  for (const record of records) {
    const name = normalizeName(pickFirst(record, NAME_ALIASES));
    const textBlob = collectRecordText(record);
    const explicitAddress = normalizeAddress(pickFirst(record, ADDRESS_ALIASES));
    const explicitPhone = normalizePhone(pickFirst(record, PHONE_ALIASES));
    const explicitDomain = normalizeDomain(pickFirst(record, WEBSITE_ALIASES));
    const recordAddresses = new Set([
      explicitAddress,
      ...extractAddresses(textBlob).map(normalizeAddress)
    ]);
    const phonesFound = new Set([
      explicitPhone,
      ...extractPhones(textBlob).map(normalizePhone)
    ]);
    const domainsFound = new Set([
      explicitDomain,
      ...extractDomains(textBlob)
    ]);

    if (name) {
      names.add(name);
    }

    for (const domain of domainsFound) {
      if (domain) {
        domains.add(domain);
      }
    }

    for (const phone of phonesFound) {
      if (phone) {
        phones.add(phone);
      }
    }

    for (const address of recordAddresses) {
      if (address) {
        addressIndex.add(address);
      }
      if (name && address) {
        nameAddress.add(`${name}::${address}`);
      }
    }

    if (record._finderSkip) {
      if (name) hardSkipNames.add(name);
      for (const domain of domainsFound) {
        if (domain) hardSkipDomains.add(domain);
      }
    }
  }

  return { names, addresses: addressIndex, domains, phones, nameAddress, hardSkipNames, hardSkipDomains };
}

export function normalizeCandidate(candidate) {
  const textBlob = collectRecordText(candidate);
  const name = normalizeName(candidate.company_name || candidate.facility_name || candidate.company || candidate.name);
  const address = normalizeAddress(candidate.formatted_address || candidate.address || extractAddresses(textBlob)[0] || "");
  const phone = normalizePhone(
    candidate.phone ||
    candidate.national_phone_number ||
    candidate.international_phone_number ||
    extractPhones(textBlob)[0] ||
    ""
  );
  const domain = normalizeDomain(candidate.website || extractDomains(textBlob)[0] || "");

  return {
    name,
    address,
    phone,
    domain,
    composite: name && address ? `${name}::${address}` : ""
  };
}

export function isDuplicate(candidate, existingIndex, seenIndex) {
  const normalized = normalizeCandidate(candidate);

  const hardSkipName = normalized.name && existingIndex.hardSkipNames?.has(normalized.name);
  const hardSkipDomain = normalized.domain && existingIndex.hardSkipDomains?.has(normalized.domain);
  if (hardSkipName || hardSkipDomain) {
    return true;
  }

  const existingName = normalized.name && existingIndex.names.has(normalized.name);
  const existingAddress = normalized.address && existingIndex.addresses?.has(normalized.address);
  const existingDomain = normalized.domain && existingIndex.domains.has(normalized.domain);
  const existingPhone = normalized.phone && existingIndex.phones.has(normalized.phone);
  const existingComposite = normalized.composite && existingIndex.nameAddress.has(normalized.composite);

  const seenName = normalized.name && seenIndex.names.has(normalized.name);
  const seenAddress = normalized.address && seenIndex.addresses?.has(normalized.address);
  const seenDomain = normalized.domain && seenIndex.domains.has(normalized.domain);
  const seenPhone = normalized.phone && seenIndex.phones.has(normalized.phone);
  const seenComposite = normalized.composite && seenIndex.nameAddress.has(normalized.composite);

  if (existingAddress || seenAddress || existingComposite || seenComposite) {
    return true;
  }

  if (normalized.name && normalized.domain &&
      ((existingName && existingDomain) || (seenName && seenDomain))) {
    return true;
  }

  if ((existingName || seenName) && !normalized.address) {
    return true;
  }

  if ((existingPhone || seenPhone) && !normalized.address) {
    return true;
  }

  if (!normalized.address && !normalized.domain && (existingName || seenName)) {
    return true;
  }

  return false;
}

export function rememberCandidate(candidate, seenIndex) {
  const normalized = normalizeCandidate(candidate);

  if (normalized.name) {
    seenIndex.names.add(normalized.name);
  }
  if (normalized.address) {
    seenIndex.addresses.add(normalized.address);
  }
  if (normalized.domain) {
    seenIndex.domains.add(normalized.domain);
  }
  if (normalized.phone) {
    seenIndex.phones.add(normalized.phone);
  }
  if (normalized.composite) {
    seenIndex.nameAddress.add(normalized.composite);
  }
}

export function createEmptyIndex() {
  return {
    names: new Set(),
    addresses: new Set(),
    domains: new Set(),
    phones: new Set(),
    nameAddress: new Set(),
    hardSkipNames: new Set(),
    hardSkipDomains: new Set()
  };
}

export function normalizeName(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\b(ltd|limited|inc|incorporated|corp|corporation|co|company|llc|lp|plc)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeAddress(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/\b(road)\b/g, " rd ")
    .replace(/\b(street)\b/g, " st ")
    .replace(/\b(avenue)\b/g, " ave ")
    .replace(/\b(drive)\b/g, " dr ")
    .replace(/\b(boulevard)\b/g, " blvd ")
    .replace(/\b(north)\b/g, " n ")
    .replace(/\b(south)\b/g, " s ")
    .replace(/\b(east)\b/g, " e ")
    .replace(/\b(west)\b/g, " w ")
    .replace(/\b[A-Z]\d[A-Z][ -]?\d[A-Z]\d\b/gi, " ")
    .replace(/\b(ontario|canada|on)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizePhone(value) {
  const digits = String(value ?? "").replace(/\D+/g, "");
  if (digits.length < 10) {
    return "";
  }
  return digits.length > 10 ? digits.slice(-10) : digits;
}

export function normalizeDomain(value) {
  const text = String(value ?? "").trim();
  if (!text) {
    return "";
  }

  const firstUrl = text
    .split(/[;,|\s]+/)
    .find((entry) => entry.includes("."));

  if (!firstUrl) {
    return "";
  }

  try {
    const parsed = new URL(firstUrl.startsWith("http") ? firstUrl : `https://${firstUrl}`);
    const hostname = parsed.hostname.replace(/^www\./, "").toLowerCase();
    return hostname === "linkedin.com" ? "" : hostname;
  } catch {
    const hostname = firstUrl.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0].toLowerCase();
    return hostname === "linkedin.com" ? "" : hostname;
  }
}

function pickFirst(record, aliases) {
  for (const alias of aliases) {
    const value = record?.[alias];
    if (value) {
      return value;
    }
  }

  return "";
}

function collectRecordText(record) {
  return Object.values(record ?? {})
    .filter((value) => typeof value === "string" && value.trim())
    .join("\n");
}

function extractPhones(text) {
  return String(text ?? "").match(/(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}/g) || [];
}

function extractDomains(text) {
  const matches = String(text ?? "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|https?:\/\/[^\s|;]+|(?:www\.)?[a-z0-9.-]+\.[a-z]{2,}(?:\/[^\s|;]+)?/gi) || [];
  const domains = [];

  for (const match of matches) {
    const normalized = normalizeDomain(match);
    if (!normalized || GENERIC_EMAIL_DOMAINS.has(normalized)) {
      continue;
    }
    domains.push(normalized);
  }

  return Array.from(new Set(domains));
}

function extractAddresses(text) {
  const source = String(text ?? "");
  const strict = source.match(/\b\d{1,6}\s+[A-Za-z0-9.'#,\-/ ]{3,140}(?:Ontario|ON)[ ,]+[A-Z]\d[A-Z][ -]?\d[A-Z]\d\b/gi) || [];
  const loose = source.match(/\b\d{1,6}\s+[A-Za-z0-9.'#&/\- ]{2,90}\b(?:street|st|avenue|ave|road|rd|drive|dr|boulevard|blvd|lane|ln|court|ct|way|parkway|pkwy|highway|hwy|crescent|cres|circle|cir)\b(?:\s+(?:north|south|east|west|n|s|e|w))?(?:\s*(?:unit|suite|ste|#)\s*[A-Za-z0-9-]+)?/gi) || [];
  return Array.from(new Set([...loose, ...strict]));
}
