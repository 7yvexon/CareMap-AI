# Data scope and nationwide aggregation

## Active nationwide data

| Dataset | Use | Reference date | Unit | Limits |
| --- | --- | --- | --- | --- |
| MOIS resident population by administrative dong ([source](https://www.data.go.kr/data/15097972/fileData.do)) | Total and age-specific resident counts; calculate ages 0–17 and 65+ | 2026-10-31 | Administrative dong | Demographic proxy, not care eligibility or unmet need |
| MOIS single-person households by administrative dong ([source](https://www.data.go.kr/data/15097973/fileData.do)) | Total and age-specific single-person household counts; calculate age 65+ | 2026-10-31 | Administrative dong | A one-person household is not proof of isolation or care need |
| NHIS integrated-care service resources ([source](https://www.data.go.kr/data/15173720/fileData.do)) | Searchable service-resource/program rows; aggregate by province, district and category | 2026-06-30 | Province and district names; 90,081 data rows in downloaded CSV | One-time snapshot; rows are not unique institutions or service capacity; some fields are blank |
| MOHW welfare-facility population by type ([source](https://www.data.go.kr/data/15161046/fileData.do)) | Show elderly-related facility-type admission capacity and facility-resident counts | 2025-12 (latest month in the one-time file) | 245 observed area labels; latest month has 4,230 area-by-type rows and 35 types | Regional aggregates, not dong or facility records; values are not vacancies or current availability; source geography predates the 2026 administrative changes |
| National local children's center standard data ([source](https://www.data.go.kr/data/15129438/standard.do)) | Aggregate record-row status by coordinate-assigned district | Collected 2026-11-14; source row dates 2024-08-08–2026-10-26 | 2,570 rows; 2,564 ordinary rows plus 6 address/coordinate review candidates | Rows are not unique facilities, operating status, capacity, or availability; districts without a row are unobserved in this snapshot |
| geoBoundaries/Natural Earth KOR ADM1 ([metadata](https://www.geoboundaries.org/api/current/gbOpen/KOR/ADM1/)) | Province-level map geometry | 2021 | 17 source polygons combined into 16 current data groups | Geography is a simplified map reference, not a current cadastral boundary source |
| SGIS administrative-dong boundaries, processed by [vuski/admdongkor](https://github.com/vuski/admdongkor/tree/master/ver20261001) | Province drill-down, neighborhood polygons, map zoom and selection | 2026-10-01 | `adm_cd2` 10-digit code; GeoJSON WGS84 | CC BY 4.0; 3,558 of 3,620 population codes match; some branch offices/new units have no matching polygon |

## Join and aggregation rules

- Join the MOIS population and single-person household files by their 10-digit `행정기관코드`, never by district display names.
- Derive ages 0–17 by summing male and female counts for ages 0 through 17. `countNumber` rejects blank or missing values, negative values, non-integers, and values outside the safe-integer range, so a missing required age header fails the build.
- Derive age 65+ as ages 65 through 109 plus the 110+ column, summing male and female counts.
- Aggregate demographic counts from administrative dong to province and district using the source province/district labels; retain the first five digits of the administrative code as the district code for review.
- The NHIS resource file has no administrative code. Its province/district names are normalized for whitespace and matched against MOIS names. Every named region in the downloaded file matched an MOIS region. Sejong entries with a blank district name are kept at Sejong’s province-wide level.
- Preserve the NHIS service category labels. Aggregate row counts by major and minor category. Do not convert resource rows into facility counts.
- The MOHW file has 50,725 monthly rows. Use only the latest month present (2025-12); the column named 행정동명 contains observed Sido and Sido-plus-city/district labels, not a complete set of administrative dongs. Sum the disjoint source-area rows for province and national totals, including Sido-only residual rows and the 2025 Sejong area. Do not add province totals to their own districts or split a parent-city total among newer child districts.
- Match MOHW areas by normalized Sido/district labels after mapping 2025 Gwangju and South Jeolla to the current 전남광주통합특별시. Of 256 current district units, 212 have a direct source-area match, 39 use a source parent-city total, and 5 use a province aggregate. The UI identifies these scopes and preserves the source area name; dong selection continues to show its parent-region statistics.
- Show only the 9 observed facility types containing 노인 in the selected-region panel, with the source fields 입소정원수 and 시설생활자수. Do not sum across facility types or interpret a capacity-minus-residents difference as available places; definitions and reporting coverage vary by type.
- The NHIS file contains 505 blank addresses and 3,559 blank phone fields. These rates are calculated from the 90,081 data rows.
- Six NHIS text characters cannot be decoded from the downloaded CSV as `euc-kr`; generated strings use replacement characters, and the raw CSV is preserved unchanged.
- The portal description states 34 minor categories, while 28 distinct minor categories have records in this CSV. Verify whether the other six categories have no records in this snapshot or were omitted before claiming complete category coverage.
- Join detailed administrative-dong geometry to population rows by the exact 10-digit `adm_cd2`/`행정기관코드`; do not infer a dong polygon from the display name.
- The boundary file has 3,559 features: 3,558 match a population code and one older/unmatched feature remains. Sixty-two population rows have no exact polygon (mostly 출장소). This includes Pyeongtaek 고덕1동 (`4122067000`) and 고덕2동 (`4122068000`), added on 2026-10-12 after the boundary snapshot ([MOIS notice](https://www.mois.go.kr/frt/bbs/type001/commonSelectBoardArticle.do?bbsId=BBSMSTR_000000000052&nttId=130109)); the boundary still has the retired 고덕동 polygon (`4122066000`). Selecting a row without a matching polygon displays the parent 시군구's available polygons and a boundary-coverage notice, not the selected dong's boundary.
- District display names are whitespace-normalized when filtering boundary features because some boundary names concatenate city and district names (for example, `수원시장안구`).
- Province background boundaries contain separate 2021 Gwangju and South Jeolla polygons; both are grouped under `전남광주통합특별시`. Selected lower-level areas use the 2026-10-01 SGIS-based boundaries.

## Service search and AI role

The dashboard's baseline service search filters the raw resource rows nationwide or by a selected province/district and ranks keyword and category matches. It returns source program, provider, contact, address, category, and matching terms. Dong selection does not narrow this source because it has no dong-level service rows.

An optional browser-based semantic mode compares the input sentence with descriptions of the 28 observed minor categories using `multilingual-e5-small` ONNX embeddings. It shows the three closest categories as candidates; the user must select any categories to include before the follow-up search. The selected categories are combined with the deterministic keyword and rule baseline to retrieve source rows. If the model cannot load, the search continues with the baseline. The model is not fine-tuned or evaluated for social-welfare requests, always returns closest categories even for out-of-domain questions, and does not assess eligibility, urgency, risk, demand, or availability. Similarity scores are not probabilities. The user still needs to verify a candidate with its provider.

The selected-region category panel loads `/api/service-summary` from the SQLite catalog and groups source program/resource rows by their original major category. If the API is unavailable, it falls back to the generated regional summary. These are record counts, not distinct institutions, service capacity, or current availability; the panel uses the whole category breakdown even when a category filter is selected.

The search returns retrieved source records rather than generated descriptions. It does not add eligibility or availability claims that are absent from the source. The current data supports resource discovery, not an individual risk or unmet-need prediction.

Do not enter personal identifiers. The local server does not persist search requests. Keep the service search as a candidate-finding aid: eligibility, active status, capacity, and actual availability require confirmation by a provider or a human caseworker.

## Proposed evaluation (not yet performed)

Prepare scenarios with social-welfare practitioners and compare the search output with their reviewed candidate list. Report:

- Top-3 candidate relevance, reviewed by practitioners
- Whether each displayed reason is supported by the source row
- Time to locate a relevant program compared with the existing manual search process
- Address and phone verification rate, including records with missing fields
- Results by service category and urban/rural area, to identify uneven performance

Do not report an improvement or model accuracy until these measurements have been run on a documented sample.

## Current Ulsan pilot material

`data/ulsan_admin_dong.csv`, `data/ulsan_care_platforms.csv`, and their generated artifacts remain as historical pilot references. The current dashboard does not load them. Ulsan's local elder-care platform category is distinct from the NHIS service taxonomy and must not be counted as equivalent without checking service definitions.

## Current child mode (aggregate status only)

The official [national local children's center standard dataset](https://www.data.go.kr/data/15129438/standard.do) was collected on 2026-11-14 as `data/source/national_child_centers_20261114.json`; the portal listed 2026-11-13 as its last-modified date. Its 2,570 rows have different source dates from 2024-08-08 through 2026-10-26. The build spatially assigns all 2,570 coordinates to the saved 2026-10-01 administrative-dong boundaries. Six rows whose normalized address prefix and coordinate-assigned district differ are flagged for review and excluded from ordinary district record counts, leaving 2,564 ordinary rows. They are review candidates, not confirmed coordinate errors.

The dashboard map is colored by the share of resident population aged 0–17. Children's-center status is shown separately in the nationwide overview and selected-region panel; selecting an administrative dong shows its parent district's status. A district with no ordinary row is labeled as having no record observed in this snapshot, not as having no centers. Across 256 districts, 146 have an ordinary row and 110 are unobserved in this snapshot. The row counts do not establish unique facilities, current operation, capacity, availability, service need, or a welfare gap.

The National Center for the Rights of the Child's 2025 year-end directory is not displayed. Its crosswalk to current districts and reuse conditions remain unresolved; do not merge it with the standard dataset into a single current facility count. The detailed coverage and missing-field review is in [child-welfare-data-review.md](child-welfare-data-review.md).

## Potential youth-facility source (not integrated)

The [national youth training facilities standard dataset](https://www.data.go.kr/data/15129449/standard.do) is a possible separate map layer. Its official catalog page lists CSV among the available formats and fields for facility name, province, district, addresses, contact details, operating organization, main facilities, area, staff count, and representative name. The page showed a last-modified date of 2026-11-02 and an update frequency of "as needed" when reviewed on 2026-11-14.

The downloaded file itself was not verified in this review, so its row count, current record coverage, and actual unauthenticated download behavior are unknown. The dataset page links to the portal's general reuse policy instead of showing a dataset-specific license; check the provider's rights before redistributing records. The official field list includes representative names; exclude that field from any generated database, browser payload, and report. The listed fields do not include coordinates, and facility-level geocoding has not been done. If later integrated, show it as a separate youth activity-facility layer; it has no verified capacity, waiting-list, or availability fields and cannot measure care coverage or a service gap.

## Missing information

- Actual service use, applications, waitlists, unmet requests, and referral outcomes are not present in the active public datasets.
- The NHIS resource snapshot does not provide provider-level capacity, staffing, operating status, or service area.
- The current nationwide dashboard does not geocode service addresses. It does not calculate travel time, walking coverage, or facility placement effects.
- The resource snapshot does not show whether each provider/program is currently active. Search results must be verified before referral.
- A future AI prediction requires a separately approved and documented outcome dataset, a privacy-safe analysis basis, and validation against observed results.

## Generated artifacts

`scripts/build-data.mjs` reads the raw public CSV/JSON/GeoJSON files in `data/source/`, validates administrative codes and count reconciliation, derives ages 0–17 and 65+, aggregates service-resource, welfare-facility population, and children's-center district records, and generates:

- `data/national_data.js` for the browser, including age counts and district-level children's-center record status; individual children's-center rows are not included
- `data/national_district_summary.csv` for review and reuse, including child population and ordinary, coordinate-assigned, and address/coordinate-review row counts

`server.mjs` reads `data/source/admin_dong_boundaries_20261001.geojson.gz` and serves only the selected province or district boundary set from `/api/area-boundaries`. The GeoJSON is gzip-compressed losslessly in the repository. Its data attribution is inherited from SGIS and the CC BY 4.0 processing terms documented by `vuski/admdongkor`.

The portal CSV files are CP949 encoded. The build script decodes them as `euc-kr`; do not resave the raw inputs as UTF-8 without updating their provenance and decoding rules.
