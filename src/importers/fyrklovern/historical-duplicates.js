const { ORDER_HEADERS, CUSTOMER_HEADERS } = require('./historical-matrixify');

const value = input => String(input ?? '').trim();

function duplicateValues(records, keyOf) {
  const groups = new Map();
  for (const record of records) {
    const key = keyOf(record);
    if (!key) continue;
    groups.set(key, (groups.get(key) || 0) + 1);
  }
  return new Set([...groups].filter(([, count]) => count > 1).map(([key]) => key));
}

function reviewDuplicates(orderRecords, customerRecords) {
  const duplicateNumbers = duplicateValues(customerRecords, row => value(row.number));
  const customerReasons = new Map();
  const orderReasons = new Map();
  const customerGroups = new Map();
  const orderGroups = new Map();
  const idsFor = (keys, prefix) => new Map([...keys].sort().map((key, index) => [key, `${prefix}${String(index + 1).padStart(4, '0')}`]));
  const numberGroups = idsFor(duplicateNumbers, 'N');
  const addReason = (map, key, reason) => {
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(reason);
  };

  for (let index = 0; index < customerRecords.length; index++) {
    const row = customerRecords[index];
    if (!value(row.number)) { addReason(customerReasons, index, 'missing source customer number'); addReason(customerGroups, index, `M${index + 2}`); }
    if (duplicateNumbers.has(value(row.number))) { addReason(customerReasons, index, 'shared source customer number'); addReason(customerGroups, index, numberGroups.get(value(row.number))); }
  }

  const orderRowsByNumber = new Map();
  const orderNumbersByCustomer = new Map();
  for (let index = 0; index < orderRecords.length; index++) {
    const row = orderRecords[index];
    const number = value(row.orderNo), customerNumber = value(row.sellToCustomerNo);
    if (!orderRowsByNumber.has(number)) orderRowsByNumber.set(number, []);
    orderRowsByNumber.get(number).push(index);
    if (!orderNumbersByCustomer.has(customerNumber)) orderNumbersByCustomer.set(customerNumber, new Set());
    orderNumbersByCustomer.get(customerNumber).add(number);
  }

  const repeatedLineCounts = new Map();
  for (const [number, indexes] of orderRowsByNumber) {
    const lines = new Map();
    for (const index of indexes) {
      const signature = JSON.stringify(ORDER_HEADERS.map(header => value(orderRecords[index][header])));
      lines.set(signature, (lines.get(signature) || 0) + 1);
    }
    const repeated = [...lines.values()].filter(count => count > 1);
    if (repeated.length) {
      addReason(orderReasons, number, 'identical order rows');
      addReason(orderGroups, number, `O${number}`);
      repeatedLineCounts.set(number, repeated);
    }
  }

  // A duplicate source number makes every order for that identifier ambiguous.
  for (let index = 0; index < customerRecords.length; index++) {
    if (!customerReasons.has(index)) continue;
    for (const number of orderNumbersByCustomer.get(value(customerRecords[index].number)) || []) {
      addReason(orderReasons, number, 'customer identity review');
      for (const group of customerGroups.get(index) || []) addReason(orderGroups, number, group);
    }
  }
  const customers = [...customerReasons.keys()].sort((a, b) => a - b).map(index => ({
    'Source Row': index + 2,
    'Review Groups': [...(customerGroups.get(index) || [])].sort().join('; '),
    'Review Reasons': [...customerReasons.get(index)].sort().join('; '),
    ...Object.fromEntries(CUSTOMER_HEADERS.map(header => [header, value(customerRecords[index][header])])),
  })).sort((a, b) => a['Review Groups'].localeCompare(b['Review Groups']) || a.number.localeCompare(b.number) || a['Source Row'] - b['Source Row']);
  const orders = [...orderReasons.keys()].flatMap(number => orderRowsByNumber.get(number).map(index => ({
    'Source Row': index + 1,
    'Review Groups': [...(orderGroups.get(number) || [])].sort().join('; '),
    'Review Reasons': [...orderReasons.get(number)].sort().join('; '),
    ...Object.fromEntries(ORDER_HEADERS.map(header => [header, value(orderRecords[index][header])])),
  }))).sort((a, b) => a['Review Groups'].localeCompare(b['Review Groups']) || a.orderNo.localeCompare(b.orderNo, undefined, { numeric: true }) || a['Source Row'] - b['Source Row']);
  const decisions = [
    ...customers.map(row => ({ Entity: 'Customer', 'Source ID': row.number, 'Review Groups': row['Review Groups'], Reasons: row['Review Reasons'], Decision: '', 'Canonical Source Number': '', 'Shopify Customer ID': '', 'Approved Repeated Line Count': '', Notes: '' })),
    ...[...repeatedLineCounts].map(([number, counts]) => ({ Entity: 'Order', 'Source ID': number, 'Review Groups': `O${number}`, Reasons: `identical order rows (${counts.join(', ')})`, Decision: '', 'Canonical Source Number': '', 'Shopify Customer ID': '', 'Approved Repeated Line Count': '', Notes: '' })),
  ];
  return {
    customers,
    orders,
    decisions,
    summary: {
      source: { customers: customerRecords.length, orderRows: orderRecords.length, orders: orderRowsByNumber.size },
      review: { customers: customers.length, orders: orderReasons.size, orderRows: orders.length, decisions: decisions.length },
      signals: { duplicateSourceNumberCustomers: customerRecords.filter(row => duplicateNumbers.has(value(row.number))).length, missingSourceNumberCustomers: customerRecords.filter(row => !value(row.number)).length, ordersWithIdenticalRows: repeatedLineCounts.size },
    },
  };
}

module.exports = { reviewDuplicates };
