# Migration Guide: New Structure

This guide helps you get started with the new import script structure.

## ✅ What's Been Done

### New Structure Created

A complete new `src/` directory with:

- ✅ **Shared Utilities** - Eliminated ~500 lines of duplicated code
  - Fields handling (bilingual values, Swedish text normalization)
  - Handle generation (6+ implementations → 1)
  - Collection disambiguation (300+ LOC duplicated in 4 files → 1)
  - HTML sanitization
  - Safe file I/O

- ✅ **API Client** - Reusable Vendre API client
  - Generic pagination (3 implementations → 1)
  - Products, Collections, Customers fetching
  - Error handling

- ✅ **Multi-Store Configuration**
  - Store-specific settings (API URLs, keys, tax rates, etc.)
  - Easy to add new stores
  - Environment variable support

- ✅ **Transformers** - Normalize Vendre data
  - Products (with pricing, specs, images)
  - Collections (with hierarchy, disambiguation)
  - Customers (with phone formatting)

- ✅ **Exporters** - Generate Matrixify Excel files
  - Products (full, price updates, vendor updates)
  - Collections (full, metafields, subcollections, assignments)
  - Customers (all, no-phone variants)

- ✅ **CLI & Commands**
  - Simple npm scripts for common workflows
  - Flexible command-line interface
  - Combined sync command (fetch + export)

### Legacy Scripts Preserved

All your original scripts in `scripts/` are unchanged and still work!

## 🚀 Getting Started

### 1. Set Up Environment

Copy the example environment file:

```bash
cp .env.example .env
```

Edit `.env` and add your API keys:

```env
SECRET_KEY=your-actual-api-key
```

### 2. Test the New Structure

Try fetching products only (quick test):

```bash
npm run fetch:products
```

This will create `results/dragonslair-products.json`

### 3. Export to Matrixify

Export the products you just fetched:

```bash
npm run export:products
```

This will create several Excel files in `results/`:

- `dragonslair-matrixify-products.xlsx`
- `dragonslair-matrixify-price-update.xlsx`
- `dragonslair-vendor-update.xlsx`

### 4. Full Sync (Recommended)

Once you're comfortable, use the all-in-one sync:

```bash
npm run sync
```

This fetches everything from Vendre and exports all Matrixify files.

## 📊 Comparison: Old vs New

### Old Way (Still Works!)

```bash
# Multiple commands needed:
npm run fetch-products
npm run fetch-collections
# ... wait ...
npm run export-products
npm run export-collections
npm run update-product-collections
npm run update-subcollections
# ... etc
```

### New Way

```bash
# One command:
npm run sync
```

Or, for specific tasks:

```bash
npm run fetch:products    # Just products
npm run export:collections # Just collections
```

## 🏪 Adding a Second Store (Legacy Method)

**Note:** This method is deprecated. Use the [Environment-Based Multi-Store Configuration](#environment-based-multi-store-configuration-new) below instead.

<details>
<summary>Click to expand legacy method</summary>

### 1. Update Configuration

Edit `src/config/stores.js`:

```javascript
store2: {
    name: 'My Second Store',
    apiUrl: 'https://mystore.com/API/1',
    apiKey: process.env.STORE2_API_KEY,
    outputPrefix: 'mystore',
    taxClasses: { "2": 25, "3": 6, "4": 12, "5": 0 },
    // ... copy other settings from dragonslair
},
```

### 2. Add API Key to .env

```env
STORE2_API_KEY=your-second-store-api-key
```

### 3. Run Sync

```bash
npm run sync:store2
```

Output files will be prefixed with `mystore-`:

- `results/mystore-products.json`
- `results/mystore-matrixify-products.xlsx`
- etc.

</details>

## 🏪 Environment-Based Multi-Store Configuration (New!)

The latest update simplifies multi-store management by using separate `.env` files for each store instead of editing code.

### What Changed?

**Before:** Stores were defined in `src/config/stores.js` with API keys from one `.env` file

**After:** Each store has its own `.env.storename` file with all configuration

### Benefits

- ✅ **Complete separation** - Each store's config is in its own file
- ✅ **No code changes** - Add stores without touching `src/config/stores.js`
- ✅ **Better security** - Store-specific credentials kept separate
- ✅ **Cleaner outputs** - Each store has its own `results/storename/` subdirectory

### How to Migrate

#### Step 1: Create Store-Specific .env Files

For Dragons Lair, create `.env.dragonslair`:

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

# Spec Field IDs
SPEC_FIELD_BGG_ID=1603
SPEC_FIELD_YEAR_PUBLISHED=1604
SPEC_FIELD_MIN_PLAYERS=1605
SPEC_FIELD_MAX_PLAYERS=1606
SPEC_FIELD_PLAY_TIME=1608
SPEC_FIELD_MIN_AGE=1609
SPEC_FIELD_BGG_WEIGHT=1610
SPEC_FIELD_BGG_COMPLEXITY=1611
SPEC_FIELD_MECHANICS=1612
SPEC_FIELD_DESIGNERS=1613
SPEC_FIELD_PUBLISHERS=1614

# Customer Tags
CUSTOMER_TAG_IMPORT=vendre-import
CUSTOMER_TAG_INACTIVE=inactive

# Phone Formatting
PHONE_COUNTRY_CODE=+46
PHONE_REMOVE_LEADING_ZERO=true
```

For a second store, create `.env.store2` with the same structure but different values.

**See `.env.example` for a complete template.**

#### Step 2: Install cross-env Dependency

```bash
npm install
```

This installs `cross-env` which was added to support environment variables on Windows.

#### Step 3: Update Your API Keys

Move your API key from the old `.env` file to the new store-specific files:

- Old: `SECRET_KEY=...` in `.env`
- New: `API_KEY=...` in `.env.dragonslair`

#### Step 4: Test the New Setup

```bash
npm run sync   # Now uses .env.dragonslair automatically
```

Output files will go to `results/dragonslair/` instead of `results/`

#### Step 5: Migrate Your Existing Files (Optional)

If you have existing output files in `results/`, you can organize them:

```bash
# Create store subdirectories (already done)
# Move existing files
move results\dragonslair-*.json results\dragonslair\
move results\dragonslair-*.xlsx results\dragonslair\
```

Or just leave them - the new structure uses subdirectories, old files won't interfere.

### New Directory Structure

```
results/
├── dragonslair/              # Dragons Lair outputs
│   ├── dragonslair-products.json
│   ├── dragonslair-matrixify-products.xlsx
│   └── ...
├── store2/                   # Store 2 outputs
│   ├── store2-products.json
│   ├── store2-matrixify-products.xlsx
│   └── ...
└── (old files can stay here)
```

### Running Commands

#### Old Way

```bash
node src/index.js --store=dragonslair --command=sync
```

#### New Way

```bash
npm run sync              # Uses .env.dragonslair (configured in package.json)
npm run sync:store2       # Uses .env.store2
```

Or manually specify the environment file:

```bash
ENV_FILE=.env.dragonslair node src/index.js --command=sync
```

### Troubleshooting

#### "STORE_NAME not found in environment variables"

Make sure you're using the npm scripts (`npm run sync`) or setting `ENV_FILE`:

```bash
ENV_FILE=.env.dragonslair npm run help
```

#### "API_KEY appears to be a placeholder"

Update your `.env.dragonslair` file with the actual API key:

```env
API_KEY=your-actual-api-key-here  # Replace this!
```

#### Scripts still using old --store parameter

The CLI still accepts `--store` for backward compatibility, but it's ignored. The store is determined by the `ENV_FILE` and `STORE_NAME` within that file.

### Adding a Third Store

1. Copy `.env.example` to `.env.storename`
2. Update all values in the new file
3. Add npm scripts in `package.json`:
   ```json
   "sync:storename": "cross-env ENV_FILE=.env.storename node src/index.js --command=sync"
   ```
4. Run `npm run sync:storename`

## 🔄 Gradual Migration Strategy

You don't have to switch everything at once!

### Week 1: Test Fetch

- Use new structure for fetching only
- Keep using old scripts for exports
- Compare outputs to ensure accuracy

### Week 2: Test Exports

- Fetch with new structure
- Export with new structure
- Compare Excel files with old script outputs

### Week 3: Full Adoption

- Use `npm run sync` for complete workflows
- Keep old scripts as backup

### Ongoing: Both Coexist

- Use new structure for regular syncs
- Keep old scripts for edge cases or one-off tasks

## 🐛 Common Issues

### Issue: "API key not configured"

**Solution:** Make sure your `.env` file exists and has `SECRET_KEY=...`

### Issue: "File not found: results/dragonslair-products.json"

**Solution:** Run fetch before export:

```bash
npm run fetch
npm run export
```

Or use sync:

```bash
npm run sync
```

### Issue: Old scripts stopped working

**Solution:** Old scripts should still work. Check that files are still in `scripts/` folder. If paths changed, update package.json scripts.

## 📁 Output File Naming

### Single Store

If you only use Dragons Lair:

- `dragonslair-products.json`
- `dragonslair-matrixify-products.xlsx`

### Multiple Stores

Each store gets its own prefix:

- `dragonslair-products.json`
- `mystore-products.json`
- `dragonslair-matrixify-products.xlsx`
- `mystore-matrixify-products.xlsx`

No confusion, no overwrites!

## 🎯 Next Steps

1. **Try the new structure** with a small test (just products)
2. **Compare outputs** with your old scripts
3. **Gradually adopt** for regular imports
4. **Keep old scripts** as backup
5. **Configure second store** if needed
6. **Enjoy cleaner, maintainable code!**

## 📞 Need Help?

- Check the main [README.md](README.md) for full documentation
- Review code comments in `src/` files for detailed API docs
- Old scripts in `scripts/` still work as before

---

**Remember:** The new structure is designed to **coexist** with your old scripts. Take your time migrating, and use whichever approach works best for each task!
