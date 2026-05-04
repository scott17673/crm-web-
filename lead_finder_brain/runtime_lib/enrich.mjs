const CONTACT_PATH_HINTS = [
  "/our-brewery",
  "/our-team",
  "/people",
  "/leadership",
  "/team",
  "/management",
  "/operations",
  "/products",
  "/product",
  "/beers",
  "/beer",
  "/coffee",
  "/roastery",
  "/shop",
  "/locations",
  "/location",
  "/facilities",
  "/facility",
  "/plant",
  "/plants",
  "/manufacturing",
  "/capabilities",
  "/contact",
  "/contact-us",
  "/about",
  "/about-us",
  "/our-story",
  "/who-we-are",
  "/news",
  "/newsroom",
  "/careers",
  "/jobs"
];

const TITLE_KEYWORDS = [
  "maintenance",
  "reliability",
  "facilities",
  "facility",
  "plant manager",
  "operations manager",
  "operations",
  "engineering manager",
  "engineering",
  "manufacturing manager",
  "production manager",
  "production supervisor",
  "quality assurance manager",
  "quality manager",
  "health & safety",
  "technical services",
  "equipment manager",
  "plant supervisor",
  "director of operations",
  "site manager",
  "president",
  "vice president",
  "vp",
  "brewmaster",
  "master brewer",
  "chief executive officer",
  "ceo",
  "owner",
  "founder"
];
const REQUEST_TIMEOUT_MS = 3500;

export async function enrichFromWebsite(websiteUrl, options = {}) {
  if (!websiteUrl) {
    return emptyWebsiteEnrichment();
  }

  const pageLimit = options.pageLimit ?? 5;
  const visited = new Set();
  const queue = [ensureHttpUrl(websiteUrl)];
  const pages = [];

  while (queue.length && pages.length < pageLimit) {
    const nextUrl = queue.shift();
    if (!nextUrl || visited.has(nextUrl)) {
      continue;
    }

    visited.add(nextUrl);

    try {
      const page = await fetchPage(nextUrl);
      if (!page) {
        continue;
      }

      pages.push(page);
      for (const link of page.links) {
        if (pages.length + queue.length >= pageLimit) {
          break;
        }
        if (!visited.has(link)) {
          queue.push(link);
        }
      }
    } catch {
      continue;
    }
  }

  const combinedText = pages.map((page) => page.text).join("\n");
  const linkedInLinks = uniqueOrdered(pages.flatMap((page) => page.linkedinLinks));
  const faxes = uniqueOrdered(pages.flatMap((page) => page.faxes));
  const phones = uniqueOrdered(pages.flatMap((page) => page.phones));
  const emails = uniqueOrdered(pages.flatMap((page) => page.emails));
  const addresses = uniqueOrdered(pages.flatMap((page) => page.addresses));
  const contacts = dedupeContacts([
    ...pages.flatMap((page) => page.contacts || []),
    ...extractContacts(combinedText, emails, linkedInLinks)
  ]);
  const endProducts = uniqueOrdered([
    ...pages.map((page) => page.endProducts || ""),
    guessEndProducts(combinedText)
  ]).find(Boolean) || "";
  const expectedCity = String(options.expectedCity ?? "").toLowerCase();

  return {
    website: pages[0]?.origin || ensureHttpUrl(websiteUrl),
    companyName: pickCompanyName(pages, websiteUrl),
    formattedAddress: pickBestAddress(addresses, expectedCity),
    phone: phones[0] || "",
    fax: faxes[0] || "",
    endProducts,
    maintenanceContacts: contacts.map(formatContact).join(" | "),
    linkedinLinks: linkedInLinks.join(" | "),
    combinedText,
    addresses,
    faxes,
    phones,
    contacts,
    linkedInLinkList: linkedInLinks
  };
}

function emptyWebsiteEnrichment() {
  return {
    website: "",
    companyName: "",
    formattedAddress: "",
    phone: "",
    fax: "",
    endProducts: "",
    maintenanceContacts: "",
    linkedinLinks: "",
    combinedText: "",
    addresses: [],
    faxes: [],
    phones: [],
    contacts: [],
    linkedInLinkList: []
  };
}

async function fetchPage(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "find-manufacturers-bot/0.1"
    },
    redirect: "follow",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });

  const contentType = response.headers.get("content-type") || "";
  if (!response.ok || !contentType.includes("text/html")) {
    return null;
  }

  const html = await response.text();
  const resolvedUrl = response.url;
  const base = new URL(resolvedUrl);
  const text = htmlToText(html);
  const faxes = extractFaxes(text);

  return {
    url: resolvedUrl,
    origin: base.origin,
    title: extractTitle(html),
    h1: extractH1(html),
    siteName: extractMetaSiteName(html) || extractSchemaOrganizationName(html),
    text,
    links: extractInterestingLinks(html, base),
    faxes,
    phones: extractPhones(text, faxes),
    emails: extractEmails(text),
    addresses: extractAddresses(text),
    linkedinLinks: extractLinkedInLinks(html, base),
    contacts: extractStructuredContacts(html),
    endProducts: guessEndProducts(`${text}\n${extractMetaDescription(html)}`)
  };
}

function extractMetaDescription(html) {
  const match = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
  return match ? decodeHtmlEntities(match[1]) : "";
}

function extractStructuredContacts(html) {
  const contacts = [];
  const pairPatterns = [
    /<h[1-4][^>]*>\s*([^<]{3,80})\s*<\/h[1-4]>[\s\S]{0,600}?<p[^>]*>\s*([^<]{3,120})\s*<\/p>/gi,
    /<div[^>]*class="[^"]*section__title-text[^"]*"[^>]*>\s*([^<]{3,80})\s*<\/(?:div|h2)>[\s\S]{0,500}?<p[^>]*>\s*([^<]{3,120})\s*<\/p>/gi
  ];

  for (const pattern of pairPatterns) {
    for (const match of html.matchAll(pattern)) {
      const name = cleanCompanyName(htmlToText(match[1]));
      const title = cleanSentence(htmlToText(match[2]));
      if (!looksLikePersonName(name) || !isLikelyLeadershipTitle(title)) {
        continue;
      }

      contacts.push({
        name,
        title,
        email: "",
        linkedin: ""
      });
    }
  }

  return dedupeContacts(contacts).slice(0, 10);
}

function extractInterestingLinks(html, baseUrl) {
  const hrefRegex = /href\s*=\s*["']([^"'#]+)["']/gi;
  const discovered = [];
  let match;

  while ((match = hrefRegex.exec(html))) {
    try {
      const resolved = new URL(match[1], baseUrl).toString();
      const parsed = new URL(resolved);
      if (parsed.origin !== baseUrl.origin) {
        continue;
      }

      const pathname = parsed.pathname.toLowerCase();
      const priority = getInterestingLinkPriority(pathname);
      if (priority !== -1) {
        discovered.push({
          url: resolved,
          priority
        });
      }
    } catch {
      continue;
    }
  }

  return uniqueOrdered(
    discovered
      .sort((left, right) => left.priority - right.priority)
      .map((entry) => entry.url)
  );
}

function extractLinkedInLinks(html, baseUrl) {
  const urlRegex = /https?:\/\/[^\s"'<>]+/gi;
  const hrefRegex = /href\s*=\s*["']([^"']+)["']/gi;
  const links = [];
  let match;

  while ((match = urlRegex.exec(html))) {
    if (match[0].includes("linkedin.com/")) {
      links.push(cleanUrl(match[0]));
    }
  }

  while ((match = hrefRegex.exec(html))) {
    try {
      const resolved = new URL(match[1], baseUrl).toString();
      if (resolved.includes("linkedin.com/")) {
        links.push(cleanUrl(resolved));
      }
    } catch {
      continue;
    }
  }

  return uniqueOrdered(links);
}

function extractEmails(text) {
  return uniqueOrdered(text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []);
}

function extractPhones(text, excluded = []) {
  const matches = text.match(/(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}/g) || [];
  const excludedPhones = new Set(excluded.map(normalizePhone));
  return uniqueOrdered(matches).filter((value) => !excludedPhones.has(normalizePhone(value)));
}

function extractFaxes(text) {
  const lines = splitIntoLines(text);
  const faxes = [];

  for (const line of lines) {
    if (!/\b(?:fax|facsimile)\b/i.test(line) && !/\bF\s*:/i.test(line)) {
      continue;
    }

    const matches = line.match(/(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}/g) || [];
    faxes.push(...matches);
  }

  return uniqueOrdered(faxes);
}

function extractAddresses(text) {
  const lines = splitIntoLines(text);
  const candidates = [];

  for (let index = 0; index < lines.length; index += 1) {
    for (let span = 1; span <= 3 && index + span <= lines.length; span += 1) {
      const candidate = cleanAddress(lines.slice(index, index + span).join(", "));
      if (!looksLikeOntarioAddress(candidate)) {
        continue;
      }

      candidates.push(candidate);
    }
  }

  return uniqueOrdered(candidates);
}

function extractContacts(text, emails, linkedInLinks) {
  const snippets = splitIntoSnippets(text);
  const contacts = [];

  for (const snippet of snippets) {
    const lower = snippet.toLowerCase();
    if (!TITLE_KEYWORDS.some((keyword) => lower.includes(keyword))) {
      continue;
    }

    const email = emails.find((entry) => lower.includes(entry.toLowerCase()));
    const linkedin = linkedInLinks.find((entry) => lower.includes(entry.toLowerCase()));
    const nameMatch = snippet.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z.'-]+){1,2})\b/);
    const title = TITLE_KEYWORDS.find((keyword) => lower.includes(keyword)) || "";
    const name = nameMatch?.[1] || "";

    if (!looksLikePersonName(name) || !title || name.toLowerCase() === title.toLowerCase()) {
      continue;
    }

    contacts.push({
      name,
      title,
      email: email || "",
      linkedin: linkedin || ""
    });
  }

  return dedupeContacts(contacts).slice(0, 8);
}

function pickCompanyName(pages, websiteUrl) {
  const candidates = [];
  const hostTokens = buildHostNameTokens(websiteUrl);
  const counts = new Map();

  for (const page of pages) {
    if (page.siteName) {
      candidates.push(cleanCompanyName(page.siteName));
    }
    if (page.title) {
      candidates.push(cleanCompanyName(page.title));
    }
    if (page.h1) {
      candidates.push(cleanCompanyName(page.h1));
    }
  }

  for (const candidate of candidates) {
    if (!candidate || candidate.length < 3 || isGenericPageLabel(candidate)) {
      continue;
    }

    const key = candidate.toLowerCase();
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  let best = "";
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const candidate of candidates) {
    if (!candidate || candidate.length < 3 || isGenericPageLabel(candidate)) {
      continue;
    }

    const score = scoreCompanyNameCandidate(candidate, hostTokens, counts.get(candidate.toLowerCase()) || 1);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  if (best) {
    return best.replace(/\.$/, "");
  }

  try {
    const host = new URL(ensureHttpUrl(websiteUrl)).hostname.replace(/^www\./, "");
    return host
      .split(".")[0]
      .replace(/[-_]+/g, " ")
      .replace(/([a-z])(\d)/gi, "$1 $2")
      .replace(/(\d)([a-z])/gi, "$1 $2")
      .replace(/\b\w/g, (character) => character.toUpperCase());
  } catch {
    return "";
  }
}

function pickBestAddress(addresses, expectedCity) {
  if (!addresses.length) {
    return "";
  }

  if (expectedCity) {
    const cityMatch = addresses.find((address) => address.toLowerCase().includes(expectedCity));
    if (cityMatch) {
      return cityMatch;
    }
  }

  return addresses[0];
}

function dedupeContacts(contacts) {
  const seen = new Set();
  const unique = [];

  for (const contact of contacts) {
    const key = `${contact.name.toLowerCase()}::${contact.title.toLowerCase()}::${contact.email.toLowerCase()}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(contact);
  }

  return unique;
}

function formatContact(contact) {
  return [contact.name, contact.title, contact.email, contact.linkedin].filter(Boolean).join(" - ");
}

function splitIntoSnippets(text) {
  return text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length >= 20 && line.length <= 320);
}

function splitIntoLines(text) {
  return String(text || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function guessEndProducts(text) {
  const normalized = text.replace(/\s+/g, " ").trim();
  const sectionProducts = extractSectionProducts(text);
  if (sectionProducts) {
    return sectionProducts;
  }

  const keywordProducts = extractKeywordProducts(text);
  if (keywordProducts) {
    return keywordProducts;
  }

  const beerProducts = extractBeerProducts(text);
  if (beerProducts) {
    return beerProducts;
  }

  const patterns = [
    /\b(?:manufactures?|produces?|makes?|fabricates?|supplies?|specializes in)\s+([^.!?;:]{10,120})/i,
    /\b(?:leading manufacturer of|supplier of|producer of)\s+([^.!?;:]{10,120})/i,
    /\b(?:our products include|products include)\s+([^.!?;:]{10,120})/i,
    /\b(?:committed to brewing)\s+([^.!?;:]{10,120})/i,
    /\b(?:award-winning craft beer|craft beer|quality beer)\b/i
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match?.[1]) {
      const candidate = cleanSentence(match[1]);
      if (!isBadProductSummary(candidate)) {
        return candidate;
      }
    }
    if (match && /craft beer|quality beer/i.test(match[0])) {
      return beerProducts || "craft beer";
    }
  }

  if (/\b(ale|lager)s?\b/i.test(normalized)) {
    return "ales and lagers";
  }

  if (/\b(craft beer|brewing beer|brew outstanding beer|quality beer|beer artisans)\b/i.test(normalized)) {
    return "craft beer";
  }

  if (/\bbeer\b/i.test(normalized) && /\b(brewery|breweries|brewer|brewing|brews)\b/i.test(normalized)) {
    return /\bcraft\b/i.test(normalized) ? "craft beer" : "beer";
  }

  if (/\b(coffee|espresso|whole bean|specialty coffee|roasted coffee)\b/i.test(normalized) &&
    /\b(roastery|roaster|roasters|roasting|coffee roasters?)\b/i.test(normalized)) {
    return "roasted coffee and whole bean coffee";
  }

  return "";
}

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, "\n")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{2,}/g, "\n")
    .replace(/\s+\.$/, "")
    .replace(/\s+\.$/, "")
    .trim();
}

function extractTitle(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? cleanCompanyName(htmlToText(match[1])) : "";
}

function extractH1(html) {
  const match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  return match ? cleanCompanyName(htmlToText(match[1])) : "";
}

function cleanCompanyName(text) {
  return decodeHtmlEntities(String(text ?? ""))
    .replace(/\s+/g, " ")
    .replace(/\b(home|welcome|contact us|about us)\b/gi, "")
    .replace(/\s+[|:]\s+.*/, "")
    .replace(/\s+[–-]\s+(local .*|making .* possible|over \d+.*|company .*|our story.*|who we are.*)$/i, "")
    .trim();
}

function isGenericPageLabel(value) {
  return new Set([
    "team",
    "our team",
    "leadership",
    "our leadership team",
    "products",
    "our products",
    "our beers",
    "our brewery",
    "about",
    "about us",
    "home",
    "contact",
    "contact us"
  ]).has(cleanCompanyName(value).toLowerCase());
}

function cleanSentence(text) {
  return text
    .replace(/\s+/g, " ")
    .replace(/\b(learn more|read more|contact us)\b.*$/i, "")
    .replace(/\s+\|.*$/g, "")
    .trim();
}

function cleanAddress(text) {
  return text
    .replace(/\s+/g, " ")
    .replace(/\s+,/g, ",")
    .replace(/^(pickup available, usually ready in \d+ hours,\s*)/i, "")
    .replace(/^(view project,\s*)/i, "")
    .replace(/^(head office,\s*)/i, "")
    .trim();
}

function cleanUrl(url) {
  return url
    .split("&quot;")[0]
    .split("\\u0026quot;")[0]
    .split('"')[0]
    .replace(/[),.;]+$/, "");
}

function ensureHttpUrl(value) {
  if (/^https?:\/\//i.test(value)) {
    return value;
  }
  return `https://${value}`;
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&#8211;|&#x2013;|&ndash;/gi, "-")
    .replace(/&#8212;|&#x2014;|&mdash;/gi, "-")
    .replace(/&#8216;|&#8217;|&rsquo;|&lsquo;/gi, "'")
    .replace(/&#8220;|&#8221;|&ldquo;|&rdquo;/gi, '"')
    .replace(/&#38;|&amp;/gi, "&")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, " ");
}

function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "");
}

function getInterestingLinkPriority(pathname) {
  const index = CONTACT_PATH_HINTS.findIndex((hint) => pathname.includes(hint));
  return index === -1 ? -1 : index;
}

function extractSectionProducts(text) {
  const lines = splitIntoLines(text);
  const headings = new Set([
    "our beers",
    "our beer",
    "products",
    "our products",
    "product offerings",
    "product lines",
    "services offered",
    "beers",
    "coffee",
    "our coffee",
    "our coffees"
  ]);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].toLowerCase();
    if (!headings.has(line)) {
      continue;
    }

    const candidates = [];
    for (let cursor = index + 1; cursor < Math.min(lines.length, index + 9); cursor += 1) {
      const entry = cleanSentence(lines[cursor]);
      if (!entry || entry.length > 60) {
        continue;
      }

      if (isSectionBoundary(entry, headings)) {
        break;
      }

      if (!/[A-Za-z]/.test(entry)) {
        continue;
      }

      if (!looksLikeProductEntry(entry)) {
        continue;
      }

      candidates.push(entry);
    }

    if (candidates.length >= 2) {
      const candidate = uniqueOrdered(candidates).slice(0, 5).join(", ");
      if (!isBadProductSummary(candidate)) {
        return candidate;
      }
    }
  }

  return "";
}

function extractBeerProducts(text) {
  const candidates = splitIntoLines(text)
    .map((line) => cleanSentence(line))
    .filter((line) => line.length >= 3 && line.length <= 40)
    .filter((line) => /\b(lager|ale|ipa|pilsner|stout|porter|kolsch|wheat|beer)\b/i.test(line))
    .filter((line) => !isBadProductSummary(line));

  if (!candidates.length) {
    return "";
  }

  const candidate = uniqueOrdered(candidates).slice(0, 5).join(", ");
  return isBadProductSummary(candidate) ? "" : candidate;
}

function looksLikePersonName(value) {
  const normalized = String(value || "").trim();
  if (!/^[A-Z][A-Za-z.'’-]+(?:\s+[A-Z][A-Za-z.'’-]+){1,3}$/.test(normalized)) {
    return false;
  }

  return !/\b(president|manager|director|operations|staff|team|office|sales|vice|chief|engineer|coordinator)\b/i.test(normalized);
}

function isLikelyLeadershipTitle(value) {
  const lower = String(value || "").toLowerCase();
  if (!lower) {
    return false;
  }

  return TITLE_KEYWORDS.some((keyword) => lower.includes(keyword)) ||
    /\b(manager|director|president|vice president|vp|owner|founder|brewmaster|engineer|supervisor|lead|coordinator|executive|chief)\b/.test(lower);
}

function isBadProductSummary(value) {
  const lower = cleanSentence(value).toLowerCase();
  return !lower ||
    lower.length > 160 ||
    /(copyright|all rights reserved|home shop about|team contact hours|log in contact|faqs|hours log in|an even greater impact|challenge asks employees|sign in to see|gift cards|subscriptions|merch|brewing equipment|classes|events|store locator|find a cafe|create your|stop by|atmosphere of coffee appreciation)/i.test(lower);
}

function uniqueOrdered(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function looksLikeOntarioAddress(value) {
  const candidate = cleanAddress(value);
  if (!candidate || candidate.length < 14 || candidate.length > 220) {
    return false;
  }

  const lower = candidate.toLowerCase();
  if (/\b(head office|corporate office|media enquiries)\b/.test(lower)) {
    return false;
  }

  const streetPattern = /\b\d{1,6}\s+[A-Za-z0-9.'#&,\-/ ]{4,160}\b/i;
  const ontarioPattern = /\b(?:Ontario|ON)\b/i;
  const postalPattern = /\b[A-Z]\d[A-Z][ -]?\d[A-Z]\d\b/i;
  const streetTypePattern = /\b(st|street|ave|avenue|rd|road|dr|drive|blvd|boulevard|lane|ln|court|ct|way|pkwy|parkway|circle|cir|cres|crescent|trail|trl|suite|unit)\b/i;
  const cityPattern = /\b(toronto|milton|burlington|oakville|mississauga|brampton|ancaster|hamilton|markham|guelph|kitchener|cambridge|waterloo|vaughan|north york|etobicoke|scarborough|stouffville|richmond hill|woodbridge|brantford)\b/i;

  return streetPattern.test(candidate) &&
    (ontarioPattern.test(candidate) || cityPattern.test(lower)) &&
    (postalPattern.test(candidate) || streetTypePattern.test(candidate));
}

function extractMetaSiteName(html) {
  const ogMatch = html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i);
  if (ogMatch?.[1]) {
    return decodeHtmlEntities(ogMatch[1]);
  }

  const twitterMatch = html.match(/<meta[^>]+name=["']twitter:site["'][^>]+content=["']([^"']+)["']/i);
  return twitterMatch?.[1] ? decodeHtmlEntities(twitterMatch[1]).replace(/^@/, "") : "";
}

function extractSchemaOrganizationName(html) {
  const blocks = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const block of blocks) {
    const decoded = decodeHtmlEntities(block[1] || "").trim();
    if (!decoded) {
      continue;
    }

    try {
      const parsed = JSON.parse(decoded);
      const queue = Array.isArray(parsed) ? [...parsed] : [parsed];
      while (queue.length) {
        const node = queue.shift();
        if (!node || typeof node !== "object") {
          continue;
        }

        const type = Array.isArray(node["@type"]) ? node["@type"].join(" ") : String(node["@type"] || "");
        if (/\b(Organization|Corporation|LocalBusiness|FoodEstablishment)\b/i.test(type) && node.name) {
          return decodeHtmlEntities(String(node.name));
        }

        if (Array.isArray(node["@graph"])) {
          queue.push(...node["@graph"]);
        }
      }
    } catch {
      continue;
    }
  }

  return "";
}

function buildHostNameTokens(websiteUrl) {
  try {
    return new URL(ensureHttpUrl(websiteUrl)).hostname
      .replace(/^www\./, "")
      .split(".")[0]
      .replace(/([a-z])(\d)/gi, "$1 $2")
      .replace(/(\d)([a-z])/gi, "$1 $2")
      .split(/[^a-z0-9]+/i)
      .filter((token) => token.length >= 2)
      .map((token) => token.toLowerCase());
  } catch {
    return [];
  }
}

function scoreCompanyNameCandidate(candidate, hostTokens, occurrences) {
  const lower = candidate.toLowerCase();
  let score = occurrences * 3;

  if (hostTokens.some((token) => lower.includes(token))) {
    score += 6;
  }

  if (candidate.split(/\s+/).length <= 4) {
    score += 2;
  }

  if (/\b(404|not found|official site)\b/.test(lower)) {
    score -= 8;
  }

  if (/\b(company|solutions|services)\b/.test(lower) && !hostTokens.some((token) => lower.includes(token))) {
    score -= 3;
  }

  return score;
}

function isSectionBoundary(value, headings) {
  const lower = cleanSentence(value).toLowerCase();
  return headings.has(lower) ||
    /^(home|about|careers|contact|locations|our people|our history|our story|our expertise|our projects|leadership team|clients|subcontractors|online ordering|ready to join us\?)$/i.test(lower);
}

function looksLikeProductEntry(value) {
  const lower = cleanSentence(value).toLowerCase();
  if (!lower || lower.length > 60) {
    return false;
  }

  if (/(gift card|subscription|merch|equipment|class|event|careers|about|history|vision|people|location|store locator|find a cafe|online ordering|join|sourcing|tasting|development|full potential|pilot coffee roasters)/i.test(lower)) {
    return false;
  }

  return /\b(beer|lager|ale|ipa|pilsner|stout|porter|coffee|espresso|whole bean|roast|bakery|bread|bagel|pastry|cake|cookie|meat|sausage|poultry|duck|cheese|dairy|salad|sauce|asphalt|aggregate|cement|concrete|redi-rock|polymer|plastic|recycling|ldpe|hdpe|hmwpe|polypropylene|polycarbonate|pet|hips|gpps|ops|pc\/abs|abs|pelletizing|regrind|paper|cardboard|aluminum|copper|stainless steel|brass)\b/i.test(lower) ||
    /^(aggregates|cement|hot mix asphalt|material transportation|ready mix concrete|redi-rock)$/i.test(lower);
}

function extractKeywordProducts(text) {
  const lines = splitIntoLines(text)
    .map((line) => cleanSentence(line))
    .filter((line) => line.length >= 3 && line.length <= 60)
    .filter((line) => looksLikeProductEntry(line));

  if (!lines.length) {
    return "";
  }

  const candidate = uniqueOrdered(lines).slice(0, 6).join(", ");
  return isBadProductSummary(candidate) ? "" : candidate;
}
