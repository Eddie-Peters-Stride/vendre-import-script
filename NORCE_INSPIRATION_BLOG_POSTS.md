# Norce inspiration Blog Posts drafts

Run `npm run norce:build-inspiration-blog-posts` from the repository root. The script reads the Swedish category export and completed channel 1 StoreAPI collection cache. It makes no Shopify API calls and does not update the cache. Optional flags are `--categories=...`, `--cache=...`, `--output-dir=...`, and `--blog-handle=inspiration`. The destination handle is fixed to the user-confirmed `inspiration` blog.

The output directory is `outputs/Fyrklovern/Matrixify files/Blog Posts/Norce inspiration drafts/`:

- `Norce inspiration - Blog Posts drafts.xlsx`: Matrixify `Blog Posts` sheet with `NEW` unpublished drafts. Routes and category IDs must match the source export exactly. Source CMS text and images are rendered in component order.
- `Norce inspiration - QA.xlsx`: per-page source/omission review, separate redirect candidates, and import preconditions. Redirect candidates are **not** included in the Blog Posts import workbook.

Six entries are held: `/inspiration` landing (243), hidden Never Boring (410), custom Härliga midsommar copy (no category), Herlige sommerfester NO/DK (610, Swedish source content), Minnesvärd midsommarfest (501, header only), and Skapa magi på julbordet med Disney (590, no current CMS items). Old snapshot and historical CMS content do not fill missing current content.

Before importing, verify that the Shopify `inspiration` blog exists, check existing Blog Post handles, review omitted linked product/inspiration blocks and external Norce image URLs, and inspect route/redirect collisions with existing Collections. The supplied timestamps are not used as publish dates. Keep these rows unpublished until editorial review is complete.

Run `node test/fyrklovern-inspiration-blog-posts.test.js` for the focused tests.
