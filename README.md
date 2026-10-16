# Vendre-to-Matrixify Import Scripts

Clean, maintainable import scripts for syncing data from Vendre to Shopify via Matrixify.

## 🚀 Quick Start

### New Structure (Recommended)

```bash
# Sync all data for Store (fetch from Vendre + export to Matrixify)
npm run sync

# Sync for second store
npm run sync:store2

# Fetch data only (no export)
npm run fetch

# Export to Matrixify only (from existing JSON files)
npm run export

# Help and all available commands
npm run help
```

### Legacy Scripts (Still Available)

All original scripts in the `scripts/` folder continue to work as before:

```bash
npm run fetch-products
npm run export-products
npm run update-inventory
npm run export-collections
# ... etc
```

## 📁 Project Structure

```
import_script/
├── src/                          # NEW: Clean, modular structure
│   ├── api/
│   │   └── vendre-client.js      # Vendre API client with pagination
│   ├── config/
│   │   ├── stores.js             # Multi-store configuration
│   │   └── matrixify.js          # Matrixify column schemas
│   ├── utils/
│   │   ├── fields.js             # Bilingual field handling
│   │   ├── handles.js            # Shopify handle generation
│   │   ├── collections.js        # Collection disambiguation
│   │   ├── html.js               # HTML sanitization
│   │   └── file-io.js            # Safe file I/O
│   ├── transformers/
│   │   ├── product-transformer.js
│   │   ├── collection-transformer.js
│   │   └── customer-transformer.js
│   ├── exporters/
│   │   ├── matrixify-products.js
│   │   ├── matrixify-collections.js
│   │   └── matrixify-customers.js
│   ├── commands/
│   │   ├── fetch.js              # Fetch from Vendre
│   │   ├── export.js             # Export to Matrixify
│   │   └── sync.js               # Combined fetch + export
│   └── index.js                  # CLI entry point
├── scripts/                      # Original scripts (preserved)
│   ├── products/
│   ├── collections/
│   ├── customers/
│   └── fetch/
├── results/                      # Output directory for JSON and Excel files
├── tags.json                     # Tag ID to name mapping
├── package.json
└── .env                          # API keys (not in Git)
```

## 🔧 Configuration

### Environment Variables

**Important:** Each store has its own `.env` file. The `ENV_FILE` environment variable selects which store to use.

#### Store Store

Create `.env.store` in the project root:

```env
# Store Information
STORE_NAME=store
STORE_DISPLAY_NAME=Store
API_URL=https://store.se/API/1
API_KEY=your-store-api-key-here

# Tax Classes
TAX_CLASS_2=25
TAX_CLASS_3=6
TAX_CLASS_4=12
TAX_CLASS_5=0

# Spec Field IDs (from Vendre)
SPEC_FIELD_BGG_ID=1603
SPEC_FIELD_YEAR_PUBLISHED=1604
# ... etc (see .env.example for full list)
```

#### Second Store

Create `.env.store2` with the same structure but different values:

```env
STORE_NAME=store2
STORE_DISPLAY_NAME=Store 2
API_URL=https://store2.example.com/API/1
API_KEY=your-store2-api-key-here
# ... etc
```

**See `.env.example` for a complete template with all required variables.**

### Adding a New Store

1. Copy `.env.example` to `.env.yourstore`
2. Update all values (especially API_KEY, API_URL, STORE_NAME)
3. Update `package.json` to add npm scripts for the new store:
   ```json
   "sync:yourstore": "cross-env ENV_FILE=.env.yourstore node src/index.js --command=sync"
   ```
4. Run `npm run sync:yourstore`

### Fyrklövern migration template

Fyrklövern uses a custom Excel export rather than the Vendre API format. The
initial template imports `productdata (standard sv-SE)` and joins its Swedish
(`sv-SE`) `dynamicfields` values by `ProductID`. It maps `ArticleNumber` to the
Shopify SKU. Each `ItemName` becomes an individual `custom.*` metafield;
multiple values are retained as Shopify list metafields.

```bash
# Uses ../Fyrklövern/fyrklovern_custom_export.xlsx by default
npm run import:fyrklovern:productdata

# Or specify the workbook explicitly
npm run import:fyrklovern:productdata -- --input="C:\path\to\fyrklovern_custom_export.xlsx"
```

This creates `results/fyrklovern/fyrklovern-products.json`. Mapping of the
remaining worksheets (prices, localization, relations and categories) is
deliberately not included yet.

The Swedish category template can be staged separately:

```bash
npm run import:fyrklovern:categories
```

This creates `results/fyrklovern/fyrklovern-categories.json` from the
`categorieslocalized` sheet filtered to `sv-SE`. The `category structure`
worksheet is retained for the staged hierarchy. Handles use the complete
Swedish category permalink path with `/` converted to `-`, and never include
source IDs.

Inspect Norce category and CMS exports without contacting Shopify:

```bash
npm run audit:fyrklovern-norce-content -- \
  --categories="C:\path\to\fyrklovern_custom_export.xlsx" \
  --cms="C:\path\to\fyrklovern-content-export-2026-10-15.csv" \
  --content-map="C:\path\to\norce-category-content-map.json" \
  --category-id=149
```

The audit reads `categorieslocalized`, `categorypermalinks`, and
`category structure`, plus the semicolon-delimited CMS CSV (including BOM and
quoted fields). It preserves source fields and component/item order, inventories
component/property names, and reports categories without a supplied ContentId
relationship. Wide culture columns are expanded into separate culture groups;
legacy row-per-culture CSVs are also accepted. A single verified relationship
can be supplied with `--category-id=149 --culture=sv-SE --content-id=<id>`. The
optional content map accepts an array of
`{ "categoryId", "culture", "contentId", "source" }` records. Its output is
`outputs/Fyrklovern/Reports and source maps/Norce CMS source audit.json` by default; `--output=<path>` changes
that location. Candidate field mappings are review-only and no Matrixify file
or Shopify change is produced by this command.

Run its parser and audit fixture checks with `npm run test:fyrklovern-norce-source`.

Build an offline Norce-to-Shopify collection mapping review from the category
workbook and a Shopify export. Only `Collections` rows with `Top Row=true` are
used; URL matches remain pending manual approval and title-only matches are
unverified suggestions. This command does not call Shopify or write imports.

```bash
npm run review:fyrklovern-mappings -- \
  --categories="C:\path\to\fyrklovern_custom_export.xlsx" \
  --shopify="exports\Export_2026-10-06_132403.xlsx"
```

To opt in to read-only StoreAPI fetching for specific Norce IDs, set
`NORCE_STOREAPI_TOKEN` locally in the ignored `.env` file (never paste or commit
the token). Use the plan's exact settings from `.env.example`:
`NORCE_STOREAPI_URL`, `NORCE_STOREAPI_SHOPID`, `NORCE_STOREAPI_TOKEN`, and
optional `NORCE_DEFAULT_CULTURE`, `NORCE_DEFAULT_COUNTRY`, and
`NORCE_DEFAULT_CURRENCY`. Timeout, retry count and request spacing are
configurable with `NORCE_STOREAPI_TIMEOUT_MS`, `NORCE_STOREAPI_RETRIES`, and
`NORCE_STOREAPI_THROTTLE_MS`.

With no arguments, the fetch command discovers unique CategoryIDs from
`NORCE_CATEGORY_EXPORT_PATH`, or from the repo-relative sibling
`../../<Fyrklovern folder>/fyrklovern_custom_export.xlsx` (directory matching
ignores accents). It fetches each unique CategoryID once in one selected
culture, default `sv-SE`, and excludes CategoryIDs with conflicting localized
source rows. `NORCE_CMS_EXPORT_PATH` is optional; if absent, CMS presence stays
unknown. The JSON cache is written to `NORCE_STOREAPI_OUTPUT_PATH` or
`outputs/Fyrklovern/Reports and source maps/StoreAPI category ContentId map.json`; per-ID errors are
retained and do not stop later IDs. Existing outputs are protected unless
`--overwrite=true` is passed.

```powershell
npm.cmd run fetch:fyrklovern-norce-categories
npm.cmd run fetch:fyrklovern-norce-categories -- --ids=149,150 --culture=sv-SE
npm.cmd run fetch:fyrklovern-norce-categories -- --categories="C:\path\to\fyrklovern_custom_export.xlsx" --cms="C:\path\to\fyrklovern-content-export.csv" --output="outputs\content-map.json"
```

To use the fetched cache in the offline mapping review, pass it as the
explicit map and point to the CMS source used for presence checks:

```powershell
npm.cmd run review:fyrklovern-mappings -- --categories="C:\path\to\fyrklovern_custom_export.xlsx" --shopify="exports\Export_2026-10-06_132403.xlsx" --content-map="outputs\Fyrklovern\Reports and source maps\StoreAPI category ContentId map.json" --cms="C:\path\to\fyrklovern-content-export.csv"
```

For the mapping review with the currently available source files, use:

```powershell
npm run review:fyrklovern-mappings -- --categories="C:\path\to\fyrklovern_custom_export.xlsx" --shopify="exports\Export_2026-10-06_132403.xlsx" --content-map="outputs\Fyrklovern\Reports and source maps\StoreAPI category ContentId map.json" --cms="C:\path\to\fyrklovern-content-export-2026-10-15.csv"
```

The explicit audit map contributes the supplied Category 149 ContentId only;
other relationships remain blank. `ContentFound` is checked against the
supplied CMS export. The review records that StoreAPI was not fetched in this
run. In PowerShell use `npm.cmd`; the command loads `.env` or `ENV_FILE`,
refuses to make requests without the token, and writes a reusable JSON mapping
cache only. No Shopify writes occur.

### Fyrklövern output folders

Fyrklövern Matrixify workbooks are grouped under `outputs/Fyrklovern/Matrixify files/Products` and `outputs/Fyrklovern/Matrixify files/Collections`. Source maps, audit reports, and mapping reviews are stored in `outputs/Fyrklovern/Reports and source maps`; Shopify's standard language-import CSV is kept separately under `outputs/Fyrklovern/Shopify language import`.

Build the approved Norce collection content import with:

```powershell
npm.cmd run build:fyrklovern-collection-content -- --categories="C:\path\to\fyrklovern_custom_export.xlsx" --cms="C:\path\to\fyrklovern-content-export.csv" --content-map="outputs\Fyrklovern\Reports and source maps\StoreAPI category ContentId map.json" --shopify="exports\Export_2026-10-06_132403.xlsx" --approved-map="C:\path\to\approved-mappings.json"
```

The report and workbooks are written to `outputs/Fyrklovern/Matrixify files/Collections/Content updates` by default. Use `--approve-url-candidates=true` only when intentionally approving every exact URL candidate. Review the generated import instructions and mapping/QA report before importing; metafield definitions must exist in Shopify first.

Create the collections-only Matrixify import workbook with:

```bash
npm run export:fyrklovern:collections
```

This creates `outputs/Fyrklovern/Matrixify files/Collections/Fyrklovern collections - full Matrixify import.xlsx` with a
single `Collections` sheet. It does not read, include, or assign products.
Fyrklövern category handles are title-based; category IDs are not appended to
them.

Create the Matrixify product import with its linked collection handles:

```bash
npm run export:fyrklovern:products
```

This creates `outputs/Fyrklovern/Matrixify files/Products/Fyrklovern products - full Matrixify import.xlsx`. The
product rows use Matrixify's `Custom Collections` column, populated with the
handles from `fyrklovern-categories.json`.

### Shopify standard language import (Fyrklövern)

Swedish (`sv-SE`) is the migrated/default language. To create a standard
Shopify language-import CSV for the other locales, first export translations
from **Shopify admin → Settings → Languages → Export**. The Shopify export is
needed to retain Shopify's resource IDs; source product IDs and category IDs
are not Shopify IDs.

```bash
npm run export:fyrklovern:shopify-language-translations -- \
  --input="C:\\Users\\Eddie Peters\\Downloads\\fyrklovern_custom_export-with_familycode_updated-2026-09-22 (1).xlsx" \
  --shopify-export="C:\\path\\shopify-language-export.csv"
```

The resulting `outputs/Fyrklovern/Shopify language import/Fyrklovern multilingual content - Shopify language import.csv` is
UTF-8, comma-delimited, and preserves Shopify's standard headers. It fills
only non-empty translations for product and collection titles, descriptions,
SEO titles, and SEO descriptions. Review the accompanying `-report.json` for
unmatched or duplicate Swedish titles before importing it through **Settings →
Languages → Import**.

## 📝 Available Commands

### Differential top-up migration (Fyrklövern)

Export live baselines from Matrixify before running the command. The Products
export must contain `ID`, `Handle`, `Variant SKU`, `Image Src`, `Image Position`,
`Image Alt Text`, and all `custom.*` metafields. The Collections export must
contain `Handle`, `Sort Order`, `Sort: Position`, `Sort: Product ID`, and
`Sort: Product Handle`.

```bash
npm run topup:fyrklovern -- --live-products="C:\\Exports\\products.xlsx" --live-collections="C:\\Exports\\collections.xlsx" --translation-export="C:\\Exports\\translations.csv" --output-dir="outputs\\fyrklovern-topup"
```

It writes separate Matrixify workbooks for products, media, collection
positions, recommendations, and translations, plus a Shopify language CSV and
an audit report. Import new products first. The report defers native Shopify
translation rows for products that do not yet have Shopify resource IDs; export
translations again after product import and rerun the command to create them.

### Sync Commands (Fetch + Export)

| Command               | Description               |
| --------------------- | ------------------------- |
| `npm run sync`        | Sync all data for Store   |
| `npm run sync:store2` | Sync all data for Store 2 |

### Fetch Commands (From Vendre API)

| Command                     | Description                                             |
| --------------------------- | ------------------------------------------------------- |
| `npm run fetch`             | Fetch all data types (products, collections, customers) |
| `npm run fetch:store2`      | Fetch all data for Store 2                              |
| `npm run fetch:products`    | Fetch products only                                     |
| `npm run fetch:collections` | Fetch collections only                                  |
| `npm run fetch:customers`   | Fetch customers only                                    |

### Export Commands (To Matrixify Excel)

| Command                       | Description                                    |
| ----------------------------- | ---------------------------------------------- |
| `npm run export`              | Export all data types to Excel                 |
| `npm run export:store2`       | Export all data for Store 2                    |
| `npm run export:products`     | Export products only                           |
| `npm run export:collections`  | Export collections only                        |
| `npm run export:customers`    | Export customers only                          |
| `npm run export:translations` | Export Matrixify translations for products and collections |

### Advanced Usage

```bash
# Run with custom environment file
ENV_FILE=.env.store node src/index.js --command=fetch --type=products

# Available options:
#   --command=<cmd>        Command to run (sync, fetch, export)
#   --type=<type>          Data type (all, products, collections, customers, translations)
#   --help                 Show help

# The store is determined by the ENV_FILE you specify
# Each .env file contains STORE_NAME which identifies the store
```

## 📤 Output Files

All output files are saved to store-specific subdirectories under `results/`:

```
results/
├── store/           # Store outputs
│   ├── store-products.json
│   ├── store-matrixify-products.xlsx
│   └── ...
└── store2/                # Store 2 outputs
    ├── store2-products.json
    ├── store2-matrixify-products.xlsx
    └── ...
```

### JSON Files (Intermediate Data)

- `results/store/store-products.json` - All products from Vendre
- `results/store/store-collections.json` - All collections from Vendre
- `results/store/store-customers.json` - All customers from Vendre

### Excel Files (Matrixify Format)

**Products:**

- `results/store/store-matrixify-products.xlsx` - Full product import
- `results/store/store-matrixify-price-update.xlsx` - Price updates only
- `results/store/store-vendor-update.xlsx` - Vendor updates only
- `results/store/store-matrixify-inventory-update.xlsx` - Inventory tracker and stock counts

**Collections:**

- `results/store/store-matrixify-collections.xlsx` - Full collection import
- `results/store/store-collection-metafields.xlsx` - Parent-child metafields
- `results/store/store-subcollections-update.xlsx` - Subcollection relationships
- `results/store/store-matrixify-product-collections.xlsx` - Product assignments

**Customers:**

- `results/store/store-customers-matrixify.xlsx` - All customers
- `results/store/store-customers-no-phone-matrixify.xlsx` - Customers without phone

**Translations:**

- `results/store/store-translations.xlsx` - Swedish to English Matrixify `Translations` workbook for products and collections

## 🔄 Workflow

### Typical Import Workflow

1. **Fetch data from Vendre:**

   ```bash
   npm run fetch
   ```

2. **Review JSON files** in `results/` folder (optional)

3. **Export to Matrixify format:**

   ```bash
   npm run export
   ```

4. **Upload Excel files to Shopify** via Matrixify app

### Or use the combined sync command:

```bash
npm run sync
```

### Translation Workflow

Translations are generated directly from the multilingual Vendre product and collection data:

1. **Fetch the latest Vendre data:**

   ```bash
   npm run fetch
   ```

2. **Optional: add Shopify product export CSVs**
   - Save them as `results/store/products_export_1.csv` (and `_2.csv` if needed)
   - This lets the exporter reuse your live Shopify product handles when they differ from the normalized Vendre handles

3. **Optional: add Matrixify translation export CSVs**
   - Save any translation export CSVs in `results/store/`
   - If present, the exporter fills `Entity ID` for matching products and collections automatically

4. **Generate translation import:**

   ```bash
   npm run export:translations
   ```

5. **Upload to Shopify via Matrixify:**
   - Import `results/store/store-translations.xlsx`
   - The workbook contains a `Translations` sheet with Matrixify columns:
     `Entity`, `Entity ID`, `Entity Handle`, `Field`, `Original Value`, and `Translation Value: en`

**Note:** `Entity Handle` is always populated and is the primary import key. `Entity ID` is optional and will be filled when matching translation export CSVs are available.

## 🏗️ Architecture

### Key Improvements

- **Eliminated ~500 lines of duplicated code** - Shared utilities consolidate 6+ implementations of handle generation, collection disambiguation logic (300+ LOC duplicated in 4 files), and pagination
- **Multi-store support** - Configuration-based approach for managing multiple Vendre stores
- **Clean separation of concerns** - API → Transform → Export pipeline
- **Maintainable** - Single source of truth for business logic
- **Type-safe schemas** - Centralized Matrixify column definitions

### Data Flow

```

Vendre API
↓
VendreClient (api/vendre-client.js)
↓
Raw JSON (results/_.json)
↓
Transformers (transformers/_.js)
↓
Normalized Objects
↓
Exporters (exporters/matrixify-_.js)
↓
Excel Files (results/_.xlsx)
↓
Matrixify Import to Shopify

```

## 🐛 Troubleshooting

### API Key Errors

```

Error: API key not configured for store 'store'

```

**Solution:** Add `API_KEY=your-api-key` to your `.env.store` file

### Missing Data Files

```
Error: File not found: results/store/store-products.json
```

**Solution:** Run `npm run fetch` before `npm run export`

### Placeholder API Key

```
Error: API_KEY appears to be a placeholder
```

**Solution:** Replace `your-store-api-key-here` with your actual API key in the `.env` file

## 🔀 Migration from Legacy Scripts

The new structure is **additive** - your old scripts still work! Migrate at your own pace:

1. **Keep using legacy scripts** for quick one-off tasks
2. **Try new structure** for regular imports: `npm run sync`
3. **Gradually adopt** new commands as you get comfortable

Both approaches can coexist indefinitely.

## 📚 Further Documentation

- **Utilities:** See comments in `src/utils/*.js` for detailed API documentation
- **Configuration:** See `.env.example` for all available environment variables
- **Multi-Store Setup:** See `.env.store` and `.env.store2` for examples
- **Legacy Scripts:** Original documentation in `scripts/` folder comments
- **Migration Guide:** See `MIGRATION.md` for detailed migration instructions

## 🤝 Contributing

When adding new features:

1. Add shared logic to `src/utils/`
2. Create store-specific config in `src/config/stores.js`
3. Follow the Transform → Export pattern
4. Update this README with new commands
