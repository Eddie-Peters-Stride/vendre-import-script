const fs = require('node:fs');
const path = require('node:path');
const XLSX = require('xlsx');

const sourcePath = 'C:/Users/Eddie Peters/Downloads/Import_Result_2026-11-09_114505.xlsx';
const outputDir = path.resolve('outputs/01a1c072-2faa-76d0-9a06-0dd633086b71');
const sourceSheet = XLSX.readFile(sourcePath).Sheets.Customers;
const rows = XLSX.utils.sheet_to_json(sourceSheet, { defval: '', raw: false });

const languageByCountry = {
  SE: 'sv', NO: 'no', FI: 'fi', DK: 'da', DE: 'de', NL: 'nl',
  IT: 'it', AT: 'de', FR: 'fr', BE: 'fr',
};
const sourceNumberKey = 'Metafield: migration.fyrklovern_customer_number [single_line_text_field]';
const retryHeaders = [
  'ID', 'Email', 'Command', 'First Name', 'Last Name', 'Phone',
  'Address Country Code', 'Address Line 1', 'Address City', 'Address Zip',
  'Address Command', 'Address Is Default', 'Address Last Name', sourceNumberKey,
];
const languageHeaders = ['ID', 'Email', 'Command', 'Language'];
const failed = rows.filter(row => row['Import Result'] === 'Failed');
if (rows.length !== 20000 || failed.length !== 50) throw new Error('Unexpected source counts');
if (new Set(rows.map(row => row.Email.toLowerCase())).size !== rows.length) throw new Error('Duplicate emails');

const retryRows = failed.map(row => {
  const phoneError = String(row['Import Comment']).includes('Phone is invalid');
  const emojiError = String(row['Import Comment']).includes('Last name cannot contain emojis');
  if (!phoneError && !emojiError) throw new Error(`Unclassified failure for ${row.Email}`);
  const retry = Object.fromEntries(retryHeaders.map(header => [header, row[header] || '']));
  retry.ID = row['ID (Ref)'] || '';
  retry.Command = 'MERGE';
  if (phoneError) retry.Phone = '';
  if (emojiError) {
    if (row[sourceNumberKey] !== 'K20532') throw new Error('Unexpected emoji failure');
    retry['Address Last Name'] = 'Sandanger Goa';
  }
  return retry;
});
if (retryRows.filter(row => row.Phone === '').length !== 49) throw new Error('Wrong phone retry count');
if (retryRows.filter(row => row['Address Last Name']).length !== 1) throw new Error('Wrong address retry count');

const languageRows = rows.map(row => {
  const country = row['Address Country Code'];
  const language = languageByCountry[country];
  if (!language) throw new Error(`Unmapped country ${country}`);
  return { ID: row['ID (Ref)'] || '', Email: row.Email, Command: 'UPDATE', Language: language };
});

function saveWorkbook(fileName, headers, data, widths) {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.json_to_sheet(data, { header: headers });
  sheet['!cols'] = widths.map(wch => ({ wch }));
  sheet['!autofilter'] = { ref: sheet['!ref'] };
  XLSX.utils.book_append_sheet(workbook, sheet, 'Customers');
  const target = path.join(outputDir, fileName);
  XLSX.writeFile(workbook, target, { bookType: 'xlsx', compression: true });
  return target;
}

fs.mkdirSync(outputDir, { recursive: true });
const retryPath = saveWorkbook('fyrklovern-file-1-customer-retry.xlsx', retryHeaders, retryRows,
  [21, 42, 12, 23, 25, 20, 21, 35, 23, 16, 19, 19, 25, 70]);
const languagePath = saveWorkbook('fyrklovern-file-1-customer-language-update.xlsx', languageHeaders, languageRows,
  [21, 42, 12, 14]);
console.log(JSON.stringify({ retryPath, languagePath, sourceRows: rows.length,
  failedRows: failed.length, phoneFixes: 49, addressFixes: 1,
  languages: languageRows.reduce((counts, row) => {
    counts[row.Language] = (counts[row.Language] || 0) + 1;
    return counts;
  }, {}) }));
