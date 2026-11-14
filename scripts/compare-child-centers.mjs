import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';
import { gunzipSync } from 'node:zlib';
import {
  buildDistrictSpatialIndex,
  findAddressCoordinateConflicts as findSpatialAddressCoordinateConflicts,
  locatePoint,
} from './lib/point-region-join.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const baselineRelativePath = 'data/source/national_child_centers_20261114.json';
const boundaryRelativePath = 'data/source/admin_dong_boundaries_20261001.geojson.gz';
const expectedBaselineRows = 2570;
const expectedBaselineCoveredDistricts = 146;
const expectedDistricts = 256;

const aliases = {
  name: ['CNTR_NM', '센터명', '시설명'],
  sido: ['CTPV_NM', '시도명', '시도'],
  sigungu: ['SGG_NM', '시군구명', '시군구'],
  roadAddress: ['LCTN_ROAD_NM', '소재지도로명주소', '도로명주소'],
  lotAddress: ['LCTN_LOTNO_ADDR', '소재지지번주소', '지번주소'],
  latitude: ['LAT', '위도'],
  longitude: ['LOT', '경도'],
};

function usage() {
  return [
    'Usage: node scripts/compare-child-centers.mjs <current.csv|current.json> [output-directory]',
    'Default output directory: tmp/child-center-comparison',
    'Keep downloaded input files outside data/source/; tmp/child-center-current.csv is ignored by Git.',
    'The input file must be a downloaded snapshot of 전국지역아동센터표준데이터.',
  ].join('\n');
}

function isWithin(parent, candidate) {
  const pathFromParent = relative(parent, candidate);
  return pathFromParent === '' ||
    (!isAbsolute(pathFromParent) && pathFromParent !== '..' && !pathFromParent.startsWith(`..${sep}`));
}

function decodeCsv(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(buffer.subarray(2));
  }
  if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(buffer.subarray(2));
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder('euc-kr').decode(buffer);
  }
}

function parseCsv(text, label) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  function finishRow() {
    row.push(field.replace(/\r$/, ''));
    if (row.some(value => value.trim() !== '')) rows.push(row);
    row = [];
    field = '';
  }

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
      if (field.length !== 0) throw new Error(`${label}: unexpected quote inside an unquoted field`);
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      finishRow();
    } else {
      field += char;
    }
  }

  if (quoted) throw new Error(`${label}: unterminated quoted field`);
  if (field.length > 0 || row.length > 0) finishRow();

  const [rawHeaders, ...values] = rows;
  if (!rawHeaders?.length) throw new Error(`${label}: CSV is empty`);
  const headers = rawHeaders.map((header, index) => index === 0 ? header.replace(/^\uFEFF/, '').trim() : header.trim());
  if (new Set(headers).size !== headers.length) throw new Error(`${label}: duplicate CSV column names`);

  return values.map((columns, index) => {
    if (columns.length !== headers.length) {
      throw new Error(`${label}: row ${index + 2} has ${columns.length} columns; expected ${headers.length}`);
    }
    return Object.fromEntries(headers.map((header, column) => [header, columns[column]]));
  });
}

function firstValue(row, candidates) {
  for (const key of candidates) {
    const value = row?.[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') return value;
  }
  return '';
}

function clean(value) {
  return String(value ?? '').normalize('NFKC').replaceAll('\u00a0', ' ').replace(/\s+/g, ' ').trim();
}

function compactName(value) {
  return clean(value).toLocaleLowerCase('ko-KR').replace(/[\s\p{P}\p{S}]/gu, '');
}

function compactAddress(value) {
  return clean(value)
    .replace(/[‐‑‒–—−]/gu, '-')
    .toLocaleLowerCase('ko-KR')
    .replace(/[\s,，·()（）]/gu, '');
}

function numeric(value) {
  const text = clean(value).replaceAll(',', '');
  if (!text) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

function normalizeRecords(rows, source) {
  return rows.map((row, index) => {
    const name = clean(firstValue(row, aliases.name));
    const roadAddress = clean(firstValue(row, aliases.roadAddress));
    const lotAddress = clean(firstValue(row, aliases.lotAddress));
    const latitude = numeric(firstValue(row, aliases.latitude));
    const longitude = numeric(firstValue(row, aliases.longitude));
    const validCoordinates = latitude !== null && longitude !== null &&
      latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180;

    return {
      source,
      rowNumber: index + 1,
      name,
      nameKey: compactName(name),
      sidoSource: clean(firstValue(row, aliases.sido)),
      sigunguSource: clean(firstValue(row, aliases.sigungu)),
      roadAddress,
      lotAddress,
      addressTexts: [...new Set([roadAddress, lotAddress].filter(Boolean))],
      addressKeys: [...new Set([roadAddress, lotAddress].map(compactAddress).filter(Boolean))],
      latitude,
      longitude,
      validCoordinates,
      regionCode: null,
      regionSido: '',
      regionSigungu: '',
      joinStatus: 'not_processed',
    };
  });
}

function rowsFromJson(parsed, label) {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') {
    for (const key of ['data', 'items', 'rows', 'records']) {
      if (Array.isArray(parsed[key])) return parsed[key];
    }
    const nestedArray = Object.values(parsed).find(Array.isArray);
    if (nestedArray) return nestedArray;
  }
  throw new Error(`${label}: expected a JSON array of records`);
}

function joinRegions(records, spatialIndex) {
  for (const record of records) {
    const result = locatePoint(record.longitude, record.latitude, spatialIndex);
    record.joinStatus = result.status;
    if (!result.district) continue;
    record.regionCode = result.district.code;
    record.regionSido = result.district.sido;
    record.regionSigungu = result.district.sigungu;
  }
}

function findAddressCoordinateConflicts(records, districts) {
  return findSpatialAddressCoordinateConflicts(records, districts).map(({ record, addressDistrict, coordinateDistrict }) => ({
    side: record.source,
    row: record.rowNumber,
    center_name: record.name,
    road_address: record.roadAddress,
    lot_address: record.lotAddress,
    address_sido: addressDistrict.sido,
    address_sigungu: addressDistrict.sigungu,
    coordinate_sgg_code: coordinateDistrict.code,
    coordinate_sido: coordinateDistrict.sido,
    coordinate_sigungu: coordinateDistrict.sigungu,
  }));
}

function consolidateAddressCoordinateConflicts(conflicts) {
  const grouped = new Map();
  for (const conflict of conflicts) {
    const key = [
      compactName(conflict.center_name),
      compactAddress(conflict.road_address),
      compactAddress(conflict.lot_address),
      conflict.coordinate_sgg_code,
    ].join('\u001f');
    const item = grouped.get(key) ?? {
      center_name: conflict.center_name,
      address_sido: conflict.address_sido,
      address_sigungu: conflict.address_sigungu,
      road_address: conflict.road_address,
      lot_address: conflict.lot_address,
      coordinate_sgg_code: conflict.coordinate_sgg_code,
      coordinate_sido: conflict.coordinate_sido,
      coordinate_sigungu: conflict.coordinate_sigungu,
      snapshot_row: '',
      current_row: '',
    };
    item[conflict.side === 'snapshot' ? 'snapshot_row' : 'current_row'] = conflict.row;
    grouped.set(key, item);
  }
  return [...grouped.values()];
}

function groupKeys(records, keyFunction, matched) {
  const groups = new Map();
  records.forEach((record, index) => {
    if (matched.has(index)) return;
    for (const key of new Set(keyFunction(record))) {
      if (!key) continue;
      const group = groups.get(key) ?? [];
      group.push(index);
      groups.set(key, group);
    }
  });
  return groups;
}

function exactSnapshotKey(record) {
  if (!record.nameKey) return '';
  const addressKey = [...record.addressKeys].sort().join('\u001e');
  const coordinateKey = record.validCoordinates
    ? `${record.latitude.toFixed(7)}\u001f${record.longitude.toFixed(7)}`
    : '';
  if (!addressKey && !coordinateKey) return '';
  return `exact-snapshot\u001f${record.nameKey}\u001f${addressKey}\u001f${coordinateKey}`;
}

function matchEquivalentRows(baseline, current, baselineMatched, currentMatched) {
  const baselineGroups = groupKeys(baseline, record => [exactSnapshotKey(record)], baselineMatched);
  const currentGroups = groupKeys(current, record => [exactSnapshotKey(record)], currentMatched);
  const matches = [];

  for (const [key, oldIndices] of baselineGroups) {
    const currentIndices = currentGroups.get(key) ?? [];
    if (!currentIndices.length) continue;
    const oldSorted = [...oldIndices].sort((a, b) => baseline[a].rowNumber - baseline[b].rowNumber);
    const currentSorted = [...currentIndices].sort((a, b) => current[a].rowNumber - current[b].rowNumber);
    const count = Math.min(oldSorted.length, currentSorted.length);
    for (let i = 0; i < count; i++) {
      const oldIndex = oldSorted[i];
      const currentIndex = currentSorted[i];
      baselineMatched.add(oldIndex);
      currentMatched.add(currentIndex);
      matches.push({ oldIndex, currentIndex, method: 'exact_name_address_coordinate_multiset' });
    }
  }

  return { count: matches.length, matches };
}

function matchByUniqueKeys(baseline, current, baselineMatched, currentMatched, keyFunction, phase) {
  const baselineGroups = groupKeys(baseline, keyFunction, baselineMatched);
  const currentGroups = groupKeys(current, keyFunction, currentMatched);
  const ambiguous = [];
  const matches = [];
  let count = 0;

  for (const key of new Set([...baselineGroups.keys(), ...currentGroups.keys()])) {
    const oldIndices = (baselineGroups.get(key) ?? []).filter(index => !baselineMatched.has(index));
    const currentIndices = (currentGroups.get(key) ?? []).filter(index => !currentMatched.has(index));
    if (!oldIndices.length || !currentIndices.length) continue;
    if (oldIndices.length === 1 && currentIndices.length === 1) {
      const oldIndex = oldIndices[0];
      const currentIndex = currentIndices[0];
      if (baselineMatched.has(oldIndex) || currentMatched.has(currentIndex)) continue;
      baselineMatched.add(oldIndex);
      currentMatched.add(currentIndex);
      matches.push({ oldIndex, currentIndex, method: phase });
      count++;
    } else {
      ambiguous.push({
        phase,
        baselineRows: oldIndices.map(index => baseline[index].rowNumber).join(';'),
        currentRows: currentIndices.map(index => current[index].rowNumber).join(';'),
        baselineCount: oldIndices.length,
        currentCount: currentIndices.length,
      });
    }
  }

  return { count, ambiguous, matches };
}

function nameAddressKeys(record) {
  if (!record.nameKey) return [];
  return record.addressKeys.map(address => `name-address\u001f${record.nameKey}\u001f${address}`);
}

function roundedCoordinateKey(record, includeName = true) {
  if (!record.validCoordinates || (includeName && !record.nameKey)) return '';
  const base = `${record.latitude.toFixed(5)}\u001f${record.longitude.toFixed(5)}`;
  return includeName ? `name-coordinate\u001f${record.nameKey}\u001f${base}` : `coordinate\u001f${base}`;
}

function possibleReviewPairs(baseline, current, baselineMatched, currentMatched) {
  const candidates = new Map();
  const phases = [
    { label: 'same_normalized_address', key: record => record.addressKeys.map(value => `address\u001f${value}`) },
    { label: 'same_coordinate_rounded_5dp', key: record => [roundedCoordinateKey(record, false)] },
    {
      label: 'same_name_and_boundary_district',
      key: record => record.nameKey && record.regionCode ? [`region-name\u001f${record.regionCode}\u001f${record.nameKey}`] : [],
    },
  ];

  for (const phase of phases) {
    const oldGroups = groupKeys(baseline, phase.key, baselineMatched);
    const newGroups = groupKeys(current, phase.key, currentMatched);
    for (const [key, oldIndices] of oldGroups) {
      const newIndices = newGroups.get(key) ?? [];
      if (oldIndices.length !== 1 || newIndices.length !== 1) continue;
      const oldIndex = oldIndices[0];
      const newIndex = newIndices[0];
      const pairKey = `${oldIndex}\u001f${newIndex}`;
      const oldRecord = baseline[oldIndex];
      const newRecord = current[newIndex];
      const reason = oldRecord.nameKey === newRecord.nameKey ? phase.label : `${phase.label}_name_changed`;
      if (!candidates.has(pairKey)) candidates.set(pairKey, { oldIndex, newIndex, reason });
    }
  }

  return [...candidates.values()].map(({ oldIndex, newIndex, reason }) => {
    const oldRecord = baseline[oldIndex];
    const newRecord = current[newIndex];
    return {
      baselineRow: oldRecord.rowNumber,
      currentRow: newRecord.rowNumber,
      reason,
      baselineName: oldRecord.name,
      currentName: newRecord.name,
      baselineAddress: oldRecord.roadAddress || oldRecord.lotAddress,
      currentAddress: newRecord.roadAddress || newRecord.lotAddress,
      distanceMeters: oldRecord.validCoordinates && newRecord.validCoordinates
        ? Math.round(distanceMeters(oldRecord, newRecord))
        : '',
    };
  });
}

function changedMatchedRows(matches, baseline, current) {
  const rows = [];
  for (const match of matches) {
    const oldRecord = baseline[match.oldIndex];
    const newRecord = current[match.currentIndex];
    const changedFields = [];
    if (oldRecord.name !== newRecord.name) changedFields.push('center_name');
    if (oldRecord.sidoSource !== newRecord.sidoSource) changedFields.push('source_sido');
    if (oldRecord.sigunguSource !== newRecord.sigunguSource) changedFields.push('source_sigungu');
    if (oldRecord.roadAddress !== newRecord.roadAddress) changedFields.push('road_address');
    if (oldRecord.lotAddress !== newRecord.lotAddress) changedFields.push('lot_address');
    if (oldRecord.latitude !== newRecord.latitude) changedFields.push('latitude');
    if (oldRecord.longitude !== newRecord.longitude) changedFields.push('longitude');
    if (changedFields.length === 0) continue;
    rows.push({
      baseline_row: oldRecord.rowNumber,
      current_row: newRecord.rowNumber,
      matched_by: match.method,
      changed_fields: changedFields.join(';'),
      baseline_name: oldRecord.name,
      current_name: newRecord.name,
      baseline_road_address: oldRecord.roadAddress,
      current_road_address: newRecord.roadAddress,
      baseline_lot_address: oldRecord.lotAddress,
      current_lot_address: newRecord.lotAddress,
      baseline_address: oldRecord.roadAddress || oldRecord.lotAddress,
      current_address: newRecord.roadAddress || newRecord.lotAddress,
      baseline_latitude: oldRecord.latitude ?? '',
      current_latitude: newRecord.latitude ?? '',
      baseline_longitude: oldRecord.longitude ?? '',
      current_longitude: newRecord.longitude ?? '',
    });
  }
  return rows;
}

function distanceMeters(a, b) {
  const radians = value => value * Math.PI / 180;
  const latitudeDelta = radians(b.latitude - a.latitude);
  const longitudeDelta = radians(b.longitude - a.longitude);
  const latitudeA = radians(a.latitude);
  const latitudeB = radians(b.latitude);
  const haversine = Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(latitudeA) * Math.cos(latitudeB) * Math.sin(longitudeDelta / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function toCsv(headers, rows) {
  return `${headers.join(',')}\r\n${rows.map(row => headers.map(header => csvCell(row[header])).join(',')).join('\r\n')}\r\n`;
}

function reportRecord(record) {
  return {
    row: record.rowNumber,
    center_name: record.name,
    source_sido: record.sidoSource,
    source_sigungu: record.sigunguSource,
    road_address: record.roadAddress,
    lot_address: record.lotAddress,
    latitude: record.latitude ?? '',
    longitude: record.longitude ?? '',
    boundary_sgg_code: record.regionCode ?? '',
    boundary_sido: record.regionSido,
    boundary_sigungu: record.regionSigungu,
    boundary_join_status: record.joinStatus,
  };
}

function addWarning(warnings, condition, message) {
  if (condition) warnings.push(message);
}

async function main() {
  const [inputArgument, outputArgument] = process.argv.slice(2);
  if (!inputArgument || inputArgument === '--help' || inputArgument === '-h') {
    console.log(usage());
    return;
  }

  const inputPath = resolve(root, inputArgument);
  const outputPath = resolve(root, outputArgument ?? 'tmp/child-center-comparison');
  const trackedSourcePath = resolve(root, 'data/source');
  if (isWithin(trackedSourcePath, inputPath)) {
    throw new Error('Keep downloaded comparison files outside data/source/. Use tmp/child-center-current.csv or an external temporary directory.');
  }
  if (isWithin(trackedSourcePath, outputPath)) {
    throw new Error('Comparison reports cannot be written inside data/source/.');
  }
  const baselinePath = resolve(root, baselineRelativePath);
  const boundaryPath = resolve(root, boundaryRelativePath);

  const [baselineBuffer, currentBuffer, boundaryBuffer] = await Promise.all([
    readFile(baselinePath),
    readFile(inputPath),
    readFile(boundaryPath),
  ]);
  const baselineRaw = rowsFromJson(JSON.parse(baselineBuffer.toString('utf8')), basename(baselinePath));
  const currentRaw = /\.json$/i.test(inputPath)
    ? rowsFromJson(JSON.parse(currentBuffer.toString('utf8')), basename(inputPath))
    : parseCsv(decodeCsv(currentBuffer), basename(inputPath));
  const boundaryData = JSON.parse(gunzipSync(boundaryBuffer).toString('utf8'));

  const baseline = normalizeRecords(baselineRaw, 'snapshot');
  const current = normalizeRecords(currentRaw, 'current');
  const spatialIndex = buildDistrictSpatialIndex(boundaryData);
  joinRegions(baseline, spatialIndex);
  joinRegions(current, spatialIndex);

  const baselineMatched = new Set();
  const currentMatched = new Set();
  const exactMatches = matchEquivalentRows(baseline, current, baselineMatched, currentMatched);
  const addressMatches = matchByUniqueKeys(
    baseline, current, baselineMatched, currentMatched, nameAddressKeys, 'name_and_address');
  const coordinateMatches = matchByUniqueKeys(
    baseline, current, baselineMatched, currentMatched,
    record => [roundedCoordinateKey(record)], 'name_and_coordinates_5dp');

  const baselineUnmatchedIndexes = baseline.map((_, index) => index).filter(index => !baselineMatched.has(index));
  const currentUnmatchedIndexes = current.map((_, index) => index).filter(index => !currentMatched.has(index));
  const allMatches = [...exactMatches.matches, ...addressMatches.matches, ...coordinateMatches.matches];
  const changedRows = changedMatchedRows(allMatches, baseline, current);
  const possibleMatches = possibleReviewPairs(baseline, current, baselineMatched, currentMatched);
  const allDistricts = [...spatialIndex.districts.values()].sort((a, b) => a.label.localeCompare(b.label, 'ko'));
  const baselineCounts = new Map();
  const currentCounts = new Map();
  const baselineObserved = new Set();
  const currentObserved = new Set();

  for (const record of baseline) {
    if (record.regionCode) {
      baselineObserved.add(record.regionCode);
      baselineCounts.set(record.regionCode, (baselineCounts.get(record.regionCode) ?? 0) + 1);
    }
  }
  for (const record of current) {
    if (record.regionCode) {
      currentObserved.add(record.regionCode);
      currentCounts.set(record.regionCode, (currentCounts.get(record.regionCode) ?? 0) + 1);
    }
  }

  const addressCoordinateConflicts = consolidateAddressCoordinateConflicts([
    ...findAddressCoordinateConflicts(baseline, allDistricts),
    ...findAddressCoordinateConflicts(current, allDistricts),
  ]);
  const baselineUnobserved = allDistricts.filter(district => !baselineObserved.has(district.code));
  const currentUnobserved = allDistricts.filter(district => !currentObserved.has(district.code));
  const newlyObserved = allDistricts.filter(district => !baselineObserved.has(district.code) && currentObserved.has(district.code));
  const noLongerObserved = allDistricts.filter(district => baselineObserved.has(district.code) && !currentObserved.has(district.code));
  const warnings = [];
  addWarning(warnings, baseline.length !== expectedBaselineRows,
    `Saved baseline has ${baseline.length} rows; documentation says ${expectedBaselineRows}.`);
  addWarning(warnings, baselineObserved.size !== expectedBaselineCoveredDistricts,
    `Saved baseline covers ${baselineObserved.size} districts spatially; prior review says ${expectedBaselineCoveredDistricts}.`);
  addWarning(warnings, allDistricts.length !== expectedDistricts,
    `Boundary file has ${allDistricts.length} districts; prior review uses ${expectedDistricts}.`);
  addWarning(warnings, baseline.some(record => record.joinStatus !== 'joined'),
    'One or more saved baseline coordinates did not join to exactly one district. Review spatial_join_issues.csv.');
  addWarning(warnings, current.some(record => record.joinStatus !== 'joined'),
    'One or more current coordinates did not join to exactly one district. Review spatial_join_issues.csv.');
  addWarning(warnings, addressCoordinateConflicts.length > 0,
    'One or more source address prefixes disagree with the coordinate-assigned district. Review address_coordinate_conflicts.csv; no source values were changed.');

  const summary = {
    baseline: {
      file: basename(baselinePath),
      sha256: sha256(baselineBuffer),
      rows: baseline.length,
      spatiallyJoinedRows: baseline.filter(record => record.joinStatus === 'joined').length,
      observedDistricts: baselineObserved.size,
      unobservedDistricts: baselineUnobserved.length,
    },
    current: {
      file: basename(inputPath),
      sha256: sha256(currentBuffer),
      rows: current.length,
      spatiallyJoinedRows: current.filter(record => record.joinStatus === 'joined').length,
      observedDistricts: currentObserved.size,
      unobservedDistricts: currentUnobserved.length,
    },
    matching: {
      matchedByExactNameAddressAndCoordinates: exactMatches.count,
      matchedByNameAndAddress: addressMatches.count,
      matchedByNameAndCoordinatesRoundedTo5Decimals: coordinateMatches.count,
      matchedRowsTotal: allMatches.length,
      matchedRowsWithFieldChanges: changedRows.length,
      baselineUnmatchedRows: baselineUnmatchedIndexes.length,
      currentUnmatchedRows: currentUnmatchedIndexes.length,
      possibleChangedRecordPairsForManualReview: possibleMatches.length,
      ambiguousMatchKeys: addressMatches.ambiguous.length + coordinateMatches.ambiguous.length,
      addressCoordinateConflictRows: addressCoordinateConflicts.length,
    },
    matchingRules: {
      fieldsByHeader: {
        centerName: aliases.name,
        province: aliases.sido,
        district: aliases.sigungu,
        roadAddress: aliases.roadAddress,
        lotAddress: aliases.lotAddress,
        latitude: aliases.latitude,
        longitude: aliases.longitude,
      },
      nameNormalization: 'Unicode NFKC, lowercase, remove whitespace and punctuation/symbols; keep the 지역아동센터 suffix.',
      addressNormalization: 'Unicode NFKC, lowercase, normalize hyphen variants, remove whitespace/commas/middle dots/parentheses; preserve hyphens and slashes.',
      matchOrder: [
        'exact normalized center name + address fields + latitude/longitude; duplicate groups are paired by occurrence count',
        'unique normalized center name + normalized road or lot address',
        'unique normalized center name + latitude/longitude rounded to 5 decimal places',
      ],
      representativeName: 'The 대표자명 field is not used for matching and is never written to reports.',
    },
    coverage: {
      districtUniverse: allDistricts.length,
      previousCCount: baselineUnobserved.length,
      currentCCount: currentUnobserved.length,
      cCountReduction: baselineUnobserved.length - currentUnobserved.length,
      newlyObservedDistricts: newlyObserved.map(({ code, label }) => ({ code, label })),
      noLongerObservedDistricts: noLongerObserved.map(({ code, label }) => ({ code, label })),
    },
    interpretation: {
      cLabel: '이 수집본에서 센터 기록 미관측',
      unmatchedRows: 'Unmatched rows may reflect changed names, addresses, or coordinates; they are not automatically confirmed openings or closures.',
      coordinateAssignment: 'District coverage is assigned from coordinates against the saved 2026-10-01 administrative-dong boundary file. Source address and coordinates are not modified.',
    },
    warnings,
  };

  const recordHeaders = [
    'row', 'center_name', 'source_sido', 'source_sigungu', 'road_address', 'lot_address',
    'latitude', 'longitude', 'boundary_sgg_code', 'boundary_sido', 'boundary_sigungu', 'boundary_join_status',
  ];
  const coverageRows = allDistricts.map(district => ({
    sgg_code: district.code,
    sido: district.sido,
    sigungu: district.sigungu,
    baseline_center_rows: baselineCounts.get(district.code) ?? 0,
    current_center_rows: currentCounts.get(district.code) ?? 0,
    baseline_observed: baselineObserved.has(district.code),
    current_observed: currentObserved.has(district.code),
    status: !baselineObserved.has(district.code) && currentObserved.has(district.code) ? 'newly_observed'
      : baselineObserved.has(district.code) && !currentObserved.has(district.code) ? 'no_longer_observed'
        : currentObserved.has(district.code) ? 'observed_in_both' : 'unobserved_in_both',
  }));
  const issues = [...baseline, ...current]
    .filter(record => record.joinStatus !== 'joined')
    .map(record => ({ side: record.source, ...reportRecord(record) }));
  const ambiguousMatches = [...addressMatches.ambiguous, ...coordinateMatches.ambiguous];

  await mkdir(outputPath, { recursive: true });
  await Promise.all([
    writeFile(resolve(outputPath, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8'),
    writeFile(resolve(outputPath, 'baseline_unmatched.csv'), toCsv(recordHeaders, baselineUnmatchedIndexes.map(index => reportRecord(baseline[index]))), 'utf8'),
    writeFile(resolve(outputPath, 'current_unmatched.csv'), toCsv(recordHeaders, currentUnmatchedIndexes.map(index => reportRecord(current[index]))), 'utf8'),
    writeFile(resolve(outputPath, 'coverage_by_sigungu.csv'), toCsv([
      'sgg_code', 'sido', 'sigungu', 'baseline_center_rows', 'current_center_rows',
      'baseline_observed', 'current_observed', 'status',
    ], coverageRows), 'utf8'),
    writeFile(resolve(outputPath, 'possible_changed_pairs.csv'), toCsv([
      'baseline_row', 'current_row', 'reason', 'baseline_name', 'current_name',
      'baseline_address', 'current_address', 'distance_meters',
    ], possibleMatches), 'utf8'),
    writeFile(resolve(outputPath, 'matched_record_changes.csv'), toCsv([
      'baseline_row', 'current_row', 'matched_by', 'changed_fields', 'baseline_name', 'current_name',
      'baseline_road_address', 'current_road_address', 'baseline_lot_address', 'current_lot_address',
      'baseline_address', 'current_address', 'baseline_latitude', 'current_latitude',
      'baseline_longitude', 'current_longitude',
    ], changedRows), 'utf8'),
    writeFile(resolve(outputPath, 'spatial_join_issues.csv'), toCsv([
      'side', ...recordHeaders,
    ], issues), 'utf8'),
    writeFile(resolve(outputPath, 'address_coordinate_conflicts.csv'), toCsv([
      'center_name', 'address_sido', 'address_sigungu', 'road_address', 'lot_address',
      'coordinate_sgg_code', 'coordinate_sido', 'coordinate_sigungu', 'snapshot_row', 'current_row',
    ], addressCoordinateConflicts), 'utf8'),
    writeFile(resolve(outputPath, 'ambiguous_matches.csv'), toCsv([
      'phase', 'baseline_rows', 'current_rows', 'baseline_count', 'current_count',
    ], ambiguousMatches), 'utf8'),
  ]);

  console.log(JSON.stringify({ summary, outputDirectory: outputPath }, null, 2));
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
