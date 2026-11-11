# Fyrklövern historical customers and orders Matrixify import

## Status

The initial design was confirmed on 2026-11-03 and revised through a design review on 2026-11-09. The export owner confirmed that every order should be created as paid and fulfilled, then directed that potential duplicates stay in a separate review file while the remaining records are generated for full migration. The remainder files have been generated; the duplicate and source-exception sets remain separate for later resolution. Generate files for manual Matrixify import only; never upload to Shopify from the script.

## Goal

Create a repeatable script that reads Fyrklövern custom customer and order CSV exports and writes separate Matrixify `Customers` and `Orders` workbooks plus a reconciliation report. The first run is a pilot. Full import files are generated only after the user reviews the pilot's Matrixify results and Shopify records.

The supplied CSVs are **examples**, not the complete exports:

- `../../Fyrklövern/export_BC_to_Shopify_sample.csv`
- `../../Fyrklövern/export_to_Shopify_customers - example.csv`

Pass input paths to the script so the full exports can use the same columns later. The example order file has 32 line rows representing 16 orders. The example customer file has one record, so only one example order has a matching customer. An actual representative pilot needs the full customer export.

The full exports are `exports/export_to_Shopify_orders.csv` and `exports/export_to_Shopify_customers.csv`. They contain 190,395 order rows for 88,038 distinct orders and 60,622 customer records. The export owner confirmed these are the complete files and that all their records belong in the migration. The order file has no header; parse its fixed 12-column order and reject rows with the wrong width. The customer file has `addressLine1` instead of the example's `addressLine`.

## Source contract

Orders, in positional order: `orderNo,orderDate,sellToCountry,sellToCustomerNo,itemID,itemName,quantity,unitPriceInclVAT,amountInclVAT,discount,VAT,currencyCode`.

Customers: `number,name,email,country,addressLine1,city,postalCode,phoneNumber`. Accept `addressLine` in the example file.

The source `orderNo` groups order lines. `sellToCustomerNo` joins to customer `number`. `itemID` is the Shopify variant SKU for merchandise. `Freight` is a separate source charge row.

The price fields and discount include VAT and are in `currencyCode`. Despite its name, `unitPriceInclVAT` is the **pre-discount line total**, not a per-unit price: `unitPriceInclVAT - discount = amountInclVAT`. `amountInclVAT` is what the customer paid for that row. This equation holds for all 32 example rows, including the row with quantity 2. `VAT` is the included tax amount after discount. No currency conversion is permitted.

Example orders use SEK, EUR, NOK, and DKK. The Shopify store's current base currency is SEK. Preserve each order's source currency in both Matrixify `Currency` and `Shop Currency` as documented for migrated orders. [ADR-0001](../adr/0001-preserve-historical-order-currency.md) records the trade-off. Pilot verification must confirm Shopify displays and totals foreign-currency orders correctly.

## Customer output

- Include every valid customer, even without an order.
- Matrixify `Customers` sheet. Resolve collisions within the source export before full batch generation. Let Matrixify handle matches to any existing Shopify test customers; do not include those test records in migration files. If multiple source numbers are confirmed to be one person, a reviewer chooses the customer's name, phone, and address.
- Split the source `name` at whitespace: put the first word in `First Name` and all remaining words, in order, in `Last Name`. Leave `Last Name` blank for a one-word name and omit both name columns when the source name is empty.
- Add the supplied address as the default customer address with explicit `Address Command=MERGE`, retaining other addresses on existing customers.
- Leave marketing consent unset. Do not send activation emails.
- Preserve source customers with missing email. Try phone only when it uniquely identifies the customer in the source and review finds no conflict; otherwise use the source-number-to-Shopify-ID mapping after customer import. Never invent an email. Distinct source customer numbers stay separate unless review confirms the same person. Store source numbers in a customer metafield, which must support multiple numbers for a confirmed merge. Do not clear unrelated fields of existing customers with empty input cells; check Matrixify's empty-column behavior when implementing.

## Order output

- Matrixify `Orders` sheet. Use `Command=NEW` so an existing order name fails rather than being replaced.
- Name is `F-[orderNo]`. Join `sellToCustomerNo` to the source customer's `number`. Use Matrixify `Customer: ID` when the Shopify export maps that customer number through the Fyrklövern metafield. Use `Customer: Email` only when the source email exactly matches one existing Shopify customer in the supplied export; otherwise keep the order in an unmatched file so Matrixify cannot create a customer.
- Use source `orderDate` as `Processed At` at noon Europe/Stockholm on that date. Source only has a calendar date.
- For every imported order, generate a successful **manual sale transaction** for the sum of source `amountInclVAT`, without a real payment gateway charge, and create a successful fulfillment. The export owner confirmed this representation for all orders. Archive the order.
- Set order and fulfillment receipts false, bypass inventory changes. Importing fulfillment may still trigger webhooks/integrations; the user will manually review the pilot.
- Mark tax included and map the supplied `VAT` amounts. `unitPriceInclVAT`, `discount`, `amountInclVAT`, and `VAT` must reconcile for each source row and each order in its original currency.
- Merchandise lines use `Line: SKU=itemID`, `Line: Title=itemName`, quantity, price, and discount. Matrixify's `Line: Price` is per unit. When the source pre-discount line total cannot be divided evenly into cent-precision unit prices, split the quantity into two line items priced at adjacent cents and allocate discount and VAT so the source totals remain exact. The full-source scan found 2,351 otherwise-valid orders requiring this conversion. Verify a same-SKU split in a nonproduction Matrixify import before full generation.
- Matrixify links matching SKUs. With a nonmatching SKU plus title and price, it creates a custom line. No current Shopify product export will be supplied, so the script cannot know every custom fallback in advance. The pilot import results must be checked for this.
- Map a `Freight` source row to a shipping charge, including its supplied VAT. An order must have at least one merchandise line.
- Do not invent historical shipping/billing addresses, payment methods, fulfillment dates, refunds, or marketing consent. Matrixify creates fulfillment/archive activity at import time.

## Validation and workflow

- Validate the customer CSV headers and positional order-row width, source IDs, dates, positive integral quantities, money fields, per-row price equation, per-order currency/customer/date consistency, VAT, and Matrixify output totals. Omit and report whole invalid orders. Do not silently repair amounts.
- Treat missing or repeated source customer numbers and identical order rows as review cases. Shared phone numbers alone are not duplicate evidence. Hold only orders tied to ambiguous source numbers, identical repeated lines, or other invalid source data. Keep unmatched orders out of the migration-ready batches and include them in a separate workbook with reasons. All source orders remain accounted for; never silently delete an identical order row.
- Validate the owner-confirmed source counts and date coverage. Represent every source order as paid and fulfilled; the source provides no cancellation or refund status to migrate. Do not migrate existing Shopify test records.
- Make a deterministic pilot of up to 10 valid orders spanning available currencies, discounts, freight, quantity > 1, and custom-line candidates, with their customers and at least one customer without an order where available.
- Produce separate customer and order files for the pilot. Test in a small nonproduction run first; check automatic fulfillment settings and connected fulfillment services before any production pilot. Import customers first, reconcile Shopify IDs, then import orders. Generate full files only with an explicit post-pilot approval option or equivalent gate, after the business accepts the production order-number sequence change.
- Split full Matrixify output into deterministic batches with at most 20,000 customers per Customers file and at most 10,000 complete orders per Orders file. Never split one order's lines across files. Import all customer batches and reconcile IDs before importing order batches.
- Reconciliation report: source and included customer/order counts, omission reasons and source IDs, source versus output monetary totals per currency, and warnings about SKU linkage that cannot be verified without Shopify catalog data. Keep customer names/emails out of the report. The separate duplicates workbook contains the personal data needed for manual review and must stay out of git.
- Make output paths configurable and avoid overwriting existing outputs by default. Keep generated files with personal data out of git.

## Verification

Test the transformation at the parsed-record-to-Matrixify-row-and-report seam with small synthetic fixtures. Cover the quantity-two line-total interpretation, VAT-inclusive discounts, freight, all four currencies, source-number-to-Shopify-ID mapping, exact existing-customer email fallback, missing customer mapping, shared phone numbers, identical order rows, invalid monetary rows, pilot selection, batch limits, and full-run gate. Inspect generated workbook sheet names, headers, grouped order rows, and sums. Run against the supplied examples without importing into Shopify.

## References

- [Matrixify Orders columns and import behavior](https://matrixify.app/documentation/orders/)
- [Matrixify Customers columns and address merge](https://matrixify.app/documentation/customers/)
- [Matrixify unmatched SKU custom-line fallback](https://matrixify.app/tutorials/bulk-add-line-items-to-shopify-orders/)
