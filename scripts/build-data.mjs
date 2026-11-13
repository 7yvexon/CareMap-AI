import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function parseCsv(text) {
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
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }

  if (field.length || row.length) {
    row.push(field.replace(/\r$/, ''));
    rows.push(row);
  }

  const [rawHeaders, ...values] = rows;
  if (!rawHeaders?.length) throw new Error('CSV is empty');
  const headers = rawHeaders.map((header, index) => index === 0 ? header.replace(/^\uFEFF/, '') : header);
  return values.map((columns, rowIndex) => {
    if (columns.length !== headers.length) {
      throw new Error(`CSV row ${rowIndex + 2} has ${columns.length} columns; expected ${headers.length}`);
    }
    return Object.fromEntries(headers.map((header, index) => [header, columns[index]]));
  });
}

function number(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid number for ${label}: ${value}`);
  return parsed;
}

function quoteCsv(value) {
  return `"${String(value ?? '').replaceAll('"', '""')}"`;
}

async function readCsv(path) {
  return parseCsv(await readFile(join(root, path), 'utf8'));
}

const areaRows = await readCsv('data/ulsan_admin_dong.csv');
const providerRows = await readCsv('data/ulsan_care_platforms.csv');

const AREAS = areaRows.map(row => ({
  code: row.code,
  asOf: row.asOf,
  sido: row.sido,
  sigungu_code: row.sigungu_code,
  sigungu: row.sigungu,
  dong: row.dong,
  population: number(row.population, `${row.code}.population`),
  male: number(row.male, `${row.code}.male`),
  female: number(row.female, `${row.code}.female`),
  elderly: number(row.elderly, `${row.code}.elderly`),
  lat: number(row.lat, `${row.code}.lat`),
  lon: number(row.lon, `${row.code}.lon`),
  place: row.place,
  osm_type: row.osm_type || null,
  osm_id: row.osm_id ? number(row.osm_id, `${row.code}.osm_id`) : null,
  coordinate_source: 'OpenStreetMap',
}));

const PROVIDERS = providerRows.map(row => ({
  sido: row.sido,
  sigungu_code: row.sigungu_code,
  sigungu: row.sigungu,
  service_type: row.service_type,
  name: row.name,
  address: row.address,
  phone: row.phone,
  operator: row.operator,
}));

const areaCodes = new Set();
for (const area of AREAS) {
  if (!area.code || !area.sido || !area.sigungu_code || !area.sigungu || !area.dong) {
    throw new Error('Area is missing a required administrative identifier');
  }
  if (areaCodes.has(area.code)) throw new Error(`Duplicate administrative code: ${area.code}`);
  areaCodes.add(area.code);
  if (area.population !== area.male + area.female || area.elderly > area.population) {
    throw new Error(`Population values do not reconcile for ${area.code}`);
  }
  if (area.lat < -90 || area.lat > 90 || area.lon < -180 || area.lon > 180) {
    throw new Error(`Coordinates are out of range for ${area.code}`);
  }
}

const districtKey = row => `${row.sido}:${row.sigungu_code}`;
const districts = new Map();
for (const area of AREAS) {
  const key = districtKey(area);
  const district = districts.get(key) ?? {
    district_id: key,
    sido: area.sido,
    sigungu_code: area.sigungu_code,
    sigungu: area.sigungu,
    dongs: 0,
    population: 0,
    elderly: 0,
    facilities: 0,
  };
  district.dongs++;
  district.population += area.population;
  district.elderly += area.elderly;
  districts.set(key, district);
}

for (const provider of PROVIDERS) {
  const district = districts.get(districtKey(provider));
  if (!district) throw new Error(`Provider references an unknown district: ${provider.sigungu}`);
  if (!provider.service_type || !provider.name || !provider.address) {
    throw new Error(`Provider record is missing a service type, name, or address: ${provider.name}`);
  }
  district.facilities++;
}

const DISTRICTS = [...districts.values()].map(district => ({
  ...district,
  elderlyPerFacility: district.facilities ? district.elderly / district.facilities : null,
}));
const dataDirectory = join(root, 'data');
await mkdir(dataDirectory, { recursive: true });
await writeFile(
  join(dataDirectory, 'ulsan_data.js'),
  `window.CAREMAP_DATA = ${JSON.stringify({ AREAS, PROVIDERS, DISTRICTS })};\n`,
  'utf8',
);

const summaryHeaders = ['district_id', 'sido', 'sigungu_code', 'sigungu', 'dongs', 'population', 'elderly', 'facilities', 'elderlyPerFacility'];
const summaryRows = [summaryHeaders.join(',')];
for (const district of DISTRICTS) {
  summaryRows.push(summaryHeaders.map(header => quoteCsv(district[header])).join(','));
}
await writeFile(join(dataDirectory, 'ulsan_district_summary.csv'), `${summaryRows.join('\r\n')}\r\n`, 'utf8');

console.log(`Built data bundle for ${AREAS.length} administrative areas and ${PROVIDERS.length} providers.`);
