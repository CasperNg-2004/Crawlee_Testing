const PLACE_ID_PATTERN = /^ChIJ[A-Za-z0-9_-]+$/;
const GOOGLE_HOST_PATTERN = /(^|\.)google\.[a-z.]+$/i;

export function isGooglePlaceId(value) {
  return PLACE_ID_PATTERN.test(value?.trim() || '');
}

export function buildGooglePlaceIdUrl(placeId, query = 'place') {
  const normalizedPlaceId = placeId?.trim();
  if (!isGooglePlaceId(normalizedPlaceId)) {
    throw new Error(`Invalid Google place ID: ${placeId || '(empty)'}`);
  }

  const url = new URL('https://www.google.com/maps/search/');
  url.searchParams.set('api', '1');
  url.searchParams.set('query', query?.trim() || 'place');
  url.searchParams.set('query_place_id', normalizedPlaceId);
  url.searchParams.set('hl', 'en');
  return url.toString();
}

export function normalizeGooglePlaceInput(value, query = 'place') {
  const input = value?.trim();
  if (!input) throw new Error('Google place input is empty.');
  if (isGooglePlaceId(input)) return buildGooglePlaceIdUrl(input, query);

  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`Google place input must be a ChIJ place ID or a valid URL: ${input}`);
  }

  if (!GOOGLE_HOST_PATTERN.test(url.hostname) || !/^\/maps(?:\/|$)/i.test(url.pathname)) {
    throw new Error(`Direct place URL must be a Google Maps URL: ${input}`);
  }

  const queryPlaceId = url.searchParams.get('query_place_id');
  if (queryPlaceId && !isGooglePlaceId(queryPlaceId)) {
    throw new Error(`Invalid query_place_id in Google Maps URL: ${queryPlaceId}`);
  }

  if (!url.searchParams.has('hl')) url.searchParams.set('hl', 'en');
  return url.toString();
}

export function extractGooglePlaceMetadata(value) {
  if (!value) return emptyMetadata();

  let parsed = null;
  try {
    parsed = new URL(value);
  } catch {
    // Canonical Maps fragments can still be parsed with the regular expressions below.
  }

  const decoded = safelyDecode(value);
  const placeId = firstValue(
    parsed?.searchParams.get('query_place_id'),
    decoded.match(/!19s(ChIJ[A-Za-z0-9_-]+)/)?.[1],
  );
  const featureId = normalizeFeatureId(
    decoded.match(/!1s(0x[0-9a-f]+:0x[0-9a-f]+)/i)?.[1]
      || decoded.match(/\b(0x[0-9a-f]+:0x[0-9a-f]+)\b/i)?.[1],
  );

  const atCoordinates = decoded.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(?:,|z|\/)/i);
  const dataCoordinates = decoded.match(/!3d(-?\d+(?:\.\d+)?).*?!4d(-?\d+(?:\.\d+)?)/i);
  const latitude = parseCoordinate(atCoordinates?.[1] || dataCoordinates?.[1], -90, 90);
  const longitude = parseCoordinate(atCoordinates?.[2] || dataCoordinates?.[2], -180, 180);

  return { placeId, featureId, latitude, longitude };
}

export function googlePlaceIdentity(value) {
  const metadata = extractGooglePlaceMetadata(value);
  if (metadata.placeId) return `place-id:${metadata.placeId}`;
  if (metadata.featureId) return `feature-id:${metadata.featureId}`;

  try {
    const url = new URL(value);
    url.hash = '';
    url.searchParams.delete('hl');
    return url.toString();
  } catch {
    return value;
  }
}

export function selectBestGooglePlaceUrl(candidates, requestedUrl, placeName) {
  const requestedMetadata = extractGooglePlaceMetadata(requestedUrl);
  const normalizedName = normalizeForMatch(placeName);
  const uniqueCandidates = [...new Set([requestedUrl, ...candidates].filter(Boolean))];
  let bestUrl = requestedUrl;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const candidate of uniqueCandidates) {
    let parsed;
    try {
      parsed = new URL(candidate, requestedUrl);
    } catch {
      continue;
    }
    if (!GOOGLE_HOST_PATTERN.test(parsed.hostname) || !/^\/maps(?:\/|$)/i.test(parsed.pathname)) continue;

    const normalizedCandidate = parsed.toString();
    const metadata = extractGooglePlaceMetadata(normalizedCandidate);
    const candidateText = normalizeForMatch(safelyDecode(normalizedCandidate));
    let score = 0;
    if (metadata.placeId && metadata.placeId === requestedMetadata.placeId) score += 600;
    if (metadata.featureId) score += 150;
    if (metadata.latitude != null && metadata.longitude != null) score += 150;
    if (/\/maps\/place\//i.test(parsed.pathname)) score += 250;
    if (normalizedName && candidateText.includes(normalizedName)) score += 300;
    if (parsed.searchParams.has('query_place_id')
      && metadata.featureId == null && metadata.latitude == null) score -= 50;

    if (score > bestScore) {
      bestScore = score;
      bestUrl = normalizedCandidate;
    }
  }

  return bestUrl;
}

export function extractGooglePlaceMetadataFromText(value, marker) {
  if (!value) return emptyMetadata();
  const text = normalizeEscapedGoogleText(value);
  const markerIndex = marker ? text.indexOf(marker) : -1;
  const featureMatches = [...text.matchAll(/0x[0-9a-f]+:0x[0-9a-f]+/gi)];
  const featureMatch = nearestMatch(featureMatches, markerIndex);
  const coordinateMatches = [
    ...text.matchAll(/@(-?\d{1,2}(?:\.\d{4,})),(-?\d{1,3}(?:\.\d{4,}))/g),
    ...text.matchAll(/!3d(-?\d{1,2}(?:\.\d{4,})).*?!4d(-?\d{1,3}(?:\.\d{4,}))/g),
    ...text.matchAll(/(-?\d{1,3}(?:\.\d{4,}))\s*[,;]\s*(-?\d{1,3}(?:\.\d{4,}))/g),
  ].map((match) => normalizeCoordinateMatch(match)).filter(Boolean);
  const coordinateMatch = nearestMatch(coordinateMatches, markerIndex);

  return {
    placeId: isGooglePlaceId(marker) ? marker : text.match(/ChIJ[A-Za-z0-9_-]+/)?.[0] || null,
    featureId: normalizeFeatureId(featureMatch?.[0]),
    latitude: coordinateMatch?.latitude ?? null,
    longitude: coordinateMatch?.longitude ?? null,
  };
}

function emptyMetadata() {
  return { placeId: null, featureId: null, latitude: null, longitude: null };
}

function safelyDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizeEscapedGoogleText(value) {
  return safelyDecode(value)
    .replaceAll('\\u003d', '=')
    .replaceAll('\\u0026', '&')
    .replaceAll('\\u002f', '/')
    .replaceAll('\\/', '/')
    .replaceAll('&amp;', '&');
}

function normalizeFeatureId(value) {
  return value ? value.toLowerCase() : null;
}

function parseCoordinate(value, minimum, maximum) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

function coordinatesAreValid(latitude, longitude) {
  return parseCoordinate(latitude, -90, 90) != null
    && parseCoordinate(longitude, -180, 180) != null;
}

function normalizeCoordinateMatch(match) {
  if (coordinatesAreValid(match[1], match[2])) {
    return { index: match.index, latitude: Number(match[1]), longitude: Number(match[2]) };
  }
  if (coordinatesAreValid(match[2], match[1])) {
    return { index: match.index, latitude: Number(match[2]), longitude: Number(match[1]) };
  }
  return null;
}

function nearestMatch(matches, markerIndex) {
  if (!matches.length) return null;
  if (markerIndex < 0) return matches[0];
  return matches.reduce((nearest, match) => (
    Math.abs((match.index ?? 0) - markerIndex) < Math.abs((nearest.index ?? 0) - markerIndex)
      ? match
      : nearest
  ));
}

function firstValue(...values) {
  return values.find(Boolean) || null;
}

function normalizeForMatch(value) {
  return safelyDecode(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}
