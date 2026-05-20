import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { enrichFromWebsite } from "./runtime_lib/enrich.mjs";
import { searchWeb } from "./runtime_lib/web-search.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const outDir = path.join(__dirname, "output");
const cacheDir = path.join(__dirname, "cache");
const stamp = new Date().toISOString().slice(0, 10);
const outputPath = path.join(outDir, `gta-public-manufacturer-census-100-${stamp}.csv`);
const summaryPath = path.join(outDir, `gta-public-manufacturer-census-100-${stamp}.json`);

const ONTARIO_MADE_SITEMAP = "https://supportontariomade.ca/sitemap.xml";
const CFIA_CSV = "https://apps.inspection.canada.ca/webapps/foodlicenceregistry/en/FoodLicenceRegistry/DownloadFoodLicenceList/?language=e&downloadType=csv";
const CRM_CONFIG_PATH = path.join(repoRoot, "crm-config.js");
const TARGET_COUNT = Number(process.env.CENSUS_TARGET_COUNT || 100);
const MIN_SCORE = Number(process.env.CENSUS_MIN_SCORE || 32);
const PAGE_FETCH_CONCURRENCY = Number(process.env.CENSUS_PAGE_CONCURRENCY || 14);
const PUBLIC_ENRICH_CONCURRENCY = Number(process.env.CENSUS_PUBLIC_ENRICH_CONCURRENCY || 5);
const CONTACT_SEARCH_CONCURRENCY = Number(process.env.CENSUS_CONTACT_CONCURRENCY || 5);
const CONTACT_SEARCH_ENABLED = process.env.CENSUS_SKIP_CONTACTS !== "1";
const PUBLIC_ENRICH_ENABLED = process.env.CENSUS_SKIP_PUBLIC_ENRICH !== "1";

const TARGET_CITY_SLUGS = new Set([
  "milton",
  "mississauga",
  "brampton",
  "oakville",
  "burlington",
  "hamilton",
  "ancaster",
  "toronto",
  "etobicoke",
  "north-york",
  "scarborough",
  "vaughan",
  "woodbridge",
  "concord",
  "markham",
  "richmond-hill",
  "whitchurch-stouffville",
  "stouffville",
  "georgetown",
  "halton-hills",
  "acton",
  "guelph",
  "cambridge",
  "kitchener",
  "waterloo",
  "brantford",
  "stoney-creek",
  "grimsby",
  "dundas",
  "caledon",
  "bolton",
  "paris",
  "ayr",
  "flamborough",
  "ajax",
  "pickering",
  "oshawa",
  "whitby",
  "newmarket",
  "aurora",
  "uxbridge",
  "orangeville",
  "barrie",
  "innisfil",
  "niagara-falls",
  "st-catharines",
  "welland",
  "thorold",
  "alliston",
  "nobleton",
  "king-city",
  "maple",
  "east-york",
  "york"
]);

const INDUSTRIAL_KEYWORDS = [
  "manufacturer",
  "manufacturing",
  "production",
  "factory",
  "plant",
  "facility",
  "processing",
  "fabrication",
  "fabricating",
  "machining",
  "cnc",
  "stamping",
  "molding",
  "moulding",
  "extrusion",
  "assembly",
  "welding",
  "metal",
  "steel",
  "aluminum",
  "plastic",
  "rubber",
  "packaging",
  "converting",
  "printing",
  "bottling",
  "batching",
  "mixing",
  "bakery",
  "food",
  "beverage",
  "sauce",
  "mix",
  "private label",
  "bulk",
  "commercial",
  "industrial",
  "automotive",
  "component",
  "parts",
  "equipment",
  "precast",
  "concrete",
  "cabinet",
  "millwork",
  "wood",
  "furniture",
  "windows",
  "doors",
  "pharmaceutical",
  "cosmetic",
  "chemical",
  "iso"
];

const STRONG_INDUSTRY_PATTERN = /\b(?:industrial|automotive|component|parts?|equipment|machine|machining|cnc|fabricat|welding|stamping|metal|steel|aluminum|plastic|rubber|packag|printing|converting|food|beverage|bakery|sauce|mix(?:es)?|private label|bulk|processing|bottling|precast|concrete|cabinet|millwork|wood products?|windows?|doors?|pharmaceutical|cosmetic|chemical|medical device|electronics?)\b/i;
const STRONG_CATEGORY_PATTERN = /\b(?:Industrial|Automotive|Food|Beverage|Home|Construction|Tools|Equipment|Health|Beauty|Components|Building|Packaging|Furniture|Wood|Metal|Plastics?)\b/i;
const NOISE_PATTERN = /\b(?:handmade|hand-crafted|hand crafted|artisan|jewelry|jewellery|crochet|knit|painting|fine art|printable|digital marketing|seo|consulting|photography|wedding|soap|candle|bath bomb|apothecary|tarot|crystal|boutique|fashion|apparel|t-shirt|t shirt|skincare only|skin care only|one woman|home-based|home based|small batch candles|hand poured)\b/i;
const FOOD_PRODUCTION_NAME_PATTERN = /\b(?:food|foods|meat|bakery|baker|baking|beverage|brewing|brewery|coffee|roast|dairy|cheese|creamery|chocolate|confection|candy|spice|sauce|snack|nutrition|protein|meal|pasta|noodle|cookie|bread|cake|pastry|dessert|seafood|fish|poultry|sausage|smokehouse|processing|processor|manufactur|packaging|packing|mill|mills|flour|grain|seed|produce|greenhouse|ferment|kombucha|juice|water|tea|distill|winery|vineyard|cereal|frozen|oil|vinegar|dressings?)\b/i;
const CFIA_RETAIL_NOISE_PATTERN = /\b(?:restaurant|grill|bar\b|cafe|catering|supermarket|grocery|groceries|market|mart|store|shop|retail|trading|trade|import|imports|importing|export|exports|wholesale|wholesaler|distribution|distributing|distributor|distributors|logistics|warehouse|supplier|suppliers|supply|farmers market|incubator|clinic|pharmacy|hotel|banquet|kitchen|delivery|ecommerce|e-commerce|variety|convenience|school|medical supply)\b/i;
const OPS_TITLE_PATTERN = /\b(?:plant manager|plant supervisor|operations manager|operations supervisor|director of operations|production manager|production supervisor|maintenance manager|maintenance supervisor|quality manager|quality assurance manager|manufacturing manager|engineering manager|facility manager|warehouse manager|logistics manager|supply chain manager|procurement manager|purchasing manager|general manager|president|owner|founder|coo|chief operating officer)\b/i;
const GENERIC_WEBSITE_TOKENS = new Set([
  "food",
  "foods",
  "beer",
  "beverage",
  "beverages",
  "baker",
  "brewing",
  "brewery",
  "bakery",
  "baking",
  "dairy",
  "cheese",
  "chocolate",
  "candy",
  "sauce",
  "spice",
  "spices",
  "hot",
  "nutrition",
  "canadian",
  "coffee",
  "meat",
  "poultry",
  "seafood",
  "frozen",
  "products",
  "product",
  "inc",
  "ltd",
  "limited",
  "corp",
  "corporation"
]);

async function main() {
  await fs.mkdir(outDir, { recursive: true });
  await fs.mkdir(cacheDir, { recursive: true });
  const [crmRows, cfiaRows, sitemapXml] = await Promise.all([
    loadCrmManufacturers(),
    loadCfiaRows(),
    fetchCachedText(ONTARIO_MADE_SITEMAP, path.join(cacheDir, "ontario-made-sitemap.xml"), 24 * 60 * 60 * 1000)
      .catch((error) => {
        console.warn(`Ontario Made sitemap unavailable (${error.message}); continuing with CFIA registry rows.`);
        return "";
      })
  ]);

  const crmIndex = buildCrmIndex(crmRows);
  const cfiaIndex = buildCfiaIndex(cfiaRows);
  const sourceUrls = parseOntarioMadeManufacturerUrls(sitemapXml)
    .filter((entry) => TARGET_CITY_SLUGS.has(entry.citySlug));

  console.log(`CRM baseline: ${crmRows.length} manufacturers`);
  console.log(`Ontario Made manufacturer pages in target cities: ${sourceUrls.length}`);
  console.log(`CFIA registry rows loaded: ${cfiaRows.length}`);

  const pages = await mapLimit(sourceUrls, PAGE_FETCH_CONCURRENCY, async (entry, index) => {
    if (index && index % 250 === 0) {
      console.log(`Checked ${index}/${sourceUrls.length} Ontario Made pages...`);
    }
    try {
      const cacheName = `ontario-made-${slugFilename(entry.url)}.html`;
      const html = await fetchCachedText(entry.url, path.join(cacheDir, cacheName), 14 * 24 * 60 * 60 * 1000, 25000);
      return parseOntarioMadePage(entry, html);
    } catch {
      return null;
    }
  });

  const profiles = pages
    .filter(Boolean)
    .map((profile) => attachEvidence(profile, cfiaIndex, crmIndex))
    .filter((profile) => profile.score >= MIN_SCORE && !profile.crmDuplicate)
    .sort((left, right) => right.score - left.score || left.company.localeCompare(right.company));

  const cfiaProfiles = cfiaRows
    .map((row) => parseCfiaProfile(row, crmIndex))
    .filter((profile) => profile && profile.score >= MIN_SCORE && !profile.crmDuplicate);
  const deduped = dedupeProfiles([...profiles, ...cfiaProfiles])
    .sort((left, right) => right.score - left.score || left.company.localeCompare(right.company));
  const selected = pickBalanced(deduped, TARGET_COUNT);

  if (PUBLIC_ENRICH_ENABLED) {
    console.log(`Resolving websites, emails, and public contacts for ${selected.length} selected companies...`);
    await mapLimit(selected, PUBLIC_ENRICH_CONCURRENCY, async (profile, index) => {
      if (index && index % 20 === 0) {
        console.log(`Public info checked ${index}/${selected.length}...`);
      }
      await enrichSelectedProfile(profile);
      return profile;
    });
  }

  const rows = selected.map(toOutputRow);
  await fs.writeFile(outputPath, toCsv(rows), "utf8");
  await fs.writeFile(summaryPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    outputPath,
    targetCount: TARGET_COUNT,
    crmManufacturersLoaded: crmRows.length,
    ontarioMadeTargetPages: sourceUrls.length,
    cfiaRowsLoaded: cfiaRows.length,
    qualifiedOntarioMadeProfiles: profiles.length,
    dedupedProfiles: deduped.length,
    selected: rows.length,
    publicEnrichEnabled: PUBLIC_ENRICH_ENABLED,
    contactSearchEnabled: CONTACT_SEARCH_ENABLED,
    rowsWithPublicOpsContact: selected.filter((profile) => (profile.contacts || []).length).length,
    selectedByCity: countBy(rows, "city"),
    selectedByProductType: countProductTypes(selected)
  }, null, 2), "utf8");

  console.log(`Wrote ${rows.length} rows`);
  console.log(outputPath);
  console.log(summaryPath);
}

async function loadCrmManufacturers() {
  const configText = await fs.readFile(CRM_CONFIG_PATH, "utf8");
  const match = configText.match(/window\.CRM_CONFIG\s*=\s*(\{[\s\S]*?\})\s*;?\s*$/);
  if (!match) {
    throw new Error(`Could not parse CRM config: ${CRM_CONFIG_PATH}`);
  }
  const config = JSON.parse(match[1]);
  const base = config.supabaseUrl.replace(/\/+$/, "") + "/rest/v1";
  const headers = {
    apikey: config.supabaseAnonKey,
    Authorization: `Bearer ${config.supabaseAnonKey}`,
    Accept: "application/json"
  };
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const url = `${base}/manufacturers?select=${encodeURIComponent("id,company,industry,end_product,tags")}&limit=1000&offset=${offset}`;
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
    if (!response.ok) {
      throw new Error(`Supabase manufacturers read failed: ${response.status} ${await response.text()}`);
    }
    const batch = await response.json();
    rows.push(...batch);
    if (batch.length < 1000) {
      break;
    }
  }
  return rows;
}

async function loadCfiaRows() {
  const text = await fetchText(CFIA_CSV, 60000);
  return parseCsv(text).map((row) => ({
    licence: cleanText(row["Food licence number"]),
    legalName: cleanText(row["Legal name"]),
    address: cleanText(row.Address),
    dba: cleanText(row["Also doing business as"]),
    establishments: cleanText(row["Included establishments"])
  }));
}

function buildCrmIndex(rows) {
  const normalizedNames = rows.map((row) => ({
    id: row.id,
    company: cleanText(row.company),
    norm: normalizeCompanyName(row.company),
    websiteHost: hostname(row.website || "")
  })).filter((row) => row.norm);
  return { normalizedNames };
}

function buildCfiaIndex(rows) {
  const byName = new Map();
  for (const row of rows) {
    for (const name of [row.legalName, row.dba].filter(Boolean)) {
      const key = normalizeCompanyName(name);
      if (!key) continue;
      const existing = byName.get(key) || [];
      existing.push(row);
      byName.set(key, existing);
    }
  }
  return { byName, rows };
}

function parseOntarioMadeManufacturerUrls(xml) {
  const urls = [];
  const pattern = /<loc>(https:\/\/supportontariomade\.ca\/manufacturer\/([^/<]+)\/[^<]+)<\/loc>/g;
  for (const match of xml.matchAll(pattern)) {
    urls.push({
      url: decodeHtml(match[1]),
      citySlug: cleanSlug(match[2])
    });
  }
  return uniqueBy(urls, (entry) => entry.url);
}

function parseOntarioMadePage(entry, html) {
  const mainBlock = firstMatch(html, /<div class="row manufacturer-page-logo">([\s\S]*?)<\/div><div class="container">/i) ||
    firstMatch(html, /<div class="row manufacturer-page-logo">([\s\S]*?)<\/div>\s*<\/div>/i) ||
    html;
  const company = cleanText(stripTags(firstMatch(mainBlock, /<h1[^>]*>([\s\S]*?)<\/h1>/i)) ||
    stripTags(firstMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/i)));
  const address = cleanText(stripTags((firstMatch(mainBlock, /<address[^>]*>([\s\S]*?)<\/address>/i) || "").replace(/<br\s*\/?>/gi, ", ")));
  const website = cleanText(firstMatch(mainBlock, /<p[^>]*class="[^"]*web-icon[^"]*"[\s\S]*?<a[^>]*href="([^"]+)"/i));
  const phone = cleanText(stripTags(firstMatch(mainBlock, /<p[^>]*class="[^"]*phone-icon[^"]*"[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i)));
  const descriptionHtml = firstMatch(mainBlock, /<p>\s*<p>([\s\S]*?)<\/p>\s*<\/p>/i) ||
    firstMatch(mainBlock, /<h1[^>]*>[\s\S]*?<\/h1>[\s\S]*?<p>([\s\S]{20,2500}?)<\/p>/i);
  const description = cleanText(stripTags(descriptionHtml || firstMeta(html, "description")));
  const categories = uniqueOrdered([...html.matchAll(/<h2 class="text-center">([\s\S]*?)<\/h2>/gi)]
    .map((match) => cleanText(stripTags(match[1]))));
  const productNames = uniqueOrdered([...html.matchAll(/<h4 class="text-dark">([\s\S]*?)<\/h4>/gi)]
    .map((match) => cleanText(stripTags(match[1]).replace(/^.*?\s/, "")))
    .filter((value) => value && normalizeCompanyName(value) !== normalizeCompanyName(company)))
    .slice(0, 8);
  const city = cityFromAddress(address) || titleCase(entry.citySlug.replace(/-/g, " "));
  const text = `${company} ${description} ${categories.join(" ")} ${productNames.join(" ")}`;
  const { score, reasons, industryBucket, equipmentFit } = scoreProfile({
    company,
    description,
    categories,
    productNames,
    website,
    address,
    text
  });
  return {
    company,
    city,
    citySlug: entry.citySlug,
    address,
    website,
    phone,
    description,
    categories,
    productNames,
    ontarioMadeUrl: entry.url,
    score,
    reasons,
    industryBucket,
    equipmentFit,
    contacts: []
  };
}

function attachEvidence(profile, cfiaIndex, crmIndex) {
  const cfiaMatches = findCfiaMatches(profile, cfiaIndex);
  const crmMatch = findCrmDuplicate(profile, crmIndex);
  let score = profile.score;
  const reasons = [...profile.reasons];
  if (cfiaMatches.length) {
    score += 18;
    reasons.push("CFIA food licence registry match");
  }
  if (profile.website) {
    score += 5;
  }
  if (profile.address && /\b(?:unit|suite|#|\d{1,5}\s+[A-Za-z].*\b(?:road|rd|drive|dr|court|crt|boulevard|blvd|avenue|ave|street|st|lane|crescent|cres)\b)/i.test(profile.address)) {
    score += 5;
  }
  if (NOISE_PATTERN.test(`${profile.company} ${profile.description}`) && !STRONG_INDUSTRY_PATTERN.test(profile.description)) {
    score -= 30;
    reasons.push("small/artisan noise");
  }
  return {
    ...profile,
    score,
    reasons: uniqueOrdered(reasons),
    cfiaMatches,
    crmDuplicate: crmMatch
  };
}

function parseCfiaProfile(row, crmIndex) {
  const city = titleCase(cityFromAddress(row.address));
  if (!city || !TARGET_CITY_SLUGS.has(cleanSlug(city.replace(/\s+/g, "-")))) {
    return null;
  }
  const company = cleanText(row.dba || row.legalName);
  const legalName = cleanText(row.legalName);
  const nameText = `${company} ${legalName}`;
  if (!FOOD_PRODUCTION_NAME_PATTERN.test(nameText)) {
    return null;
  }
  if (CFIA_RETAIL_NOISE_PATTERN.test(nameText)) {
    return null;
  }
  const profile = {
    company,
    city,
    citySlug: cleanSlug(city.replace(/\s+/g, "-")),
    address: row.address,
    website: "",
    phone: "",
    description: `Listed in the CFIA Safe Food for Canadians licence registry under ${legalName}.`,
    categories: ["Food & Beverage - CFIA licensed"],
    productNames: guessFoodProductsFromName(nameText),
    ontarioMadeUrl: "",
    score: scoreCfiaManufacturerName(nameText),
    reasons: ["CFIA food licence registry match", "food production name signal"],
    industryBucket: "Food & Beverage",
    equipmentFit: inferEquipmentFit("Food & Beverage", nameText),
    contacts: [],
    cfiaMatches: [row]
  };
  return {
    ...profile,
    crmDuplicate: findCrmDuplicate(profile, crmIndex)
  };
}

function scoreCfiaManufacturerName(text) {
  let score = 52;
  if (/\b(?:processing|processor|manufactur|plant|packag|co-?pack)\b/i.test(text)) score += 24;
  if (/\b(?:bakery|baker|baking|brewery|brewing|distill|roast|roaster|meat pack|poultry|sausage|smokehouse|dairy|cheese|creamery|confection|chocolate|candy|sauce|spice|seasoning|beverage|mill|mills|flour|frozen|prepared food|nutrition)\b/i.test(text)) score += 18;
  if (/\b(?:inc|ltd|limited|corp|corporation|ulc|lp)\b/i.test(text)) score += 4;
  if (/^\d+\b/.test(cleanText(text))) score -= 8;
  return score;
}

function guessFoodProductsFromName(text) {
  const products = [];
  const pairs = [
    ["Meat / protein processing", /\b(?:meat|poultry|sausage|smokehouse|fish|seafood)\b/i],
    ["Bakery / baked goods", /\b(?:bakery|baker|baking|bread|cake|pastry|cookie)\b/i],
    ["Beverages / brewing / coffee", /\b(?:beverage|brewery|brewing|coffee|roast|juice|tea|kombucha|distill|water)\b/i],
    ["Dairy / cheese / creamery", /\b(?:dairy|cheese|creamery|milk)\b/i],
    ["Sauces / spices / dressings", /\b(?:sauce|spice|seasoning|vinegar|dressing|oil)\b/i],
    ["Snacks / confectionery", /\b(?:snack|chocolate|confection|candy|dessert)\b/i],
    ["Grains / flour / milling", /\b(?:mill|mills|flour|grain|cereal|seed)\b/i],
    ["Frozen / prepared foods", /\b(?:frozen|meal|pasta|noodle|prepared)\b/i],
    ["Packaging / co-packing", /\b(?:packaging|packing|co-pack|copack)\b/i]
  ];
  for (const [label, pattern] of pairs) {
    if (pattern.test(text)) products.push(label);
  }
  return products.length ? products : ["Food processing / licensed food handling"];
}

function scoreProfile(profile) {
  const text = cleanText(profile.text);
  let score = 0;
  const reasons = [];
  if (/\bmanufacturer|manufacturing|produces?|production|makes?|made in ontario\b/i.test(text)) {
    score += 20;
    reasons.push("manufacturer language");
  }
  if (STRONG_INDUSTRY_PATTERN.test(text)) {
    score += 30;
    reasons.push("industrial/product keywords");
  }
  if (profile.categories.some((category) => STRONG_CATEGORY_PATTERN.test(category))) {
    score += 16;
    reasons.push("target category");
  }
  if (profile.productNames.length >= 2) {
    score += 10;
    reasons.push("multiple listed products");
  }
  if (/\b(?:private label|bulk|wholesale|commercial|restaurant chains|retail and foodservice|supply chain|iso|certified)\b/i.test(text)) {
    score += 12;
    reasons.push("commercial/bulk signal");
  }
  if (/\b(?:cnc|machining|fabricat|stamping|welding|extrusion|molding|moulding|assembly|printing|packaging|processing|bottling|batching|mixing|plant|facility|factory)\b/i.test(text)) {
    score += 18;
    reasons.push("equipment/process signal");
  }
  if (NOISE_PATTERN.test(text)) {
    score -= 24;
    reasons.push("small/artisan noise");
  }

  const industryBucket = classifyIndustry(profile.categories, text);
  const equipmentFit = inferEquipmentFit(industryBucket, text);
  return { score, reasons, industryBucket, equipmentFit };
}

function classifyIndustry(categories, text) {
  const haystack = `${categories.join(" ")} ${text}`;
  if (/\bfood|beverage|bakery|sauce|snack|coffee|tea|dairy|meat|brewery|distill|juice|chocolate|confection\b/i.test(haystack)) return "Food & Beverage";
  if (/\bautomotive|component|parts?|metal|steel|aluminum|machin|cnc|stamping|welding|fabricat|equipment|industrial\b/i.test(haystack)) return "Industrial / Metal / Components";
  if (/\bplastic|rubber|mold|mould|extrusion|resin|polymer\b/i.test(haystack)) return "Plastics / Rubber";
  if (/\bpackag|printing|label|paper|corrugat|converting\b/i.test(haystack)) return "Packaging / Printing";
  if (/\bwood|cabinet|millwork|furniture|door|window|flooring|lumber\b/i.test(haystack)) return "Wood / Millwork / Furniture";
  if (/\bconcrete|precast|masonry|stone|brick|building product|construction\b/i.test(haystack)) return "Building Products";
  if (/\bpharma|medical device|health|cosmetic|chemical|cleaner|detergent\b/i.test(haystack)) return "Health / Chemical / Cosmetics";
  return "Other Manufacturing";
}

function inferEquipmentFit(industryBucket, text) {
  if (/Food/.test(industryBucket)) return "Likely mixing, batching, conveying, packaging, sanitation, and line maintenance work.";
  if (/Industrial|Metal/.test(industryBucket)) return "Likely fabrication, machining, stamping, assembly, welding, and plant maintenance work.";
  if (/Plastics/.test(industryBucket)) return "Likely molding/extrusion, material handling, conveyors, and maintenance work.";
  if (/Packaging/.test(industryBucket)) return "Likely converting, printing, packaging line, conveyor, and maintenance work.";
  if (/Wood/.test(industryBucket)) return "Likely CNC/cutting, finishing, dust collection, assembly, and maintenance work.";
  if (/Building/.test(industryBucket)) return "Likely batching, cutting, forming, material handling, and maintenance work.";
  if (/Health|Chemical/.test(industryBucket)) return "Likely batching, filling, packaging, sanitation, and maintenance work.";
  if (/\bcnc|machining|fabricat|packag|processing|plant|facility|assembly\b/i.test(text)) {
    return "Public page shows process/equipment language; likely fit for maintenance or fabrication support.";
  }
  return "Manufacturing fit needs a second verification pass.";
}

function findCfiaMatches(profile, cfiaIndex) {
  const keys = uniqueOrdered([
    normalizeCompanyName(profile.company),
    ...companyAliases(profile.company).map(normalizeCompanyName)
  ].filter(Boolean));
  const matches = [];
  for (const key of keys) {
    if (cfiaIndex.byName.has(key)) {
      matches.push(...cfiaIndex.byName.get(key));
    }
  }
  if (!matches.length && profile.industryBucket === "Food & Beverage") {
    const profileTokens = tokenSet(profile.company);
    for (const row of cfiaIndex.rows) {
      const rowTokens = tokenSet(`${row.legalName} ${row.dba}`);
      if (jaccard(profileTokens, rowTokens) >= 0.72) {
        matches.push(row);
      }
      if (matches.length >= 3) break;
    }
  }
  return uniqueBy(matches, (row) => `${row.licence}:${row.legalName}`).slice(0, 3);
}

function findCrmDuplicate(profile, crmIndex) {
  const name = normalizeCompanyName(profile.company);
  const aliases = companyAliases(profile.company).map(normalizeCompanyName).filter(Boolean);
  const host = hostname(profile.website);
  const profileTokens = tokenSet(profile.company);
  for (const row of crmIndex.normalizedNames) {
    if (!row.norm) continue;
    if (name === row.norm || aliases.includes(row.norm)) {
      return { id: row.id, company: row.company, reason: "exact/alias name match" };
    }
    if (host && row.websiteHost && host === row.websiteHost) {
      return { id: row.id, company: row.company, reason: "website match" };
    }
    if (name.length > 8 && row.norm.length > 8 && (name.includes(row.norm) || row.norm.includes(name))) {
      return { id: row.id, company: row.company, reason: "contained name match" };
    }
    const sim = jaccard(profileTokens, tokenSet(row.company));
    if (sim >= 0.82 && profileTokens.size >= 2) {
      return { id: row.id, company: row.company, reason: `token similarity ${sim.toFixed(2)}` };
    }
  }
  return null;
}

function dedupeProfiles(profiles) {
  const selected = [];
  for (const profile of profiles) {
    const key = normalizeCompanyName(profile.company);
    const host = hostname(profile.website);
    const duplicate = selected.find((existing) => {
      if (host && hostname(existing.website) === host) return true;
      const existingKey = normalizeCompanyName(existing.company);
      if (key === existingKey) return true;
      if (key.length > 10 && existingKey.length > 10 && (key.includes(existingKey) || existingKey.includes(key))) return true;
      return jaccard(tokenSet(profile.company), tokenSet(existing.company)) >= 0.86;
    });
    if (duplicate) {
      duplicate.productNames = uniqueOrdered([...duplicate.productNames, ...profile.productNames]).slice(0, 12);
      duplicate.categories = uniqueOrdered([...duplicate.categories, ...profile.categories]).slice(0, 8);
      duplicate.reasons = uniqueOrdered([...duplicate.reasons, ...profile.reasons]);
      duplicate.score = Math.max(duplicate.score, profile.score);
      continue;
    }
    selected.push({ ...profile });
  }
  return selected;
}

function pickBalanced(profiles, count) {
  const picked = [];
  const cityCounts = new Map();
  const industryCounts = new Map();
  const cityCap = 12;
  const industryCap = 34;
  for (const profile of profiles) {
    if (picked.length >= count) break;
    const cityKey = normalizeCompanyName(profile.city || profile.citySlug);
    const industryKey = profile.industryBucket;
    if ((cityCounts.get(cityKey) || 0) >= cityCap) continue;
    if ((industryCounts.get(industryKey) || 0) >= industryCap) continue;
    picked.push(profile);
    cityCounts.set(cityKey, (cityCounts.get(cityKey) || 0) + 1);
    industryCounts.set(industryKey, (industryCounts.get(industryKey) || 0) + 1);
  }
  for (const profile of profiles) {
    if (picked.length >= count) break;
    if (picked.includes(profile)) continue;
    picked.push(profile);
  }
  return picked.slice(0, count);
}

async function enrichSelectedProfile(profile) {
  try {
    if (!profile.website) {
      profile.website = await resolvePublicWebsite(profile);
    }
  } catch {
    profile.website = profile.website || "";
  }

  if (profile.website) {
    try {
      const siteProfile = await enrichFromWebsite(profile.website, {
        pageLimit: 3,
        expectedCity: profile.city
      });
      profile.website = siteProfile.website || profile.website;
      profile.phone = profile.phone || siteProfile.phone || "";
      profile.emails = uniqueOrdered(siteProfile.emails || []);
      profile.websiteEndProducts = cleanWebsiteEndProducts(siteProfile.endProducts);
      profile.siteContacts = normalizeWebsiteContacts(siteProfile.contacts || [], profile.website);
      profile.contacts = dedupePublicContacts([
        ...(profile.contacts || []),
        ...profile.siteContacts.filter((contact) => OPS_TITLE_PATTERN.test(contact.title))
      ]);
    } catch {
      profile.emails = profile.emails || [];
      profile.websiteEndProducts = profile.websiteEndProducts || "";
    }
  }

  if (CONTACT_SEARCH_ENABLED) {
    try {
      profile.contacts = dedupePublicContacts([
        ...(profile.contacts || []),
        ...await findPublicOpsContacts(profile)
      ]);
    } catch {
      profile.contacts = profile.contacts || [];
    }
  }
}

async function resolvePublicWebsite(profile) {
  const company = simplifyCompanyForSearch(profile.company);
  if (!company) return "";
  const queries = uniqueOrdered([
    `"${company}" "${profile.city}" Ontario website`,
    `"${company}" "${profile.city}"`,
    `"${company}" food manufacturer Ontario`
  ]);
  for (const query of queries) {
    try {
      const results = await searchWeb(query, {
        limit: 5,
        timeoutMs: 6000,
        skipPatterns: [
          "yellowpages",
          "directory",
          "linkedin",
          "facebook",
          "instagram",
          "zoominfo",
          "apollo",
          "rocketreach",
          "opencorporates",
          "cfia",
          "inspection.canada",
          "supportontariomade"
        ]
      });
      const match = results.find((result) => looksLikeCompanyWebsite(result, profile));
      if (match?.websiteUrl) {
        return match.websiteUrl;
      }
    } catch {
      continue;
    }
  }
  return "";
}

function looksLikeCompanyWebsite(result, profile) {
  const domain = hostname(result.websiteUrl || result.url);
  if (!domain) return false;
  if (/\b(?:yellowpages|facebook|instagram|linkedin|zoominfo|apollo|rocketreach|opencorporates|canada411|yelp|tripadvisor|supportontariomade|inspection\.canada|gc\.ca)\b/i.test(domain)) {
    return false;
  }
  const domainText = normalizeCompanyName(rootDomain(domain));
  const resultText = normalizeCompanyName(`${result.title || ""} ${result.snippet || ""} ${result.url || ""}`);
  const identityTokens = companyIdentityTokens(profile.company);
  if (!identityTokens.length) return false;
  const allTokens = [...tokenSet(profile.company)].filter((token) => token.length >= 3);
  const domainHits = identityTokens.filter((token) => rootDomainHasIdentityToken(domainText, token));
  const genericDomainHits = allTokens.filter((token) => GENERIC_WEBSITE_TOKENS.has(token) && domainText.includes(token));
  if (domainHits.length >= 2) return true;
  if (domainHits.length === 1 && genericDomainHits.length) return true;
  if (domainHits.length === 1 && allTokens.length === 1 && domainHits[0].length >= 5) return true;
  if (domainHits.length === 1 && domainHits[0].length >= 5 && resultText.includes(normalizeCompanyName(profile.company))) {
    return true;
  }
  return false;
}

function rootDomainHasIdentityToken(domainText, token) {
  return domainText === token || domainText.startsWith(token);
}

function cleanWebsiteEndProducts(value) {
  const text = cleanText(value);
  if (!text || /\b(?:cookie settings|privacy policy|terms of use|subscribe|newsletter)\b/i.test(text)) {
    return "";
  }
  return truncate(text, 240);
}

function normalizeWebsiteContacts(contacts, source) {
  return contacts
    .map((contact) => ({
      name: cleanPersonName(contact.name),
      title: cleanText(contact.title),
      source: cleanText(contact.linkedin || contact.email || source)
    }))
    .filter((contact) => contact.name && contact.title);
}

async function findPublicOpsContacts(profile) {
  const company = simplifyCompanyForSearch(profile.company);
  if (!company) return [];
  const queries = uniqueOrdered([
    `site:linkedin.com/in "${company}" "operations manager"`,
    `site:linkedin.com/in "${company}" "plant manager"`,
    `site:linkedin.com/in "${company}" "production manager"`,
    `"${company}" "maintenance manager"`,
    `"${company}" "director of operations"`
  ]).slice(0, 3);
  const found = [];
  for (const query of queries) {
    try {
      const results = await searchWeb(query, {
        limit: 5,
        keepUrlPath: true,
        allowBlockedDomains: true,
        allowedDomains: ["linkedin.com", "rocketreach.co", "wiza.co", "signalhire.com", "zoominfo.com", "apollo.io", "theorg.com"],
        timeoutMs: 4500
      });
      for (const result of results) {
        if (!looksLikeContactResultForCompany(result, profile)) {
          continue;
        }
        found.push(...extractContactsFromResult(result, profile));
      }
    } catch {
      continue;
    }
    if (found.length >= 2) break;
  }
  return uniqueBy(found.filter((contact) => OPS_TITLE_PATTERN.test(contact.title)), (contact) => `${normalizePersonName(contact.name)}:${normalizeCompanyName(contact.title)}`).slice(0, 3);
}

function looksLikeContactResultForCompany(result, profile) {
  const url = cleanText(result.url).toLowerCase();
  const text = normalizeCompanyName(`${result.title || ""} ${result.snippet || ""} ${result.url || ""}`);
  const identityTokens = companyIdentityTokens(profile.company);
  if (!identityTokens.length) return false;
  const sharedTokens = identityTokens.filter((token) => text.includes(token)).length;
  if (sharedTokens < Math.min(2, identityTokens.length)) {
    return false;
  }
  if (/linkedin\.com/i.test(url) && !/ca\.linkedin\.com/i.test(url) && !/\b(?:canada|ontario)\b/i.test(text)) {
    return false;
  }
  const city = normalizeCompanyName(profile.city);
  return !city || text.includes(city) || /\b(?:canada|ontario)\b/i.test(text) || /ca\.linkedin\.com/i.test(url);
}

function dedupePublicContacts(contacts) {
  return uniqueBy(
    contacts
      .map((contact) => ({
        name: cleanPersonName(contact.name),
        title: cleanText(contact.title),
        source: cleanText(contact.source)
      }))
      .filter((contact) => contact.name && contact.title)
      .sort((left, right) => contactPriority(right) - contactPriority(left)),
    (contact) => `${normalizePersonName(contact.name)}:${normalizeCompanyName(contact.title)}`
  ).slice(0, 4);
}

function contactPriority(contact) {
  let priority = 0;
  if (OPS_TITLE_PATTERN.test(contact.title)) priority += 20;
  if (/\b(?:plant|operations|production|maintenance|manufacturing|quality)\b/i.test(contact.title)) priority += 10;
  if (/linkedin\.com/i.test(contact.source)) priority += 5;
  return priority;
}

function extractContactsFromResult(result, profile) {
  const haystack = cleanText(`${result.title || ""}. ${result.snippet || ""}`);
  const contacts = [];
  const titlePattern = "(plant manager|plant supervisor|operations manager|operations supervisor|director of operations|production manager|production supervisor|maintenance manager|maintenance supervisor|quality manager|quality assurance manager|manufacturing manager|engineering manager|facility manager|warehouse manager|logistics manager|supply chain manager|procurement manager|purchasing manager|general manager|president|owner|founder|coo|chief operating officer)";
  const patterns = [
    new RegExp(`([A-Z][A-Za-z'’.-]+(?:\\s+[A-Z][A-Za-z'’.-]+){1,4})\\s+[-–|,]\\s+${titlePattern}\\b`, "i"),
    new RegExp(`([A-Z][A-Za-z'’.-]+(?:\\s+[A-Z][A-Za-z'’.-]+){1,4}).{0,80}\\b${titlePattern}\\b.{0,60}\\b(?:at|@)\\s+${escapeRegex(firstCompanyToken(profile.company))}`, "i"),
    new RegExp(`\\b${titlePattern}\\b\\s+[-–|,]\\s+([A-Z][A-Za-z'’.-]+(?:\\s+[A-Z][A-Za-z'’.-]+){1,4})`, "i")
  ];
  for (const pattern of patterns) {
    const match = haystack.match(pattern);
    if (!match) continue;
    const [name, title] = match[1] && OPS_TITLE_PATTERN.test(match[1])
      ? [match[2], match[1]]
      : [match[1], match[2]];
    const cleanedName = cleanPersonName(name);
    const cleanedTitle = titleCase(cleanText(title));
    if (!cleanedName || !cleanedTitle) continue;
    if (normalizeCompanyName(cleanedName).includes(normalizeCompanyName(firstCompanyToken(profile.company)))) continue;
    contacts.push({
      name: cleanedName,
      title: cleanedTitle,
      source: result.url || ""
    });
  }
  return contacts;
}

function toOutputRow(profile) {
  return {
    company: profile.company,
    notes: buildNotes(profile),
    contacts: buildContactSection(profile)
  };
}

function buildNotes(profile) {
  const cfia = profile.cfiaMatches?.[0];
  const products = uniqueOrdered([
    ...profile.categories,
    ...profile.productNames,
    profile.websiteEndProducts
  ]).slice(0, 12).join(" | ");
  return [
    `Address: ${profile.address || "not found"}`,
    profile.website ? `Website: ${profile.website}` : "",
    `Phone: ${profile.phone || "not found"}`,
    `Email: ${profile.emails?.length ? profile.emails.slice(0, 4).join(", ") : "not found"}`,
    `End product/capability: ${products || "not found"}`,
    profile.description ? `Proof: ${truncate(profile.description, 300)}` : "",
    cfia ? `CFIA source: licence ${cfia.licence}; legal name ${cfia.legalName}; ${cfia.address}` : "",
    profile.ontarioMadeUrl ? `Ontario Made source: ${profile.ontarioMadeUrl}` : "",
    "CRM: not found in current CRM name baseline"
  ].filter(Boolean).join("\n");
}

function buildContactSection(profile) {
  const contacts = dedupePublicContacts(profile.contacts || []);
  if (contacts.length) {
    return contacts
      .map((contact) => `${contact.name} - ${contact.title}${contact.source ? ` (${contact.source})` : ""}`)
      .join("\n");
  }
  if (profile.emails?.length) {
    return `No named operations contact found in this public pass.\nGeneral email: ${profile.emails.slice(0, 3).join(", ")}`;
  }
  if (profile.phone) {
    return `No named operations contact found in this public pass.\nGeneral phone: ${profile.phone}`;
  }
  return "No named operations contact found in this public pass.";
}

async function fetchText(url, timeoutMs = 30000) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/135.0 Safari/537.36"
    },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) {
    throw new Error(`Fetch failed ${response.status} for ${url}`);
  }
  return response.text();
}

async function fetchCachedText(url, cachePath, maxAgeMs, timeoutMs = 30000) {
  try {
    const stat = await fs.stat(cachePath);
    if (Date.now() - stat.mtimeMs <= maxAgeMs) {
      return fs.readFile(cachePath, "utf8");
    }
  } catch {
    // Cache miss.
  }
  try {
    const text = await fetchText(url, timeoutMs);
    await fs.writeFile(cachePath, text, "utf8");
    return text;
  } catch (error) {
    try {
      return await fs.readFile(cachePath, "utf8");
    } catch {
      throw error;
    }
  }
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, limit) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function slugFilename(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 160);
}

function parseCsv(text) {
  text = String(text || "").replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (quoted) {
      if (char === "\"" && next === "\"") {
        field += "\"";
        index += 1;
      } else if (char === "\"") {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === "\"") {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  const headers = rows.shift() || [];
  return rows.map((values) => Object.fromEntries(headers.map((header, index) => [cleanText(header), values[index] || ""])));
}

function toCsv(rows) {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]);
  return [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(","))
  ].join("\n") + "\n";
}

function csvCell(value) {
  const text = String(value ?? "");
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, "\"\"")}"`;
  }
  return text;
}

function firstMatch(text, pattern) {
  const match = String(text || "").match(pattern);
  return match ? match[1] || "" : "";
}

function firstMeta(html, name) {
  const pattern = new RegExp(`<meta[^>]+(?:name|property)=["']${escapeRegex(name)}["'][^>]+content=["']([^"']*)["']`, "i");
  return cleanText(decodeHtml(firstMatch(html, pattern)));
}

function stripTags(value) {
  return decodeHtml(String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " "));
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&#038;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&ndash;/g, "-")
    .replace(/&mdash;/g, "-")
    .replace(/&nbsp;/g, " ");
}

function cleanText(value) {
  return decodeHtml(String(value || ""))
    .replace(/\s+/g, " ")
    .trim();
}

function cleanSlug(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9-]+/g, "").replace(/-+$/g, "");
}

function normalizeCompanyName(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\b(?:incorporated|inc|ltd|limited|corp|corporation|company|co|canada|ontario|the|les|aliments|manufacturing|manufacturer|products|product|group)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePersonName(value) {
  return cleanText(value).toLowerCase().replace(/[^a-z]+/g, " ").replace(/\s+/g, " ").trim();
}

function tokenSet(value) {
  return new Set(normalizeCompanyName(value).split(/\s+/).filter((token) => token.length >= 3));
}

function companyIdentityTokens(company) {
  return [...tokenSet(company)]
    .filter((token) => token.length >= 3 && !GENERIC_WEBSITE_TOKENS.has(token));
}

function jaccard(leftSet, rightSet) {
  if (!leftSet.size || !rightSet.size) return 0;
  let shared = 0;
  for (const token of leftSet) {
    if (rightSet.has(token)) shared += 1;
  }
  return shared / (leftSet.size + rightSet.size - shared);
}

function uniqueOrdered(values) {
  const seen = new Set();
  const output = [];
  for (const value of values) {
    const clean = cleanText(value);
    const key = clean.toLowerCase();
    if (!clean || seen.has(key)) continue;
    seen.add(key);
    output.push(clean);
  }
  return output;
}

function uniqueBy(items, keyFn) {
  const seen = new Set();
  const output = [];
  for (const item of items) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }
  return output;
}

function hostname(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function rootDomain(host) {
  const parts = String(host || "").split(".").filter(Boolean);
  if (parts.length < 2) return host || "";
  return parts[parts.length - 2] || host;
}

function cityFromAddress(address) {
  const parts = cleanText(address).split(",").map((part) => part.trim()).filter(Boolean);
  const provinceIndex = parts.findIndex((part) => /^Ontario$/i.test(part));
  if (provinceIndex >= 1) return parts[provinceIndex - 1];
  return "";
}

function titleCase(value) {
  return cleanText(value).toLowerCase().replace(/\b[a-z]/g, (char) => char.toUpperCase());
}

function companyAliases(company) {
  const clean = cleanText(company);
  return uniqueOrdered([
    clean,
    clean.replace(/\s+-\s+.*$/, ""),
    clean.replace(/\b(?:ltd|limited|inc|corp|corporation)\.?$/i, ""),
    clean.replace(/\b(?:fanta|minute maid|vitaminwater|canada dry|pure leaf|brisk|mug root beer|sprite|coca-cola|coke)\b.*$/i, "Coca-Cola Canada Bottling")
  ]);
}

function simplifyCompanyForSearch(company) {
  return cleanText(company)
    .replace(/\b(?:Inc|Ltd|Limited|Corporation|Corp|Company|Co)\.?$/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function firstCompanyToken(company) {
  return normalizeCompanyName(company).split(/\s+/).find((token) => token.length >= 4) || "";
}

function cleanPersonName(value) {
  const cleaned = cleanText(value)
    .replace(/\b(?:MBA|P\.?Eng\.?|CPA|CFA|LinkedIn|Canada)\b/gi, "")
    .replace(/[^A-Za-z'’.\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!/^[A-Z][A-Za-z'’.-]+(?:\s+[A-Z][A-Za-z'’.-]+){1,4}$/.test(cleaned)) return "";
  if (/\b(?:company|manufacturing|products|operations|manager|director|president|owner|plant|production)\b/i.test(cleaned)) return "";
  return cleaned;
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function truncate(value, limit) {
  const text = cleanText(value);
  return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
}

function countBy(rows, key) {
  return rows.reduce((counts, row) => {
    const value = row[key] || "";
    counts[value] = (counts[value] || 0) + 1;
    return counts;
  }, {});
}

function countProductTypes(profiles) {
  return profiles.reduce((counts, profile) => {
    const value = uniqueOrdered([...(profile.categories || []), ...(profile.productNames || [])]).join(" | ") || "Unknown";
    counts[value] = (counts[value] || 0) + 1;
    return counts;
  }, {});
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
