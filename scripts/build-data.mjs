import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';

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

function elderlyTotal(row, label) {
  let total = 0;
  for (let age = 65; age <= 109; age++) {
    total += number(row[`${age}세남자`], `${label}.${age}세남자`);
    total += number(row[`${age}세여자`], `${label}.${age}세여자`);
  }
  total += number(row['110세이상 남자'], `${label}.110세이상 남자`);
  total += number(row['110세이상 여자'], `${label}.110세이상 여자`);
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
const boundarySource = JSON.parse(await readFile(join(root, 'data/source/kor_admin1_boundaries_2021.geojson'), 'utf8'));

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
  const elderly = elderlyTotal(row, code);
  const singlePersonHouseholds = number(householdRow['계'], `${code}.singlePersonHouseholds`);
  const elderlySinglePersonHouseholds = elderlyTotal(householdRow, `${code}.elderlySinglePersonHouseholds`);

  if (population !== male + female || elderly > population) {
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
  district.elderly += elderly;
  district.singlePersonHouseholds += singlePersonHouseholds;
  district.elderlySinglePersonHouseholds += elderlySinglePersonHouseholds;
  districtsByKey.set(key, district);

  const province = provincesByName.get(sido) ?? {
    sido,
    dongCount: 0,
    districtCount: 0,
    population: 0,
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
  province.elderly += elderly;
  province.singlePersonHouseholds += singlePersonHouseholds;
  province.elderlySinglePersonHouseholds += elderlySinglePersonHouseholds;
  provincesByName.set(sido, province);

  return area;
});

if (householdsByCode.size !== adminCodes.size || [...householdsByCode.keys()].some(code => !adminCodes.has(code))) {
  throw new Error('Population and single-household administrative codes do not match');
}

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
    elderlyRate: district.population ? district.elderly / district.population : 0,
    resourceCategoryCount: Object.keys(district.resourcesByMajor).length,
  }))
  .sort((a, b) => a.sido.localeCompare(b.sido, 'ko') || a.displayName.localeCompare(b.displayName, 'ko'));

const provinces = [...provincesByName.values()]
  .map(province => ({
    ...province,
    elderlyRate: province.population ? province.elderly / province.population : 0,
  }))
  .sort((a, b) => a.sido.localeCompare(b.sido, 'ko'));

const metadata = {
  populationAsOf: '2026-10-31',
  singleHouseholdsAsOf: '2026-10-31',
  resourcesAsOf: '2026-06-30',
  boundaryReferenceYear: 2021,
  populationRows: areas.length,
  districtCount: districts.length,
  provinceCount: provinces.length,
  elderlyPopulation: areas.reduce((sum, area) => sum + area.elderly, 0),
  elderlySinglePersonHouseholds: areas.reduce((sum, area) => sum + area.elderlySinglePersonHouseholds, 0),
  resourceRows: resourceRows.length,
  resourceProvinceOnlyRows: provinceOnlyResourceRows,
  resourceRowsWithMissingAddress: missingAddressRows,
  resourceRowsWithMissingPhone: missingPhoneRows,
  resourceEncodingReplacementChars: encodingReplacementCounts.get('data/source/nhis_integrated_care_resources_20260630.csv') ?? 0,
  majorCategoryCount: majorCategories.size,
  minorCategoryCount: minorCategories.size,
};

const data = {
  metadata,
  areas,
  districts,
  provinces,
  boundaries,
  majorCategories: [...majorCategories].sort((a, b) => a.localeCompare(b, 'ko')),
  minorCategories: [...minorCategories].sort((a, b) => a.localeCompare(b, 'ko')),
};

const summaryHeaders = [
  'sido', 'sigungu', 'sigungu_code', 'dong_count', 'population', 'elderly_65_plus',
  'elderly_65_plus_rate', 'elderly_single_person_households_65_plus', 'service_resource_rows',
  'missing_address_rows', 'missing_phone_rows',
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
    elderly_65_plus: district.elderly,
    elderly_65_plus_rate: district.elderlyRate.toFixed(6),
    elderly_single_person_households_65_plus: district.elderlySinglePersonHouseholds,
    service_resource_rows: district.resourceRows,
    missing_address_rows: district.missingAddressRows,
    missing_phone_rows: district.missingPhoneRows,
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
