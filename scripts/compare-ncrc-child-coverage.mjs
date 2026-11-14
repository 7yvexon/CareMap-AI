import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { gunzipSync, inflateRawSync } from 'node:zlib';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const defaultInput = resolve(root, 'tmp/ncrc-2025-center-directory.xlsx');
const inputPath = resolve(process.argv[2] ?? defaultInput);
const boundaryPath = resolve(root, 'data/source/admin_dong_boundaries_20261001.geojson.gz');
const nationalDataPath = resolve(root, 'data/national_data.js');
const expectedSource = {
  bytes: 395298,
  sha256: '404822a5b144f650c51bfc6f47d6eee9c57c0804ee39603cd120eb8dd1d11df9',
  rows: 4176,
};
const expectedCoverage = {
  districts: 256,
  standardObserved: 146,
  standardUnobserved: 110,
  directPairMatchesWithoutIntegratedProvinceAliases: 79,
  pairOrAddressPrefixMatchesWithoutIntegratedProvinceAliases: 88,
  addressPrefixOnlyMatchesWithoutIntegratedProvinceAliases: 9,
  directPairAfterIntegratedProvinceAliases: 95,
  addedByAddressTokenHeuristic: 4,
  directPairPlusTokenHeuristicDistricts: 99,
  addressPrefixOnlyAfterIntegratedAliasDirectPair: 9,
  tokenOnlyAfterAddressPrefix: 4,
  allMethodsLinkedUnobservedDistricts: 108,
  allMethodsUnlinkedDistricts: 2,
  ambiguousAddressPrefixRows: 0,
  ambiguousAddressTokenRows: 0,
};
const integratedProvinceAliases = new Map([
  ['전라남도', '전남광주통합특별시'],
  ['광주광역시', '전남광주통합특별시'],
]);
const reorganizedSourceAreas = new Map([
  ['경기도\u001f화성시', ['화성시 만세구', '화성시 효행구', '화성시 병점구', '화성시 동탄구']],
  ['인천광역시\u001f중구', ['제물포구', '영종구']],
  ['인천광역시\u001f서구', ['검단구', '서해구']],
]);
const candidateDistrictNames = [
  '화성시 만세구', '화성시 효행구', '화성시 병점구', '화성시 동탄구',
  '제물포구', '영종구', '검단구', '서해구',
];
const xmlNamespace = '(?:[A-Za-z_][\\w.:-]*:)?';

function isWithin(parent, candidate) {
  const pathFromParent = relative(parent, candidate);
  return pathFromParent === '' ||
    (!isAbsolute(pathFromParent) && pathFromParent !== '..' && !pathFromParent.startsWith(`..${sep}`));
}

function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replaceAll('\u00a0', ' ')
    .replace(/[‐‑‒–—−]/gu, '-')
    .replace(/\s+/gu, ' ')
    .trim();
}

function compactRegion(value) {
  return normalizeText(value)
    .toLocaleLowerCase('ko-KR')
    .replace(/[\s,，·()（）]/gu, '');
}

function compactProvince(value, integratedAliases = true) {
  const key = compactRegion(value);
  return integratedAliases ? compactRegion(integratedProvinceAliases.get(key) ?? key) : key;
}

function pairKey(sido, sigungu, integratedAliases = true) {
  return `${compactProvince(sido, integratedAliases)}\u001f${compactRegion(sigungu)}`;
}

function decodeXml(value) {
  return String(value)
    .replace(/&#x([\da-f]+);/giu, (_, digits) => String.fromCodePoint(Number.parseInt(digits, 16)))
    .replace(/&#(\d+);/gu, (_, digits) => String.fromCodePoint(Number(digits)))
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&amp;/gu, '&');
}

function xmlAttribute(attributes, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = attributes.match(new RegExp(`(?:^|\\s)${escaped}="([^"]*)"`, 'u'));
  return match ? decodeXml(match[1]) : '';
}

function xmlElements(text, tag) {
  const element = new RegExp(
    `<${xmlNamespace}${tag}\\b([^>]*?)(?:\\/>|>([\\s\\S]*?)<\\/${xmlNamespace}${tag}>)`,
    'gu',
  );
  return [...text.matchAll(element)].map(match => [match[0], match[1], match[2] ?? '']);
}

function findEndOfCentralDirectory(buffer) {
  const start = Math.max(0, buffer.length - 22 - 0xffff);
  for (let offset = buffer.length - 22; offset >= start; offset--) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error('입력 파일이 표준 XLSX ZIP 구조가 아닙니다.');
}

function readZipEntries(buffer) {
  const endOffset = findEndOfCentralDirectory(buffer);
  const diskNumber = buffer.readUInt16LE(endOffset + 4);
  const centralDirectoryDisk = buffer.readUInt16LE(endOffset + 6);
  const entriesOnDisk = buffer.readUInt16LE(endOffset + 8);
  const entryCount = buffer.readUInt16LE(endOffset + 10);
  const centralDirectoryOffset = buffer.readUInt32LE(endOffset + 16);
  if (diskNumber !== 0 || centralDirectoryDisk !== 0 || entriesOnDisk !== entryCount || entryCount === 0xffff || centralDirectoryOffset === 0xffffffff) {
    throw new Error('다중 디스크 또는 ZIP64 XLSX는 지원하지 않습니다.');
  }

  const entries = new Map();
  let offset = centralDirectoryOffset;
  for (let index = 0; index < entryCount; index++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('XLSX ZIP 중앙 디렉터리를 읽을 수 없습니다.');
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const fileName = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    if ((flags & 0x0001) !== 0) throw new Error('암호화된 XLSX는 읽을 수 없습니다.');
    if (method !== 0 && method !== 8) throw new Error('지원하지 않는 XLSX 압축 방식입니다.');
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
      throw new Error('ZIP64 XLSX는 지원하지 않습니다.');
    }
    if (buffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) throw new Error('XLSX ZIP 항목을 읽을 수 없습니다.');

    const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    const content = method === 8
      ? inflateRawSync(compressed, { maxOutputLength: 20 * 1024 * 1024 })
      : compressed;
    if (content.length !== uncompressedSize) throw new Error('XLSX ZIP 항목 크기가 맞지 않습니다.');
    entries.set(fileName, content.toString('utf8'));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function workbookWorksheetPath(entries) {
  const workbook = entries.get('xl/workbook.xml');
  const relationships = entries.get('xl/_rels/workbook.xml.rels');
  if (!workbook || !relationships) throw new Error('XLSX 통합 문서 정보가 없습니다.');
  const sheets = xmlElements(workbook, 'sheet');
  if (sheets.length !== 1) throw new Error('기준 주소록 XLSX는 시트 1개여야 합니다.');
  const relationId = xmlAttribute(sheets[0][1], 'r:id');
  const relation = xmlElements(relationships, 'Relationship')
    .find(([_, attributes]) => xmlAttribute(attributes, 'Id') === relationId);
  if (!relation) throw new Error('XLSX 첫 시트 경로를 확인할 수 없습니다.');
  const target = xmlAttribute(relation[1], 'Target');
  const worksheetPath = target.startsWith('/')
    ? target.slice(1)
    : posix.normalize(posix.join('xl', target));
  if (!worksheetPath.startsWith('xl/worksheets/')) throw new Error('예상하지 않은 XLSX 시트 경로입니다.');
  return worksheetPath;
}

function parseSharedStrings(xml) {
  if (!xml) return [];
  return xmlElements(xml, 'si').map(([_, __, item]) =>
    xmlElements(item, 't').map(([, , text]) => decodeXml(text)).join(''));
}

function columnIndex(reference) {
  const letters = reference.match(/^[A-Z]+/u)?.[0];
  if (!letters) throw new Error('XLSX 셀 열 번호를 읽을 수 없습니다.');
  let value = 0;
  for (const letter of letters) value = value * 26 + letter.charCodeAt(0) - 64;
  return value - 1;
}

function cellText(attributes, body, sharedStrings) {
  const type = xmlAttribute(attributes, 't');
  const valueMatch = body.match(new RegExp(`<${xmlNamespace}v\\b[^>]*>([\\s\\S]*?)<\\/${xmlNamespace}v>`, 'u'));
  if (type === 's') {
    const index = Number(valueMatch?.[1]);
    if (!Number.isInteger(index) || index < 0 || index >= sharedStrings.length) throw new Error('XLSX 공유 문자열 참조가 올바르지 않습니다.');
    return sharedStrings[index];
  }
  if (type === 'inlineStr') return xmlElements(body, 't').map(([, , text]) => decodeXml(text)).join('');
  return valueMatch ? decodeXml(valueMatch[1]) : '';
}

function parseWorksheetRows(xml, sharedStrings, selectedColumns = null, maxRows = null) {
  const rowElements = xmlElements(xml, 'row');
  const rows = maxRows === null ? rowElements : rowElements.slice(0, maxRows);
  return rows.map(([_, __, rowXml]) => {
    const cells = new Map();
    let hasAnyValue = false;
    const cellPattern = new RegExp(`<${xmlNamespace}c\\b([^>]*)>([\\s\\S]*?)<\\/${xmlNamespace}c>|<${xmlNamespace}c\\b([^>]*)\\s*\\/>`, 'gu');
    for (const match of rowXml.matchAll(cellPattern)) {
      const attributes = match[1] ?? match[3];
      const reference = xmlAttribute(attributes, 'r');
      if (!reference) throw new Error('XLSX 셀 참조가 없습니다.');
      const index = columnIndex(reference);
      const body = match[2] ?? '';
      if (new RegExp(`<${xmlNamespace}(?:v|is)\\b`, 'u').test(body)) hasAnyValue = true;
      if (selectedColumns && !selectedColumns.has(index)) continue;
      const text = cellText(attributes, body, sharedStrings);
      if (text !== '') {
        cells.set(index, text);
        hasAnyValue = true;
      }
    }
    return { cells, hasAnyValue };
  });
}

function findRequiredColumns(rows) {
  const requiredHeaders = {
    sido: new Set(['시도', '시도명']),
    sigungu: new Set(['시군구', '시군구명']),
    address: new Set(['시설소재지', '소재지', '주소']),
  };
  for (let rowIndex = 0; rowIndex < Math.min(rows.length, 30); rowIndex++) {
    const row = rows[rowIndex].cells;
    const result = {};
    for (const [columnIndexValue, value] of row) {
      const header = compactRegion(value);
      for (const [field, candidates] of Object.entries(requiredHeaders)) {
        if (!candidates.has(header)) continue;
        if (result[field] !== undefined) throw new Error('주소록 헤더에 필요한 열 이름이 중복됩니다.');
        result[field] = columnIndexValue;
      }
    }
    if (Object.keys(result).length === Object.keys(requiredHeaders).length) {
      return { rowIndex, columns: result };
    }
  }
  throw new Error('주소록에서 시도·시군구·소재지 열을 찾지 못했습니다.');
}

function parseDirectoryRows(worksheetXml, sharedStrings) {
  const headerRows = parseWorksheetRows(worksheetXml, sharedStrings, null, 30);
  const { rowIndex, columns } = findRequiredColumns(headerRows);
  const usedColumns = new Set(Object.values(columns));
  const dataRows = parseWorksheetRows(worksheetXml, sharedStrings, usedColumns).slice(rowIndex + 1);
  const records = [];
  for (const row of dataRows) {
    if (!row.hasAnyValue) continue;
    records.push({
      sido: normalizeText(row.cells.get(columns.sido)),
      sigungu: normalizeText(row.cells.get(columns.sigungu)),
      address: normalizeText(row.cells.get(columns.address)),
    });
  }
  return {
    records,
    headerRow: rowIndex + 1,
    columnsUsed: ['시도', '시군구', '시설 소재지'],
    rowsMissingRegionKeys: records.filter(record => !record.sido || !record.sigungu).length,
    rowsMissingAddress: records.filter(record => !record.address).length,
  };
}

function readNationalData(sourceText) {
  const context = vm.createContext({ window: {} });
  new vm.Script(sourceText, { filename: 'data/national_data.js' }).runInContext(context, { timeout: 2000 });
  const data = context.window.CAREMAP_DATA;
  if (!data || !Array.isArray(data.districts) || !data.metadata) throw new Error('생성된 전국 시군구 자료를 읽지 못했습니다.');
  if (data.districts.length !== expectedCoverage.districts) throw new Error('생성 자료의 시군구 수가 기준과 다릅니다.');
  return data;
}

function validateDistrictBoundaryCodes(districts, boundaryData) {
  const districtIds = new Set();
  const nationalCodes = new Set();
  for (const district of districts) {
    const districtId = normalizeText(district?.districtId);
    const code = normalizeText(district?.sigunguCode);
    if (!districtId || districtIds.has(districtId)) throw new Error('전국 시군구 ID가 비어 있거나 중복됩니다.');
    if (!/^\d{5}$/u.test(code) || nationalCodes.has(code)) {
      throw new Error('전국 시군구 코드가 5자리 숫자가 아니거나 중복됩니다.');
    }
    districtIds.add(districtId);
    nationalCodes.add(code);
  }
  if (districtIds.size !== expectedCoverage.districts || nationalCodes.size !== expectedCoverage.districts) {
    throw new Error('전국 시군구 ID·코드 수가 기준과 다릅니다.');
  }

  const boundaryCodes = new Set();
  for (const feature of boundaryData.features) {
    const code = normalizeText(feature.properties?.sgg);
    if (!/^\d{5}$/u.test(code)) throw new Error('행정경계에 올바른 시군구 코드가 없습니다.');
    boundaryCodes.add(code);
  }
  if (boundaryCodes.size !== expectedCoverage.districts ||
      [...nationalCodes].some(code => !boundaryCodes.has(code)) ||
      [...boundaryCodes].some(code => !nationalCodes.has(code))) {
    throw new Error('행정경계와 전국 시군구 코드 집합이 일치하지 않습니다.');
  }
}

async function rejectUnsafeOutputFiles(outputDirectory, filenames) {
  for (const filename of filenames) {
    const target = resolve(outputDirectory, filename);
    if (!isWithin(outputDirectory, target)) throw new Error('집계 파일 경로가 출력 폴더를 벗어납니다.');
    try {
      const info = await lstat(target);
      if (info.isSymbolicLink() || !info.isFile() || info.nlink > 1) {
        throw new Error('기존 집계 파일이 일반 단일 링크 파일이 아니어서 쓰기를 중단했습니다.');
      }
      const realTarget = await realpath(target);
      if (!isWithin(outputDirectory, realTarget)) throw new Error('집계 파일 실제 경로가 출력 폴더를 벗어납니다.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

function csvField(value) {
  const text = String(value ?? '');
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function toCsv(rows, headers) {
  return `${[headers, ...rows.map(row => headers.map(header => row[header] ?? ''))]
    .map(row => row.map(csvField).join(','))
    .join('\n')}\n`;
}

function matchDirectoryRows(records, districts, standardUnobserved) {
  if (new Set(districts.map(district => district.districtId)).size !== districts.length) {
    throw new Error('생성 자료에 중복된 시군구 ID가 있습니다.');
  }
  const districtByPair = new Map(districts.map(district => [
    pairKey(district.sido, district.sigungu), district,
  ]));
  const districtByPairWithoutAlias = new Map(districts.map(district => [
    pairKey(district.sido, district.sigungu, false), district,
  ]));
  const directRows = new Map();
  const directRowsWithoutAlias = new Map();
  const addressPrefixRowsWithoutAlias = new Map();
  const directC = new Set();
  const directCWithoutAlias = new Set();
  const addressPrefixCWithoutAlias = new Set();
  let ambiguousAddressPrefixRows = 0;
  const candidateDistricts = new Map(districts
    .filter(district => candidateDistrictNames.some(name => compactRegion(name) === compactRegion(district.sigungu)))
    .map(district => [district.districtId, district]));
  const candidateTokens = new Map([...candidateDistricts.keys()].map(id => [id, new Set()]));

  for (const record of records) {
    const withAlias = districtByPair.get(pairKey(record.sido, record.sigungu));
    if (withAlias) {
      directRows.set(withAlias.districtId, (directRows.get(withAlias.districtId) ?? 0) + 1);
      if (standardUnobserved.has(withAlias.districtId)) directC.add(withAlias.districtId);
    }
    const withoutAlias = districtByPairWithoutAlias.get(pairKey(record.sido, record.sigungu, false));
    if (withoutAlias) {
      directRowsWithoutAlias.set(withoutAlias.districtId, (directRowsWithoutAlias.get(withoutAlias.districtId) ?? 0) + 1);
      if (standardUnobserved.has(withoutAlias.districtId)) directCWithoutAlias.add(withoutAlias.districtId);
    }
    const addressKey = compactRegion(record.address);
    if (!addressKey) continue;
    const addressPrefixHits = [];
    for (const district of districts) {
      if (!standardUnobserved.has(district.districtId)) continue;
      const sigunguPrefix = compactRegion(district.sigungu);
      const provinceOnlyDistrict = !sigunguPrefix &&
        normalizeText(district.displayName) === normalizeText(district.sido);
      if (!sigunguPrefix && !provinceOnlyDistrict) continue;
      const addressPrefix = compactProvince(district.sido, false) + sigunguPrefix;
      if (!addressPrefix || !addressKey.startsWith(addressPrefix)) continue;
      addressPrefixHits.push(district);
    }
    const uniqueAddressPrefixHits = new Map(addressPrefixHits.map(district => [district.districtId, district]));
    if (uniqueAddressPrefixHits.size > 1) {
      ambiguousAddressPrefixRows++;
      continue;
    }
    const [addressPrefixDistrict] = uniqueAddressPrefixHits.values();
    if (addressPrefixDistrict && standardUnobserved.has(addressPrefixDistrict.districtId)) {
      const district = addressPrefixDistrict;
      addressPrefixRowsWithoutAlias.set(district.districtId, (addressPrefixRowsWithoutAlias.get(district.districtId) ?? 0) + 1);
      addressPrefixCWithoutAlias.add(district.districtId);
    }
  }

  return {
    directRows,
    directRowsWithoutAlias,
    addressPrefixRowsWithoutAlias,
    directC,
    directCWithoutAlias,
    addressPrefixCWithoutAlias,
    ambiguousAddressPrefixRows,
    candidateDistricts,
    candidateTokens,
  };
}

function addAddressTokenMatches(records, standardUnobserved, matches, boundaryData) {
  const candidateDistrictByCode = new Map([...matches.candidateDistricts.values()]
    .map(district => [normalizeText(district.sigunguCode), district]));
  const candidateDistrictByName = new Map([...matches.candidateDistricts.values()]
    .map(district => [compactRegion(district.sigungu), district]));
  if (candidateDistrictByName.size !== matches.candidateDistricts.size) {
    throw new Error('주소 토큰 후보 시군구 이름이 중복됩니다.');
  }
  for (const feature of boundaryData.features) {
    const district = candidateDistrictByCode.get(normalizeText(feature.properties?.sgg));
    const districtId = district?.districtId;
    const administrativeName = normalizeText(feature.properties?.adm_nm);
    if (!districtId || !administrativeName) continue;
    const token = administrativeName.split(/\s+/u).at(-1);
    const tokenKey = compactRegion(token);
    if (tokenKey.length >= 2) matches.candidateTokens.get(districtId)?.add(tokenKey);
  }

  const tokenRows = new Map();
  const tokenC = new Set();
  let ambiguousAddressTokenRows = 0;
  for (const record of records) {
    const sourceKey = pairKey(record.sido, record.sigungu);
    const candidates = reorganizedSourceAreas.get(sourceKey);
    if (!candidates || !record.address) continue;
    const addressKey = compactRegion(record.address);
    const hits = candidates.filter(name => {
      const districtId = candidateDistrictByName.get(compactRegion(name))?.districtId;
      return districtId && [...(matches.candidateTokens.get(districtId) ?? [])].some(token => addressKey.includes(token));
    });
    if (hits.length > 1) {
      ambiguousAddressTokenRows++;
      continue;
    }
    if (hits.length !== 1) continue;
    const district = candidateDistrictByName.get(compactRegion(hits[0]));
    const districtId = district?.districtId;
    if (!districtId) continue;
    tokenRows.set(districtId, (tokenRows.get(districtId) ?? 0) + 1);
    if (standardUnobserved.has(districtId)) tokenC.add(districtId);
  }
  matches.tokenRows = tokenRows;
  matches.tokenC = tokenC;
  matches.ambiguousAddressTokenRows = ambiguousAddressTokenRows;
}

function mainSummary(sourceBytes, sourceHash, directory, nationalData, matches) {
  const districts = nationalData.districts;
  const observed = districts.filter(district => Number(district.childCenterCoordinateAssignedRows) > 0);
  const unobserved = districts.filter(district => Number(district.childCenterCoordinateAssignedRows) === 0);
  const directPairPlusTokenHeuristic = new Set([...matches.directC, ...matches.tokenC]);
  const pairOrAddressPrefixWithoutAliases = new Set([
    ...matches.directCWithoutAlias,
    ...matches.addressPrefixCWithoutAlias,
  ]);
  const addressPrefixOnlyWithoutAliases = [...matches.addressPrefixCWithoutAlias]
    .filter(districtId => !matches.directCWithoutAlias.has(districtId));
  const additionalTokenMatches = [...matches.tokenC].filter(districtId => !matches.directC.has(districtId));
  const addressPrefixOnlyAfterIntegratedAliasDirectPairs = [...matches.addressPrefixCWithoutAlias]
    .filter(districtId => !matches.directC.has(districtId));
  const directPairOrAddressPrefix = new Set([...matches.directC, ...matches.addressPrefixCWithoutAlias]);
  const linkedIncludingAddressPrefixAndTokens = new Set([...directPairOrAddressPrefix, ...matches.tokenC]);
  const tokenOnlyAfterAddressPrefix = [...matches.tokenC]
    .filter(districtId => !directPairOrAddressPrefix.has(districtId));
  const summary = {
    source: {
      file: 'ncrc-2025-center-directory.xlsx',
      bytes: sourceBytes.length,
      sha256: sourceHash,
      dataRows: directory.records.length,
      columnsUsed: directory.columnsUsed,
      headerRow: directory.headerRow,
      rowsMissingSidoOrSigungu: directory.rowsMissingRegionKeys,
      rowsMissingAddress: directory.rowsMissingAddress,
      asOf: '2025년 말',
    },
    standardData: {
      rows: nationalData.metadata.childCenterRows,
      referenceDateMin: nationalData.metadata.childCenterDataAsOfMin,
      referenceDateMax: nationalData.metadata.childCenterDataAsOfMax,
      districtCount: districts.length,
      observedDistrictCount: observed.length,
      unobservedDistrictCount: unobserved.length,
    },
    linkage: {
      directPairWithoutIntegratedProvinceAliases: matches.directCWithoutAlias.size,
      addressPrefixOnlyWithoutIntegratedProvinceAliases: addressPrefixOnlyWithoutAliases.length,
      directPairOrAddressPrefixWithoutIntegratedProvinceAliases: pairOrAddressPrefixWithoutAliases.size,
      directPairAfterIntegratedProvinceAliases: matches.directC.size,
      provinceAliases: Object.fromEntries(integratedProvinceAliases),
      additionalDistrictsFromAddressTokenAfterDirectPair: additionalTokenMatches.length,
      directPairPlusTokenHeuristicDistricts: directPairPlusTokenHeuristic.size,
      additionalDistrictsFromAddressPrefixAfterIntegratedAliasDirectPair: addressPrefixOnlyAfterIntegratedAliasDirectPairs.length,
      additionalDistrictsFromAddressTokenAfterAddressPrefix: tokenOnlyAfterAddressPrefix.length,
      totalUnobservedDistrictsLinkedIncludingAddressPrefixAndToken: linkedIncludingAddressPrefixAndTokens.size,
      unobservedDistrictsStillUnlinked: unobserved.length - linkedIncludingAddressPrefixAndTokens.size,
      ambiguousAddressPrefixRows: matches.ambiguousAddressPrefixRows,
      ambiguousAddressTokenRows: matches.ambiguousAddressTokenRows,
      addressTokenSource: '2026-10-01 boundary GeoJSON properties.adm_nm; final whitespace-delimited token, length >= 2',
      candidateOldAreas: [
        '경기도 / 화성시',
        '인천광역시 / 중구',
        '인천광역시 / 서구',
      ],
      tokenNormalization: 'Unicode NFKC, lowercase, remove whitespace, commas, middle dots, and parentheses; substring match',
    },
    interpretation: [
      '주소록 행 수는 고유 시설 수나 현재 운영 수가 아니다.',
      '95/110은 통합 시도 별칭 적용 후 직접 시도·시군구 일치이며, 99/110은 해당 직접 일치와 행정구역 토큰 휴리스틱의 합집합이다. 주소 접두어를 포함한 전체 규칙 합집합은 108/110이고 2곳은 연결되지 않았다.',
      '모든 연결은 문자열 기반이며 공식 코드 조인이나 지오코딩 결과가 아니다.',
      '이 수치는 지역아동센터 부재, 서비스 공백, 제출률을 뜻하지 않는다.',
      '주소록 원본의 재사용 조건은 확인되지 않았으며 이 스크립트는 원본 행·시설명·주소·전화번호를 출력하지 않는다.',
    ],
  };

  if (sourceBytes.length !== expectedSource.bytes || sourceHash !== expectedSource.sha256 || directory.records.length !== expectedSource.rows) {
    throw new Error('주소록 입력 파일의 크기·SHA-256·행 수가 기록된 2025년 스냅샷과 다릅니다.');
  }
  if (districts.length !== expectedCoverage.districts || observed.length !== expectedCoverage.standardObserved || unobserved.length !== expectedCoverage.standardUnobserved) {
    throw new Error('현재 생성 자료의 시군구 관측 집계가 문서 기준과 다릅니다.');
  }
  if (matches.directCWithoutAlias.size !== expectedCoverage.directPairMatchesWithoutIntegratedProvinceAliases ||
      pairOrAddressPrefixWithoutAliases.size !== expectedCoverage.pairOrAddressPrefixMatchesWithoutIntegratedProvinceAliases ||
      addressPrefixOnlyWithoutAliases.length !== expectedCoverage.addressPrefixOnlyMatchesWithoutIntegratedProvinceAliases ||
      matches.directC.size !== expectedCoverage.directPairAfterIntegratedProvinceAliases ||
      additionalTokenMatches.length !== expectedCoverage.addedByAddressTokenHeuristic ||
      directPairPlusTokenHeuristic.size !== expectedCoverage.directPairPlusTokenHeuristicDistricts ||
      addressPrefixOnlyAfterIntegratedAliasDirectPairs.length !== expectedCoverage.addressPrefixOnlyAfterIntegratedAliasDirectPair ||
      tokenOnlyAfterAddressPrefix.length !== expectedCoverage.tokenOnlyAfterAddressPrefix ||
      linkedIncludingAddressPrefixAndTokens.size !== expectedCoverage.allMethodsLinkedUnobservedDistricts ||
      unobserved.length - linkedIncludingAddressPrefixAndTokens.size !== expectedCoverage.allMethodsUnlinkedDistricts ||
      matches.ambiguousAddressPrefixRows !== expectedCoverage.ambiguousAddressPrefixRows ||
      matches.ambiguousAddressTokenRows !== expectedCoverage.ambiguousAddressTokenRows) {
    throw new Error(`주소록 문자열 연결 결과가 검토된 79/88/95/99/108/2 기준과 다릅니다 ` +
      `(별칭 없는 직접 쌍 ${matches.directCWithoutAlias.size}, 별칭 없는 주소 접두어 단독 ${addressPrefixOnlyWithoutAliases.length}, ` +
      `별칭 없는 주소 접두어 포함 ${pairOrAddressPrefixWithoutAliases.size}, ` +
      `별칭 후 직접 쌍 ${matches.directC.size}, ` +
      `직접쌍+토큰 ${directPairPlusTokenHeuristic.size}, ` +
      `접두어 추가 ${addressPrefixOnlyAfterIntegratedAliasDirectPairs.length}, ` +
      `토큰 추가 ${tokenOnlyAfterAddressPrefix.length}, 전체 연결 ${linkedIncludingAddressPrefixAndTokens.size}, ` +
      `전체 미연결 ${unobserved.length - linkedIncludingAddressPrefixAndTokens.size}, ` +
      `모호 접두어 행 ${matches.ambiguousAddressPrefixRows}, 모호 토큰 행 ${matches.ambiguousAddressTokenRows}). 민감 행 값은 출력하지 않았습니다.`);
  }
  return {
    summary,
    observed,
    unobserved,
    directPairPlusTokenHeuristic,
    linkedIncludingAddressPrefixAndTokens,
  };
}

function directoryLinkageLabel(districtId, matches) {
  if (matches.directCWithoutAlias.has(districtId)) return '직접 시도·시군구 일치';
  if (matches.directC.has(districtId)) return '통합 시도 별칭 적용 후 직접 일치';
  if (matches.addressPrefixCWithoutAlias.has(districtId)) return '주소 접두어 휴리스틱(시도 별칭 미적용)';
  if (matches.tokenC.has(districtId)) return '행정구역 토큰 휴리스틱';
  return '이 수집본에서 연결되지 않음';
}

async function main() {
  const realRoot = await realpath(root);
  const tempPath = resolve(root, 'tmp');
  const tempInfo = await lstat(tempPath);
  if (!tempInfo.isDirectory() || tempInfo.isSymbolicLink()) throw new Error('입력 tmp/는 저장소 안의 실제 폴더여야 합니다.');
  const tempRoot = await realpath(tempPath);
  if (!isWithin(realRoot, tempRoot)) throw new Error('입력 tmp/가 저장소 경로 밖에 있습니다.');
  const realInput = await realpath(inputPath);
  if (!isWithin(tempRoot, realInput)) throw new Error('주소록 입력은 저장소의 Git 제외 tmp/ 아래에 두어야 합니다.');
  const dataSourceRoot = resolve(root, 'data/source');
  if (isWithin(dataSourceRoot, realInput)) throw new Error('추적 데이터 폴더의 입력은 허용하지 않습니다.');
  const sourceBytes = await readFile(realInput);
  const sourceHash = createHash('sha256').update(sourceBytes).digest('hex');
  if (sourceBytes.length !== expectedSource.bytes || sourceHash !== expectedSource.sha256) {
    throw new Error('주소록 입력이 검토된 2025년 기준 파일과 다릅니다.');
  }

  const entries = readZipEntries(sourceBytes);
  const worksheetPath = workbookWorksheetPath(entries);
  const worksheetXml = entries.get(worksheetPath);
  if (!worksheetXml) throw new Error('주소록 시트 데이터를 읽지 못했습니다.');
  const sharedStrings = parseSharedStrings(entries.get('xl/sharedStrings.xml') ?? '');
  const directory = parseDirectoryRows(worksheetXml, sharedStrings);
  const nationalData = readNationalData(await readFile(nationalDataPath, 'utf8'));
  const boundaryData = JSON.parse(gunzipSync(await readFile(boundaryPath)).toString('utf8'));
  if (!Array.isArray(boundaryData.features) || boundaryData.features.length !== 3559) throw new Error('행정경계 파일의 feature 수가 기준과 다릅니다.');

  const districts = nationalData.districts;
  validateDistrictBoundaryCodes(districts, boundaryData);
  const standardUnobserved = new Set(districts
    .filter(district => Number(district.childCenterCoordinateAssignedRows) === 0)
    .map(district => district.districtId));
  const matches = matchDirectoryRows(directory.records, districts, standardUnobserved);
  addAddressTokenMatches(directory.records, standardUnobserved, matches, boundaryData);
  const {
    summary,
    observed,
    unobserved,
    directPairPlusTokenHeuristic,
    linkedIncludingAddressPrefixAndTokens,
  } = mainSummary(sourceBytes, sourceHash, directory, nationalData, matches);

  const outputDirectory = resolve(tempRoot, 'ncrc-coverage-comparison');
  let outputDirectoryInfo;
  try {
    outputDirectoryInfo = await lstat(outputDirectory);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await mkdir(outputDirectory);
    outputDirectoryInfo = await lstat(outputDirectory);
  }
  if (!outputDirectoryInfo.isDirectory() || outputDirectoryInfo.isSymbolicLink()) {
    throw new Error('집계 출력 폴더는 심볼릭 링크가 아닌 실제 폴더여야 합니다.');
  }
  const realOutputDirectory = await realpath(outputDirectory);
  const expectedOutputDirectory = resolve(tempRoot, 'ncrc-coverage-comparison');
  if (!isWithin(tempRoot, realOutputDirectory) || realOutputDirectory !== expectedOutputDirectory) {
    throw new Error('집계 출력 경로는 Git 제외 tmp/ncrc-coverage-comparison/이어야 합니다.');
  }
  await rejectUnsafeOutputFiles(realOutputDirectory, ['summary.json', 'coverage_by_sigungu.csv']);
  const observedIds = new Set(observed.map(district => district.districtId));
  const coverageRows = districts.map(district => {
    const standardObserved = observedIds.has(district.districtId);
    const directRows = matches.directRows.get(district.districtId) ?? 0;
    const tokenRows = matches.tokenRows.get(district.districtId) ?? 0;
    return {
      district_id: district.districtId,
      sigungu_code: district.sigunguCode,
      sido: district.sido,
      sigungu: district.sigungu || district.displayName,
      standarddata_record_rows: district.childCenterRecordRows,
      standarddata_coordinate_assigned_rows: district.childCenterCoordinateAssignedRows,
      standarddata_address_coordinate_review_rows: district.childCenterAddressCoordinateReviewRows,
      standarddata_observed: standardObserved,
      ncrc_2025_direct_pair_rows_after_integrated_province_aliases: directRows,
      ncrc_2025_direct_pair_rows_without_alias: matches.directRowsWithoutAlias.get(district.districtId) ?? 0,
      ncrc_2025_address_prefix_rows_without_alias: matches.addressPrefixRowsWithoutAlias.get(district.districtId) ?? 0,
      ncrc_2025_address_token_heuristic_rows: tokenRows,
      standard_unobserved_directory_linkage: standardObserved
        ? '표준데이터 기록 관측'
        : directoryLinkageLabel(district.districtId, matches),
    };
  });
  const headers = [
    'district_id', 'sigungu_code', 'sido', 'sigungu', 'standarddata_record_rows',
    'standarddata_coordinate_assigned_rows', 'standarddata_address_coordinate_review_rows',
    'standarddata_observed', 'ncrc_2025_direct_pair_rows_after_integrated_province_aliases',
    'ncrc_2025_direct_pair_rows_without_alias', 'ncrc_2025_address_prefix_rows_without_alias',
    'ncrc_2025_address_token_heuristic_rows', 'standard_unobserved_directory_linkage',
  ];
  await Promise.all([
    writeFile(resolve(realOutputDirectory, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8'),
    writeFile(resolve(realOutputDirectory, 'coverage_by_sigungu.csv'), toCsv(coverageRows, headers), 'utf8'),
  ]);
  console.log(JSON.stringify({
    sourceRows: directory.records.length,
    standardObservedDistricts: observed.length,
    standardUnobservedDistricts: unobserved.length,
    directPairAfterIntegratedProvinceAliases: matches.directC.size,
    addressPrefixOnlyWithoutProvinceAliases: summary.linkage.addressPrefixOnlyWithoutIntegratedProvinceAliases,
    additionalAddressTokenLinksAfterPairAndPrefix: summary.linkage.additionalDistrictsFromAddressTokenAfterAddressPrefix,
    directPairPlusTokenHeuristicDistricts: directPairPlusTokenHeuristic.size,
    totalIncludingAddressPrefixAndTokenHeuristics: linkedIncludingAddressPrefixAndTokens.size,
    stillUnlinkedAfterAllThreeMethods: summary.linkage.unobservedDistrictsStillUnlinked,
    ambiguousAddressPrefixRows: matches.ambiguousAddressPrefixRows,
    ambiguousAddressTokenRows: matches.ambiguousAddressTokenRows,
    outputDirectory: relative(root, realOutputDirectory),
  }, null, 2));
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
