# Vendre-to-Matrixify Import Scripts

Clean, maintainable import scripts for syncing data from Vendre to Shopify via Matrixify.

## 🚀 Quick Start

### New Structure (Recommended)

```bash
# Sync all data for Dragons Lair (fetch from Vendre + export to Matrixify)
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

#### Dragons Lair Store

Create `.env.dragonslair` in the project root:

```env
# Store Information
STORE_NAME=dragonslair
STORE_DISPLAY_NAME=Dragons Lair
API_URL=https://dragonslair.se/API/1
API_KEY=your-dragonslair-api-key-here

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

## 📝 Available Commands

### Sync Commands (Fetch + Export)

| Command               | Description                    |
| --------------------- | ------------------------------ |
| `npm run sync`        | Sync all data for Dragons Lair |
| `npm run sync:store2` | Sync all data for Store 2      |

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
| `npm run export:translations` | Export translations (requires Shopify exports) |

### Advanced Usage

```bash
# Run with custom environment file
ENV_FILE=.env.dragonslair node src/index.js --command=fetch --type=products

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
├── dragonslair/           # Dragons Lair outputs
│   ├── dragonslair-products.json
│   ├── dragonslair-matrixify-products.xlsx
│   └── ...
└── store2/                # Store 2 outputs
    ├── store2-products.json
    ├── store2-matrixify-products.xlsx
    └── ...
```

### JSON Files (Intermediate Data)

- `results/dragonslair/dragonslair-products.json` - All products from Vendre
- `results/dragonslair/dragonslair-collections.json` - All collections from Vendre
- `results/dragonslair/dragonslair-customers.json` - All customers from Vendre

### Excel Files (Matrixify Format)

**Products:**

- `results/dragonslair/dragonslair-matrixify-products.xlsx` - Full product import
- `results/dragonslair/dragonslair-matrixify-price-update.xlsx` - Price updates only
- `results/dragonslair/dragonslair-vendor-update.xlsx` - Vendor updates only

**Collections:**

- `results/dragonslair/dragonslair-matrixify-collections.xlsx` - Full collection import
- `results/dragonslair/dragonslair-collection-metafields.xlsx` - Parent-child metafields
- `results/dragonslair/dragonslair-subcollections-update.xlsx` - Subcollection relationships
- `results/dragonslair/dragonslair-matrixify-product-collections.xlsx` - Product assignments

**Customers:**

- `results/dragonslair/dragonslair-customers-matrixify.xlsx` - All customers
- `results/dragonslair/dragonslair-customers-no-phone-matrixify.xlsx` - Customers without phone

**Translations:**

- `results/dragonslair/dragonslair-translations.xlsx` - Swedish → English translations (Shopify Translate & Adapt format)

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

Translations require existing Shopify product data:

1. **Export products from Shopify:**
   - Export all products as CSV (via Shopify admin or Matrixify)
   - Save as `results/dragonslair/products_export_1.csv` (and `_2.csv` if needed)

2. **Export translations from Shopify:**
   - Use Shopify's "Translate & Adapt" app to export translations
   - Save as `results/dragonslair/dragonslair_translations_*.csv`

3. **Generate translation import:**

   ```bash
   npm run export:translations
   ```

4. **Upload to Shopify:**
   - Import `results/dragonslair/dragonslair-translations.xlsx` via Translate & Adapt app

**Note:** Translations map Vendre SKUs to Shopify product IDs, so you need the Shopify export files first in the store's subdirectory.

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

Error: API key not configured for store 'dragonslair'

```

**Solution:** Add `API_KEY=your-api-key` to your `.env.dragonslair` file

### Missing Data Files

```
Error: File not found: results/dragonslair/dragonslair-products.json
```

**Solution:** Run `npm run fetch` before `npm run export`

### Placeholder API Key

```
Error: API_KEY appears to be a placeholder
```

**Solution:** Replace `your-dragonslair-api-key-here` with your actual API key in the `.env` file

## 🔀 Migration from Legacy Scripts

The new structure is **additive** - your old scripts still work! Migrate at your own pace:

1. **Keep using legacy scripts** for quick one-off tasks
2. **Try new structure** for regular imports: `npm run sync`
3. **Gradually adopt** new commands as you get comfortable

Both approaches can coexist indefinitely.

## 📚 Further Documentation

- **Utilities:** See comments in `src/utils/*.js` for detailed API documentation
- **Configuration:** See `.env.example` for all available environment variables
- **Multi-Store Setup:** See `.env.dragonslair` and `.env.store2` for examples
- **Legacy Scripts:** Original documentation in `scripts/` folder comments
- **Migration Guide:** See `MIGRATION.md` for detailed migration instructions

## 🤝 Contributing

When adding new features:

1. Add shared logic to `src/utils/`
2. Create store-specific config in `src/config/stores.js`
3. Follow the Transform → Export pattern
4. Update this README with new commands

## 📄 License

Internal use only - Dragons Lair

```

```
