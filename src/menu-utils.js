export function cleanMenuDescription(description, priceText) {
  const cleanedDescription = cleanText(description);
  if (!cleanedDescription) return null;
  const cleanedPrice = cleanText(priceText);
  if (cleanedPrice && comparable(cleanedDescription) === comparable(cleanedPrice)) return null;
  return cleanedDescription;
}

function cleanText(value) {
  return value?.replace(/\s+/g, ' ').trim() || null;
}

function comparable(value) {
  return value.toLowerCase().replace(/\s+/g, '');
}
