# Norce extraction and Matrixify review

This workflow reads Fyrklövern's Norce StoreAPI and existing Shopify Matrixify exports. It never writes to Shopify. The extraction caches and generated reports are local files under `cache/` and `norcemigration/`.

## Sources and identity

- Products: `exports/Shopify_Products_2026-10-21.csv` is the current Shopify native export, with 989 unique handles and external article IDs. It has no Shopify product ID column. `exports/Export_2026-09-29_101146 (1).xlsx` supplies IDs for 973 products whose handle and article ID match exactly. The other 16, including `10014062`, have verified unique handles and no ID. Conflicts and coverage are recorded in `cache/norce-products-inventory-coverage.json`.
- Collections: `exports/Export_2026-10-22_142102.xlsx` has 313 Shopify collection IDs and 21 typed `custom.*` metafield columns. The Norce `fyrklovern_custom_export.xlsx` category workbook and `outputs/Fyrklovern/Matrixify files/Collections/Content updates/Collection content - approved URL mappings.json` provide source and approved CategoryID mappings. Approval conflicts are recorded in `cache/norce-collections-inventory-coverage.json`.
- The 16 products without IDs can use their unique current handles for Matrixify `UPDATE` rows. Matrixify Translations requires an entity ID, so translations for those products are recorded for review and omitted from import files until IDs are verified.
- The StoreAPI's eight channel contexts are defined in `src/importers/fyrklovern/norce-extraction/channels.js`. DE and AT are distinct even though both use `de-DE`.

Set `NORCE_STOREAPI_TOKEN` in `.env` (never in an export). Optional environment variables are `NORCE_STOREAPI_URL`, `NORCE_STOREAPI_SHOPID`, `SHOPIFY_PRODUCTS_EXPORT_PATH`, `SHOPIFY_COLLECTIONS_EXPORT_PATH`, `NORCE_CATEGORY_EXPORT_PATH`, and `NORCE_CACHE_DIR`.

## Commands

```text
node src/importers/fyrklovern/norce-extraction/cli.js extract-products --channel=4 --article-number=10014062
node src/importers/fyrklovern/norce-extraction/cli.js extract-collections --channel=1 --category-id=149
npm run norce:extract-all
npm run norce:resume
npm run norce:status
npm run norce:refresh-channels
npm run norce:validate
npm run norce:generate-matrixify
```

The extract CLI also accepts `--limit=N`, `--refresh`, `--force`, `--dry-run`, `--collections-first`, `--checkpoint-interval=N`, `--products=path`, `--collections=path`, `--categories=path`, and `--cache-dir=path`. Every successful work item is first saved to a synced journal. The default Excel checkpoint interval is 20 work items; on resume, the journal is replayed into the Excel cache before another API request. `--refresh` keeps the prior successful result if the replacement request fails. `--collections-first` runs collections before products within the same rate-limited process. `status`, `validate`, and `generate-matrixify` make no Norce requests.

`norce:refresh-channels` discovers the StoreAPI `channels` schema and saves its response to `cache/norce-channels-discovery.json`. Review every culture, country, and currency before passing that file to extraction with `--channels-file=path`. The active full run uses the eight confirmed contexts in `channels.js`.

The caches contain products or collections, typed attribute and CMS rows, images, raw responses, per-group progress, errors, and chunked long values. `*.previous.xlsx` retains the prior valid checkpoint. The `Progress` sheet is the resumable manifest. `COMPLETE` groups are skipped on resume. Optional groups that the runtime schema does not expose appear as `NOT_AVAILABLE`; the product row remains `PARTIAL`, while basic fields and attributes can still qualify for a reviewed import.

For the current full run, `cache/norce-full.pid` identifies the background extraction process and `cache/norce-full.stdout.log` shows checkpoint progress. The run processes collections first, then resumes outstanding product work under the same request limiter. `scripts/fyrklovern/watchNorceFull.js` runs offline validation after that process exits and generates Matrixify files only if validation passes. Its outcome is recorded in `cache/norce-finalize.log`.

## Review before any Matrixify import

`norce:validate` writes mapping, translation, CMS, image, attribute, error, and per-channel summary reports to `norcemigration/reports/`. It exits nonzero while coverage or matching is incomplete. `norce:generate-matrixify` only uses the Excel caches and refuses to create update workbooks while required records or unique Shopify matches are missing. It generates `UPDATE` rows for existing products and collections. Each successful generation publishes a fresh folder under `norcemigration/matrixify-runs/` with a manifest, so files from earlier runs cannot be confused with the current set. It does not change prices, inventory, handles, options, variants, or collection rules.

Image references are not populated in collection metafields until a successful Shopify Files import is reconciled. `01-files.xlsx` contains deduplicated collection image upload candidates with deterministic filenames. After manually importing Files, pass a Matrixify Files result or export with unique successful/Ready filenames via `node src/importers/fyrklovern/norce-matrixify.js generate --files-results=path`; only verified files enter `list.file_reference` updates. Product media already in Shopify is left alone, with differences shown in the image review report. `04-translations.xlsx` contains fields with all six locales present; per-locale `04-translations-<locale>.xlsx` files preserve individually available values without blank translation cells. The locale `no` is based on the store's actual translation export. DE/AT differences and possible source-language fallbacks are held for review.

Configured product attribute destinations and culture-to-Shopify locale codes are in `src/importers/fyrklovern/norce-transform-config.json`. The generator checks those metafield columns against the verified Shopify Products export. Attribute values without a configured destination remain in `attribute-mapping.xlsx` for review.

Collection `Body HTML` uses the localized Norce category export's `content` field when populated. All 1,791 cells in the available workbook are empty, so the generator falls back to the first safe `text` property in current StoreAPI component order, matching the project's existing collection content import rule. Other StoreAPI CMS components remain separate in the cache and map to semantic `custom.layout_*` metafields only when their key and type match the October 22 Shopify export. Unsafe, structured, or unsupported properties are held in review reports. Empty source descriptions are not written as empty Shopify updates. Eligible localized CMS rich-text and configured product text metafield values are translated only when the primary value and channel structure can be verified; unmapped attributes and unsupported translation types remain in review.

The October 21/22 Shopify exports are snapshots. Revalidate against newer exports before a later production import if store records change. No production import is performed by these scripts.
