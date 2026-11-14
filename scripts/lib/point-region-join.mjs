function clean(value) {
  return String(value ?? '').normalize('NFKC').replaceAll('\u00a0', ' ').replace(/\s+/g, ' ').trim();
}

function compactAddress(value) {
  return clean(value)
    .replace(/[‐‑‒–—−]/gu, '-')
    .toLocaleLowerCase('ko-KR')
    .replace(/[\s,，·()（）]/gu, '');
}

function coordinatePairs(value, pairs = []) {
  if (!Array.isArray(value)) return pairs;
  if (value.length >= 2 && typeof value[0] === 'number' && typeof value[1] === 'number') {
    pairs.push([value[0], value[1]]);
    return pairs;
  }
  for (const item of value) coordinatePairs(item, pairs);
  return pairs;
}

function featurePolygons(feature) {
  const { type, coordinates } = feature.geometry ?? {};
  if (type === 'Polygon') return [coordinates];
  if (type === 'MultiPolygon') return coordinates;
  return [];
}

export function buildDistrictSpatialIndex(boundaryData) {
  if (!Array.isArray(boundaryData?.features)) throw new Error('Boundary GeoJSON has no feature list');
  const districts = new Map();
  const features = [];

  for (const feature of boundaryData.features) {
    const properties = feature.properties ?? {};
    const code = clean(properties.sgg);
    const sido = clean(properties.sidonm);
    const sigungu = clean(properties.sggnm);
    const polygons = featurePolygons(feature);
    const pairs = coordinatePairs(feature.geometry?.coordinates);
    if (!code || !sido || !sigungu || !polygons.length || !pairs.length) continue;

    districts.set(code, { code, sido, sigungu, label: `${sido} ${sigungu}` });
    const bounds = pairs.reduce((current, [longitude, latitude]) => ({
      minLongitude: Math.min(current.minLongitude, longitude),
      maxLongitude: Math.max(current.maxLongitude, longitude),
      minLatitude: Math.min(current.minLatitude, latitude),
      maxLatitude: Math.max(current.maxLatitude, latitude),
    }), {
      minLongitude: Infinity,
      maxLongitude: -Infinity,
      minLatitude: Infinity,
      maxLatitude: -Infinity,
    });
    features.push({ code, polygons, ...bounds });
  }

  if (districts.size === 0 || features.length === 0) throw new Error('No usable district geometries found');
  return { districts, features };
}

function pointOnSegment(x, y, a, b) {
  const epsilon = 1e-10;
  const cross = (x - a[0]) * (b[1] - a[1]) - (y - a[1]) * (b[0] - a[0]);
  if (Math.abs(cross) > epsilon) return false;
  return x >= Math.min(a[0], b[0]) - epsilon && x <= Math.max(a[0], b[0]) + epsilon &&
    y >= Math.min(a[1], b[1]) - epsilon && y <= Math.max(a[1], b[1]) + epsilon;
}

function pointInRing(longitude, latitude, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j];
    const b = ring[i];
    if (pointOnSegment(longitude, latitude, a, b)) return true;
    const crossesLatitude = (a[1] > latitude) !== (b[1] > latitude);
    if (crossesLatitude) {
      const crossingLongitude = ((b[0] - a[0]) * (latitude - a[1])) / (b[1] - a[1]) + a[0];
      if (longitude < crossingLongitude) inside = !inside;
    }
  }
  return inside;
}

function pointInPolygon(longitude, latitude, rings) {
  if (!rings?.length || !pointInRing(longitude, latitude, rings[0])) return false;
  for (let i = 1; i < rings.length; i++) {
    if (pointInRing(longitude, latitude, rings[i])) return false;
  }
  return true;
}

function pointInFeature(longitude, latitude, feature) {
  return feature.polygons.some(polygon => pointInPolygon(longitude, latitude, polygon));
}

export function locatePoint(longitude, latitude, spatialIndex) {
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude) ||
      longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) {
    return { status: 'missing_or_invalid_coordinates', district: null };
  }

  const matchedCodes = new Set();
  for (const feature of spatialIndex.features) {
    if (longitude < feature.minLongitude - 1e-10 || longitude > feature.maxLongitude + 1e-10 ||
        latitude < feature.minLatitude - 1e-10 || latitude > feature.maxLatitude + 1e-10) continue;
    if (pointInFeature(longitude, latitude, feature)) matchedCodes.add(feature.code);
  }

  if (matchedCodes.size === 1) {
    const code = [...matchedCodes][0];
    return { status: 'joined', district: spatialIndex.districts.get(code) ?? null };
  }
  return {
    status: matchedCodes.size === 0 ? 'outside_boundary' : 'ambiguous_boundary',
    district: null,
  };
}

export function findAddressCoordinateConflicts(records, districts) {
  const districtPrefixes = districts.map(district => ({
    ...district,
    addressPrefix: compactAddress(`${district.sido} ${district.sigungu}`),
  }));
  const conflicts = [];

  for (const record of records) {
    if (!record.regionCode) continue;
    const address = (record.addressTexts ?? []).map(compactAddress).filter(Boolean);
    const candidates = districtPrefixes
      .filter(district => district.code !== record.regionCode &&
        address.some(value => value.startsWith(district.addressPrefix)))
      .sort((a, b) => b.addressPrefix.length - a.addressPrefix.length);
    if (!candidates.length) continue;

    const longestPrefixLength = candidates[0].addressPrefix.length;
    const bestCandidates = candidates.filter(candidate => candidate.addressPrefix.length === longestPrefixLength);
    const codes = new Set(bestCandidates.map(candidate => candidate.code));
    if (codes.size !== 1) continue;

    const addressDistrict = bestCandidates[0];
    const coordinateDistrict = districts.find(district => district.code === record.regionCode);
    conflicts.push({
      record,
      recordId: record.rowNumber,
      addressDistrict,
      coordinateDistrict,
      addressCode: addressDistrict.code,
      addressSido: addressDistrict.sido,
      addressSigungu: addressDistrict.sigungu,
      coordinateCode: coordinateDistrict.code,
      coordinateSido: coordinateDistrict.sido,
      coordinateSigungu: coordinateDistrict.sigungu,
    });
  }

  return conflicts;
}
