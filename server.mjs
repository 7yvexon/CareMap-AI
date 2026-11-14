import { createServer } from 'node:http';
import { constants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { openServiceCatalog } from './scripts/lib/service-catalog.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const resourcePath = join(root, 'data/source/nhis_integrated_care_resources_20260630.csv');
const catalogPath = join(root, 'data/cache/service_resources.sqlite');
const serviceResourcesAsOf = '2026-06-30';
const adminBoundariesAsOf = '2026-10-01';
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

function sendJsonError(res, message) {
  res.writeHead(400, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify({ error: message }));
}

const serviceCatalog = await openServiceCatalog({ sourcePath: resourcePath, databasePath: catalogPath });
const resourceRowCount = serviceCatalog.rowCount;

const boundaryPath = join(root, 'data/source/admin_dong_boundaries_20261001.geojson.gz');
const boundaryCollection = JSON.parse(gunzipSync(await readFile(boundaryPath)).toString('utf8'));
const boundaryFeatureCount = boundaryCollection.features?.length ?? 0;
const nationalDataSource = await readFile(join(root, 'data/national_data.js'), 'utf8');
const nationalDataJson = nationalDataSource.slice(nationalDataSource.indexOf('{'), nationalDataSource.lastIndexOf('}') + 1);
const nationalData = JSON.parse(nationalDataJson);
const populationDongCodes = new Set(nationalData.areas.map(area => area.code));
const expectedProvinceNames = new Set(nationalData.provinces.map(province => normalize(province.sido)).filter(Boolean));
const allowedIntentCategories = new Set(nationalData.minorCategories.map(normalize).filter(Boolean));
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

const provincesWithoutBoundaries = [...expectedProvinceNames]
  .filter(province => !boundariesByProvince.has(province))
  .sort((a, b) => a.localeCompare(b, 'ko'));
const unexpectedIndexedProvinces = [...boundariesByProvince.keys()]
  .filter(province => !expectedProvinceNames.has(province))
  .sort((a, b) => a.localeCompare(b, 'ko'));

const intentRules = [
  { terms: ['식사', '반찬', '밥', '영양', '도시락', '배달', '급식'], categories: ['식사지원'] },
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

function inferCategories(query) {
  const normalizedQuery = normalize(query);
  const compactQuery = normalizedQuery.replace(/\s+/g, '');
  const hospitalEscort = /(?:병원|진료|외래).{0,5}(?:동행|같이|함께|데려|모셔)|(?:동행|같이|함께|데려|모셔).{0,5}(?:병원|진료|외래)/.test(normalizedQuery)
    || ['병원동행', '진료동행', '외래동행'].some(phrase => compactQuery.includes(phrase));
  if (hospitalEscort) return ['이동지원'];
  return [...new Set(intentRules
    .filter(rule => rule.terms.some(term => normalizedQuery.includes(term)))
    .flatMap(rule => rule.categories))];
}

function searchServiceResources({ query, province, district, category, limit, intentCategories = [] }) {
  const normalizedQuery = normalize(query);
  const compactQuery = normalizedQuery.replace(/\s+/g, '');
  const terms = [...new Set((normalizedQuery.match(/[가-힣A-Za-z0-9]{2,}/g) ?? [])
    .filter(term => !stopWords.has(term)))];
  const inferredCategories = [...new Set([...inferCategories(normalizedQuery), ...intentCategories])];
  const results = [];
  const seen = new Set();

  const candidates = serviceCatalog.searchCandidates({ province, district, category, inferredCategories, terms });
  for (const resource of candidates) {
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
    if (compactQuery.length >= 2 && resource.program.replace(/\s+/g, '').includes(compactQuery)) score += 16;
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
    res.writeHead(405, {
      'Allow': 'GET',
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end('Method not allowed');
    return;
  }

  const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
  if (pathname === '/api/health') {
    const requiredPageAssets = ['/', '/leaflet.js', '/leaflet.css', '/data/national_data.js'];
    const pageAssetsReady = (await Promise.all(requiredPageAssets.map(async route => {
      const entry = files.get(route);
      if (!entry) return false;
      try {
        await access(join(root, entry[0]), constants.R_OK);
        return true;
      } catch {
        return false;
      }
    }))).every(Boolean);
    const serviceSearchReady = resourceRowCount > 0 && serviceCatalog.filterIndexCount === 3;
    const provinceBoundaryCoverageReady = expectedProvinceNames.size > 0
      && provincesWithoutBoundaries.length === 0
      && unexpectedIndexedProvinces.length === 0
      && boundariesByProvince.size === expectedProvinceNames.size;
    const areaBoundariesReady = boundaryFeatureCount > 0
      && boundariesByDongCode.size > 0
      && provinceBoundaryCoverageReady;
    const ready = pageAssetsReady && serviceSearchReady && areaBoundariesReady;
    const payload = {
      ready,
      serviceResourceRowCount: resourceRowCount,
      adminBoundaryFeatureCount: boundaryFeatureCount,
      expectedProvinceCount: expectedProvinceNames.size,
      indexedProvinceCount: boundariesByProvince.size,
      provincesWithoutBoundaries,
      unexpectedIndexedProvinces,
      referenceDates: {
        serviceResources: serviceResourcesAsOf,
        adminBoundaries: adminBoundariesAsOf,
      },
      checks: {
        pageAssets: pageAssetsReady,
        serviceSearch: serviceSearchReady,
        areaBoundaries: areaBoundariesReady,
      },
    };
    res.writeHead(ready ? 200 : 503, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(JSON.stringify(payload));
    return;
  }

  if (pathname === '/api/area-boundaries') {
    const url = new URL(req.url, 'http://127.0.0.1');
    const province = normalize(url.searchParams.get('province'));
    const district = normalize(url.searchParams.get('district'));
    const code = normalize(url.searchParams.get('code'));
    if (province.length > 60 || district.length > 60) {
      sendJsonError(res, '지역 이름은 60자 이하로 입력해 주세요.');
      return;
    }
    if (code && !/^\d{10}$/.test(code)) {
      sendJsonError(res, '행정동 코드는 10자리 숫자로 입력해 주세요.');
      return;
    }
    if (!province) {
      sendJsonError(res, '시도를 선택해 주세요.');
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
      boundaryAsOf: adminBoundariesAsOf,
      selectedBoundaryFound,
    }));
    return;
  }

  // GET /api/service-summary counts source program/resource records, not facilities, current availability, or capacity.
  if (pathname === '/api/service-summary') {
    const url = new URL(req.url, 'http://127.0.0.1');
    const province = normalize(url.searchParams.get('province'));
    const district = normalize(url.searchParams.get('district'));
    if (province.length > 60 || district.length > 60) {
      sendJsonError(res, '지역 이름은 각각 60자 이하로 입력해 주세요.');
      return;
    }
    if (district && !province) {
      sendJsonError(res, '시군구 범위를 지정하려면 시도를 함께 입력해 주세요.');
      return;
    }

    const summary = serviceCatalog.summarizeServiceRecords({ province, district });
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(JSON.stringify({
      sourceAsOf: serviceCatalog.sourceAsOf,
      scope: {
        province: province || null,
        district: district || null,
      },
      totalRecordCount: summary.totalRecordCount,
      categories: summary.categories,
    }));
    return;
  }

  if (pathname === '/api/resources') {
    const url = new URL(req.url, 'http://127.0.0.1');
    const query = normalize(url.searchParams.get('query'));
    if (query.length > 150) {
      sendJsonError(res, '검색어는 150자 이하로 입력해 주세요.');
      return;
    }
    if (query.length < 2) {
      sendJsonError(res, '필요한 도움을 두 글자 이상 입력해 주세요.');
      return;
    }

    const province = normalize(url.searchParams.get('province'));
    const district = normalize(url.searchParams.get('district'));
    const category = normalize(url.searchParams.get('category'));
    const requestedIntentCategories = url.searchParams.getAll('intent').map(normalize);
    if (province.length > 60 || district.length > 60 || category.length > 60) {
      sendJsonError(res, '지역과 분류 값은 각각 60자 이하로 입력해 주세요.');
      return;
    }
    if (requestedIntentCategories.length > 3
      || requestedIntentCategories.some(name => !allowedIntentCategories.has(name))) {
      sendJsonError(res, '의미 검색 유형은 제공되는 서비스 중분류에서 최대 3개까지 선택할 수 있습니다.');
      return;
    }
    const intentCategories = [...new Set(requestedIntentCategories)];
    const rawLimit = url.searchParams.get('limit');
    const parsedLimit = rawLimit === null || normalize(rawLimit) === '' ? 8 : Number(rawLimit);
    const limit = Number.isInteger(parsedLimit) ? Math.max(1, Math.min(parsedLimit, 12)) : 8;
    const results = searchServiceResources({ query, province, district, category, limit, intentCategories });
    const inferredCategories = [...new Set([...inferCategories(query), ...intentCategories])];

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify({
      asOf: serviceResourcesAsOf,
      sourceRows: resourceRowCount,
      searchMethod: intentCategories.length
        ? '사용자 선택 의미 유형과 규칙·키워드 후보 검색'
        : '규칙 기반 키워드·서비스 유형 후보 검색',
      semanticIntentCategories: intentCategories,
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
  console.log(`CareMap AI: http://127.0.0.1:${port} (${resourceRowCount} resources, ${boundariesByDongCode.size} dong boundaries indexed)`);
});
