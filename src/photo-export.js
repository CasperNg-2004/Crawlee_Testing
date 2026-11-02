const PHOTO_LIST_COLUMNS = [
  'placeId',
  'shopName',
  'photoId',
  'tab',
  'uploadDate',
  'fullSizeImageUrl',
];

export function flattenPhotoList(records) {
  const rows = [];
  const seen = new Set();

  for (const record of records || []) {
    for (const photo of record?.photos || []) {
      const tabs = Array.isArray(photo.tabs) && photo.tabs.length ? photo.tabs : [null];
      for (const tab of tabs) {
        const key = `${record?.placeId ?? ''}\u0000${photo?.photoId ?? ''}\u0000${tab ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({
          placeId: record?.placeId ?? null,
          shopName: record?.name ?? null,
          photoId: photo?.photoId ?? null,
          tab,
          uploadDate: photo?.uploadDate?.text ?? null,
          fullSizeImageUrl: photo?.fullSizeImageUrl ?? null,
        });
      }
    }
  }

  return rows;
}

export function photoListToCsv(rows) {
  const escape = (value) => {
    const text = value == null ? '' : String(value);
    return `"${text.replaceAll('"', '""')}"`;
  };
  return `${PHOTO_LIST_COLUMNS.join(',')}\n${(rows || [])
    .map((row) => PHOTO_LIST_COLUMNS.map((column) => escape(row[column])).join(','))
    .join('\n')}\n`;
}
