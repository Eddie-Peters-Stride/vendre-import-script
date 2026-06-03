// updateMetafieldsForMatrixify.js
// Reads a Matrixify products CSV, updates publishers and mechanics metafields to single-line list, outputs XLSX for import

const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const ExcelJS = require('exceljs');

const INPUT_CSV = path.join(__dirname, '../results/matrixify-collections.csv');
const OUTPUT_XLSX = path.join(__dirname, '../results/matrixify-collections-updated.xlsx');

// Update these to match your metafield column names
const PUBLISHERS_FIELD = 'Metafield: custom.publishers [string]';
const MECHANICS_FIELD = 'Metafield: custom.mechanics [string]';

function toSingleLineList(value) {
    if (!value) return '';
    // Split only by semicolons, trim, remove empties, join with comma
    return value
        .split(/;/)
        .map(v => v.trim())
        .filter(Boolean)
        .join(', ');
}

async function processFile() {
    const rows = [];
    fs.createReadStream(INPUT_CSV)
        .pipe(csv())
        .on('data', (row) => {
            // Update metafields
            if (row[PUBLISHERS_FIELD]) {
                row[PUBLISHERS_FIELD] = toSingleLineList(row[PUBLISHERS_FIELD]);
            }
            if (row[MECHANICS_FIELD]) {
                row[MECHANICS_FIELD] = toSingleLineList(row[MECHANICS_FIELD]);
            }
            rows.push(row);
        })
        .on('end', async () => {
            // Write to XLSX
            const workbook = new ExcelJS.Workbook();
            const worksheet = workbook.addWorksheet('Products');
            if (rows.length === 0) {
                console.error('No data found in CSV.');
                return;
            }
            // Only include Handle, publishers metafield, and Command columns
            const outputColumns = [
                'Handle',
                PUBLISHERS_FIELD,
                'Command'
            ];
            worksheet.columns = outputColumns.map(key => ({ header: key, key }));
            rows.forEach(row => {
                const filteredRow = {};
                outputColumns.forEach(col => {
                    filteredRow[col] = row[col] || '';
                });
                worksheet.addRow(filteredRow);
            });
            await workbook.xlsx.writeFile(OUTPUT_XLSX);
            console.log('Updated XLSX written to', OUTPUT_XLSX);
        });
}

processFile();
