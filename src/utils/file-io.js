/**
 * Safe file I/O utilities with error handling
 */

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

/**
 * Safely read and parse JSON file
 * @param {string} filePath - Path to JSON file
 * @returns {Object|Array} Parsed JSON data
 * @throws {Error} If file doesn't exist or JSON is invalid
 */
function safeReadJson(filePath) {
    if (!fs.existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`);
    }

    try {
        const content = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(content);
    } catch (error) {
        throw new Error(`Failed to parse JSON from ${filePath}: ${error.message}`);
    }
}

/**
 * Safely write JSON file with formatting
 * @param {string} filePath - Path to write JSON file
 * @param {Object|Array} data - Data to write
 * @param {boolean} pretty - Whether to format JSON (default: true)
 */
function safeWriteJson(filePath, data, pretty = true) {
    try {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        const content = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
        fs.writeFileSync(filePath, content, 'utf8');
    } catch (error) {
        throw new Error(`Failed to write JSON to ${filePath}: ${error.message}`);
    }
}

/**
 * Normalize Vendre API response to always return an array
 * Handles both { list: [...] } and direct array responses
 * @param {Object|Array} data - Vendre API response
 * @returns {Array} Normalized array
 */
function normalizeVendreResponse(data) {
    if (Array.isArray(data)) return data;
    if (Array.isArray(data.list)) return data.list;
    return [];
}

/**
 * Load Vendre data from JSON file and normalize to array
 * @param {string} filePath - Path to JSON file
 * @returns {Array} Normalized array of entities
 */
function loadVendreData(filePath) {
    const data = safeReadJson(filePath);
    return normalizeVendreResponse(data);
}

/**
 * Write Excel file from array of row objects
 * @param {Array} rows - Array of row objects
 * @param {string} outputPath - Path to write Excel file
 * @param {string} sheetName - Name of the worksheet (default: 'Sheet1')
 */
function writeExcelFile(rows, outputPath, sheetName = 'Sheet1') {
    try {
        const dir = path.dirname(outputPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        const worksheet = XLSX.utils.json_to_sheet(rows);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
        XLSX.writeFile(workbook, outputPath);
    } catch (error) {
        throw new Error(`Failed to write Excel file to ${outputPath}: ${error.message}`);
    }
}

/**
 * Ensure directory exists, create if not
 * @param {string} dirPath - Directory path
 */
function ensureDirectory(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

/**
 * Check if file exists
 * @param {string} filePath - File path
 * @returns {boolean} True if file exists
 */
function fileExists(filePath) {
    return fs.existsSync(filePath);
}

module.exports = {
    safeReadJson,
    safeWriteJson,
    normalizeVendreResponse,
    loadVendreData,
    writeExcelFile,
    ensureDirectory,
    fileExists,
};
