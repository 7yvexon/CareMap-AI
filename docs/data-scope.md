# Data scope and nationwide aggregation

## Active nationwide data

| Dataset | Use | Reference date | Unit | Limits |
| --- | --- | --- | --- | --- |
| MOIS resident population by administrative dong ([source](https://www.data.go.kr/data/15097972/fileData.do)) | Total and age-specific resident counts; calculate age 65+ | 2026-10-31 | Administrative dong | Demographic proxy, not care eligibility or unmet need |
| MOIS single-person households by administrative dong ([source](https://www.data.go.kr/data/15097973/fileData.do)) | Total and age-specific single-person household counts; calculate age 65+ | 2026-10-31 | Administrative dong | A one-person household is not proof of isolation or care need |
| NHIS integrated-care service resources ([source](https://www.data.go.kr/data/15173720/fileData.do)) | Service-resource/program rows aggregated by province, district and category | 2026-06-30 | Province and district names; 90,081 data rows in downloaded CSV | One-time snapshot; rows are not unique institutions or service capacity; some fields are blank |
| geoBoundaries/Natural Earth KOR ADM1 ([metadata](https://www.geoboundaries.org/api/current/gbOpen/KOR/ADM1/)) | Province-level map geometry | 2021 | 17 source polygons combined into 16 current data groups | Geography is a simplified map reference, not a current cadastral boundary source |

## Join and aggregation rules

- Join the MOIS population and single-person household files by their 10-digit `행정기관코드`, never by district display names.
- Derive age 65+ as ages 65 through 109 plus the 110+ column, summing male and female counts.
- Aggregate demographic counts from administrative dong to province and district using the source province/district labels; retain the first five digits of the administrative code as the district code for review.
- The NHIS resource file has no administrative code. Its province/district names are normalized for whitespace and matched against MOIS names. Every named region in the downloaded file matched an MOIS region. Sejong entries with a blank district name are kept at Sejong’s province-wide level.
- Preserve the NHIS service category labels. Aggregate row counts by major and minor category. Do not convert resource rows into facility counts.
- The NHIS file contains 505 blank addresses and 3,559 blank phone fields. These rates are calculated from the 90,081 data rows.
- Six NHIS text characters cannot be decoded from the downloaded CSV as `euc-kr`; generated strings use replacement characters, and the raw CSV is preserved unchanged.
- Map boundaries contain separate 2021 Gwangju and South Jeolla polygons; both are grouped under `전남광주통합특별시` for this data snapshot.

## Current Ulsan pilot material

`data/ulsan_admin_dong.csv`, `data/ulsan_care_platforms.csv`, and their generated artifacts remain as historical pilot references. The current dashboard does not load them. Ulsan's local elder-care platform category is distinct from the NHIS service taxonomy and must not be counted as equivalent without checking service definitions.

## Missing information

- Actual service use, applications, waitlists, unmet requests, and referral outcomes are not present in the active public datasets.
- The NHIS resource snapshot does not provide provider-level capacity, staffing, operating status, or service area.
- The current nationwide dashboard does not geocode service addresses. It does not calculate travel time, walking coverage, or facility placement effects.
- A future AI prediction requires a separately approved and documented outcome dataset, a privacy-safe analysis basis, and validation against observed results.

## Generated artifacts

`scripts/build-data.mjs` reads the three raw public CSV/GeoJSON files in `data/source/`, validates administrative codes and count reconciliation, merges demographic indicators, aggregates service-resource rows, and generates:

- `data/national_data.js` for the browser
- `data/national_district_summary.csv` for review and reuse

The portal CSV files are CP949 encoded. The build script decodes them as `euc-kr`; do not resave the raw inputs as UTF-8 without updating their provenance and decoding rules.
