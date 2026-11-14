import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';
import { gunzipSync } from 'node:zlib';
import {
  buildDistrictSpatialIndex,
  findAddressCoordinateConflicts,
  locatePoint,
} from './lib/point-region-join.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const koreanDecoder = new TextDecoder('euc-kr');
const encodingReplacementCounts = new Map();

function parseCsv(buffer, label) {
  const text = koreanDecoder.decode(buffer);
  encodingReplacementCounts.set(label, (text.match(/\uFFFD/g) ?? []).length);
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field.replace(/\r$/, ''));
      if (row.some(value => value !== '')) rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }

  if (field.length || row.length) {
    row.push(field.replace(/\r$/, ''));
    if (row.some(value => value !== '')) rows.push(row);
  }

  const [rawHeaders, ...values] = rows;
  if (!rawHeaders?.length) throw new Error(`${label} is empty`);
  const headers = rawHeaders.map((header, index) => index === 0 ? header.replace(/^\uFEFF/, '') : header);
  const headerSet = new Set(headers);
  if (headerSet.size !== headers.length) throw new Error(`${label} has duplicate column names`);

  return values.map((columns, rowIndex) => {
    if (columns.length !== headers.length) {
      throw new Error(`${label} row ${rowIndex + 2} has ${columns.length} columns; expected ${headers.length}`);
    }
    return Object.fromEntries(headers.map((header, index) => [header, columns[index]]));
  });
}

async function readCsv(path) {
  return parseCsv(await readFile(join(root, path)), path);
}

function normalize(value) {
  return String(value ?? '').replaceAll('\u00a0', ' ').replace(/\s+/g, ' ').trim();
}

function number(value, label) {
  const parsed = Number(String(value ?? '').replaceAll(',', '').trim() || 0);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid number for ${label}: ${value}`);
  return parsed;
}

function countNumber(value, label) {
  const text = normalize(value).replaceAll(',', '');
  if (!text) throw new Error(`Missing count for ${label}`);
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`Invalid non-negative integer count for ${label}: ${value}`);
  return parsed;
}

function elderlyTotal(row, label) {
  let total = 0;
  for (let age = 65; age <= 109; age++) {
    total += countNumber(row[`${age}세남자`], `${label}.${age}세남자`);
    total += countNumber(row[`${age}세여자`], `${label}.${age}세여자`);
  }
  total += countNumber(row['110세이상 남자'], `${label}.110세이상 남자`);
  total += countNumber(row['110세이상 여자'], `${label}.110세이상 여자`);
  return total;
}

function childrenTotal(row, label) {
  let total = 0;
  for (let age = 0; age <= 17; age++) {
    total += countNumber(row[`${age}세남자`], `${label}.${age}세남자`);
    total += countNumber(row[`${age}세여자`], `${label}.${age}세여자`);
  }
  return total;
}

function bump(record, key) {
  const normalized = normalize(key) || '분류 미기재';
  record[normalized] = (record[normalized] ?? 0) + 1;
}

function regionKey(sido, sigungu) {
  return `${normalize(sido)}\u001f${normalize(sigungu)}`;
}

function quoteCsv(value) {
  return `"${String(value ?? '').replaceAll('"', '""')}"`;
}

const populationRows = await readCsv('data/source/mois_admin_dong_population_20261031.csv');
const householdRows = await readCsv('data/source/mois_admin_dong_single_person_households_20261031.csv');
const resourceRows = await readCsv('data/source/nhis_integrated_care_resources_20260630.csv');
const facilityPopulationRows = await readCsv('data/source/mohw_welfare_facility_population_20251231.csv');
const boundarySource = JSON.parse(await readFile(join(root, 'data/source/kor_admin1_boundaries_2021.geojson'), 'utf8'));
const childCenterRows = JSON.parse(await readFile(join(root, 'data/source/national_child_centers_20261114.json'), 'utf8'));
const childCenterBoundaryData = JSON.parse(gunzipSync(await readFile(join(root, 'data/source/admin_dong_boundaries_20261001.geojson.gz'))).toString('utf8'));
if (!Array.isArray(childCenterRows)) throw new Error('National child center source must be a JSON array');
const childCenterSpatialIndex = buildDistrictSpatialIndex(childCenterBoundaryData);

const householdsByCode = new Map();
for (const row of householdRows) {
  const code = normalize(row['행정기관코드']);
  if (!/^\d{10}$/.test(code)) throw new Error(`Invalid household administrative code: ${code}`);
  if (householdsByCode.has(code)) throw new Error(`Duplicate household administrative code: ${code}`);
  householdsByCode.set(code, row);
}

const adminCodes = new Set();
const districtsByKey = new Map();
const provincesByName = new Map();
const areas = populationRows.map(row => {
  const code = normalize(row['행정기관코드']);
  if (!/^\d{10}$/.test(code)) throw new Error(`Invalid population administrative code: ${code}`);
  if (adminCodes.has(code)) throw new Error(`Duplicate population administrative code: ${code}`);
  adminCodes.add(code);

  const householdRow = householdsByCode.get(code);
  if (!householdRow) throw new Error(`Missing single-household row for administrative code: ${code}`);
  const asOf = normalize(row['기준연월']);
  const population = number(row['계'], `${code}.population`);
  const male = number(row['남자'], `${code}.male`);
  const female = number(row['여자'], `${code}.female`);
  const children0To17 = childrenTotal(row, code);
  const elderly = elderlyTotal(row, code);
  const singlePersonHouseholds = number(householdRow['계'], `${code}.singlePersonHouseholds`);
  const elderlySinglePersonHouseholds = elderlyTotal(householdRow, `${code}.elderlySinglePersonHouseholds`);

  if (population !== male + female || children0To17 + elderly > population) {
    throw new Error(`Population values do not reconcile for ${code}`);
  }
  if (number(householdRow['남자'], `${code}.maleSinglePersonHouseholds`) +
      number(householdRow['여자'], `${code}.femaleSinglePersonHouseholds`) !== singlePersonHouseholds ||
      elderlySinglePersonHouseholds > singlePersonHouseholds) {
    throw new Error(`Single-household values do not reconcile for ${code}`);
  }

  const sido = normalize(row['시도명']);
  const sigungu = normalize(row['시군구명']);
  const dong = normalize(row['읍면동명']);
  if (!sido || !dong || !asOf) throw new Error(`Area is missing a required field: ${code}`);

  const area = {
    code,
    sigunguCode: code.slice(0, 5),
    asOf,
    sido,
    sigungu,
    dong,
    population,
    male,
    female,
    children0To17,
    childrenRate: population ? children0To17 / population : 0,
    elderly,
    elderlyRate: population ? elderly / population : 0,
    singlePersonHouseholds,
    elderlySinglePersonHouseholds,
  };

  const key = regionKey(sido, sigungu);
  const district = districtsByKey.get(key) ?? {
    districtId: `${sido}:${sigungu || '시도 전체'}`,
    sido,
    sigungu,
    sigunguCode: area.sigunguCode,
    dongCount: 0,
    population: 0,
    children0To17: 0,
    childCenterRecordRows: 0,
    childCenterCoordinateAssignedRows: 0,
    childCenterAddressCoordinateReviewRows: 0,
    elderly: 0,
    singlePersonHouseholds: 0,
    elderlySinglePersonHouseholds: 0,
    resourceRows: 0,
    resourcesByMajor: {},
    resourcesByMinor: {},
    missingAddressRows: 0,
    missingPhoneRows: 0,
  };
  district.dongCount++;
  district.population += population;
  district.children0To17 += children0To17;
  district.elderly += elderly;
  district.singlePersonHouseholds += singlePersonHouseholds;
  district.elderlySinglePersonHouseholds += elderlySinglePersonHouseholds;
  districtsByKey.set(key, district);

  const province = provincesByName.get(sido) ?? {
    sido,
    dongCount: 0,
    districtCount: 0,
    population: 0,
    children0To17: 0,
    childCenterRecordRows: 0,
    childCenterCoordinateAssignedRows: 0,
    childCenterAddressCoordinateReviewRows: 0,
    elderly: 0,
    singlePersonHouseholds: 0,
    elderlySinglePersonHouseholds: 0,
    resourceRows: 0,
    resourcesByMajor: {},
    missingAddressRows: 0,
    missingPhoneRows: 0,
  };
  province.dongCount++;
  province.population += population;
  province.children0To17 += children0To17;
  province.elderly += elderly;
  province.singlePersonHouseholds += singlePersonHouseholds;
  province.elderlySinglePersonHouseholds += elderlySinglePersonHouseholds;
  provincesByName.set(sido, province);

  return area;
});

if (householdsByCode.size !== adminCodes.size || [...householdsByCode.keys()].some(code => !adminCodes.has(code))) {
  throw new Error('Population and single-household administrative codes do not match');
}

const populationDistrictsByCode = new Map([...districtsByKey.values()].map(district => [district.sigunguCode, district]));
const childCenterCoordinateRecords = childCenterRows.map((row, index) => {
  const latitudeText = normalize(row.LAT).replaceAll(',', '');
  const longitudeText = normalize(row.LOT).replaceAll(',', '');
  const latitude = latitudeText ? Number(latitudeText) : Number.NaN;
  const longitude = longitudeText ? Number(longitudeText) : Number.NaN;
  return {
    rowNumber: index + 1,
    latitude,
    longitude,
    addressTexts: [normalize(row.LCTN_ROAD_NM), normalize(row.LCTN_LOTNO_ADDR)].filter(Boolean),
    regionCode: '',
    joinStatus: 'not_processed',
  };
});

let childCenterCoordinateAssignedRows = 0;
let childCenterUnassignedRows = 0;
for (const record of childCenterCoordinateRecords) {
  const result = locatePoint(record.longitude, record.latitude, childCenterSpatialIndex);
  record.joinStatus = result.status;
  if (!result.district) {
    childCenterUnassignedRows++;
    continue;
  }
  record.regionCode = result.district.code;
  const populationDistrict = populationDistrictsByCode.get(record.regionCode);
  if (!populationDistrict) {
    childCenterUnassignedRows++;
    record.joinStatus = 'district_not_in_population_reference';
    continue;
  }
  childCenterCoordinateAssignedRows++;
  populationDistrict.childCenterCoordinateAssignedRows++;
  const province = provincesByName.get(populationDistrict.sido);
  province.childCenterCoordinateAssignedRows++;
}

const childCenterAddressCoordinateConflicts = findAddressCoordinateConflicts(
  childCenterCoordinateRecords,
  [...childCenterSpatialIndex.districts.values()],
);
const childCenterConflictRows = new Set(childCenterAddressCoordinateConflicts.map(conflict => conflict.recordId));
for (const record of childCenterCoordinateRecords) {
  if (!record.regionCode || !populationDistrictsByCode.has(record.regionCode)) continue;
  const populationDistrict = populationDistrictsByCode.get(record.regionCode);
  const province = provincesByName.get(populationDistrict.sido);
  if (childCenterConflictRows.has(record.rowNumber)) {
    populationDistrict.childCenterAddressCoordinateReviewRows++;
    province.childCenterAddressCoordinateReviewRows++;
  } else {
    populationDistrict.childCenterRecordRows++;
    province.childCenterRecordRows++;
  }
}

const childCenterSourceDates = childCenterRows
  .map(row => normalize(row.DATA_CRTR_YMD).replace(/[^0-9]/g, '').slice(0, 8))
  .filter(value => /^\d{8}$/.test(value))
  .sort();
const childCenterObservedDistrictCount = [...districtsByKey.values()]
  .filter(district => district.childCenterRecordRows > 0).length;

const majorCategories = new Set();
const minorCategories = new Set();
let missingAddressRows = 0;
let missingPhoneRows = 0;
let provinceOnlyResourceRows = 0;

for (const row of resourceRows) {
  const sido = normalize(row['시도']);
  const sigungu = normalize(row['시군구']);
  const major = normalize(row['대분류']) || '분류 미기재';
  const minor = normalize(row['중분류']) || '분류 미기재';
  const hasAddress = Boolean(normalize(row['기관주소']));
  const hasPhone = Boolean(normalize(row['기관연락처']));

  if (!sido) throw new Error('Service-resource row has no province field');
  const province = provincesByName.get(sido);
  if (!province) throw new Error(`Service resource references an unknown province: ${sido}`);
  if (!sigungu) provinceOnlyResourceRows++;

  const district = districtsByKey.get(regionKey(sido, sigungu));
  if (district) {
    district.resourceRows++;
    bump(district.resourcesByMajor, major);
    bump(district.resourcesByMinor, minor);
    if (!hasAddress) district.missingAddressRows++;
    if (!hasPhone) district.missingPhoneRows++;
  } else if (sigungu) {
    throw new Error(`Service resource references an unknown district: ${sido} ${sigungu}`);
  }

  province.resourceRows++;
  bump(province.resourcesByMajor, major);
  if (!hasAddress) {
    missingAddressRows++;
    province.missingAddressRows++;
  }
  if (!hasPhone) {
    missingPhoneRows++;
    province.missingPhoneRows++;
  }
  majorCategories.add(major);
  minorCategories.add(minor);
}

const facilitySidoAliases = new Map([...provincesByName.keys()].map(sido => [sido, sido]));
facilitySidoAliases.set('광주광역시', '전남광주통합특별시');
facilitySidoAliases.set('전라남도', '전남광주통합특별시');
const facilitySidoAliasEntries = [...facilitySidoAliases.entries()].sort((a, b) => b[0].length - a[0].length);
const facilityPopulationAsOf = facilityPopulationRows
  .map(row => normalize(row['통계연월']))
  .filter(Boolean)
  .sort()
  .at(-1);
if (!facilityPopulationAsOf) throw new Error('Welfare-facility population file has no reference month');

const facilityRowsForLatestMonth = facilityPopulationRows.filter(
  row => normalize(row['통계연월']) === facilityPopulationAsOf,
);
const facilityAreasBySourceName = new Map();
const facilityAreasByRegion = new Map();
const facilityTypes = new Set();

for (const [index, row] of facilityRowsForLatestMonth.entries()) {
  const sourceAreaName = normalize(row['행정동명']);
  const aliasEntry = facilitySidoAliasEntries.find(([alias]) =>
    sourceAreaName === alias || sourceAreaName.startsWith(alias + ' '));
  if (!aliasEntry) throw new Error('Unmapped welfare-facility area at latest-month row ' + (index + 2) + ': ' + sourceAreaName);

  const [sourceSido, sido] = aliasEntry;
  const suffix = normalize(sourceAreaName.slice(sourceSido.length));
  const sigungu = !suffix || suffix === sourceSido || suffix === sido ? '' : suffix;
  const sourceLevel = sigungu ? 'district' : 'province';
  const facilityType = normalize(row['복지시설유형명']);
  if (!facilityType) throw new Error('Welfare-facility row has no facility type: ' + sourceAreaName);

  const area = facilityAreasBySourceName.get(sourceAreaName) ?? {
    sourceAreaName,
    sourceSidoName: sourceSido,
    sido,
    sigungu,
    sourceLevel,
    byType: {},
  };
  if (area.sourceSidoName !== sourceSido || area.sido !== sido || area.sigungu !== sigungu || area.sourceLevel !== sourceLevel) {
    throw new Error('Welfare-facility area maps inconsistently: ' + sourceAreaName);
  }
  const stats = area.byType[facilityType] ?? { capacity: 0, residents: 0 };
  stats.capacity += number(row['입소정원수'], sourceAreaName + '.' + facilityType + '.capacity');
  stats.residents += number(row['시설생활자수'], sourceAreaName + '.' + facilityType + '.residents');
  area.byType[facilityType] = stats;
  facilityAreasBySourceName.set(sourceAreaName, area);
  facilityTypes.add(facilityType);

  if (sigungu) {
    const key = regionKey(sido, sigungu);
    const previous = facilityAreasByRegion.get(key);
    if (previous && previous.sourceAreaName !== sourceAreaName) {
      throw new Error('Duplicate welfare-facility district area: ' + sourceAreaName);
    }
    facilityAreasByRegion.set(key, area);
  }
}

function addFacilityTypes(target, source) {
  for (const [facilityType, values] of Object.entries(source ?? {})) {
    const current = target[facilityType] ?? { capacity: 0, residents: 0 };
    current.capacity += values.capacity;
    current.residents += values.residents;
    target[facilityType] = current;
  }
}

function makeFacilityPopulation(byType, sourceLevel, sourceAreaNames) {
  return {
    asOf: facilityPopulationAsOf,
    sourceLevel,
    sourceAreaNames: [...new Set(sourceAreaNames)].sort((a, b) => a.localeCompare(b, 'ko')),
    byType: Object.fromEntries(Object.entries(byType).sort(([a], [b]) => a.localeCompare(b, 'ko'))),
  };
}

const facilityProvinceAreas = new Map();
for (const area of facilityAreasBySourceName.values()) {
  const province = facilityProvinceAreas.get(area.sido) ?? { sourceAreaNames: [], byType: {} };
  province.sourceAreaNames.push(area.sourceSidoName);
  addFacilityTypes(province.byType, area.byType);
  facilityProvinceAreas.set(area.sido, province);
}

for (const province of provincesByName.values()) {
  const source = facilityProvinceAreas.get(province.sido);
  if (!source) throw new Error('Welfare-facility data has no province aggregate for ' + province.sido);
  province.facilityPopulation = makeFacilityPopulation(source.byType, 'province', source.sourceAreaNames);
}

const facilityDistrictMatchCounts = { district: 0, city: 0, province: 0 };
for (const district of districtsByKey.values()) {
  const exact = facilityAreasByRegion.get(regionKey(district.sido, district.sigungu));
  let matchedArea = exact;
  let sourceLevel = 'district';

  if (!matchedArea && district.sigungu) {
    const parentCities = [...facilityAreasByRegion.values()]
      .filter(area => area.sido === district.sido
        && area.sigungu.endsWith('시')
        && district.sigungu.startsWith(area.sigungu + ' '))
      .sort((a, b) => b.sigungu.length - a.sigungu.length);
    matchedArea = parentCities[0];
    if (matchedArea) sourceLevel = 'city';
  }

  if (matchedArea) {
    district.facilityPopulation = makeFacilityPopulation(
      matchedArea.byType,
      sourceLevel,
      [matchedArea.sourceAreaName],
    );
  } else {
    district.facilityPopulation = {
      ...provincesByName.get(district.sido).facilityPopulation,
      sourceLevel: 'province',
    };
    sourceLevel = 'province';
  }
  facilityDistrictMatchCounts[sourceLevel]++;
}

const nationalFacilityTypes = {};
for (const province of provincesByName.values()) {
  addFacilityTypes(nationalFacilityTypes, province.facilityPopulation.byType);
}
const nationalFacilityPopulation = makeFacilityPopulation(
  nationalFacilityTypes,
  'national',
  [...provincesByName.values()].flatMap(province => province.facilityPopulation.sourceAreaNames),
);
const elderlyFacilityTypes = [...facilityTypes]
  .filter(facilityType => facilityType.includes('노인'))
  .sort((a, b) => a.localeCompare(b, 'ko'));

for (const province of provincesByName.values()) {
  province.districtCount = [...districtsByKey.values()].filter(district => district.sido === province.sido).length;
}

const boundaryNameToSido = new Map([
  ['Gangwon', '강원특별자치도'],
  ['Gyeonggi', '경기도'],
  ['South Chungcheong', '충청남도'],
  ['Incheon', '인천광역시'],
  ['North Jeolla', '전북특별자치도'],
  ['South Jeolla', '전남광주통합특별시'],
  ['South Gyeongsang', '경상남도'],
  ['Busan', '부산광역시'],
  ['Ulsan', '울산광역시'],
  ['North Gyeongsang', '경상북도'],
  ['Jeju', '제주특별자치도'],
  ['Seoul', '서울특별시'],
  ['Daejeon', '대전광역시'],
  ['Sejong', '세종특별자치시'],
  ['North Chungcheong', '충청북도'],
  ['Gwangju', '전남광주통합특별시'],
  ['Daegu', '대구광역시'],
]);

const boundaryGroups = new Map();
for (const feature of boundarySource.features ?? []) {
  const sourceName = normalize(feature.properties?.shapeName);
  const sido = boundaryNameToSido.get(sourceName);
  if (!sido) throw new Error(`Unmapped province boundary: ${sourceName}`);
  if (!provincesByName.has(sido)) throw new Error(`Boundary has no population summary: ${sido}`);
  const group = boundaryGroups.get(sido) ?? { sourceNames: [], coordinates: [] };
  group.sourceNames.push(sourceName);
  const geometry = feature.geometry;
  if (geometry?.type === 'Polygon') group.coordinates.push(geometry.coordinates);
  else if (geometry?.type === 'MultiPolygon') group.coordinates.push(...geometry.coordinates);
  else throw new Error(`Unsupported geometry type for ${sourceName}: ${geometry?.type}`);
  boundaryGroups.set(sido, group);
}

if (boundaryGroups.size !== provincesByName.size) {
  throw new Error(`Province boundary count ${boundaryGroups.size} does not match population count ${provincesByName.size}`);
}

const boundaries = [...boundaryGroups.entries()].map(([sido, group]) => ({
  type: 'Feature',
  properties: { sido, sourceNames: group.sourceNames, referenceYear: 2021 },
  geometry: { type: 'MultiPolygon', coordinates: group.coordinates },
}));

const districts = [...districtsByKey.values()]
  .map(district => ({
    ...district,
    displayName: district.sigungu || district.sido,
    childrenRate: district.population ? district.children0To17 / district.population : 0,
    elderlyRate: district.population ? district.elderly / district.population : 0,
    resourceCategoryCount: Object.keys(district.resourcesByMajor).length,
  }))
  .sort((a, b) => a.sido.localeCompare(b.sido, 'ko') || a.displayName.localeCompare(b.displayName, 'ko'));

const provinces = [...provincesByName.values()]
  .map(province => ({
    ...province,
    childrenRate: province.population ? province.children0To17 / province.population : 0,
    elderlyRate: province.population ? province.elderly / province.population : 0,
  }))
  .sort((a, b) => a.sido.localeCompare(b.sido, 'ko'));

const childrenPopulationByArea = areas.reduce((sum, area) => sum + area.children0To17, 0);
const childrenPopulationByDistrict = districts.reduce((sum, district) => sum + district.children0To17, 0);
const childrenPopulationByProvince = provinces.reduce((sum, province) => sum + province.children0To17, 0);
if (childrenPopulationByArea !== childrenPopulationByDistrict || childrenPopulationByArea !== childrenPopulationByProvince) {
  throw new Error('0–17 population totals do not reconcile across administrative levels');
}

function isoDate(compactDate) {
  return compactDate ? `${compactDate.slice(0, 4)}-${compactDate.slice(4, 6)}-${compactDate.slice(6, 8)}` : null;
}

const metadata = {
  populationAsOf: '2026-10-31',
  singleHouseholdsAsOf: '2026-10-31',
  resourcesAsOf: '2026-06-30',
  boundaryReferenceYear: 2021,
  populationRows: areas.length,
  districtCount: districts.length,
  provinceCount: provinces.length,
  children0To17Population: childrenPopulationByArea,
  childCenterCollectionAsOf: '2026-11-14',
  childCenterRows: childCenterRows.length,
  childCenterDataAsOfMin: isoDate(childCenterSourceDates[0]),
  childCenterDataAsOfMax: isoDate(childCenterSourceDates.at(-1)),
  childCenterCoordinateAssignedRows,
  childCenterUnassignedRows,
  childCenterAddressCoordinateReviewRows: childCenterConflictRows.size,
  childCenterDistrictCount: districts.length,
  childCenterObservedDistrictCount,
  childCenterUnobservedDistrictCount: districts.length - childCenterObservedDistrictCount,
  elderlyPopulation: areas.reduce((sum, area) => sum + area.elderly, 0),
  elderlySinglePersonHouseholds: areas.reduce((sum, area) => sum + area.elderlySinglePersonHouseholds, 0),
  resourceRows: resourceRows.length,
  resourceProvinceOnlyRows: provinceOnlyResourceRows,
  resourceRowsWithMissingAddress: missingAddressRows,
  resourceRowsWithMissingPhone: missingPhoneRows,
  resourceEncodingReplacementChars: encodingReplacementCounts.get('data/source/nhis_integrated_care_resources_20260630.csv') ?? 0,
  majorCategoryCount: majorCategories.size,
  minorCategoryCount: minorCategories.size,
  facilityPopulationAsOf,
  facilityPopulationRows: facilityPopulationRows.length,
  facilityPopulationLatestRows: facilityRowsForLatestMonth.length,
  facilityPopulationSourceAreaCount: facilityAreasBySourceName.size,
  facilityPopulationTypeCount: facilityTypes.size,
  elderlyFacilityTypeCount: elderlyFacilityTypes.length,
  facilityDistrictExactMatches: facilityDistrictMatchCounts.district,
  facilityDistrictParentCityMatches: facilityDistrictMatchCounts.city,
  facilityDistrictProvinceFallbacks: facilityDistrictMatchCounts.province,
};

const data = {
  metadata,
  areas,
  districts,
  provinces,
  nationalFacilityPopulation,
  elderlyFacilityTypes,
  boundaries,
  majorCategories: [...majorCategories].sort((a, b) => a.localeCompare(b, 'ko')),
  minorCategories: [...minorCategories].sort((a, b) => a.localeCompare(b, 'ko')),
};

const summaryHeaders = [
  'sido', 'sigungu', 'sigungu_code', 'dong_count', 'population', 'children_0_17', 'children_0_17_rate',
  'child_center_standard_data_rows', 'child_center_coordinate_assigned_rows',
  'child_center_address_coordinate_review_rows', 'elderly_65_plus',
  'elderly_65_plus_rate', 'elderly_single_person_households_65_plus', 'service_resource_rows',
  'missing_address_rows', 'missing_phone_rows', 'facility_population_source_scope',
  'facility_population_source_area',
  ...elderlyFacilityTypes.flatMap(facilityType => [
    'facility_' + facilityType + '_capacity',
    'facility_' + facilityType + '_residents',
  ]),
  ...[...majorCategories].sort((a, b) => a.localeCompare(b, 'ko')).map(category => `resource_${category}`),
];
const summaryLines = [summaryHeaders.join(',')];
for (const district of districts) {
  const values = {
    sido: district.sido,
    sigungu: district.sigungu || district.sido,
    sigungu_code: district.sigunguCode,
    dong_count: district.dongCount,
    population: district.population,
    children_0_17: district.children0To17,
    children_0_17_rate: district.childrenRate.toFixed(6),
    child_center_standard_data_rows: district.childCenterRecordRows,
    child_center_coordinate_assigned_rows: district.childCenterCoordinateAssignedRows,
    child_center_address_coordinate_review_rows: district.childCenterAddressCoordinateReviewRows,
    elderly_65_plus: district.elderly,
    elderly_65_plus_rate: district.elderlyRate.toFixed(6),
    elderly_single_person_households_65_plus: district.elderlySinglePersonHouseholds,
    service_resource_rows: district.resourceRows,
    missing_address_rows: district.missingAddressRows,
    missing_phone_rows: district.missingPhoneRows,
    facility_population_source_scope: district.facilityPopulation.sourceLevel,
    facility_population_source_area: district.facilityPopulation.sourceAreaNames.join(' / '),
    ...Object.fromEntries(elderlyFacilityTypes.flatMap(facilityType => {
      const stats = district.facilityPopulation.byType[facilityType] ?? { capacity: 0, residents: 0 };
      return [
        ['facility_' + facilityType + '_capacity', stats.capacity],
        ['facility_' + facilityType + '_residents', stats.residents],
      ];
    })),
    ...Object.fromEntries([...majorCategories].map(category => [`resource_${category}`, district.resourcesByMajor[category] ?? 0])),
  };
  summaryLines.push(summaryHeaders.map(header => quoteCsv(values[header])).join(','));
}

const dataDirectory = join(root, 'data');
await mkdir(dataDirectory, { recursive: true });
await writeFile(join(dataDirectory, 'national_data.js'), `window.CAREMAP_DATA = ${JSON.stringify(data)};\n`, 'utf8');
await writeFile(join(dataDirectory, 'national_district_summary.csv'), `${summaryLines.join('\r\n')}\r\n`, 'utf8');

console.log(
  `Built national data for ${areas.length} administrative dongs, ${districts.length} districts, ` +
  `${provinces.length} provinces, and ${resourceRows.length} service-resource rows.`,
);
