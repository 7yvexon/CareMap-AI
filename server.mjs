import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';
import { gunzipSync } from 'node:zlib';

const root = dirname(fileURLToPath(import.meta.url));
const resourcePath = join(root, 'data/source/nhis_integrated_care_resources_20260630.csv');
const koreanDecoder = new TextDecoder('euc-kr');
const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/leaflet.js', ['leaflet.js', 'text/javascript; charset=utf-8']],
  ['/leaflet.css', ['leaflet.css', 'text/css; charset=utf-8']],
  ['/data/ulsan_data.js', ['data/ulsan_data.js', 'text/javascript; charset=utf-8']],
  ['/data/ulsan_admin_dong.csv', ['data/ulsan_admin_dong.csv', 'text/csv; charset=utf-8']],
  ['/data/ulsan_care_platforms.csv', ['data/ulsan_care_platforms.csv', 'text/csv; charset=utf-8']],
  ['/data/ulsan_district_summary.csv', ['data/ulsan_district_summary.csv', 'text/csv; charset=utf-8']],
  ['/data/national_data.js', ['data/national_data.js', 'text/javascript; charset=utf-8']],
  ['/data/national_district_summary.csv', ['data/national_district_summary.csv', 'text/csv; charset=utf-8']],
]);

function normalize(value) {
  return String(value ?? '').replaceAll('\u00a0', ' ').replace(/\s+/g, ' ').trim();
}

function parseCsv(text, label) {
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
  return values.map((columns, rowIndex) => {
    if (columns.length !== headers.length) {
      throw new Error(`${label} row ${rowIndex + 2} has ${columns.length} columns; expected ${headers.length}`);
    }
    return Object.fromEntries(headers.map((header, index) => [header, columns[index]]));
  });
}

let sourceRows = parseCsv(koreanDecoder.decode(await readFile(resourcePath)), resourcePath);
const resourceRowCount = sourceRows.length;
const serviceResources = sourceRows.map((row, index) => ({
  id: index + 1,
  sido: normalize(row['시도']),
  sigungu: normalize(row['시군구']),
  provider: normalize(row['서비스 제공기관명']),
  phone: normalize(row['기관연락처']),
  address: normalize(row['기관주소']),
  major: normalize(row['대분류']) || '분류 미기재',
  minor: normalize(row['중분류']) || '분류 미기재',
  program: normalize(row['프로그램명칭']),
}));
sourceRows = null;

const boundaryPath = join(root, 'data/source/admin_dong_boundaries_20261001.geojson.gz');
const boundaryCollection = JSON.parse(gunzipSync(await readFile(boundaryPath)).toString('utf8'));
const nationalDataSource = await readFile(join(root, 'data/national_data.js'), 'utf8');
const nationalDataJson = nationalDataSource.slice(nationalDataSource.indexOf('{'), nationalDataSource.lastIndexOf('}') + 1);
const populationDongCodes = new Set(JSON.parse(nationalDataJson).areas.map(area => area.code));
const compactRegionName = value => normalize(value).replace(/\s+/g, '');
const boundariesByProvince = new Map();
const boundariesByDistrict = new Map();
const boundariesByDongCode = new Map();

for (const feature of boundaryCollection.features ?? []) {
  const properties = feature.properties ?? {};
  const sido = normalize(properties.sidonm);
  const sigungu = normalize(properties.sggnm);
  const code = normalize(properties.adm_cd2);
  const fullName = normalize(properties.adm_nm);
  if (!populationDongCodes.has(code)) continue;
  const prefix = normalize(`${sido} ${sigungu}`);
  const dong = fullName.startsWith(prefix) ? normalize(fullName.slice(prefix.length)) : fullName.split(/\s+/).at(-1);
  feature.properties = { code, sido, sigungu, dong };

  if (!boundariesByProvince.has(sido)) boundariesByProvince.set(sido, []);
  boundariesByProvince.get(sido).push(feature);
  const districtKey = `${sido}\u001f${compactRegionName(sigungu)}`;
  if (!boundariesByDistrict.has(districtKey)) boundariesByDistrict.set(districtKey, []);
  boundariesByDistrict.get(districtKey).push(feature);
  if (code) boundariesByDongCode.set(code, feature);
}

const intentRules = [
  { terms: ['식사', '반찬', '밥', '영양'], categories: ['식사지원'] },
  { terms: ['복약', '약', '약물'], categories: ['방문복약관리'] },
  { terms: ['진료', '병원', '의사', '간호'], categories: ['방문진료', '방문간호', '건강-돌봄 통합지원'] },
  { terms: ['재활', '걷기', '운동'], categories: ['방문재활'] },
  { terms: ['목욕', '씻기'], categories: ['방문목욕'] },
  { terms: ['이동', '외출', '교통', '차량'], categories: ['이동지원'] },
  { terms: ['주거', '집수리', '낙상', '문턱', '안전손잡이'], categories: ['주거공간개선', '주거지지원'] },
  { terms: ['치매', '기억'], categories: ['치매전문관리'] },
  { terms: ['가사', '청소', '빨래', '집안일'], categories: ['가사지원', '일상생활지원'] },
  { terms: ['주간보호', '낮시간'], categories: ['주야간보호', '단기보호'] },
  { terms: ['우울', '정신건강', '마음'], categories: ['정신건강관리'] },
];

const stopWords = new Set(['어르신', '서비스', '돌봄', '도움', '지원', '찾아줘', '찾고', '찾는', '찾아', '싶어요', '있어요', '필요', '필요해요', '어려워', '어려워요', '준비가', '힘들어', '불편해요', '가능한']);

function searchServiceResources({ query, province, district, category, limit }) {
  const normalizedQuery = normalize(query);
  const terms = [...new Set((normalizedQuery.match(/[가-힣A-Za-z0-9]{2,}/g) ?? [])
    .filter(term => !stopWords.has(term)))];
  const inferredCategories = [...new Set(intentRules
    .filter(rule => rule.terms.some(term => normalizedQuery.includes(term)))
    .flatMap(rule => rule.categories))];
  const results = [];
  const seen = new Set();

  for (const resource of serviceResources) {
    if (province && resource.sido !== province) continue;
    if (district && resource.sigungu !== district) continue;
    if (category && resource.major !== category) continue;

    const categoryMatches = inferredCategories.filter(name => resource.minor === name || resource.major === name);
    const textFields = {
      program: resource.program,
      minor: resource.minor,
      major: resource.major,
      provider: resource.provider,
      address: resource.address,
    };
    const matchedTerms = terms.filter(term => Object.values(textFields).some(value => value.includes(term)));
    if (!categoryMatches.length && !matchedTerms.length) continue;

    let score = categoryMatches.length * 8;
    if (normalizedQuery && resource.program.includes(normalizedQuery)) score += 12;
    score += matchedTerms.reduce((sum, term) => sum + (resource.program.includes(term) ? 5 : 0)
      + (resource.minor.includes(term) ? 4 : 0)
      + (resource.major.includes(term) ? 2 : 0)
      + (resource.provider.includes(term) ? 1 : 0)
      + (resource.address.includes(term) ? 0.5 : 0), 0);

    const identity = [resource.sido, resource.sigungu, resource.provider, resource.program, resource.major, resource.minor, resource.address].join('\u001f');
    if (seen.has(identity)) continue;
    seen.add(identity);
    results.push({
      ...resource,
      matchedCategories: categoryMatches,
      matchedTerms,
      score,
    });
  }

  return results
    .sort((a, b) => b.score - a.score || a.program.localeCompare(b.program, 'ko'))
    .slice(0, limit)
    .map(({ score, ...resource }) => resource);
}

const server = createServer(async (req, res) => {
  if (req.method !== 'GET') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Method not allowed');
    return;
  }

  const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
  if (pathname === '/api/area-boundaries') {
    const url = new URL(req.url, 'http://127.0.0.1');
    const province = normalize(url.searchParams.get('province')).slice(0, 60);
    const district = normalize(url.searchParams.get('district')).slice(0, 60);
    const code = normalize(url.searchParams.get('code')).slice(0, 10);
    if (!province) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: '시도를 선택해 주세요.' }));
      return;
    }

    const districtKey = `${province}\u001f${compactRegionName(district)}`;
    const features = district
      ? boundariesByDistrict.get(districtKey) ?? []
      : boundariesByProvince.get(province) ?? [];
    const selectedBoundaryFound = code ? features.some(feature => feature.properties.code === code) : null;
    res.writeHead(200, { 'Content-Type': 'application/geo+json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify({
      type: 'FeatureCollection',
      features,
      boundaryAsOf: '2026-10-01',
      selectedBoundaryFound,
    }));
    return;
  }

  if (pathname === '/api/resources') {
    const url = new URL(req.url, 'http://127.0.0.1');
    const query = normalize(url.searchParams.get('query')).slice(0, 150);
    if (query.length < 2) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: '필요한 도움을 두 글자 이상 입력해 주세요.' }));
      return;
    }

    const province = normalize(url.searchParams.get('province')).slice(0, 60);
    const district = normalize(url.searchParams.get('district')).slice(0, 60);
    const category = normalize(url.searchParams.get('category')).slice(0, 60);
    const parsedLimit = Number(url.searchParams.get('limit'));
    const limit = Number.isInteger(parsedLimit) ? Math.max(1, Math.min(parsedLimit, 12)) : 8;
    const results = searchServiceResources({ query, province, district, category, limit });
    const inferredCategories = [...new Set(intentRules
      .filter(rule => rule.terms.some(term => query.includes(term)))
      .flatMap(rule => rule.categories))];

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify({
      asOf: '2026-06-30',
      sourceRows: resourceRowCount,
      searchMethod: '규칙 기반 키워드·서비스 유형 후보 검색',
      inferredCategories,
      results,
    }));
    return;
  }

  const entry = files.get(pathname);
  if (!entry) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }

  try {
    const body = await readFile(join(root, entry[0]));
    res.writeHead(200, {
      'Content-Type': entry[1],
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(body);
  } catch {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Unable to read the requested file');
  }
});

const port = Number(process.env.PORT || 8765);
server.listen(port, '127.0.0.1', () => {
  console.log(`CareMap AI: http://127.0.0.1:${port} (${serviceResources.length} resources, ${boundariesByDongCode.size} dong boundaries indexed)`);
});
