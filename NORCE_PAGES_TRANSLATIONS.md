# Norce Pages to Shopify Pages translations

The October 22 Matrixify Pages export contains 26 Shopify Pages with IDs. This workflow uses Norce StoreAPI `pages` and `page(id)` for current page components across the eight configured channels. The second query includes known hidden Page IDs that are absent from the published `pages` list. `om-oss` uses the completed category 1294 cache, whose Swedish body matches the Shopify Page.

Run:

```text
npm run norce:fetch-pages
npm run norce:build-page-translations
node test/fyrklovern-page-translations.test.js
```

The fetch saves one JSON checkpoint per channel under `cache/norce-pages/`. It skips existing checkpoints; pass `--refresh` to update them. The builder uses only those checkpoints, `cache/norce-collections-cache.xlsx`, and `exports/Export_2026-10-22_150343.xlsx`. Neither command writes to Shopify.

Outputs are in `outputs/Fyrklovern/Matrixify files/Pages/Translations staging/`:

- `Shopify Pages - verified translations.xlsx`: Matrixify `Translations` rows for supported localized Title and Body HTML fields. Each row has one locale value, the verified Shopify Page ID and handle, and no blank translation value.
- `Shopify Pages - translation review.xlsx`: all 26 Page identities, Swedish source matching, fields still needing translations, locale coverage, embedded links, pending body differences, and import preconditions. **Do not import the review workbook.**

The builder compares Shopify's Swedish Body HTML text with Norce Swedish page content. If the bodies differ, it holds Body HTML translations, including the `information` and `retail` pages. It omits missing locales and obvious Swedish body fallbacks. The external iframe on `servisguiden` is compared as HTML, preserving its locale-specific URL. SEO translations are omitted because the exported base SEO fields are empty. It does not change Shopify Pages, handles, templates, or publication state.

Current unresolved Pages: `contact` has no content; `cancelorder` has no verified Norce page counterpart; `prova-tallrik-hemma` has a matching Norce Page name but no current CMS body. Some other Pages have partial locale coverage. Review legal and market-specific text, links, and any existing Shopify translations before import.

Sources: [Norce StoreAPI Page schema](https://storeapi-schema.norce.io/), [Matrixify Pages](https://matrixify.app/documentation/pages/), and [Matrixify Translations](https://matrixify.app/documentation/translations/).
