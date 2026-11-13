# Data scope and national expansion

## Current pilot

| Dataset | Use | Reference date | Limits |
| --- | --- | --- | --- |
| MOIS resident population by administrative dong ([source](https://www.data.go.kr/data/15097972/fileData.do)) | Population and age aggregates for Ulsan | 2026-10-31 | Aggregate population is a potential-demand proxy, not service eligibility or unmet need. |
| Ulsan elder-care platform list ([source](https://www.data.go.kr/data/15054169/fileData.do)) | Names, district, address, operator, and phone | 2025-12-31 | Ulsan describes this local program as home elder support centers. It is not equivalent to every national long-term-care provider category. |
| OpenStreetMap search results ([copyright and license](https://www.openstreetmap.org/copyright)) | Display coordinates for administrative-area population markers | Retrieved during data preparation | OSM objects include nodes, ways, and relations; some results resolve to administrative offices. These points are not a consistent boundary centroid and are not used to calculate distance. |

The current prototype uses public, aggregate and service-location data. It does not use individual benefit records or data from SSIS internal systems. The local welfare-provider list gives the project a social-service planning use case; it should not be described as direct integration with SSIS data.

## Source files and generated files

- `data/ulsan_admin_dong.csv` and `data/ulsan_care_platforms.csv` are the pilot's source files.
- Both source files retain province and administrative-district codes (`sido`, `sigungu_code`) so later regional datasets can be joined by code rather than display name.
- `service_type` preserves the source-specific category `ulsan_elder_care_platform`. Keep the original local category when adding another region; only map it to a shared category after checking the service definition.
- `osm_type` and `osm_id` record the OSM object used for each population-marker coordinate. They do not establish that the point is a statistical centroid.
- `scripts/build-data.mjs` validates and transforms the two source CSVs. It generates `data/ulsan_data.js` for the browser and `data/ulsan_district_summary.csv` from the same records.
- Do not hand-edit generated files. Run `node scripts/build-data.mjs` after changing a source CSV; `npm start` runs this step automatically.

## National expansion sequence

1. Define a common record format for area code, source category, service type, reference date, source URL, and coordinate provenance while retaining the original regional category.
2. Add one region-specific data adapter at a time. Do not combine service types only because their names look similar.
3. Reconcile administrative codes and dates, and publish row counts, missing-address rates, and category mappings for each region.
4. Validate the mapping and display with a second municipality before describing the system as nationally comparable.
5. Add travel-time coverage or facility-placement optimization only after service locations, candidate sites, and movement assumptions are verified.

Potential future use of restricted or person-level social-security data requires a confirmed dataset, access approval, and a defined privacy-safe analysis. It is outside this public-data pilot.
