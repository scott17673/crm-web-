export const verifierFixtures = [
  {
    id: "royal-pest-control",
    expectedQualified: false,
    candidate: {
      company_hint: "Royal Pest Control",
      search_query: "food processing plant in Brampton Ontario",
      source_title: "Royal Pest Control | Pest Removal Services",
      source_url: "https://www.royalpestcontrol.ca/",
      snippets: [
        "Royal Pest Control is a pest control company serving residential, commercial and industrial clients in the GTA.",
        "Services include bed bug extermination, cockroach extermination, rat and mice removal, wasp removal, odor control, and pest control for food processing plant customers.",
        "Address: 84 Newington Cres, Brampton, ON. Phone: 416-938-4598."
      ]
    }
  },
  {
    id: "paris-baguette-cafe",
    expectedQualified: false,
    candidate: {
      company_hint: "Paris Baguette | Your Neighborhood Bakery Cafe",
      search_query: "bakery manufacturer in Toronto Ontario",
      source_title: "Paris Baguette | Pastries, Cakes, Coffee",
      source_url: "https://parisbaguette.ca/",
      snippets: [
        "Your neighborhood bakery cafe. Menu, locations, rewards, catering, order now.",
        "Find a cafe near me. Freshly baked breads, pastries, cakes, and expertly brewed drinks.",
        "The page describes bakery cafes and retail/customer ordering, not a production plant."
      ]
    }
  },
  {
    id: "meatloaf-recipe-page",
    expectedQualified: false,
    candidate: {
      company_hint: "Easy Meatloaf to Make at Home | Best Meat Loaf Recipe",
      search_query: "meat processing plant in Burlington Ontario",
      source_title: "Easy Meatloaf to Make at Home | Best Meat Loaf Recipe",
      source_url: "https://example.com/meatloaf-recipe",
      snippets: [
        "Recipe article with ingredients, cooking steps, and gift suggestions.",
        "No company name, no facility address, no manufacturing or processing operation."
      ]
    }
  },
  {
    id: "crupi-asphalt",
    expectedQualified: true,
    candidate: {
      company_hint: "The Crupi Group",
      search_query: "hot mix asphalt plant in Scarborough Ontario",
      source_title: "Asphalt Plants | The Crupi Group",
      source_url: "https://crupigroup.com/project/asphalt-plants/",
      snippets: [
        "The Crupi Group operates four hot mix asphalt production facilities in the GTA.",
        "Scarborough location: 85 Passmore Avenue, Scarborough, ON M1V 4S9. Asphalt plant and aggregate supply.",
        "Products include hot mix asphalt, aggregates, paving materials, and related construction materials."
      ]
    }
  },
  {
    id: "protectolite",
    expectedQualified: true,
    candidate: {
      company_hint: "Protectolite",
      search_query: "building products manufacturer in North York Ontario",
      source_title: "Protectolite Composites Inc.",
      source_url: "http://www.protectolite.com/",
      snippets: [
        "Protectolite manufactures fiberglass reinforced plastic products and composite building/industrial products.",
        "Manufacturing facility: 84 Railside Road, North York, ON M3A 1A3. Phone: 416-444-4484.",
        "Capabilities include molded and fabricated composite products for industrial and architectural uses."
      ]
    }
  },
  {
    id: "durose-manufacturing",
    expectedQualified: true,
    candidate: {
      company_hint: "Durose Manufacturing",
      search_query: "metal processing manufacturer in Guelph Ontario",
      source_title: "Durose Manufacturing Ltd.",
      source_url: "https://durose.com/",
      snippets: [
        "Durose Manufacturing is a steel fabrication and manufacturing company.",
        "Facility: 460 Elizabeth Street, Guelph, ON N1E 6C1. Phone: 519-822-5251.",
        "Capabilities include metal fabrication, welding, machining, assembly, and industrial manufacturing."
      ]
    }
  },
  {
    id: "dufferin-asphalt-no-address",
    expectedQualified: false,
    candidate: {
      company_hint: "Home - Dufferin Asphalt",
      search_query: "asphalt plant in Toronto Ontario",
      source_title: "Home - Dufferin Asphalt",
      source_url: "https://www.dufferinasphalt.com/",
      snippets: [
        "Dufferin Asphalt supplies asphalt and paving materials.",
        "The evidence packet does not include a specific facility address in the GTA or within 2 hours.",
        "No plant address, phone, or location proof is available in this packet."
      ]
    }
  }
];
