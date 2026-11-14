export function cleanMenuDescription(description, priceText) {
  const cleanedDescription = cleanText(description);
  if (!cleanedDescription) return null;
  const cleanedPrice = cleanText(priceText);
  if (cleanedPrice && comparable(cleanedDescription) === comparable(cleanedPrice)) return null;
  return cleanedDescription;
}

export function countMenuItems(menu) {
  return menu?.sections?.reduce(
    (total, section) => total + (Array.isArray(section?.items) ? section.items.length : 0),
    0,
  ) || 0;
}

function cleanText(value) {
  return value?.replace(/\s+/g, ' ').trim() || null;
}

function comparable(value) {
  return value.toLowerCase().replace(/\s+/g, '');
}
