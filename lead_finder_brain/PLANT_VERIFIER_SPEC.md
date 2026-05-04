# Industrial Plant Verifier Spec

## Goal

Find industrial-level manufacturers or processors in the GTA or within roughly a 2-hour driving radius of the GTA.

The system must only save a lead after confirming:

1. The result is an actual company.
2. The company is the plant/facility operator, not a vendor, contractor, distributor, association, article, directory, or service company.
3. There is at least one real facility address in the target area.
4. The company manufactures, processes, produces, packages, recycles, casts, molds, mixes, mills, stamps, coats, fabricates, roasts, brews, bakes, crushes, extrudes, or otherwise physically transforms products/materials at industrial scale.
5. The facility likely uses industrial production equipment such as pumps, conveyors, mixers, packaging lines, compressors, crushers, kilns, ovens, tanks, boilers, hydraulics, motors, gearboxes, dust collection, chillers, dryers, screens, presses, molding machines, extruders, furnaces, finishing lines, or similar machinery.
6. The proof can be cited from the evidence packet.

If any required proof is missing, the verifier must return `qualified: false` and the finder must move on.

No grading. No maybe-save. No CRM row unless `qualified: true`.

## Output Shape

```json
{
  "qualified": true,
  "is_real_company": true,
  "is_plant_operator": true,
  "facility_in_range": true,
  "manufactures_or_processes": true,
  "industrial_scale": true,
  "reject_reason": "",
  "confidence": "high",
  "proof": [
    {
      "claim": "Company operates a hot mix asphalt plant in Scarborough.",
      "source_type": "company_site",
      "source_url": "https://example.com/locations",
      "evidence": "Locations page lists Scarborough asphalt plant."
    }
  ],
  "confirmed_facilities": [
    {
      "name": "Scarborough asphalt plant",
      "address": "85 Passmore Ave, Scarborough, ON M1V 4S9",
      "city": "Scarborough",
      "phone": "416-000-0000",
      "source_url": "https://example.com/locations",
      "facility_type": "hot mix asphalt plant"
    }
  ],
  "end_products": [
    "hot mix asphalt",
    "aggregates"
  ],
  "production_related_names": [
    "asphalt plant",
    "hot mix plant",
    "aggregate operation"
  ],
  "likely_equipment": [
    "aggregate conveyors",
    "dryer drum",
    "burner",
    "baghouse",
    "screens",
    "loadout silos"
  ],
  "people": [
    {
      "name": "Jane Smith",
      "title": "Plant Manager",
      "linkedin_url": "https://www.linkedin.com/in/example/",
      "source_url": "https://www.linkedin.com/in/example/",
      "confidence": "direct_linkedin_profile"
    }
  ]
}
```

Reject shape:

```json
{
  "qualified": false,
  "is_real_company": true,
  "is_plant_operator": false,
  "facility_in_range": false,
  "manufactures_or_processes": false,
  "industrial_scale": false,
  "reject_reason": "Company is a contractor/service provider, not the operator of a manufacturing or processing plant.",
  "confidence": "high",
  "proof": []
}
```

## Industry Proof Requirements

### Food Processors

Accept only if evidence shows a production/processing/packing operation, not a restaurant, grocery, caterer, or retail shop.

Proof examples:

- Company says it operates a food processing facility or plant.
- Facility address is listed for production, processing, packing, co-packing, prepared foods, ingredients, frozen foods, sauces, snacks, dairy, or similar.
- Products are physical packaged food products sold wholesale, retail, foodservice, private label, or distribution.
- Evidence mentions production lines, processing, packaging, HACCP/SQF/BRC, CFIA, GFSI, co-manufacturing, or plant operations.

Likely equipment:

- mixers, kettles, tanks, pumps, conveyors, slicers, ovens, fryers, fillers, sealers, labelers, packaging lines, refrigeration, boilers, CIP systems.

Reject:

- restaurants, caterers, grocers, retail bakeries, cafes, recipe pages, food bloggers, associations, distributors only.

### Meat/Poultry Plants

Accept only if evidence shows slaughter, cutting, deboning, further processing, packing, sausage, deli meat, poultry processing, meat packing, or similar production.

Proof examples:

- Company site says meat processor, poultry processor, meat packer, butcher plant, processing facility, federally/provincially inspected plant.
- Facility address is tied to processing/packing operations.
- Products include meat cuts, sausages, deli meats, poultry, cooked/frozen meat products.

Likely equipment:

- conveyors, grinders, mixers, stuffers, tumblers, smokehouses, slicers, packaging lines, refrigeration, compressors, boilers, sanitation/CIP systems.

Reject:

- butcher shops with only retail counter, restaurants, farms with no processing plant, recipes, foodservice distributors.

### Bakeries With Production Lines

Accept only if evidence shows wholesale/commercial/industrial bakery production, not a cafe or retail bakery storefront.

Proof examples:

- Company says bakery manufacturer, commercial bakery, wholesale bakery, production bakery, baking facility, plant.
- Products are bread, buns, pastries, cakes, cookies, frozen dough, or packaged baked goods for wholesale/foodservice/retail.
- Facility address is tied to production.

Likely equipment:

- mixers, dough dividers, proofers, ovens, conveyors, cooling tunnels, slicers, baggers, packaging lines, refrigeration.

Reject:

- cafes, patisseries, cake shops, retail-only bakeries, bakery-cafes, franchise storefronts.

### Breweries/Cideries With Canning/Bottling

Accept if evidence shows the company brews/ferments and packages product, even if it also has a taproom.

Proof examples:

- Company says brewery, cidery, brewing facility, production brewery, brewhouse.
- Products include beer/cider in cans, bottles, kegs, distribution, LCBO, retail, wholesale.
- Evidence mentions canning, bottling, kegging, fermentation tanks, brewhouse, cellar, packaging.

Likely equipment:

- mash tun, kettle, fermenters, brite tanks, pumps, heat exchangers, glycol chillers, CIP, canning/bottling/kegging lines, conveyors.

Reject:

- pubs/bars/bistros that only serve beverages and do not brew/package, beer guides/directories.

### Coffee Roasters With Commercial Roasting

Accept only if evidence shows commercial roasting/production, not just a cafe.

Proof examples:

- Company says coffee roastery, roasting facility, wholesale roasting, private label roasting.
- Products include roasted coffee bags, wholesale coffee, beans, blends.
- Facility address is tied to roasting/production.

Likely equipment:

- roasters, destoners, grinders, conveyors, packaging/bagging/sealing lines, ventilation, afterburners, compressors.

Reject:

- cafes, coffee shops, directories, coffee retailers with no roasting evidence.

### Ready-Mix/Precast Concrete Plants

Accept if evidence shows the company operates ready-mix, precast, block, paver, pipe, or concrete product manufacturing facilities.

Proof examples:

- Company says ready-mix plant, concrete plant, batch plant, precast plant, block plant, concrete products manufacturing.
- Facility address is a plant/yard/location, not only head office.
- Products include ready-mix concrete, precast panels, blocks, pavers, pipe, vaults, curbs, barriers.

Likely equipment:

- batch plants, mixers, aggregate bins, conveyors, silos, cement screws, pumps, forms, cranes, vibration tables, curing systems.

Reject:

- concrete contractors, polishing, cutting, sawing, driveway/paving contractors, engineering consultants.

### Asphalt Plants

Accept if evidence shows hot mix asphalt production or asphalt plant operation.

Proof examples:

- Company says asphalt plant, hot mix asphalt plant, asphalt producer, asphalt production facility.
- Facility/location page lists asphalt plant address.
- Products include hot mix asphalt, asphalt mixes, aggregates, paving materials.

Likely equipment:

- aggregate conveyors, cold feed bins, dryer drum, burner, baghouse, screens, asphalt tanks, silos, loadout systems.

Reject:

- paving contractors with no plant, driveway sealing, sealcoating, asphalt repair services only.

### Aggregate/Quarry Operations

Accept if evidence shows quarry, pit, aggregate processing, crushing, screening, washing, sand/gravel/stone production.

Proof examples:

- Company says quarry, pit, aggregate operation, crushing plant, screening plant, sand and gravel operation.
- Facility address/location page lists quarry/pit/aggregate plant.
- Products include aggregates, sand, gravel, crushed stone, limestone, screenings.

Likely equipment:

- crushers, screens, conveyors, feeders, washers, pumps, motors, gearboxes, loaders, dust collection.

Reject:

- landscape supply yards, trucking companies, aggregate distributors with no owned operation.

### Recycling/Material Recovery Plants

Accept if evidence shows the company operates a recycling facility/material recovery/processing plant.

Proof examples:

- Company says recycling facility, material recovery facility, plastics recycling plant, scrap processing yard, metal recycling processor.
- Facility address is tied to processing operations.
- Products/materials include recycled plastics, metal scrap, paper/cardboard, e-waste, C&D recycling, recovered materials.

Likely equipment:

- conveyors, balers, shredders, granulators, magnets, screens, sorters, compactors, dust collection, forklifts.

Reject:

- junk removal, auto parts retail, bottle depots, articles about recycling, environmental organizations, insurance pages.

### Metal Processors, Stampers, Coaters, Foundries

Accept if evidence shows metal manufacturing/processing operations.

Proof examples:

- Company says metal stamping, machining, fabrication plant, foundry, galvanizing, coating, heat treating, metal finishing, steel/aluminum processing.
- Facility address is tied to manufacturing/production.
- Products/services physically transform metal: stamped parts, castings, machined components, coatings, polished/finished metal, structural steel fabrication.

Likely equipment:

- presses, CNC machines, lathes, mills, saws, welding systems, paint/coating lines, ovens, cranes, dust collection, compressors, hydraulics.

Reject:

- metal distributors, scrap brokers, contractors, installers, engineering-only firms.

### Plastic Injection Molding/Extrusion/Thermoforming

Accept if evidence shows plastics manufacturing or processing.

Proof examples:

- Company says injection molding, extrusion, thermoforming, blow molding, plastic products manufacturing, polymer processing.
- Facility address is tied to production.
- Products include molded parts, containers, film, sheets, profiles, packaging, industrial plastic components.

Likely equipment:

- injection molding machines, extruders, dryers, chillers, grinders, conveyors, robots, molds/tooling, compressors, cooling systems.

Reject:

- plastic distributors, retailers, installers, recyclers unless they process material industrially.

### Packaging Manufacturers

Accept if evidence shows manufacturing/converting of packaging products.

Proof examples:

- Company says packaging manufacturer, box plant, corrugated packaging, flexible packaging, labels, bags, containers, folding cartons.
- Facility address is tied to production/converting/printing.
- Products include boxes, cartons, labels, films, bags, containers, packaging components.

Likely equipment:

- presses, die cutters, slitters, laminators, corrugators, folder-gluers, conveyors, compressors, ink systems, rewinders.

Reject:

- packaging distributors, design agencies, fulfillment/warehouse-only companies.

### Building Product Manufacturers

Accept if evidence shows manufacturing of physical building products.

Proof examples:

- Company says it manufactures windows, doors, insulation, panels, roofing products, bricks, blocks, trusses, cabinets, flooring, stone veneer, glass products, architectural products.
- Facility address is tied to production/manufacturing.
- Products are physical building materials/components.

Likely equipment:

- saws, presses, CNC routers, mixers, kilns, ovens, conveyors, coating lines, cranes, dust collection, compressors, packaging lines.

Reject:

- contractors, installers, retailers, flooring stores, tile stores, lumber yards, distributors, wholesalers, showrooms only.

## Verification Questions

The verifier must answer these internally for every candidate:

1. Is this actually a company?
2. Is it the operator of the plant, not a vendor serving plants?
3. Is there a real facility address in the GTA or roughly 2-hour radius?
4. Do they make/process physical products there?
5. Would this facility plausibly have industrial production equipment?
6. Is it not retail/service/contractor junk?
7. Can the proof be cited from the evidence packet?

All seven must be yes for `qualified: true`.

## After Yes

Only after `qualified: true`, run enrichment:

1. Find all relevant facility addresses in the target area.
2. Find phone numbers for those facilities.
3. Extract end products.
4. Extract production-related names/terms.
5. Find full LinkedIn profile links for relevant people if available.
6. Build the CRM row.

Missing people or missing LinkedIn links must not block saving the lead after the plant is qualified.

## People To Find After Yes

After a plant is confirmed and the row is being enriched, search for people at that company in these role families:

- plant manager
- plant superintendent
- site manager
- maintenance manager
- maintenance supervisor
- maintenance team lead
- production manager
- production supervisor
- production team lead
- operations manager
- director of operations
- general manager
- maintenance mechanic
- millwright
- industrial mechanic
- maintenance technician
- reliability manager
- facilities manager
- purchaser
- purchasing manager
- buyer
- procurement manager
- parts / maintenance purchaser

Similar titles are okay if they clearly relate to plant operations, maintenance, production, facilities, reliability, or purchasing for the confirmed company.

Reject people/contact matches if they are:

- sales
- marketing
- HR/recruiting
- finance/accounting
- IT/software
- legal
- customer service
- retail/store manager
- unrelated company with a similar name

Preferred people output:

```json
{
  "people": [
    {
      "name": "Full Name",
      "title": "Maintenance Manager",
      "linkedin_url": "https://www.linkedin.com/in/full-profile-path/",
      "source_url": "https://www.linkedin.com/in/full-profile-path/",
      "confidence": "direct_linkedin_profile"
    }
  ],
  "people_search_status": "found_some"
}
```

Allowed `people_search_status` values:

- `found_some`
- `searched_none_found`
- `not_searched`

Even if `people_search_status` is `searched_none_found`, the CRM row still gets added when `qualified: true`.
