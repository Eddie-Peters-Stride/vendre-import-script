# Link Fyrklövern orders by source customer number

Use the Fyrklövern customer number to join each order to its source customer. Map that number to Shopify's customer ID from the customer metafield and set Matrixify's `Customer: ID` when the mapping exists. If no ID mapping exists, use the source customer's email only when that email matches exactly one existing customer in the supplied Shopify export. Do not use phone number as a customer join key, and leave orders unmatched when neither mapping is available.

This keeps source identity authoritative and prevents order imports from creating customers through an unmatched email. Multiple source numbers may map to one Shopify customer when the export contains that relationship.
