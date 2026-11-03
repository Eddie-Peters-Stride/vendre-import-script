/** Normalize and reconcile Norce StoreAPI publication snapshots. */
const { clean } = require('./norce-source-ingestion');

function key(categoryId, culture) { return `${clean(categoryId)}\0${clean(culture)}`; }
function componentIdentity(component) { return clean(component.itemName || component.name || component.componentName).replace(/\s+/g, ' ').toLocaleLowerCase(); }

function scalarValue(property) {
    const value = property?.value;
    if (value == null) return null;
    if (typeof value !== 'object') return value;
    if (Object.hasOwn(value, 'value')) return value.value;
    return null;
}

function normalizeStoreApiComponents(category) {
    const flattened = [];
    function visit(nodes, parentPath = [], parentName = '') {
        for (const [index, node] of (nodes || []).entries()) {
            const sourceOrder = flattened.length;
            const component = {
                itemName: clean(node.name), componentName: clean(node.name),
                componentType: clean(node.type), componentId: clean(node.id),
                order: sourceOrder + 1, sourceOrder, hierarchyPath: [...parentPath, index + 1],
                parentName, tags: Array.isArray(node.tags) ? node.tags.slice() : [],
                items: (node.properties || []).map((property, propertyIndex) => ({
                    propertyName: clean(property.name), propertyType: clean(property.type),
                    valueType: clean(property.valueType), value: scalarValue(property),
                    rawValue: property.value ?? null, order: propertyIndex + 1,
                    sourceRow: `${sourceOrder + 1}.${propertyIndex + 1}`,
                })),
            };
            flattened.push(component);
            visit(node.children, component.hierarchyPath, component.itemName);
        }
    }
    visit(category?.data?.items);
    return flattened;
}

function categoryLookup(snapshot) {
    const result = new Map();
    for (const record of snapshot?.records || []) {
        const k = key(record.categoryId, record.culture);
        if (result.has(k)) {
            const previous = result.get(k);
            result.set(k, { categoryId: record.categoryId, culture: record.culture,
                status: 'duplicate snapshot records', retrievedAt: '',
                duplicateCount: (previous.duplicateCount || 1) + 1 });
        } else result.set(k, record);
    }
    return result;
}

function loadComponentExceptions(input) {
    if (!input) return [];
    const raw = typeof input === 'string' ? require('fs').readFileSync(input, 'utf8') : input;
    const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const rows = Array.isArray(data) ? data : data.exceptions || [];
    return rows.map(row => ({
        categoryId: clean(row.categoryId ?? row.CategoryID),
        culture: clean(row.culture ?? row.Culture),
        contentId: clean(row.contentId ?? row.ContentId),
        componentName: clean(row.componentName ?? row.ComponentName),
        approved: row.approved === true || row.Approved === true || /^(approved|yes|true)$/i.test(clean(row.approvalStatus ?? row.ApprovalStatus)),
        reason: clean(row.reason ?? row.Reason),
        approvedBy: clean(row.approvedBy ?? row.ApprovedBy),
    })).filter(row => row.categoryId && row.culture && row.contentId && row.componentName);
}

function reconcileCsvComponents({ categoryId, culture, contentId, apiComponents, cmsContent, exceptions = [] }) {
    if (!cmsContent) return { missingFromApi: [], approvedExceptions: [], unmatchedApprovals: [] };
    const present = new Set(apiComponents.map(componentIdentity));
    const missingFromApi = [];
    const approvedExceptions = [];
    for (const component of cmsContent.components || []) {
        if (present.has(componentIdentity(component))) continue;
        const report = {
            categoryId, culture, contentId,
            componentName: clean(component.itemName), componentType: clean(component.componentType),
            componentId: clean(component.componentId), status: 'not_returned_by_storeapi',
        };
        const approval = exceptions.find(row => row.approved && row.categoryId === String(categoryId) &&
            row.culture === culture && row.contentId === contentId &&
            componentIdentity({ itemName: row.componentName }) === componentIdentity(component));
        if (approval) {
            report.exceptionStatus = 'approved_csv_exception';
            report.approvalReason = approval.reason;
            report.approvedBy = approval.approvedBy;
            approvedExceptions.push({ ...component, hierarchyPath: [], parentName: '',
                exceptionApproval: { reason: approval.reason, approvedBy: approval.approvedBy } });
        }
        missingFromApi.push(report);
    }
    const unmatchedApprovals = exceptions.filter(row => row.approved && row.categoryId === String(categoryId) &&
        row.culture === culture && row.contentId === contentId).flatMap(row => {
        const identity = componentIdentity({ itemName: row.componentName });
        if (!(cmsContent.components || []).some(component => componentIdentity(component) === identity)) {
            return [{ ...row, status: 'approved_exception_not_found_in_csv' }];
        }
        if (present.has(identity)) return [{ ...row, status: 'exception_no_longer_needed_storeapi_returned' }];
        return [];
    });
    return { missingFromApi, approvedExceptions, unmatchedApprovals };
}

module.exports = {
    key, componentIdentity, scalarValue, normalizeStoreApiComponents,
    categoryLookup, loadComponentExceptions, reconcileCsvComponents,
};
