# Industrial Plant Enrichment Spec

## Goal

Run only after the plant verifier returns `qualified: true`.

The enrichment system must turn a confirmed industrial plant lead into a usable CRM row by finding:

1. All relevant in-range facility addresses for the company.
2. Facility/head office phone numbers, fax numbers, and useful emails when available.
3. End products or product categories.
4. Likely plant equipment/process clues.
5. Production, maintenance, operations, general management, purchasing, and plant-adjacent contacts.
6. Full personal LinkedIn profile URLs when found.
7. Cited proof for every important field.

The enrichment system must not reject the lead just because contacts are missing. Once the plant verifier says yes, the company row stays. Missing contact data becomes a contact search status, not a lead rejection.

## Input

The enrichment system receives the verified plant packet:

```json
{
  "company": "Company name",
  "confirmed_facilities": [],
  "end_products": [],
  "likely_equipment": [],
  "proof": [],
  "source_urls": []
}
```

The input may include raw website snippets, LinkedIn company pages, directory pages, job postings, government permits, PDFs, and manually found evidence.

## Output Shape

```json
{
  "company": "Company name",
  "qualified": true,
  "facilities": [
    {
      "name": "Plant or facility name",
      "facility_type": "hot mix asphalt plant",
      "address": "83 Passmore Ave",
      "city": "Toronto",
      "province": "ON",
      "postal_code": "M1V 4S9",
      "phone": "416-000-0000",
      "fax": "",
      "email": "",
      "source_url": "https://example.com/locations",
      "notes": "Official locations page lists this as an asphalt plant."
    }
  ],
  "end_products": [
    "hot mix asphalt"
  ],
  "likely_equipment": [
    "aggregate conveyors",
    "dryer drum",
    "baghouse",
    "loadout silos"
  ],
  "contacts": [
    {
      "name": "Jane Smith",
      "title": "Maintenance Manager",
      "role_match": "maintenance manager",
      "phone": "",
      "email": "",
      "linkedin_url": "https://www.linkedin.com/in/example",
      "source_url": "https://www.linkedin.com/in/example",
      "confidence": "high",
      "notes": "LinkedIn profile shows Maintenance Manager at the company."
    }
  ],
  "proof": [
    {
      "claim": "Company operates an asphalt plant at 83 Passmore Ave.",
      "source_url": "https://example.com/locations",
      "evidence": "Official locations page lists 83 Passmore Ave as an asphalt plant."
    }
  ],
  "contact_search_status": "contacts_found"
}
```

Allowed `contact_search_status` values:

- `contacts_found`: at least one target contact with a title and source.
- `partial_contacts`: useful contacts found, but some expected roles or LinkedIn URLs are still missing.
- `no_target_contacts_found`: no useful target contact found after the required search passes.

## Source Priority

Use sources in this order when available:

1. Official company location/contact pages.
2. Official company product/service/capability pages.
3. Government permits, environmental approvals, inspection lists, licensing pages, CFIA/municipal/provincial records, public PDFs.
4. Company LinkedIn page, especially employee links.
5. Public personal LinkedIn profile pages.
6. Job postings for plant, production, maintenance, quality, operations, or purchasing roles.
7. Credible directories that expose names/titles, such as SignalHire, Wiza, Clodura, Adapt, Source From Ontario, industry associations, supplier/delegate pages.
8. Search snippets only when the full page is inaccessible, and only if the snippet is specific enough to cite.

Prefer official facility evidence for addresses and phones. Use directories for people only when official sources do not list staff.

## Required Search Passes

The enrichment system must do these passes before giving up on contacts:

### Pass 1: Company Facilities

Search:

- `[company] official website contact`
- `[company] locations`
- `[company] plant`
- `[company] facility`
- `[company] products`
- `[company] equipment`
- `[company] address phone`

Extract:

- plant/location names
- addresses
- city/province/postal code
- phone/fax/email
- facility type
- end products
- obvious plant equipment/process clues

If a company has multiple relevant in-range facilities, output separate facility rows.

### Pass 2: Official Proof And Regulatory Records

Search:

- `[company] environmental compliance approval`
- `[company] ECA`
- `[company] permit`
- `[company] technical standards registration`
- `[company] CFIA`
- `[company] food safety`
- `[company] ISO`
- `[company] SQF`
- `[company] HACCP`
- `[company] plant manager`
- `[company] production manager`
- `[company] maintenance manager`

Use these records to strengthen facility proof and sometimes find named operators, general managers, plant contacts, or signers.

### Pass 3: LinkedIn Company Page

Search/open:

- `site:linkedin.com/company [company]`
- LinkedIn company page employee list if visible.

Extract every public `linkedin.com/in/` profile link that appears on the company page.

Do not use the company LinkedIn page as a person's LinkedIn URL. Use it only as evidence that employee profile links exist.

For each employee link, try to capture:

- name
- current title
- company association
- location
- source URL

### Pass 4: Targeted People Search

Run title-specific searches:

- `"company" "plant manager" LinkedIn`
- `"company" "production manager" LinkedIn`
- `"company" "production supervisor" LinkedIn`
- `"company" "maintenance manager" LinkedIn`
- `"company" "maintenance supervisor" LinkedIn`
- `"company" "millwright" LinkedIn`
- `"company" "maintenance mechanic" LinkedIn`
- `"company" "operations manager" LinkedIn`
- `"company" "general manager" LinkedIn`
- `"company" "purchaser" LinkedIn`
- `"company" "buyer" LinkedIn`
- `"company" "procurement" LinkedIn`
- `"company" "quality manager" LinkedIn`
- `"company" "engineering manager" LinkedIn`

Also search known names from directories:

- `"person name" "company" LinkedIn`
- `"person name" "company" "title"`

### Pass 5: Directory Cross-Check

Search/open people directories only after the above passes:

- SignalHire company profile and employee list
- Wiza company profile and person pages
- Clodura company profile
- Adapt person/company pages
- ContactOut staff pages
- Source From Ontario / trade delegate pages
- industry association member/speaker pages

Use these to fill titles, roles, emails, direct phones, and coworkers. Mark confidence lower if the source is not official or LinkedIn.

### Pass 6: Stale Contact Check

Before outputting a contact, search for obvious stale/conflicting signals when the person appears questionable:

- `"person name" "company" obituary`
- `"person name" "company" retired`
- `"person name" "company" left"`
- `"person name" "new company"`

If evidence shows the person is deceased, retired, or clearly no longer at the company, do not output them as a current outreach contact. Mention the reason in proof or notes if needed.

## Target Contact Roles

High priority:

- Plant Manager
- Operations Manager
- General Manager
- Maintenance Manager
- Maintenance Supervisor
- Maintenance Mechanic
- Industrial Mechanic
- Millwright
- Production Manager
- Production Supervisor
- Manufacturing Manager
- Engineering Manager
- Facilities Manager
- Quality Manager
- Purchaser
- Buyer
- Procurement
- Supply Chain

Medium priority:

- Site Supervisor
- Lead Hand
- Team Lead
- Project Manager at a production-heavy company
- Estimator at asphalt/concrete/aggregate/metal processors
- Logistics Supervisor when tied to plant/material operations
- Owner/President/VP at smaller plants when no plant manager is visible

Low priority or exclude unless useful:

- HR only
- Sales only
- Marketing only
- Finance/accounting only
- IT only
- generic employee with no title
- company page with no personal profile

## LinkedIn Rules

1. Only put a URL in `linkedin_url` when it is a full personal profile URL containing `/in/`.
2. Do not invent LinkedIn URLs from names.
3. Do not use LinkedIn search result URLs as person profile URLs.
4. Do not use generic company pages as person profile URLs.
5. If a screenshot confirms a profile but does not show the browser URL, include the contact but leave `linkedin_url` empty and note that the profile exists but the exact URL was not captured.
6. If the profile URL is exposed by the company page or search result, use the clean canonical URL without tracking query strings when possible.

## Facility Rules

1. Prefer actual plant/facility addresses over head office addresses.
2. Include head office only when it is also the plant, or when no separate facility phone exists.
3. If the official site lists multiple in-range plants, create one facility row per plant.
4. Do not label an office as a plant unless evidence says manufacturing/processing happens there.
5. If phone numbers are facility-specific, attach them to that facility.
6. If only a main phone is available, attach it to the head office/main facility and note that it is a main company number.

## Confidence Rules

High confidence contact:

- official company source, public LinkedIn profile, government filing, or strong direct source confirms name, title, and company.

Medium confidence contact:

- credible directory confirms name/title/company, or LinkedIn confirms company but another source confirms title.

Low confidence contact:

- directory-only evidence, stale snippets, or role is useful but not directly plant/production/maintenance.

Do not output contacts with no useful title unless notes clearly explain why they are still relevant.

## Failure Rules

Never fail the whole enrichment because one contact field is missing.

If a field is missing:

- use empty string for unknown phone/email/LinkedIn.
- cite the source that proves the rest of the contact.
- set `contact_search_status` to `partial_contacts` or `no_target_contacts_found`.

If the API/model/search call errors:

- retry the failed pass once.
- if it fails again, save the error separately and do not produce fake contacts.
- do not mark the lead as enriched unless the output JSON was actually produced and normalized.

## Normalization Rules

Before saving:

1. Remove duplicate contacts by normalized name and company.
2. Prefer the contact object with a LinkedIn URL over one without.
3. Prefer official or LinkedIn source over directory-only source.
4. Remove tracking query strings from LinkedIn URLs.
5. Remove stale/inactive contacts.
6. Keep source URLs for every contact and facility.
7. Keep contact rows separate from facility rows in the CSV/CRM output.

## CRM Behavior

The CRM row should be created after plant verification, then enriched in-place.

Minimum CRM row after verifier yes:

- company
- facility address
- facility type
- product category
- proof

Additional enrichment fields:

- main phone
- facility phone
- email
- website
- contacts
- contact titles
- LinkedIn URLs
- notes
- contact search status

No contact found is not a reason to delete the lead.
