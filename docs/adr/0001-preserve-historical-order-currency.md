# Preserve historical order currency

Fyrklövern order prices are recorded in the currency of each source order, while the current Shopify store base currency is SEK. Set both Matrixify `Currency` and `Shop Currency` to the source order's currency so its amounts stay unchanged; historical SEK conversion amounts are not present in the export. Matrixify permits a migrated order's shop currency to differ from the store's current currency, and this value cannot be changed after creation. Validate EUR, NOK, and DKK orders in the pilot before importing the full history.
