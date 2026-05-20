export const INDUSTRY_PRESETS = [
  {
    id: "food_beverage",
    label: "Food and Beverage",
    queries: [
      "food processing plant",
      "meat processing plant",
      "poultry processing plant",
      "brewery",
      "craft brewery",
      "coffee roastery",
      "coffee roaster",
      "bakery manufacturer",
      "food manufacturer",
      "beverage manufacturer"
    ]
  },
  {
    id: "concrete",
    label: "Concrete",
    queries: [
      "precast concrete manufacturer",
      "concrete products manufacturer",
      "concrete plant"
    ]
  },
  {
    id: "metal_refineries",
    label: "Metal Refineries",
    queries: [
      "metal refinery",
      "metal processing plant",
      "steel processing manufacturer"
    ]
  },
  {
    id: "recycling",
    label: "Recycling",
    queries: [
      "recycling facility",
      "metal recycling plant",
      "plastic recycling plant"
    ]
  },
  {
    id: "aggregate_asphalt",
    label: "Aggregate / Asphalt",
    queries: [
      "aggregate plant",
      "sand and gravel plant",
      "quarry processing plant",
      "asphalt plant",
      "asphalt producer",
      "hot mix asphalt plant"
    ]
  },
  {
    id: "packaging",
    label: "Packaging",
    queries: [
      "packaging manufacturer",
      "corrugated packaging manufacturer",
      "flexible packaging manufacturer",
      "label manufacturer",
      "folding carton manufacturer",
      "box plant"
    ]
  },
  {
    id: "building_products",
    label: "Building Products",
    queries: [
      "building materials manufacturer",
      "construction products manufacturer",
      "masonry products manufacturer"
    ]
  },
  {
    id: "others",
    label: "Others",
    queries: [
      "industrial manufacturer",
      "industrial manufacturing company",
      "fabrication company"
    ]
  }
];

export const DEFAULT_INDUSTRY_IDS = [
  "food_beverage",
  "concrete",
  "metal_refineries",
  "recycling",
  "aggregate_asphalt",
  "packaging",
  "building_products",
  "others"
];

const INDUSTRY_ID_ALIASES = {
  mining_aggregate: "aggregate_asphalt",
  asphalt_plants: "aggregate_asphalt"
};

export function normalizeIndustryId(id) {
  const normalized = String(id || "").trim();
  return INDUSTRY_ID_ALIASES[normalized] || normalized;
}

export function getIndustryPreset(id) {
  const normalized = normalizeIndustryId(id);
  return INDUSTRY_PRESETS.find((preset) => preset.id === normalized) || null;
}

export function inferIndustryLabel(query) {
  const lower = String(query || "").toLowerCase();

  for (const preset of INDUSTRY_PRESETS) {
    if (preset.queries.some((entry) => lower.includes(entry.toLowerCase()))) {
      return preset.label;
    }
  }

  return "Others";
}
