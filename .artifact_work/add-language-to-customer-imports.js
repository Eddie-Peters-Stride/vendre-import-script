const fs = require('node:fs');
const path = require('node:path');
const XLSX = require('xlsx');

const sourceDir = path.resolve('outputs/fyrklovern-historical/full-remainder-split-names-20k');
const outputDir = path.resolve('outputs/01a1c072-2faa-76d0-9a06-0dd633086b71');
const languages = {
  SE: 'sv', NO: 'no', FI: 'fi', DK: 'da', DE: 'de', NL: 'nl',
  IT: 'it', AT: 'de', FR: 'fr', BE: 'nl',
};

fs.mkdirSync(outputDir, { recursive: true });
for (const batch of ['02', '03']) {
  const input = path.join(sourceDir, `full-remainder-customers-${batch}.xlsx`);
  const source = XLSX.readFile(input);
  if (source.SheetNames.length !== 1 || source.SheetNames[0] !== 'Customers') {
    throw new Error(`Unexpected sheets in batch ${batch}`);
  }
  const data = XLSX.utils.sheet_to_json(source.Sheets.Customers, { header: 1, defval: '', raw: false });
  const headers = data[0];
  const countryColumn = headers.indexOf('Address Country Code');
  if (countryColumn < 0 || headers.includes('Language')) throw new Error(`Unexpected columns in batch ${batch}`);
  const languageColumn = countryColumn;
  const updated = data.map((row, index) => {
    if (index === 0) return [...row.slice(0, languageColumn), 'Language', ...row.slice(languageColumn)];
    const country = row[countryColumn];
    const language = languages[country];
    if (!language) throw new Error(`Unmapped country ${country} at batch ${batch} row ${index + 1}`);
    return [...row.slice(0, languageColumn), language, ...row.slice(languageColumn)];
  });
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet(updated);
  sheet['!cols'] = updated[0].map(header => ({ wch: Math.max(14, Math.min(65, header.length + 2)) }));
  sheet['!autofilter'] = { ref: sheet['!ref'] };
  XLSX.utils.book_append_sheet(workbook, sheet, 'Customers');
  const output = path.join(outputDir, `full-remainder-customers-${batch}-with-language.xlsx`);
  XLSX.writeFile(workbook, output, { bookType: 'xlsx', compression: true });
  console.log(JSON.stringify({ batch, rows: data.length - 1, output }));
}
