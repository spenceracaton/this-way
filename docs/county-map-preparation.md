# Preparing new Pinellas maps

The 87-map catalog exhausts the prepared bundles found in the pinned FTW source
audit. New areas need fresh geography. The first research candidates are
Greenbriar, Harbor Bluffs, and South Highpoint, in that order. Their source
identities and boundaries remain unverified. They are absent from the public
picker and production coverage registry.

[The candidate queue](../scripts/county-map-candidates.json) separates research
from accepted maps. Its FDOT Census-derived reference areas are not association
boundaries or parcel membership. County road centerlines and USGS water are
separate sources; each retains its own metadata and terms. No listing, residence,
photo, seasonal overlay, or participation records are part of this work.

## One neighborhood per iteration

1. Query the exact reference-area name and verify it is the intended Pinellas
   area. Preserve the original feature ID, all geometry parts and holes, source
   URLs, response checksums, and retrieval time. Ambiguous names or unsupported
   geometry stop the attempt rather than producing a guessed outline.
2. Acquire all road and water records for the reference extent. Reconcile object
   IDs across pages; a truncated or duplicate response must fail. Bind names and
   road classes from inspected service metadata, not guessed field names.
3. Draw a neutral preview in a cloud scratch directory. Keep raw geographic
   inputs separately reusable. Verify four spatially separated source-to-artwork
   anchors, masks, credits, and source terms. Keep the source and raster hashes.
4. Inspect actual WebKit renders at 390×664, 320×568, and 664×390, including zoom
   and picker states. Have UX and visual reviewers critique the results. Revise
   concrete issues and repeat the affected checks.
5. Record the result, failed assumptions, request/byte counts, rendered/reused
   assets, validation results, and the specific process change for the next
   neighborhood. Finish this reflection before starting the next candidate.
6. Promote a verified bundle through a focused ordinary PR, required checks,
   auto-merge, and exact-main production verification under `AGENTS.md`.

Do not change the catalog count when only a queue entry, source snapshot, or
preview exists. The current application model's single-ring coverage must not
silently discard parts or holes from a new reference boundary.

## First attempt: Greenbriar source preflight

- Result: source access blocked; no new boundary, map, or raster is verified.
- Evidence: the cloud's enforced policy does not allow the three GIS hosts. A
  read-only FDOT layer metadata request returned HTTP 403.
- Preparation: the source queue and snapshot acquisition helper are separate
  from production map registration. Offline fixtures exercise source-response
  failures and download completeness; they do not validate the live services.
- Process critique: establish source identity, response geometry, and complete
  pagination before investing in a renderer or making artwork. Reusing the
  Feather Sound approach does not establish another area's boundary or terms.
- Next change: enable the three read-only GIS source hosts through the cloud
  environment configuration workflow, then inspect actual metadata and acquire
  Greenbriar alone. Save the source result and critique before continuing.

The saved network draft adds `gis.fdot.gov`, `services.arcgis.com`, and
`hydro.nationalmap.gov` while preserving the existing destinations. Saving a
draft does not apply or publish it. The acquisition helper needs no production
database credentials or Cloudflare deployment token.

## Acquisition entry point

After source access is enabled, start with this single candidate:

```sh
python3 scripts/acquire-county-geography.py \
  --name Greenbriar --candidate-id greenbriar-cdp \
  --output /workspace/design-review/county-candidates/greenbriar-source-1
```

The destination must be new and outside `public/`. The tool saves boundary,
road, and water GeoJSON; original metadata; source features; retrieval time;
actual field bindings; reconciled record counts; and file checksums. It stages
the complete snapshot before installing the destination directory. This output
is research input, not an approved application map.

Ambiguous metadata stops acquisition. Inspect the metadata before supplying
`--boundary-name-field`, `--road-name-field`, or `--road-class-field`; each
override must name an actual source field. Multipart boundaries and holes are
retained for review. A successful download still requires source-term and
identity review, geometry validation, and the map critique loop above.

The twelve offline protocol fixtures pass. They exercise complete paginated
retrieval, missing/duplicate/truncated records, ambiguous names, source errors,
coordinate-system rejection, multipart geometry, and empty water results. The
real FDOT/County/USGS service contracts remain unverified until access works.
