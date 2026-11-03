# Fyrklövern historical Matrixify files

Run the local generator with the full customer and order CSV exports. It only reads CSVs and writes workbooks and a reconciliation JSON; it has no Shopify connection.

```powershell
npm run build:fyrklovern:historical-matrixify -- --orders="C:\path\orders.csv" --customers="C:\path\customers.csv"
```

The default pilot files go to `outputs/fyrklovern-historical/`: `pilot-customers.xlsx`, `pilot-orders.xlsx`, and `pilot-reconciliation.json`. If customer rows need different populated columns, further customer workbooks receive `-2`, `-3`, and so on. Import all of them before orders. Use `--output-dir=...` or the individual `--customer-output=...`, `--order-output=...`, and `--report-output=...` options. Existing files are not overwritten. Generated files contain personal data and the default directory is ignored by Git.

The pilot selects at most 10 valid orders across currencies, discounts, freight, and quantities where available. It includes their customers and one extra customer without a selected order when available. The example CSVs have only one customer, so only one of their 16 orders can be included. Use the complete customer export for a representative pilot.

Import the **Customers** workbook manually in Matrixify first, then the **Orders** workbook. Review Matrixify's import results and the resulting Shopify orders, especially foreign currencies, taxes, totals, SKU linking versus custom-line fallback, and fulfillment webhooks or integrations. Matrixify creates fulfillment and archive activity at import time. This script does not send receipts or charge a payment gateway.

After reviewing the pilot, generate full files explicitly:

```powershell
npm run build:fyrklovern:historical-matrixify -- --orders="C:\path\orders.csv" --customers="C:\path\customers.csv" --mode=full --approve-full
```

The report gives source, included, and workbook-derived totals and VAT by source currency, plus omitted source IDs and reasons. It contains no customer names or email addresses. Invalid orders are omitted as a whole. Customers are grouped into workbooks by populated fields, because Matrixify can clear existing values when a column contains blank cells.
