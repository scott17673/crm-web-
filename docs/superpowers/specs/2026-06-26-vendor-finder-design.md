# ED Vendor Finder — Design Spec
**Date:** 2026-06-26  
**Status:** Approved

## Overview

A new Claude skill (`/ed-vendor-finder`) that finds manufacturing vendor companies in Southern Ontario — engineering firms, industrial trades, and equipment suppliers — and outputs clean CSVs for CRM import. Built alongside `ed-lead-finder` but completely separate.

**Key difference from ed-lead-finder:** targets vendors *to* manufacturers (not manufacturers themselves). Higher intrinsic conversion rate — every mechanical engineering firm is worth a call. Simpler vetting. No Serper dependency.

---

## Pipeline

```
yp_discover.py  →  dedupe_against_crm.py  →  vendor_vet_sites.py  →  2 CSVs
 (YP scraper)      (existing, unchanged)      (YES/NO vetter)
```

### 1. yp_discover.py
Scrapes yellowpages.ca by YP category + city. No API key. No quota.

**Output columns:** `company, website, address, phone, yp_category, vendor_category, city`

`vendor_category` is set from whichever bucket the YP category belongs to: `Engineering`, `Trades`, or `Equipment`.

### 2. dedupe_against_crm.py
Existing script, unchanged. Drops candidates already in the CRM by name/domain/phone/alias.

### 3. vendor_vet_sites.py
Fetches each company's homepage. Applies bucket-specific YES/NO rules.

**Engineering** — YES if: working website. NO if: no website, dead link, or clearly miscategorized.

**Trades** — YES if: working website + at least one industrial signal (`industrial`, `manufacturing`, `commercial`, `plant`, `facility`, `heavy`, `millwright`, `cnc`, `fabricat`). NO if: residential signals dominate (`residential`, `home`, `house`, `condo`, `apartment`) or no website.

**Equipment** — YES if: working website + industrial/product content relevant to the category. NO if: consumer retail, no website, or irrelevant content.

No REVIEW tier. If the data isn't there to confirm → NO.

**Output:**
- `confirmed_vendors.csv` — all YES
- `rejected.csv` — all NO (audit trail)

---

## YP Categories

### Engineering (10)
Mechanical Engineers, Electrical Engineers, Structural Engineers, Industrial Engineers, Consulting Engineers, Automation Systems & Equipment, Control Systems, Industrial Controls, Machine Safety, Safety Consultants

### Trades (16)
Millwrights, Industrial Electricians, Electricians & Electrical Contractors, Welders & Welding, Machine Shops, Mechanical Contractors, Industrial Contractors, Rigging & Machinery Movers, Crane Rental & Service, Pipefitters, Hydraulic Equipment & Supplies, Pump Repair & Installation, Electric Motor Sales & Service, Air Compressors, Overhead Travelling Cranes, Hoists

### Equipment (14)
Conveyors & Conveyor Equipment, Material Handling Equipment, Packaging Machines Equipment & Supplies, Robotics, Pneumatic Equipment, Hydraulic Equipment & Supplies, Industrial Machinery, Industrial Pumps, Dust Collection Systems, Central Vacuum Systems, Bearings, Power Transmission Equipment, Industrial Supplies, Crane Manufacturers & Distributors

---

## Territory
Same as ed-lead-finder — within ~2 hours of Milton, ON. GTA core, Hamilton corridor, Waterloo region, Durham, Barrie, Niagara. No Windsor/Sarnia/Chatham.

---

## CRM Integration
- No auto-push. User decides when to import.
- On push: `bulk-import-vendors.mjs` (same pattern as existing manufacturer imports).
- CRM destination: vendor section with `vendor_category` dropdown (Engineering / Trades / Equipment).

---

## New Files
| File | Location |
|------|----------|
| `yp_discover.py` | `C:\Users\scott\lead-scraper-test\` |
| `vendor_vet_sites.py` | `C:\Users\scott\lead-scraper-test\` |
| `SKILL.md` | `C:\Users\scott\.claude\skills\ed-vendor-finder\` |

**Reused unchanged:** `dedupe_against_crm.py`, `post_vet_crm_filter.py`, `export_crm_dedup.mjs`
