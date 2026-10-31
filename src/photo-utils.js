const MONTHS = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

export function normalizePhotoTabName(tab) {
  return tab.toLowerCase().replace(/\s+and\s+/g, ' & ').replace(/\s+/g, ' ').trim();
}

export function parseGoogleUploadDate(value) {
  const text = value
    .replace(/^Photo\s*[-–—]\s*/i, '')
    .replace(/^Uploaded\s+/i, '')
    .trim();
  const monthFirst = text.match(/^([A-Za-z]+)\.?\s+(?:(\d{1,2}),?\s+)?((?:19|20)\d{2})$/);
  const dayFirst = text.match(/^(\d{1,2})\s+([A-Za-z]+)\.?,?\s+((?:19|20)\d{2})$/);
  const iso = text.match(/^((?:19|20)\d{2})-(\d{2})-(\d{2})$/);
  if (iso) {
    return { text, year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]) };
  }
  if (dayFirst) {
    return {
      text,
      year: Number(dayFirst[3]),
      month: MONTHS[dayFirst[2].toLowerCase()] ?? null,
      day: Number(dayFirst[1]),
    };
  }
  if (!monthFirst) return { text, year: null, month: null, day: null };
  return {
    text,
    year: Number(monthFirst[3]),
    month: MONTHS[monthFirst[1].toLowerCase()] ?? null,
    day: monthFirst[2] ? Number(monthFirst[2]) : null,
  };
}

export function photoDateRank(uploadDate, now = Date.now()) {
  if (!uploadDate) return Number.NEGATIVE_INFINITY;
  if (uploadDate.year) {
    return Date.UTC(uploadDate.year, (uploadDate.month ?? 1) - 1, uploadDate.day ?? 1);
  }
  const text = uploadDate.text?.toLowerCase() || '';
  if (text === 'today') return now;
  if (text === 'yesterday') return now - 86_400_000;
  const relative = text.match(/^(a|an|\d+)\s+(day|week|month|year)s?\s+ago$/);
  if (!relative) return Number.NEGATIVE_INFINITY;
  const amount = /^(a|an)$/.test(relative[1]) ? 1 : Number(relative[1]);
  const unitMs = {
    day: 86_400_000,
    week: 7 * 86_400_000,
    month: 30 * 86_400_000,
    year: 365 * 86_400_000,
  }[relative[2]];
  return now - amount * unitMs;
}
