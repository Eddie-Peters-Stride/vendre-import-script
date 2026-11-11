# Fyrklövern historical Matrixify preparation

The source CSVs are in `exports/`. The scripts read local files only; they never upload to Shopify. Generated review and Matrixify files contain personal data and go under the Git-ignored `outputs/fyrklovern-historical/` directory by default. Existing outputs are not overwritten.

## Review source identity and repeated rows

```powershell
npm run review:fyrklovern:historical-duplicates
```

This creates `duplicates-review.xlsx` with complete source rows on `Customers` and `Orders` sheets, `duplicates-decisions.csv` as the review template, and `duplicates-summary.json` without personal data. Current review rules flag missing or repeated source customer numbers and identical order lines. Shared email or phone alone does not make a customer a duplicate. Older review workbooks in this directory were generated under the previous contact-based rules and should not be used for the current import.

Use `--orders=...`, `--customers=...`, and `--output-dir=...` to choose other input and output paths. The review includes all orders for a flagged customer and the customer of a flagged order. The review is a preparation step, not a Matrixify import file.

## Matrixify preview

The existing generator can produce a small preview for a nonproduction test:

```powershell
node scripts/fyrklovern/buildHistoricalMatrixify.js --orders=exports/export_to_Shopify_orders.csv --customers=exports/export_to_Shopify_customers.csv --output-dir=outputs/fyrklovern-historical/full-source-preview
```

The preview selects up to ten orders. It does not yet apply the reviewed source-number-to-Shopify-ID mapping and must not be used for a production import. The export owner confirmed every order should be created as paid and fulfilled; the generator represents each with a successful manual sale transaction and fulfillment. Full workbook generation is blocked until the source duplicate decisions, customer identity reconciliation, and post-pilot approval are available. Matrixify will handle matches to existing Shopify test customers; those test records are not part of the migration files. The source owner confirmed the two files are complete; their observed counts are 60,622 customer records, 190,395 order rows, and 88,038 distinct orders. The writer now limits each Customers workbook to 20,000 customers and each Orders workbook to 10,000 complete orders; it never splits an order across files.

The generator now splits an unevenly priced source line into two Matrixify line items with adjacent cent-precision unit prices. It allocates the source discount and VAT across them without changing the order total. The full-source scan found 2,351 otherwise-valid orders needing this conversion; these are no longer rejected for unit-price precision. Verify one such order in a nonproduction Matrixify import, especially if both lines have the same SKU. The source still has 40 orders with invalid quantity, one with no merchandise line, and one with inconsistent order fields; these require source review before complete import batches are generated.

Read the [design plan](plans/fyrklovern-historical-matrixify-import.md) before preparing production files.

## Earlier full remainder files

The export owner's instruction is to keep all potential duplicates separate and prepare the rest of the source for migration. `outputs/fyrklovern-historical/full-remainder/` contains the regenerated `duplicates-review.xlsx`, five `full-remainder-customers-*.xlsx` files, nine `full-remainder-orders-*.xlsx` files, `source-exceptions.xlsx`, and `full-remainder-reconciliation.json`.

The Matrixify files contain 58,791 customers and 85,092 complete orders. The duplicate review holds 1,830 customers and 2,905 orders. The exception workbook holds one customer with an invalid email and 41 orders that fail source validation or link to that customer. These sets reconcile to all 60,622 source customers and 88,038 source orders. The files have not been imported into Shopify. Import the customer batches before the order batches, inspect Matrixify's import results, and test a split-price order with a repeated SKU before the full run.

The updated files with split customer names and size-based batches are in `outputs/fyrklovern-historical/full-remainder-split-names-20k/`. They put the first word of the source name in `First Name` and the remaining words in `Last Name`. This set has three customer workbooks, split only at 20,000 rows. The earlier `full-remainder/` and `full-remainder-split-names/` files preserve the previous batching.

These files predate the current customer-number-to-Shopify-ID matching rule. Use the ID-linked order files below for order imports.

## Current ID-linked order files

Build the current order package from the complete Shopify customer export. Pass `--overwrite` only when regenerating the same output directory:

```powershell
node scripts/fyrklovern/buildHistoricalOrdersByCustomerId.js --shopify-customers=<Shopify-customer-export.csv> --output-dir=outputs/fyrklovern-historical/id-email-linked-2026-11-10 [--overwrite]
```

The builder joins source `sellToCustomerNo` to `number`, then maps the Fyrklövern customer-number metafield to Shopify `Customer ID`. It uses `Customer: Email` only when the email matches exactly one existing customer in that export. It does not create customers from unmatched email addresses, and it does not use phone numbers for customer matching.

The current export has 58,796 Shopify customers, with 58,791 source-number-to-Shopify-ID mappings and five customers without a source number. No unmatched source email uniquely matched an existing exported Shopify customer, so the generated import files use ID association only. The nine `orders-*.xlsx` files contain 85,092 orders; `unmatched-orders.xlsx` contains the other 2,946 orders and their 7,103 source rows with reasons. There are 1,831 source customer numbers without an ID mapping; the unmatched workbook also marks 25 identical-line orders and includes 41 source-validation exceptions. These reasons may overlap. Source number `K00010` has six unmatched orders because it has no metafield-to-Shopify-ID mapping and its email is not present in the Shopify export.

The builder checks that every import row has exactly one customer association, every `Fulfillment: ID` is a unique number, the order and fulfillment receipt fields are `FALSE`, and imported plus unmatched order counts reconcile. The files have not been uploaded to Shopify. Check Shopify automatic fulfillment and connected fulfillment/SMS integrations before importing; receipt fields do not control third-party automations.

To recreate the earlier remainder files, run the duplicate review script followed by `node scripts/fyrklovern/buildHistoricalRemainder.js --output-dir=<new-directory>`. Existing output files are never overwritten. Run `node scripts/fyrklovern/verifyHistoricalRemainder.js <new-directory>` to check the earlier file counts and order grouping.

To recreate the files in a new directory, run the duplicate review script followed by `node scripts/fyrklovern/buildHistoricalRemainder.js --output-dir=<new-directory>`. Existing output files are never overwritten. Run `node scripts/fyrklovern/verifyHistoricalRemainder.js <new-directory>` to check the written file counts and order grouping.
