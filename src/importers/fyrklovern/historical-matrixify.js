const ORDER_HEADERS = ['orderNo', 'orderDate', 'sellToCountry', 'sellToCustomerNo', 'itemID', 'itemName', 'quantity', 'unitPriceInclVAT', 'amountInclVAT', 'discount', 'VAT', 'currencyCode'];
const CUSTOMER_HEADERS = ['number', 'name', 'email', 'country', 'addressLine', 'city', 'postalCode', 'phoneNumber'];
const CUSTOMER_COLUMNS = { name: 'First Name', phoneNumber: 'Phone', country: 'Address Country Code', addressLine: 'Address Line 1', city: 'Address City', postalCode: 'Address Zip' };
const ORDER_COLUMNS = ['Name', 'Command', 'Customer: Email', 'Email', 'Processed At', 'Closed At', 'Currency', 'Shop Currency', 'Send Receipt', 'Inventory Behaviour', 'Tax: Included', 'Line: Type', 'Line: ID', 'Line: SKU', 'Line: Title', 'Line: Quantity', 'Line: Price', 'Line: Discount', 'Line: Tax 1 Title', 'Line: Tax 1 Price', 'Fulfillment: ID', 'Fulfillment: Status', 'Fulfillment: Send Receipt', 'Transaction: Kind', 'Transaction: Processed At', 'Transaction: Amount', 'Transaction: Currency', 'Transaction: Status', 'Transaction: Gateway', 'Transaction: Force Gateway'];
const CUSTOMER_BASE_COLUMNS = ['Email', 'Command', 'Address Command', 'Address Is Default'];

const value = v => String(v ?? '').trim();
const money = v => {
  const s = value(v);
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(s)) return null;
  const [whole, fraction = ''] = s.split('.');
  const sign = whole.startsWith('-') ? -1 : 1;
  return sign * (Math.abs(Number(whole)) * 100 + Number(fraction.padEnd(2, '0')));
};
const format = cents => `${cents < 0 ? '-' : ''}${Math.floor(Math.abs(cents) / 100)}.${String(Math.abs(cents) % 100).padStart(2, '0')}`;
const emptyTotals = () => ({ source: '0.00', included: '0.00', output: '0.00', sourceVat: '0.00', includedVat: '0.00', outputVat: '0.00' });
const emailValid = email => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
const dateValid = s => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T12:00:00Z`)) && new Date(`${s}T12:00:00Z`).toISOString().slice(0, 10) === s;
const stockholmNoon = s => `${s} 12:00:00 ${new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Stockholm', timeZoneName: 'shortOffset' }).formatToParts(new Date(`${s}T12:00:00Z`)).find(p => p.type === 'timeZoneName').value === 'GMT+2' ? '+0200' : '+0100'}`;

function validateHeaders(actual, expected, label) {
  const missing = expected.filter(h => !actual.includes(h));
  if (missing.length) throw new Error(`${label} CSV missing headers: ${missing.join(', ')}`);
}

function transform(orderRecords, customerRecords, options = {}) {
  const mode = options.mode || 'pilot';
  if (!['pilot', 'full'].includes(mode)) throw new Error('mode must be pilot or full');
  if (mode === 'full' && options.approveFull !== true) throw new Error('Full output requires --approve-full after pilot review');
  const report = { mode, source: { customers: customerRecords.length, orders: 0, orderRows: orderRecords.length }, included: { customers: 0, orders: 0 }, omitted: { customers: [], orders: [] }, totals: {}, warnings: ['SKU linkage and custom-line fallback cannot be verified without the Shopify catalog; inspect Matrixify pilot results.', 'Verify foreign-currency totals and fulfillment/integration effects in Shopify after the manual pilot import.'] };
  const byNumber = new Map(), byEmail = new Map();
  for (const c of customerRecords) {
    const n = value(c.number), e = value(c.email).toLowerCase();
    if (n) byNumber.set(n, (byNumber.get(n) || 0) + 1);
    if (e) byEmail.set(e, (byEmail.get(e) || 0) + 1);
  }
  const validCustomers = new Map();
  for (let i = 0; i < customerRecords.length; i++) {
    const c = customerRecords[i], n = value(c.number), e = value(c.email).toLowerCase();
    const reasons = [];
    if (!n) reasons.push('missing customer number');
    else if (!/^[A-Za-z0-9_-]+$/.test(n)) reasons.push('invalid customer number');
    if (!e) reasons.push('missing email');
    else if (!emailValid(e)) reasons.push('invalid email');
    if (n && byNumber.get(n) > 1) reasons.push('duplicate customer number');
    if (e && byEmail.get(e) > 1) reasons.push('duplicate email');
    if (reasons.length) report.omitted.customers.push({ sourceId: n || `row ${i + 2}`, reasons });
    else validCustomers.set(n, { ...c, email: e });
  }
  const groups = new Map();
  for (let i = 0; i < orderRecords.length; i++) {
    const row = orderRecords[i], id = value(row.orderNo);
    const key = id || `missing row ${i + 2}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  report.source.orders = groups.size;
  const validOrders = [];
  for (const [id, rows] of groups) {
    const first = rows[0], reasons = [];
    const customerNo = value(first.sellToCustomerNo), currency = value(first.currencyCode), date = value(first.orderDate);
    if (!value(first.orderNo)) reasons.push('missing order number');
    else if (!/^[A-Za-z0-9_-]+$/.test(id) || id.length > 253) reasons.push('invalid order number');
    if (!customerNo) reasons.push('missing customer number');
    else if (!validCustomers.has(customerNo)) reasons.push('customer absent or omitted');
    if (!dateValid(date)) reasons.push('invalid order date');
    if (!/^[A-Z]{3}$/.test(currency)) reasons.push('invalid currency');
    if (!/^[A-Z]{2}$/.test(value(first.sellToCountry))) reasons.push('invalid country');
    let total = 0, vat = 0, discounted = false, freight = false, multi = false;
    const parsed = [];
    for (const row of rows) {
      if (value(row.sellToCustomerNo) !== customerNo || value(row.currencyCode) !== currency || value(row.orderDate) !== date || value(row.sellToCountry) !== value(first.sellToCountry)) reasons.push('inconsistent order customer, currency, date, or country');
      const qty = Number(value(row.quantity));
      const pre = money(row.unitPriceInclVAT), paid = money(row.amountInclVAT), discount = money(row.discount), tax = money(row.VAT);
      const isFreight = value(row.itemID).toLowerCase() === 'freight';
      if (!value(row.itemID) || !value(row.itemName)) reasons.push('missing item ID or title');
      if (!Number.isSafeInteger(qty) || qty <= 0 || (isFreight && qty !== 1)) reasons.push('invalid quantity');
      if ([pre, paid, discount, tax].some(x => x === null || !Number.isSafeInteger(x))) reasons.push('invalid money');
      else {
        if (pre < 0 || paid < 0 || discount < 0 || tax < 0 || tax > paid || pre - discount !== paid) reasons.push('invalid price, discount, or VAT equation');
        if (!isFreight && Number.isSafeInteger(qty) && qty > 0 && pre % qty !== 0) reasons.push('pre-discount total cannot be divided into cent-precision unit price');
        total += paid; vat += tax;
        discounted ||= discount > 0;
      }
      freight ||= isFreight;
      multi ||= qty > 1;
      parsed.push({ row, qty, pre, paid, discount, tax, isFreight });
    }
    if (!parsed.some(p => !p.isFreight)) reasons.push('no merchandise line');
    if (parsed.filter(p => p.isFreight).length > 1) reasons.push('multiple freight lines');
    if (!Number.isSafeInteger(total) || !Number.isSafeInteger(vat)) reasons.push('order total overflow');
    if (reasons.length) report.omitted.orders.push({ sourceId: id, reasons: [...new Set(reasons)] });
    else validOrders.push({ id, rows: parsed, customerNo, currency, date, total, vat, discounted, freight, multi });
  }
  validOrders.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  const selected = mode === 'full' ? validOrders : selectPilot(validOrders);
  const selectedCustomerIds = mode === 'full' ? [...validCustomers.keys()] : [...new Set(selected.map(o => o.customerNo))];
  if (mode === 'pilot') {
    const sourceOrderCustomers = new Set(orderRecords.map(row => value(row.sellToCustomerNo)));
    const extra = [...validCustomers.keys()].sort().find(id => !sourceOrderCustomers.has(id));
    if (extra) selectedCustomerIds.push(extra);
  }
  const customers = selectedCustomerIds.map(id => validCustomers.get(id));
  const customerRows = customers.map(c => {
    const row = { Email: c.email, Command: 'MERGE' };
    for (const [source, target] of Object.entries(CUSTOMER_COLUMNS)) {
      if (value(c[source]) && (source === 'name' || source === 'phoneNumber' || value(c.addressLine))) row[target] = value(c[source]);
    }
    if (value(c.addressLine)) Object.assign(row, { 'Address Command': 'MERGE', 'Address Is Default': 'TRUE' });
    return row;
  });
  const batchMap = new Map();
  const columnOrder = ['Email', 'Command', ...Object.values(CUSTOMER_COLUMNS), ...CUSTOMER_BASE_COLUMNS.slice(2)];
  for (const row of customerRows) {
    const columns = columnOrder.filter(column => Object.hasOwn(row, column));
    const key = columns.join('|');
    if (!batchMap.has(key)) batchMap.set(key, { columns, rows: [] });
    batchMap.get(key).rows.push(row);
  }
  const customerBatches = [...batchMap.values()].sort((a, b) => a.columns.join('|').localeCompare(b.columns.join('|')));
  if (!customerBatches.length) customerBatches.push({ columns: ['Email', 'Command'], rows: [] });
  if (customerBatches.length > 1) report.warnings.push(`Customer rows have ${customerBatches.length} different populated-column sets. Import every customer workbook before orders.`);
  let nextLineId = 1;
  const orderRows = selected.flatMap(order => {
    const rows = orderToRows(order, validCustomers.get(order.customerNo).email);
    for (const row of rows) if (row['Line: Type'] === 'Line Item') row['Line: ID'] = nextLineId++;
    return rows;
  });
  for (const [id, rows] of groups) {
    const currency = value(rows[0].currencyCode);
    if (!/^[A-Z]{3}$/.test(currency) || rows.some(r => value(r.currencyCode) !== currency)) continue;
    const amounts = rows.map(r => ({ paid: money(r.amountInclVAT), vat: money(r.VAT) }));
    if (amounts.some(a => a.paid === null || a.vat === null)) {
      report.warnings.push(`Source totals exclude order ${id} because its money cannot be parsed.`);
      continue;
    }
    const t = report.totals[currency] ||= emptyTotals();
    t.source = format(money(t.source) + amounts.reduce((n, a) => n + a.paid, 0));
    t.sourceVat = format(money(t.sourceVat) + amounts.reduce((n, a) => n + a.vat, 0));
  }
  for (const order of selected) {
    const t = report.totals[order.currency] ||= emptyTotals();
    t.included = format(money(t.included) + order.total);
    t.includedVat = format(money(t.includedVat) + order.vat);
  }
  const outputByOrder = new Map();
  for (const row of orderRows) {
    const key = row.Name, entry = outputByOrder.get(key) || { currency: row.Currency, total: 0, vat: 0, transaction: null };
    if (row['Line: Type'] === 'Line Item') entry.total += money(row['Line: Price']) * row['Line: Quantity'] + money(row['Line: Discount']);
    if (row['Line: Type'] === 'Shipping Line') entry.total += money(row['Line: Price']);
    if (row['Line: Type'] === 'Discount') entry.total += money(row['Line: Discount']);
    if (row['Line: Tax 1 Price']) entry.vat += money(row['Line: Tax 1 Price']);
    if (row['Line: Type'] === 'Transaction') entry.transaction = money(row['Transaction: Amount']);
    outputByOrder.set(key, entry);
  }
  for (const order of selected) {
    const output = outputByOrder.get(`F-${order.id}`);
    if (!output || output.total !== order.total || output.vat !== order.vat || output.transaction !== order.total) throw new Error(`Matrixify output does not reconcile for order ${order.id}`);
    const t = report.totals[order.currency];
    t.output = format(money(t.output) + output.total);
    t.outputVat = format(money(t.outputVat) + output.vat);
  }
  report.included = { customers: customers.length, orders: selected.length };
  if (mode === 'pilot' && validOrders.length > selected.length) report.warnings.push(`${validOrders.length - selected.length} valid orders excluded by pilot size/selection; generate full files only after pilot approval.`);
  return { customerRows, customerBatches, orderRows, orderColumns: ORDER_COLUMNS, report };
}

function selectPilot(orders) {
  const chosen = [], remaining = [...orders], covered = new Set();
  while (remaining.length && chosen.length < 10) {
    let best = 0, score = -1;
    for (let i = 0; i < remaining.length; i++) {
      const o = remaining[i], features = [o.currency, o.discounted && 'discount', o.freight && 'freight', o.multi && 'multi', 'custom-line candidate'];
      const gain = features.filter(f => f && !covered.has(f)).length;
      if (gain > score) { score = gain; best = i; }
    }
    const [order] = remaining.splice(best, 1);
    chosen.push(order);
    [order.currency, order.discounted && 'discount', order.freight && 'freight', order.multi && 'multi', 'custom-line candidate'].filter(Boolean).forEach(x => covered.add(x));
  }
  return chosen.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
}

function orderToRows(order, email) {
  const at = stockholmNoon(order.date);
  const base = { Name: `F-${order.id}`, Command: 'NEW', 'Customer: Email': email, Email: email, 'Processed At': at, 'Closed At': at, Currency: order.currency, 'Shop Currency': order.currency, 'Send Receipt': 'FALSE', 'Inventory Behaviour': 'bypass', 'Tax: Included': 'TRUE' };
  const rows = [];
  for (const p of order.rows) {
    if (p.isFreight) {
      rows.push({ ...base, 'Line: Type': 'Shipping Line', 'Line: Title': value(p.row.itemName), 'Line: Price': format(p.pre), 'Line: Tax 1 Title': 'VAT', 'Line: Tax 1 Price': format(p.tax) });
      if (p.discount) rows.push({ ...base, 'Line: Type': 'Discount', 'Line: Title': 'shipping', 'Line: Discount': format(-p.discount) });
    } else {
      const price = format(p.pre / p.qty);
      rows.push({ ...base, 'Line: Type': 'Line Item', 'Line: SKU': value(p.row.itemID), 'Line: Title': value(p.row.itemName), 'Line: Quantity': p.qty, 'Line: Price': price, 'Line: Discount': format(-p.discount), 'Line: Tax 1 Title': 'VAT', 'Line: Tax 1 Price': format(p.tax) });
    }
  }
  rows.push({ ...base, 'Line: Type': 'Fulfillment Line', 'Fulfillment: ID': `F-${order.id}`, 'Fulfillment: Status': 'success', 'Fulfillment: Send Receipt': 'FALSE' });
  rows.push({ ...base, 'Line: Type': 'Transaction', 'Transaction: Kind': 'sale', 'Transaction: Processed At': at, 'Transaction: Amount': format(order.total), 'Transaction: Currency': order.currency, 'Transaction: Status': 'success', 'Transaction: Gateway': 'manual', 'Transaction: Force Gateway': 'FALSE' });
  return rows;
}

module.exports = { transform, validateHeaders, ORDER_HEADERS, CUSTOMER_HEADERS, format, money };
