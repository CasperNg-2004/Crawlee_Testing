import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import ExcelJS from 'exceljs';

const FONT_NAME = 'Arial';
const HEADER_COLOR = 'FF1F4E78';
const HEADER_FONT_COLOR = 'FFFFFFFF';
const LINK_COLOR = 'FF0563C1';
const STATUS_COLORS = {
  success: { fill: 'FFE2F0D9', font: 'FF375623' },
  none: { fill: 'FFFFF2CC', font: 'FF7F6000' },
  partial: { fill: 'FFFCE4D6', font: 'FFC65911' },
  failed: { fill: 'FFF4CCCC', font: 'FF9C0006' },
};

export function buildExcelData(records) {
  const data = {
    places: [],
    menu: [],
    photos: [],
    reviews: [],
    openingHours: [],
    popularTimes: [],
    about: [],
  };

  for (const record of records || []) {
    const place = {
      placeId: record.placeId ?? null,
      shopName: record.name ?? null,
    };
    data.places.push({
      ...place,
      featureId: record.featureId ?? null,
      latitude: record.latitude ?? null,
      longitude: record.longitude ?? null,
      rating: record.rating ?? null,
      area: record.area ?? null,
      category: record.category ?? null,
      businessStatus: record.businessStatus?.replaceAll('_', ' ') ?? null,
      brandSize: record.brandSize ?? null,
      numberOfOutlets: record.numberOfOutlets ?? null,
      address: record.address ?? null,
      phone: record.contact?.phone ?? null,
      website: record.contact?.website ?? null,
      reviewCount: record.reviewCount ?? null,
      priceLevel: record.priceLevel ?? null,
      menuStatus: record.menuScrape?.status ?? null,
      menuTabExists: yesNo(record.menuScrape?.tabExists),
      menuItemCount: record.menuScrape?.itemCount ?? countMenuItems(record.menu),
      photoStatus: record.photoScrape?.status ?? null,
      photoCount: record.photos?.length ?? 0,
      reviewStatus: record.reviewScrape?.status ?? null,
      scrapedReviewCount: record.reviews?.length ?? 0,
      peakHours: Array.isArray(record.peakHours) ? record.peakHours.join(' | ') : null,
      googleMapsUrl: record.googleMapsUrl ?? null,
      scrapedAt: dateOrNull(record.scrapedAt),
    });

    for (const section of record.menu?.sections || []) {
      for (const item of section.items || []) {
        data.menu.push({
          ...place,
          section: section.name ?? null,
          dishName: item.name ?? null,
          description: item.description ?? null,
          priceText: item.priceText ?? null,
          priceValue: item.priceValue ?? null,
          currency: item.currency ?? null,
        });
      }
    }

    for (const photo of record.photos || []) {
      const tabs = Array.isArray(photo.tabs) && photo.tabs.length ? photo.tabs : [null];
      for (const tab of tabs) {
        data.photos.push({
          ...place,
          photoId: photo.photoId ?? null,
          tab,
          uploadDate: photo.uploadDate?.text ?? null,
          width: photo.width ?? null,
          height: photo.height ?? null,
          fullSizeImageUrl: photo.fullSizeImageUrl ?? null,
        });
      }
    }

    for (const review of record.reviews || []) {
      data.reviews.push({
        ...place,
        reviewId: review.reviewId ?? null,
        rating: review.rating ?? null,
        publishedText: review.publishedText ?? null,
        text: review.text ?? null,
        likes: review.likes ?? null,
      });
    }

    for (const hours of record.openingHours || []) {
      data.openingHours.push({
        ...place,
        day: hours.day ?? null,
        hours: hours.hours ?? null,
      });
    }

    const overallPeak = new Set((record.popularTimes?.overallPeak || [])
      .map((hour) => `${hour.day}\u0000${hour.time}\u0000${hour.busynessPercent}`));
    const overallQuietest = new Set((record.popularTimes?.overallQuietest || [])
      .map((hour) => `${hour.day}\u0000${hour.time}\u0000${hour.busynessPercent}`));
    for (const day of record.popularTimes?.days || []) {
      const dayPeak = new Set((day.peak || [])
        .map((hour) => `${hour.time}\u0000${hour.busynessPercent}`));
      const dayQuietest = new Set((day.quietest || [])
        .map((hour) => `${hour.time}\u0000${hour.busynessPercent}`));
      for (const hour of day.hours || []) {
        data.popularTimes.push({
          ...place,
          day: day.day ?? null,
          time: hour.time ?? null,
          hour24: hour.hour ?? null,
          minute: hour.minute ?? null,
          busynessPercent: hour.busynessPercent ?? null,
          dayPeak: yesNo(dayPeak.has(`${hour.time}\u0000${hour.busynessPercent}`)),
          dayQuietest: yesNo(dayQuietest.has(`${hour.time}\u0000${hour.busynessPercent}`)),
          overallPeak: yesNo(overallPeak.has(`${day.day}\u0000${hour.time}\u0000${hour.busynessPercent}`)),
          overallQuietest: yesNo(overallQuietest.has(`${day.day}\u0000${hour.time}\u0000${hour.busynessPercent}`)),
        });
      }
    }

    for (const [section, attributes] of Object.entries(record.about || {})) {
      for (const attribute of attributes || []) {
        data.about.push({
          ...place,
          section,
          attribute: attribute.name ?? null,
          available: yesNo(attribute.available),
        });
      }
    }
  }

  return data;
}

export async function exportRestaurantsToExcel(records, filePath) {
  const data = buildExcelData(records);
  await mkdir(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    filename: temporaryPath,
    useStyles: true,
    useSharedStrings: true,
  });
  workbook.creator = 'KL Google Maps Scraper';
  workbook.created = new Date();
  workbook.modified = new Date();

  try {
    writePlacesSheet(workbook, data.places);
    writeSimpleSheet(workbook, 'Menu', menuColumns(), data.menu, { tabColor: 'FF70AD47' });
    writeSimpleSheet(workbook, 'Photos', photoColumns(), data.photos, { tabColor: 'FF5B9BD5' });
    writeSimpleSheet(workbook, 'Reviews', reviewColumns(), data.reviews, { tabColor: 'FFA5A5A5' });
    writeSimpleSheet(
      workbook, 'Opening Hours', openingHoursColumns(), data.openingHours, { tabColor: 'FFFFC000' },
    );
    writeSimpleSheet(
      workbook, 'Popular Times', popularTimesColumns(), data.popularTimes, { tabColor: 'FFED7D31' },
    );
    writeSimpleSheet(workbook, 'About', aboutColumns(), data.about, { tabColor: 'FF8064A2' });
    await workbook.commit();
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }

  return Object.fromEntries(Object.entries(data).map(([name, rows]) => [name, rows.length]));
}

function writePlacesSheet(workbook, rows) {
  const sheet = createSheet(workbook, 'Places', placeColumns(), 'FF1F4E78');
  for (const value of rows) {
    const row = sheet.addRow({
      ...value,
      website: hyperlink(value.website),
      googleMapsUrl: hyperlink(value.googleMapsUrl),
    });
    styleStatusCell(row.getCell('menuStatus'), value.menuStatus);
    styleStatusCell(row.getCell('photoStatus'), value.photoStatus);
    styleStatusCell(row.getCell('reviewStatus'), value.reviewStatus);
    styleLinkCell(row.getCell('website'));
    styleLinkCell(row.getCell('googleMapsUrl'));
    row.commit();
  }
  sheet.commit();
}

function writeSimpleSheet(workbook, name, columns, rows, options = {}) {
  const sheet = createSheet(workbook, name, columns, options.tabColor);
  for (const value of rows) {
    const rowValue = { ...value };
    if (name === 'Photos') rowValue.fullSizeImageUrl = hyperlink(value.fullSizeImageUrl);
    const row = sheet.addRow(rowValue);
    if (name === 'Photos') styleLinkCell(row.getCell('fullSizeImageUrl'));
    row.commit();
  }
  sheet.commit();
}

function createSheet(workbook, name, columns, tabColor) {
  const sheet = workbook.addWorksheet(name, {
    properties: { defaultRowHeight: 18, tabColor: { argb: tabColor } },
    views: [{ state: 'frozen', ySplit: 1, xSplit: 2, showGridLines: false }],
  });
  sheet.columns = columns.map((column) => ({
    ...column,
    style: {
      font: { name: FONT_NAME, size: 10, color: { argb: 'FF222222' } },
      alignment: { vertical: 'middle', wrapText: Boolean(column.wrapText) },
      numFmt: column.numFmt,
    },
  }));
  const header = sheet.getRow(1);
  header.height = 28;
  header.font = { name: FONT_NAME, size: 10, bold: true, color: { argb: HEADER_FONT_COLOR } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_COLOR } };
  header.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  header.border = { bottom: { style: 'thin', color: { argb: 'FFFFFFFF' } } };
  header.commit();
  sheet.autoFilter = { from: 'A1', to: `${columnLetter(columns.length)}1` };
  return sheet;
}

function placeColumns() {
  return [
    column('Shop name', 'shopName', 34, true), column('Place ID', 'placeId', 28),
    column('Feature ID', 'featureId', 24), column('Latitude', 'latitude', 13, false, '0.000000'),
    column('Longitude', 'longitude', 13, false, '0.000000'),
    column('Rating', 'rating', 9, false, '0.0'), column('Area', 'area', 18),
    column('Category', 'category', 20), column('Business status', 'businessStatus', 20),
    column('Brand size', 'brandSize', 16), column('Number of outlets', 'numberOfOutlets', 16, false, '0'),
    column('Address', 'address', 48, true), column('Phone', 'phone', 18),
    column('Website', 'website', 38), column('Google review count', 'reviewCount', 18, false, '#,##0'),
    column('Price level', 'priceLevel', 18), column('Menu status', 'menuStatus', 14),
    column('Menu tab exists', 'menuTabExists', 14), column('Menu item count', 'menuItemCount', 15, false, '#,##0'),
    column('Photo status', 'photoStatus', 14), column('Photo count', 'photoCount', 13, false, '#,##0'),
    column('Review status', 'reviewStatus', 14),
    column('Scraped review count', 'scrapedReviewCount', 18, false, '#,##0'),
    column('Peak hours', 'peakHours', 38, true), column('Google Maps URL', 'googleMapsUrl', 38),
    column('Scraped at', 'scrapedAt', 19, false, 'yyyy-mm-dd hh:mm'),
  ];
}

function menuColumns() {
  return [
    column('Place ID', 'placeId', 28), column('Shop name', 'shopName', 34, true),
    column('Section', 'section', 36, true), column('Dish name', 'dishName', 34, true),
    column('Description', 'description', 58, true), column('Price text', 'priceText', 14),
    column('Price value', 'priceValue', 13, false, '#,##0.00'), column('Currency', 'currency', 10),
  ];
}

function photoColumns() {
  return [
    column('Place ID', 'placeId', 28), column('Shop name', 'shopName', 34, true),
    column('Photo ID', 'photoId', 38), column('Tab', 'tab', 18),
    column('Upload date', 'uploadDate', 16), column('Width', 'width', 10, false, '#,##0'),
    column('Height', 'height', 10, false, '#,##0'),
    column('Full-size image URL', 'fullSizeImageUrl', 50),
  ];
}

function reviewColumns() {
  return [
    column('Place ID', 'placeId', 28), column('Shop name', 'shopName', 34, true),
    column('Review ID', 'reviewId', 38), column('Rating', 'rating', 9, false, '0'),
    column('Published', 'publishedText', 16), column('Review text', 'text', 80, true),
    column('Likes', 'likes', 9, false, '#,##0'),
  ];
}

function openingHoursColumns() {
  return [
    column('Place ID', 'placeId', 28), column('Shop name', 'shopName', 34, true),
    column('Day', 'day', 18), column('Opening hours', 'hours', 36, true),
  ];
}

function popularTimesColumns() {
  return [
    column('Place ID', 'placeId', 28), column('Shop name', 'shopName', 34, true),
    column('Day', 'day', 14), column('Time', 'time', 12),
    column('Hour (24h)', 'hour24', 12, false, '0'), column('Minute', 'minute', 9, false, '0'),
    column('Busyness %', 'busynessPercent', 13, false, '0'),
    column('Day peak', 'dayPeak', 11), column('Day quietest', 'dayQuietest', 13),
    column('Overall peak', 'overallPeak', 13), column('Overall quietest', 'overallQuietest', 16),
  ];
}

function aboutColumns() {
  return [
    column('Place ID', 'placeId', 28), column('Shop name', 'shopName', 34, true),
    column('About section', 'section', 22), column('Attribute', 'attribute', 36, true),
    column('Available', 'available', 12),
  ];
}

function column(header, key, width, wrapText = false, numFmt = undefined) {
  return { header, key, width, wrapText, numFmt };
}

function styleStatusCell(cell, status) {
  const colors = STATUS_COLORS[status];
  if (!colors) return;
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: colors.fill } };
  cell.font = { name: FONT_NAME, size: 10, bold: true, color: { argb: colors.font } };
  cell.alignment = { horizontal: 'center', vertical: 'middle' };
}

function styleLinkCell(cell) {
  if (!cell.value) return;
  cell.font = { name: FONT_NAME, size: 10, color: { argb: LINK_COLOR }, underline: true };
}

function hyperlink(url) {
  return url ? { text: url, hyperlink: url } : null;
}

function dateOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function countMenuItems(menu) {
  return menu?.sections?.reduce((total, section) => total + (section.items?.length || 0), 0) || 0;
}

function yesNo(value) {
  if (value === true) return 'Yes';
  if (value === false) return 'No';
  return null;
}

function columnLetter(count) {
  let value = count;
  let result = '';
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}
