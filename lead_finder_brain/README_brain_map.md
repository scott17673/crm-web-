# Lead Finder Brain Map

This folder now has one clean finder path:

`dashboard-server.mjs -> find-manufacturers.mjs -> plant-verifier.mjs -> plant-enrichment.mjs`

## Main Files

1. `dashboard-server.mjs`
   - Start/stop API for the finder.
   - Launches `find-manufacturers.mjs`.
   - Serves logs and current CSV rows.

2. `find-manufacturers.mjs`
   - Main runner loop.
   - Searches by city + industry.
   - Builds evidence packets.
   - Runs the plant verifier first.
   - Runs plant enrichment only after verifier yes.
   - Writes CSV rows and syncs accepted leads to CRM.

3. `plant-verifier.mjs`
   - First brain.
   - Strict yes/no decision on whether a company is a real in-range industrial plant operator.

4. `plant-enrichment.mjs`
   - Second brain.
   - Pulls addresses, phones, products, equipment clues, contacts, and LinkedIn links after verifier yes.

5. `PLANT_VERIFIER_SPEC.md`
   - Written rules for the first gate.

6. `PLANT_ENRICHMENT_SPEC.md`
   - Written rules for the second gate.

## Support Files

- `runtime_lib/`
  - Non-brain plumbing only:
  - search
  - website crawling
  - CSV helpers
  - dedupe
  - CRM sync
  - nearby city lists
  - industry query presets

- `accepted-lead-evidence.mjs`
  - Hand-built evidence packets used to test enrichment.

- `enrich-accepted-leads.mjs`
  - Test runner for enrichment on accepted leads.

- `test-fixtures.mjs`
  - Known good/bad verifier examples.

- `test-first-gate.mjs`
  - Verifier test runner.

- `test-output/`
  - Generated test output only.

## What Is Gone

These old brain copies were removed:

- old `company-intelligence.mjs`
- archived old runner copies
- old VM sync copies
- extra local copies of the old live brain

## Quick Mental Model

- `runtime_lib` finds and gathers
- `plant-verifier` decides yes/no
- `plant-enrichment` fills the row after yes
- `find-manufacturers` glues it together
