const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const XLSX = require('xlsx');
const { NorceStoreApiClient, CATEGORY_QUERY, storeApiConfigFromEnv } = require('../src/api/norce-storeapi-client');
const { buildMappingReview, normalizePath, readSuppliedContentMap, writeMappingWorkbook } = require('../src/importers/fyrklovern/build-mapping-review');
const { main: fetchNorceCategories, discoverCategoryPairs, discoverCategories, applyFetchExitStatus } = require('../src/importers/fyrklovern/fetch-norce-categories');

async function testClient() {
    for (const field of ['items', 'name type', 'properties', 'valueType', 'StringValue', 'BoolValue', 'children']) {
        assert(CATEGORY_QUERY.includes(field), `StoreAPI query requests ${field}`);
    }
    let calls = 0;
    const missing = new NorceStoreApiClient({ config: { token: '' }, transport: async () => { calls++; } });
    await assert.rejects(() => missing.fetchCategory(149), /token is missing/);
    assert.equal(calls, 0, 'missing token must fail before transport');
    const insecure = new NorceStoreApiClient({ config: { token: 'secret', endpoint: 'http://example.test' }, transport: async () => { calls++; } });
    await assert.rejects(() => insecure.fetchCategory(149), /must use HTTPS/);
    assert.equal(calls, 0, 'HTTP endpoint must fail before transport');
    let request;
    const client = new NorceStoreApiClient({
        config: { token: 'secret', shopId: 'fyrklovern', culture: 'sv-SE', country: 'SE', currency: 'SEK' },
        transport: async (...args) => { request = args; return { ok: true, json: async () => ({ data: { category: { id: '149', data: { id: 'norce-content-149', name: 'CMS' } } } }) }; },
    });
    assert.deepEqual(await client.fetchCategory(149), { id: '149', data: { id: 'norce-content-149', name: 'CMS' }, CategoryID: '149', ContentId: 'norce-content-149', contentIds: ['norce-content-149'] });
    assert.equal(request[0], 'https://storeapi.jetshop.io/');
    assert.equal(request[1].method, 'POST');
    assert.deepEqual(request[1].headers, {
        'Content-Type': 'application/json', Shopid: 'fyrklovern', Token: 'secret',
        Culture: 'sv-SE', Country: 'SE', Currency: 'SEK',
    });
    const body = JSON.parse(request[1].body);
    assert.equal(body.query, CATEGORY_QUERY);
    assert.deepEqual(body.variables, { id: '149' });
    const graphqlFailure = new NorceStoreApiClient({ config: { token: 'secret', retries: 0 },
        transport: async () => ({ ok: true, json: async () => ({ errors: [{ message: "Culture 'da-DK' is not supported in channel." }] }) }) });
    await assert.rejects(() => graphqlFailure.fetchCategory(1, { culture: 'da-DK' }), /Culture 'da-DK' is not supported in channel/);
    assert.equal(storeApiConfigFromEnv({}).token, '');
    assert.deepEqual(storeApiConfigFromEnv({ NORCE_STOREAPI_URL: 'https://example.test', NORCE_STOREAPI_SHOPID: 'shop', NORCE_STOREAPI_TOKEN: 'secret', NORCE_DEFAULT_CULTURE: 'en-GB' }), {
        endpoint: 'https://example.test', shopId: 'shop', token: 'secret', culture: 'en-GB',
        country: 'SE', currency: 'SEK', timeoutMs: 15000, retries: 2, throttleMs: 250,
    });
    let retryCount = 0;
    const retrying = new NorceStoreApiClient({
        config: { token: 'secret', retries: 1, throttleMs: 0 },
        transport: async () => {
            retryCount++;
            if (retryCount === 1) return { ok: false, status: 503 };
            return { ok: true, json: async () => ({ data: { category: { id: 149, data: { id: 'cms149', name: 'CMS' } } } }) };
        },
    });
    assert.equal((await retrying.fetchCategory(149)).ContentId, 'cms149');
    assert.equal(retryCount, 2, 'transient server failure retries once');
}

async function testNpmArgumentFallback() {
    let calls = 0;
    await assert.rejects(() => fetchNorceCategories([], {
        env: { npm_config_ids: '149,150', NORCE_STOREAPI_TOKEN: '' },
        transport: async () => { calls += 1; },
    }), /token is missing/);
    assert.equal(calls, 0, 'npm-provided IDs are accepted, but missing token still prevents transport');
}
function testFetchExitStatus() {
    const fakeProcess = { exitCode: 0 };
    assert.equal(applyFetchExitStatus([{ status: 'error' }], fakeProcess), true);
    assert.equal(fakeProcess.exitCode, 1, 'partial errors set nonzero CLI status after cache write');
    const successProcess = { exitCode: 0 };
    assert.equal(applyFetchExitStatus([{ status: 'fetched' }], successProcess), false);
    assert.equal(successProcess.exitCode, 0);
}

async function testCategoryDiscoveryFetch() {
    let calls = 0;
    await assert.rejects(() => fetchNorceCategories([], {
        env: {}, transport: async () => { calls += 1; },
    }), /token is missing/);
    assert.equal(calls, 0, 'missing token fails before any StoreAPI transport');

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'norce-fetch-test-'));
    try {
        const categoriesPath = path.join(tempDir, 'categories.xlsx');
        const source = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(source, XLSX.utils.aoa_to_sheet([
            ['CategoryID', 'Culture', 'name'], ['1', 'sv-SE', 'One'], ['1', 'sv-SE', 'One'], ['2', 'sv-SE', 'Two'], ['2', 'en-GB', 'Two'], ['3', 'sv-SE', 'Conflict A'], ['3', 'sv-SE', 'Conflict B'],
        ]), 'categorieslocalized');
        XLSX.utils.book_append_sheet(source, XLSX.utils.aoa_to_sheet([['CategoryID','Culture','Link']]), 'categorypermalinks');
        XLSX.utils.book_append_sheet(source, XLSX.utils.aoa_to_sheet([['Last CategoryID','Culture']]), 'category structure');
        XLSX.writeFile(source, categoriesPath);
        assert.deepEqual(discoverCategoryPairs(categoriesPath, 'sv-SE'), [
            { categoryId: '1', culture: 'sv-SE' }, { categoryId: '2', culture: 'sv-SE' },
        ]);
        assert.deepEqual(discoverCategories(categoriesPath, 'sv-SE').excludedConflictIds, ['3']);
        const cmsPath = path.join(tempDir, 'cms.csv');
        fs.writeFileSync(cmsPath, 'ContentId;ItemName;ComponentName;ComponentItemId;PropertyName;sv-SE\ncms-one;One;;;text;found\n', 'utf8');
        const outputPath = path.join(tempDir, 'mapping.json');
        const env = { NORCE_STOREAPI_TOKEN: 'mock-secret', NORCE_STOREAPI_RETRIES: '0', NORCE_STOREAPI_THROTTLE_MS: '0' };
        const records = await fetchNorceCategories([
            `--categories=${categoriesPath}`, `--cms=${cmsPath}`, `--output=${outputPath}`,
        ], { env, transport: async (_url, request) => {
            calls += 1;
            const id = JSON.parse(request.body).variables.id;
            if (id === '1') return { ok: false, status: 404 };
            return {
                ok: true,
                json: async () => ({ data: { category: { id: '2', data: { id: 'cms-one', name: 'Content' } } } }),
            };
        } });
        assert.equal(records.length, 2);
        assert.equal(records[0].status, 'error', 'failure is retained for the first ID');
        assert.equal(records[1].cmsFound, true, 'later ID still succeeds after prior failure');
        const resultFile = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
        assert.equal(resultFile.culture, 'sv-SE');
        assert.equal(resultFile.fileFormat, 'fyrklovern-storeapi-category-content-map/v1');
        assert.deepEqual(readSuppliedContentMap(outputPath), [{ categoryId: '2', culture: 'sv-SE', contentId: 'cms-one', source: 'explicit StoreAPI fetch output' }]);

        const mismatchPath = path.join(tempDir, 'mismatch.json');
        const mismatch = await fetchNorceCategories([
            '--ids=99', `--output=${mismatchPath}`,
        ], { env, transport: async () => ({ ok: true, json: async () => ({ data: { category: { id: '98', data: { id: 'wrong-cms-id' } } } }) }) });
        assert.equal(mismatch[0].status, 'error');
        assert.match(mismatch[0].error, /returned CategoryID 98 for requested CategoryID 99/);
        const mismatchOutput = JSON.parse(fs.readFileSync(mismatchPath, 'utf8'));
        assert.equal(mismatchOutput.mappings.length, 1);
        assert.equal(mismatchOutput.mappings[0].contentId, null, 'mismatched API category must not produce a ContentId');

        const previousCwd = process.cwd();
        process.chdir(tempDir);
        try {
            const mockTransport = async (_url, request) => {
                const id = JSON.parse(request.body).variables.id;
                return { ok: true, json: async () => ({ data: { category: { id, data: { id: `cms-${id}` } } } }) };
            };
            await fetchNorceCategories([`--categories=${categoriesPath}`, '--cms=none'], { env, transport: mockTransport });
            const cachePath = path.join(tempDir, 'outputs', 'Fyrklovern', 'Reports and source maps', 'StoreAPI category ContentId map.json');
            assert(fs.existsSync(cachePath));
            await fetchNorceCategories([`--categories=${categoriesPath}`, '--cms=none'], { env, transport: mockTransport });
            assert.equal(JSON.parse(fs.readFileSync(cachePath, 'utf8')).records.length, 2, 'known generated cache is safely rerunnable');
            let callsBeforeCultureMismatch = calls;
            await assert.rejects(() => fetchNorceCategories([`--categories=${categoriesPath}`, '--cms=none', '--culture=de-DE'], { env, transport: mockTransport }), /Refusing to overwrite/);
            assert.equal(calls, callsBeforeCultureMismatch, 'a different culture cannot overwrite the existing default cache');

            let sentCulture = '';
            const culturePath = path.join(tempDir, 'culture.json');
            await fetchNorceCategories(['--ids=1', '--culture=de-DE', '--cms=none', `--output=${culturePath}`], {
                env, transport: async (_url, request) => {
                    sentCulture = request.headers.Culture;
                    return { ok: true, json: async () => ({ data: { category: { id: '1', data: { id: 'cms-de' } } } }) };
                },
            });
            assert.equal(sentCulture, 'de-DE');
            const cultureOutput = JSON.parse(fs.readFileSync(culturePath, 'utf8'));
            assert.equal(cultureOutput.culture, 'de-DE');
            assert.equal(cultureOutput.records[0].cmsFound, null, 'CMS presence remains unknown when no CSV is supplied');
        } finally { process.chdir(previousCwd); }
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

function testMapping() {
    assert.equal(normalizePath('/Dukning-servering/tallrikar/?x=1'), 'dukning-servering-tallrikar');
    const data = {
        categories: [
            { key: '149\0sv-SE', categoryId: '149', culture: 'sv-SE', source: { name: 'Tallrikar' }, permalinks: [{ Link: '/dukning-servering/tallrikar/' }] },
            { key: '149\0en-GB', categoryId: '149', culture: 'en-GB', source: { name: 'Plates' }, permalinks: [{ Link: '' }] },
            { key: '150\0sv-SE', categoryId: '150', culture: 'sv-SE', source: { name: 'Tallrikar' }, permalinks: [{ Link: '' }] },
        ],
        diagnostics: { categoryConflicts: [], permalinkConflicts: [] },
    };
    const report = buildMappingReview({ categoryData: data, contentMap: [{ categoryId: '149', culture: 'sv-SE', contentId: 'cms149' }], cmsContentIds: new Set(['cms149']), collections: [
        { ID: '728776376660', Handle: 'dukning-servering-tallrikar', Title: 'Tallrikar' },
    ] });
    assert.deepEqual(report.explicitCandidate, report.mappings[0]);
    assert.equal(report.explicitCandidate.Status, 'URL candidate - manual approval required');
    assert.equal(report.explicitCandidate.ManualApproval, 'Pending');
    assert.equal(report.explicitCandidate.ContentId, 'cms149');
    assert.equal(report.explicitCandidate.ContentFound, 'Found');
    assert.equal(report.explicitCandidate.StoreAPIStatus, 'not fetched in this review run');
    assert.equal(report.mappings[1].ShopifyID, '', 'no cross-culture handle carryover');
    assert.equal(report.mappings[2].Status, 'title-only suggestion - unverified');
    assert.equal(report.mappings[2].ShopifyID, '');
    const approved = buildMappingReview({ categoryData: data, approvedMap: [{ categoryId: '149', culture: 'sv-SE', shopifyId: '728776376660' }], collections: [
        { ID: '728776376660', Handle: 'dukning-servering-tallrikar', Title: 'Tallrikar' },
        { ID: '728776376660', Handle: 'dukning-servering-tallrikar', Title: 'Tallrikar duplicate' },
        { ID: '', Handle: '', Title: 'Broken collection' },
    ] });
    assert.equal(approved.mappings[0].Status, 'invalid approved mapping - Shopify identity issue', 'approved map with duplicate Shopify identity is rejected');
    assert.equal(approved.mappings[0].ShopifyIdentityIssue, 'duplicate Shopify ID; duplicate Shopify handle');
    assert.equal(approved.shopifyIdentityDiagnostics.missingIds.length, 1);
    assert.equal(approved.shopifyIdentityDiagnostics.missingHandles.length, 1);
    assert.equal(approved.shopifyIdentityDiagnostics.duplicateIds.length, 1);
    assert.equal(approved.shopifyIdentityDiagnostics.duplicateHandles.length, 1);
    assert.equal(approved.approvedMapDuplicateCount, 0);
    const conflictedApproval = buildMappingReview({ categoryData: data, approvedMap: [
        { categoryId: '149', culture: 'sv-SE', shopifyId: '728776376660' },
        { categoryId: '149', culture: 'sv-SE', shopifyId: 'other-id' },
    ], collections: [{ ID: '728776376660', Handle: 'dukning-servering-tallrikar', Title: 'Tallrikar' }] });
    assert.equal(conflictedApproval.mappings[0].Status, 'ambiguous - conflicting approved map');
    assert.equal(conflictedApproval.approvedMapConflicts.length, 1);
    const dedupedApproval = buildMappingReview({ categoryData: data, approvedMap: [
        { categoryId: '149', culture: 'sv-SE', shopifyId: '728776376660' },
        { categoryId: '149', culture: 'sv-SE', shopifyId: '728776376660' },
    ], collections: [{ ID: '728776376660', Handle: 'dukning-servering-tallrikar', Title: 'Tallrikar' }] });
    assert.equal(dedupedApproval.approvedMapDuplicateCount, 1);
    assert.equal(dedupedApproval.mappings[0].Status, 'approved mapping');
    const invalidTarget = buildMappingReview({ categoryData: data, collections: [
        { ID: '', Handle: 'dukning-servering-tallrikar', Title: 'Tallrikar' },
    ] });
    assert.equal(invalidTarget.mappings[0].Status, 'ambiguous - invalid or duplicate Shopify identity');
    assert.equal(invalidTarget.mappings[0].Candidate, false);
    const conflict = buildMappingReview({ categoryData: data, contentMap: [
        { categoryId: '149', culture: 'sv-SE', contentId: 'cms-a' },
        { categoryId: '149', culture: 'sv-SE', contentId: 'cms-b' },
    ], collections: [{ ID: '728776376660', Handle: 'dukning-servering-tallrikar', Title: 'Tallrikar' }] });
    assert.equal(conflict.mappings[0].ContentId, '');
    assert.equal(conflict.mappings[0].ContentRelationshipStatus, 'ambiguous supplied mapping');
    assert.equal(conflict.contentMapConflicts.length, 1);
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mapping-review-test-'));
    const workbookPath = path.join(tempDir, 'review.xlsx');
    writeMappingWorkbook(report, workbookPath);
    const workbook = XLSX.readFile(workbookPath);
    assert.deepEqual(workbook.SheetNames, ['Mapping Review', 'Diagnostics']);
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets['Mapping Review'], { header: 1, defval: '' });
    assert.equal(rows.length, report.mappings.length + 4);
    assert(rows[3].includes('ContentId'));
    const auditPath = path.join(tempDir, 'audit.json');
    fs.writeFileSync(auditPath, JSON.stringify({ categoryPreview: { categoryId: '149', culture: 'sv-SE', contentId: 'cms149', contentIdSource: 'explicit' } }));
    assert.deepEqual(readSuppliedContentMap(auditPath), [{ categoryId: '149', culture: 'sv-SE', contentId: 'cms149', source: 'explicit' }]);
    fs.writeFileSync(auditPath, JSON.stringify({ culture: 'sv-SE', results: [{ requestedId: '149', category: { CategoryID: '149', ContentId: 'cms149' } }] }));
    assert.deepEqual(readSuppliedContentMap(auditPath), [{ categoryId: '149', culture: 'sv-SE', contentId: 'cms149', source: 'explicit StoreAPI fetch output' }]);
    fs.rmSync(tempDir, { recursive: true, force: true });
}

(async () => { await testClient(); await testNpmArgumentFallback(); testFetchExitStatus(); await testCategoryDiscoveryFetch(); testMapping(); console.log('Fyrklövern StoreAPI/mapping review tests passed'); })().catch(error => { console.error(error); process.exit(1); });
