export const EXCEL_FONT_NAME = 'Arial';
const HEADER_COLOR = 'FF1F4E78';
const HEADER_FONT_COLOR = 'FFFFFFFF';
const LINK_COLOR = 'FF0563C1';

export function column(header, key, width, wrapText = false, numFmt = undefined) {
  return { header, key, width, wrapText, numFmt };
}

export function createSheet(workbook, name, columns, tabColor, options = {}) {
  const sheet = workbook.addWorksheet(name, {
    properties: { defaultRowHeight: 18, tabColor: { argb: tabColor } },
    views: [{ state: 'frozen', ySplit: 1, xSplit: 2, showGridLines: false }],
  });
  sheet.columns = columns.map((value) => ({
    ...value,
    style: {
      font: { name: EXCEL_FONT_NAME, size: 10, color: { argb: 'FF222222' } },
      alignment: { vertical: 'middle', wrapText: Boolean(value.wrapText) },
      numFmt: value.numFmt,
    },
  }));
  const header = sheet.getRow(1);
  header.height = 28;
  header.font = { name: EXCEL_FONT_NAME, size: 10, bold: true, color: { argb: HEADER_FONT_COLOR } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_COLOR } };
  header.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  header.border = { bottom: { style: 'thin', color: { argb: 'FFFFFFFF' } } };
  if (options.commitHeader) header.commit();
  sheet.autoFilter = { from: 'A1', to: `${columnLetter(columns.length)}1` };
  return sheet;
}

export function styleStatusCell(cell, status, colorsByStatus) {
  const colors = colorsByStatus[status];
  if (!colors) return;
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: colors.fill } };
  cell.font = { name: EXCEL_FONT_NAME, size: 10, bold: true, color: { argb: colors.font } };
  cell.alignment = { horizontal: 'center', vertical: 'middle' };
}

export function styleLinkCell(cell) {
  if (!cell.value) return;
  cell.font = { name: EXCEL_FONT_NAME, size: 10, color: { argb: LINK_COLOR }, underline: true };
}

export function hyperlink(url) {
  return url ? { text: url, hyperlink: url } : null;
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
