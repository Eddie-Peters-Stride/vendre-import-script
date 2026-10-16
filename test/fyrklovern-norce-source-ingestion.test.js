const assert = require('assert');
const XLSX = require('xlsx');
const {
    parseCmsCsvText, normalizeCms, buildAudit, readCategoryWorkbook,
} = require('../src/importers/fyrklovern/norce-source-ingestion');

const csvText = '\uFEFFContentId;Culture;ComponentType;ComponentItemId;ComponentPosition;ItemPosition;PropertyName;PropertyType;PropertyValue;ImageAssetId;ImageAltText;ImageURL\r\n' +
    'c52bc2f5-987d-4b8d-ac59-05bd2db24b24;sv-SE;root;root;0;0;text;html;"Intro; text";;;\r\n' +
    'c52bc2f5-987d-4b8d-ac59-05bd2db24b24;sv-SE;headingAndParagraphs;hp-1;2;2;heading;text;First;;;\r\n' +
    'c52bc2f5-987d-4b8d-ac59-05bd2db24b24;sv-SE;headingAndParagraphs;hp-1;2;1;paragraph;text;Paragraph;;;\r\n' +
    'c52bc2f5-987d-4b8d-ac59-05bd2db24b24;sv-SE;headingAndParagraphs;hp-2;1;0;heading;text;Second;;;\r\n' +
    'c52bc2f5-987d-4b8d-ac59-05bd2db24b24;sv-SE;image;img-1;3;0;asset;id;asset-abc;asset-abc;Tallrikar;not-a-url\r\n' +
    'c52bc2f5-987d-4b8d-ac59-05bd2db24b24;sv-SE;image;img-2;4;0;asset;id;asset-no-url;asset-no-url;Alt only;\r\n' +
    ';sv-SE;unknown;orphan;5;0;newField;unknown;keep me;;;;;\r\n';

const parsed = parseCmsCsvText(csvText);
assert.equal(parsed.headers[0], 'ContentId');
assert.equal(parsed.records[0].PropertyValue, 'Intro; text');
assert.equal(parsed.records[0].__sourceRow, 2);

const cms = normalizeCms(parsed.records, parsed.headers);
assert.equal(cms.contents.length, 1);
assert.deepEqual(cms.contents[0].components.map(component => component.componentType), [
    'root', 'headingAndParagraphs', 'headingAndParagraphs', 'image', 'image',
]);
assert.equal(cms.contents[0].components[0].items[0].value, 'Intro; text');
assert.deepEqual(cms.contents[0].components.map(component => component.order), [0, 1, 2, 3, 4]);
assert.deepEqual(cms.contents[0].components[2].items.map(item => item.propertyName), ['paragraph', 'heading']);
assert.deepEqual(cms.contents[0].components[2].items.map(item => item.order), [1, 2]);
assert.equal(cms.missingRelationships[0].reason, 'missing ContentId');
assert.equal(cms.inventory.componentTypes.headingAndParagraphs, 3);
assert.equal(cms.inventory.propertyTypes.html, 1);

const lossAwareCsv = parseCmsCsvText('\uFEFFContentId;Culture;;Cul-ture;Value\n' +
    'id-1;sv-SE;blank-header;short\n' +
    'id-2;sv-SE;blank-header;sv-SE;overflow;extra-cell\n');
assert.equal(lossAwareCsv.diagnostics.headerIssues.length, 2);
assert.deepEqual(lossAwareCsv.diagnostics.rowWidthIssues.map(issue => issue.kind), ['short', 'overflow']);
assert.equal(lossAwareCsv.diagnostics.rowWidthIssues[0].missingColumnCount, 1);
assert.equal(lossAwareCsv.records[0].__shortCellCount, 1);
assert.deepEqual(lossAwareCsv.diagnostics.rowWidthIssues[1].overflowValues, ['extra-cell']);
assert.deepEqual(lossAwareCsv.records[1].__overflow, ['extra-cell']);
const newlineCsv = parseCmsCsvText('ContentId;Culture;Value\n' +
    'id;sv-SE;"line one\nline two; with delimiter"\n');
assert.equal(newlineCsv.records[0].Value, 'line one\nline two; with delimiter');

const localizedHeaders = 'ContentId;ItemName;ComponentName;ComponentItemId;PropertyName;da-DK;de-DE;en-GB;fi-FI;nb-NO;nl-NL;sv-SE';
const localizedId = 'c52bc2f5-987d-4b8d-ac59-05bd2db24b24';
const localizedCsv = parseCmsCsvText('\uFEFF' + localizedHeaders + '\r\n' + [
    `${localizedId};Tallrikar;;;heading;;;;;;;`,
    `${localizedId};Tallrikar;;;text;;;;;;;Hos oss hittar du ett brett sortiment av snygga tallrikar i olika material.`,
    `${localizedId};SEO-Text Tallrika;headingAndParagraphs;hp-1;heading;;;;;;;Stora och små tallrikar`,
    `${localizedId};SEO-Text Tallrika;headingAndParagraphs;hp-1;paragraph1;;;;;;;Första stycket`,
    `${localizedId};SEO-Text Tallrika;headingAndParagraphs;hp-1;paragraph2;;;;;;;Andra stycket`,
    `${localizedId};SEO-Text Tallrika;headingAndParagraphs;hp-2;heading;;;;;;;Högkvalitativa tallrikar`,
    `${localizedId};SEO-Text Tallrika;headingAndParagraphs;hp-2;paragraph1;;;;;;;Tredje stycket`,
    `${localizedId};SEO-Text Tallrika;headingAndParagraphs;hp-2;paragraph2;;;;;;;`,
].join('\r\n') + '\r\n');
assert.equal(localizedCsv.headers.length, 12);
assert.equal(localizedCsv.headers[0], 'ContentId');
assert.equal(localizedCsv.diagnostics.headerIssues.length, 0);
assert.deepEqual(localizedCsv.headers.slice(5), ['da-DK', 'de-DE', 'en-GB', 'fi-FI', 'nb-NO', 'nl-NL', 'sv-SE']);
const localizedCms = normalizeCms(localizedCsv.records, localizedCsv.headers);
const swedishContent = localizedCms.contents.find(item => item.contentId === localizedId && item.culture === 'sv-SE');
assert.equal(swedishContent.sourceRows.length, 8);
assert.equal(swedishContent.components.length, 3);
assert.equal(swedishContent.components[0].componentType, 'root');
assert.equal(swedishContent.components[0].items[1].value, 'Hos oss hittar du ett brett sortiment av snygga tallrikar i olika material.');
assert.equal(swedishContent.components[1].componentType, 'headingAndParagraphs');
assert.equal(swedishContent.components[1].items.length, 3);
assert.ok(swedishContent.components[0].sourceOrder < swedishContent.components[1].sourceOrder);
assert.deepEqual(swedishContent.components[0].items.map(item => item.propertyName), ['heading', 'text']);
const danishContent = localizedCms.contents.find(item => item.contentId === localizedId && item.culture === 'da-DK');
assert.ok(danishContent);
assert.equal(danishContent.components[0].items[1].value, '');
assert.equal(danishContent.components[0].items[1].cultureValues['sv-SE'], 'Hos oss hittar du ett brett sortiment av snygga tallrikar i olika material.');
const localeSelectionAudit = buildAudit({
    categories: [
        { key: '149\u0000da-DK', categoryId: '149', culture: 'da-DK', source: { name: 'Tallerkener' }, permalinks: [] },
        { key: '149\u0000sv-SE', categoryId: '149', culture: 'sv-SE', source: { name: 'Tallrikar', content: '' }, permalinks: [] },
    ],
    cms: localizedCms,
    contentMap: [{ categoryId: '149', culture: 'sv-SE', contentId: localizedId }],
});
assert.equal(localeSelectionAudit.categoryPreview.culture, 'sv-SE');
assert.equal(localeSelectionAudit.categoryPreview.contentId, localizedId);
assert.equal(localeSelectionAudit.categoryPreview.components.length, 3);
assert.equal(localeSelectionAudit.categoryPreview.imageCoverage.componentCount, 0);
assert.match(localeSelectionAudit.categoryPreview.imageCoverage.status, /no image components/);

// Exercise the workbook reader with in-memory fixture rows through a temporary file.
const fs = require('fs');
const os = require('os');
const path = require('path');
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'fyrklovern-source-'));
try {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([
        { CategoryID: 149, Culture: 'sv-SE', name: 'Tallrikar', content: '', pagetitle: 'Tallrikar', metadescription: '' },
        { CategoryID: 200, Culture: 'sv-SE', name: 'Glas', content: '<p>Text</p>', pagetitle: '', metadescription: 'Glas SEO' },
    ]), 'categorieslocalized');
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([
        { CategoryID: 149, Culture: 'sv-SE', Link: '/dukning-servering/tallrikar' },
    ]), 'categorypermalinks');
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([
        { 'Last CategoryID': 149, Culture: 'sv-SE', 'Hierarchy - CategoryID': '1>149', 'Hierarchy - Breadcrumbs': 'Dukning>Tallrikar' },
    ]), 'category structure');
    const workbookPath = path.join(temporaryDirectory, 'categories.xlsx');
    XLSX.writeFile(workbook, workbookPath);
    const categoryData = readCategoryWorkbook(workbookPath);
    const categories = categoryData.categories;
    assert.equal(categories[0].permalinks[0].Link, '/dukning-servering/tallrikar');
    assert.equal(categories[0].structures[0]['Last CategoryID'], 149);

    const audit = buildAudit({
        categories,
        categoryDiagnostics: categoryData.diagnostics,
        cms,
        contentMap: [{ categoryId: 149, culture: 'sv-SE', contentId: 'c52bc2f5-987d-4b8d-ac59-05bd2db24b24', source: 'confirmed StoreAPI relationship' }],
    });
    assert.equal(audit.categoryPreview.contentId, 'c52bc2f5-987d-4b8d-ac59-05bd2db24b24');
    assert.equal(audit.categoryPreview.cmsFound, true);
    assert.equal(audit.categoryPreview.candidates.some(candidate => candidate.target === 'Body HTML'), false);
    assert.equal(audit.categoryPreview.candidates.filter(candidate => candidate.source === 'CMS headingAndParagraphs').length, 2);
    assert.equal(audit.categoryPreview.imageAudit.some(field => field.field === 'ImageAssetId' && field.unresolved), true);
    assert.equal(audit.missingContentIds.some(item => item.categoryId === '200'), true);
    assert.equal(audit.previews.find(item => item.categoryId === '200').candidates.some(candidate => candidate.target === 'Body HTML'), true);

    // Duplicate category rows are deduped when identical and excluded when conflicting.
    const duplicateWorkbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(duplicateWorkbook, XLSX.utils.json_to_sheet([
        { CategoryID: 149, Culture: 'sv-SE', name: 'Tallrikar', content: '', pagetitle: 'Tallrikar' },
        { CategoryID: 149, Culture: 'sv-SE', name: 'Tallrikar', content: '', pagetitle: 'Tallrikar' },
        { CategoryID: 200, Culture: 'sv-SE', name: 'Glas', content: '' },
        { CategoryID: 200, Culture: 'sv-SE', name: 'Glas conflict', content: '' },
    { CategoryID: 201, Culture: 'sv-SE', name: 'Skålar', content: '' },
    ]), 'categorieslocalized');
    XLSX.utils.book_append_sheet(duplicateWorkbook, XLSX.utils.json_to_sheet([
        { CategoryID: 149, Culture: 'sv-SE', Link: '/first' },
        { CategoryID: 149, Culture: 'sv-SE', Link: '/second' },
    ]), 'categorypermalinks');
    XLSX.utils.book_append_sheet(duplicateWorkbook, XLSX.utils.json_to_sheet([
        { 'Last CategoryID': 149, Culture: 'sv-SE', 'Hierarchy - CategoryID': '1>149', 'Hierarchy - Breadcrumbs': 'Dukning>Tallrikar' },
        { 'Last CategoryID': 149, Culture: 'sv-SE', 'Hierarchy - CategoryID': '1>149', 'Hierarchy - Breadcrumbs': 'Dukning>Tallrikar' },
        { 'Last CategoryID': 201, Culture: 'sv-SE', 'Hierarchy - CategoryID': '1>201', 'Hierarchy - Breadcrumbs': 'Dukning>Skålar' },
        { 'Last CategoryID': 201, Culture: 'sv-SE', 'Hierarchy - CategoryID': '1>201', 'Hierarchy - Breadcrumbs': 'Dukning>Servering' },
    ]), 'category structure');
    const duplicatePath = path.join(temporaryDirectory, 'duplicates.xlsx');
    XLSX.writeFile(duplicateWorkbook, duplicatePath);
    const duplicateData = readCategoryWorkbook(duplicatePath);
    assert.equal(duplicateData.categories.length, 2);
    assert.equal(duplicateData.categories[0].categoryId, '149');
    assert.equal(duplicateData.diagnostics.categoryDuplicates[0].removedCount, 1);
    assert.equal(duplicateData.diagnostics.categoryConflicts.length, 1);
    assert.equal(duplicateData.categories[0].permalinks.length, 0);
    assert.equal(duplicateData.categories[0].structures.length, 1);
    assert.equal(duplicateData.diagnostics.permalinkConflicts.length, 1);
    assert.equal(duplicateData.diagnostics.structureDuplicates[0].removedCount, 1);
    assert.equal(duplicateData.diagnostics.structureConflicts.length, 1);
    assert.equal(duplicateData.categories.find(category => category.categoryId === '201').structures.length, 0);

    const conflictAudit = buildAudit({
        categories,
        cms,
        contentMap: [
            { categoryId: 149, culture: 'sv-SE', contentId: 'content-a' },
            { categoryId: 149, culture: 'sv-SE', contentId: 'content-b' },
            { categoryId: 200, culture: 'sv-SE', contentId: 'same' },
            { categoryId: 200, culture: 'sv-SE', contentId: 'same' },
        ],
    });
    assert.equal(conflictAudit.contentMapConflicts.length, 1);
    assert.equal(conflictAudit.contentMapDuplicates.length, 1);
    assert.equal(conflictAudit.categoryPreview.contentId, null);

    const bodyPriority = buildAudit({
        categories: [{ key: 'x', categoryId: '1', culture: 'sv-SE', permalinks: [], source: { content: '', text: '<p>fallback must not win</p>' } }],
        cms,
        contentMap: [],
    });
    assert.equal(bodyPriority.previews[0].candidates.some(candidate => candidate.target === 'Body HTML'), false);
    assert.equal(bodyPriority.previews[0].bodyFieldDiagnostics.length, 1);

    const imageAudit = auditForImageFields(cms);
    assert.equal(imageAudit.find(field => field.field === 'ImageAltText').kind, 'altText');
    assert.equal(imageAudit.find(field => field.field === 'ImageAssetId' && field.value === 'asset-abc').reason, 'invalid source image URL');
    assert.equal(imageAudit.find(field => field.field === 'ImageAssetId' && field.value === 'asset-no-url').reason, 'source image URL is absent from this CMS item');
    assert.equal(imageAudit.find(field => field.field === 'ImageURL').reason, 'invalid image URL');
} finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}

function auditForImageFields(contentData) {
    return require('../src/importers/fyrklovern/norce-source-ingestion').auditImageFields(contentData.contents[0]);
}

console.log('Fyrklövern Norce source ingestion tests passed');
