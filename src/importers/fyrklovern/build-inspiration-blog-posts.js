/** Offline Norce inspiration -> staged Matrixify Blog Posts drafts. No Shopify writes. */
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { loadCache, progressOf, rawOf } = require('./norce-extraction/cache');
const { readCategoryWorkbook } = require('./norce-source-ingestion');

const ROUTES = [
  [507, '5 dukningstips till påsk', '/inspiration/dukningstips/hogtider/5-dukningstips-till-pask'],
  [500, 'Kräftkalas', '/inspiration/dukningstips/festliga-tillfallen/kraftkalas'],
  [637, 'Sensommarkväll', '/inspiration/dukningstips/sasonger/sommarkvall'],
  [646, 'Magisk sommarfrukost', '/inspiration/dukningstips/sasonger/sommarfrukost'],
  [589, 'Duka för en minnesvärd jul', '/inspiration/dukningstips/hogtider/duka-for-en-minnesvard-jul'],
  [591, '5 dukningstips till Halloween', '/inspiration/dukningstips/festliga-tillfallen/5-dukningstips-till-halloween'],
  [499, 'Vardagslyx', '/inspiration/dukningstips/vardag/vardagslyx'],
  [635, 'Herrgårdsdrömmar', '/inspiration/dukningstips/festliga-tillfallen/herrgardsdrommar'],
  [636, 'När hav möter porslin', '/inspiration/dukningstips/festliga-tillfallen/nar-hav-moter-porslin'],
  [411, 'Stilfull påskdukning i blåvitt och rosa', '/inspiration/dukningstips/hogtider/stilfull-paskdukning-i-blavitt-och-rosa'],
  [552, 'Drömmigt vårmingel', '/inspiration/dukningstips/sasonger/drommigt-varmingel'],
  [610, 'Herlige sommerfester', '/inspiration/dukningstips/hogtider/harliga-midsommar-nodk'],
  [506, 'Härliga midsommar SE/FI', '/inspiration/dukningstips/hogtider/harliga-midsommar'],
  [501, 'Minnesvärd midsommarfest', '/inspiration/dukningstips/hogtider/minnesvard-midsommarfest'],
  [590, 'Skapa magi på julbordet med Disney', '/inspiration/dukningstips/hogtider/skapa-magi-pa-julbordet-med-disney'],
  [412, 'Trend - Duka i lila och grönt', '/inspiration/trender/trend-duka-i-lila-och-gront'],
  [498, 'Drömmar om Toscana', '/inspiration/dukningstips/sasonger/drommar-om-toscana'],
].map(([categoryId, title, route]) => ({ categoryId: String(categoryId), title, route }));
const HELD = [
  { categoryId: '243', title: 'Inspiration landing', route: '/inspiration', reason: 'Navigation landing page; blog article mapping requires review' },
  { categoryId: '410', title: 'Never Boring', route: '', reason: 'Hidden entry; archived route requires review' },
  { categoryId: '', title: 'Härliga midsommar org (copy)', route: '', reason: 'No verified source category or route' },
  { categoryId: '610', title: 'Herlige sommerfester', route: '/inspiration/dukningstips/hogtider/harliga-midsommar-nodk', reason: 'NO/DK title has Swedish midsummer CMS body; verified localized editorial content required' },
];
const BLOG_HEADERS = ['Blog: Handle', 'Handle', 'Command', 'Title', 'Body HTML', 'Summary HTML', 'Published', 'Tags', 'Image Src', 'Image Alt Text'];
const BLOG_LOCALES = Object.freeze({ no: 2, da: 3, fi: 4, de: 5, en: 6, nl: 7 });
const BLOG_TRANSLATION_HEADERS = ['Entity', 'Entity ID', 'Entity Handle', 'Field', ...Object.keys(BLOG_LOCALES).map(locale => `Translation Value: ${locale}`)];
const esc = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const canonical = route => `/${String(route || '').trim().replace(/^\/+|\/+$/g, '')}`.toLowerCase();
const prop = (item, name) => item?.properties?.find(p => p.name === name)?.value?.value ?? '';
const safeUrl = value => /^https:\/\//i.test(String(value || '').trim()) ? String(value).trim() : '';

function safeHtml(html) {
  let input = String(html || '');
  input = input.replace(/<\s*(script|style|iframe|object|embed|form|svg)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '');
  input = input.replace(/<!--[\s\S]*?-->/g, '');
  const allowed = new Set(['p','br','strong','b','em','i','u','ul','ol','li','h2','h3','h4','blockquote','span','a']);
  return input.replace(/<\/?[a-z][^>]*>/gi, tag => {
    const match = /^<\s*(\/?)\s*([a-z][\w-]*)/i.exec(tag);
    if (!match || !allowed.has(match[2].toLowerCase())) return '';
    const name = match[2].toLowerCase();
    if (match[1]) return `</${name}>`;
    if (name === 'br') return '<br>';
    if (name === 'a') {
      const href = /\bhref\s*=\s*(['"])(.*?)\1/i.exec(tag)?.[2] || '';
      const safe = safeUrl(href) || (/^\/(?!\/)/.test(href) ? href : '');
      return safe ? `<a href="${esc(safe)}">` : '<a>';
    }
    return `<${name}>`;
  });
}

function renderComponents(items) {
  const html = [], review = [], images = [];
  for (const [index, item] of (items || []).entries()) {
    const type = item.type;
    const at = index + 1;
    if (type === 'Content Page Header') {
      if (prop(item, 'heading')) html.push(`<h2>${esc(prop(item, 'heading'))}</h2>`);
      if (prop(item, 'content')) html.push(safeHtml(prop(item, 'content')));
    } else if (type === 'Text Block') {
      if (prop(item, 'content')) html.push(safeHtml(prop(item, 'content')));
    } else if (type === 'Big Quote') {
      if (prop(item, 'text')) html.push(`<blockquote>${safeHtml(prop(item, 'text'))}</blockquote>`);
    } else if (type === 'Content Page Image Section') {
      for (const child of item.children || []) {
        if (child.type !== 'contentPageImage') { review.push({ position: at, type: child.type, issue: 'Unsupported image child' }); continue; }
        const src = safeUrl(prop(child, 'image'));
        if (!src) { review.push({ position: at, type, issue: 'Missing or unsafe image URL' }); continue; }
        images.push({ src, alt: String(prop(child, 'alt') || '') });
        html.push(`<figure><img src="${esc(src)}" alt="${esc(prop(child, 'alt'))}">${prop(child, 'caption') ? `<figcaption>${esc(prop(child, 'caption'))}</figcaption>` : ''}</figure>`);
        if (prop(child, 'link')) review.push({ position: at, type, issue: 'Image link omitted pending target verification' });
      }
    } else if (type === 'InspirationBlock') {
      if (prop(item, 'miniTitle')) html.push(`<p>${esc(prop(item, 'miniTitle'))}</p>`);
      if (prop(item, 'title')) html.push(`<h2>${esc(prop(item, 'title'))}</h2>`);
      if (prop(item, 'text')) html.push(safeHtml(prop(item, 'text')));
      if (prop(item, 'content')) html.push(safeHtml(prop(item, 'content')));
      for (const child of item.children || []) {
        if (child.type === 'imageItem') {
          const src = safeUrl(prop(child, 'image'));
          if (src) {
            images.push({ src, alt: String(prop(child, 'alt') || '') });
            html.push(`<figure><img src="${esc(src)}" alt="${esc(prop(child, 'alt'))}"></figure>`);
          } else review.push({ position: at, type: `${type}/${child.type}`, issue: 'Missing or unsafe image URL' });
        } else if (child.type !== 'themeSelector') review.push({ position: at, type: `${type}/${child.type}`, issue: 'Linked or nested inspiration content requires mapping review' });
      }
    } else if (type === 'ProductsBlock' || type === 'Link Row') {
      review.push({ position: at, type, issue: 'Linked products or navigation omitted pending mapping review' });
    } else if (type === 'DividerBlock') {
      if (prop(item, 'title')) html.push(`<h2>${esc(prop(item, 'title'))}</h2>`);
      if (prop(item, 'linkUrl')) review.push({ position: at, type, issue: 'Divider link omitted pending target verification' });
    } else review.push({ position: at, type: type || '', issue: 'Unsupported component' });
  }
  return { html: html.filter(Boolean).join('\n'), images, review };
}

function chooseSource(id, cache, channel = 1) {
  if (progressOf(cache, id, channel, 'category')?.Status === 'COMPLETE') {
    const category = rawOf(cache, id, channel, 'category');
    if (category?.data?.items) return { category, source: 'current-cache', at: progressOf(cache, id, channel, 'category')?.['Last Success'] || '' };
  }
  // The older snapshot is diagnostic only; it must never supply an import row.
  return null;
}

function build({ categories, cache, blogHandle = 'inspiration' }) {
  if (blogHandle !== 'inspiration') throw new Error('Destination blog handle must be explicitly verified as inspiration');
  const posts = [], translations = [], missingTranslations = [], conflicts = [], qa = [], redirects = [];
  for (const entry of HELD) qa.push({ 'Category ID': entry.categoryId, 'Requested Title': entry.title, 'Source Route': entry.route, Status: 'HELD', Reason: entry.reason });
  for (const entry of ROUTES) {
    if (entry.categoryId === '610') continue;
    const source = categories.filter(row => row.categoryId === entry.categoryId && row.culture === 'sv-SE');
    const exact = source.filter(row => row.permalinks.some(link => canonical(link.Link) === canonical(entry.route)));
    const base = { 'Category ID': entry.categoryId, 'Requested Title': entry.title, 'Source Route': entry.route };
    if (exact.length !== 1 || source.length !== 1 || source[0].permalinkConflict) {
      qa.push({ ...base, Status: 'HELD', Reason: 'Unique category and exact permalink could not be verified' }); continue;
    }
    const found = chooseSource(entry.categoryId, cache);
    if (!found) { qa.push({ ...base, Status: 'HELD', Reason: 'No complete Swedish StoreAPI content' }); continue; }
    const rendered = renderComponents(found.category.data.items);
    const sourceName = found.category.name || source[0].source.Name || '';
    const handle = entry.route.split('/').filter(Boolean).at(-1);
    const status = rendered.html.replace(/<[^>]*>/g, '').trim().length < 50 ? 'HELD' : 'DRAFT';
    qa.push({ ...base, 'Source Name': sourceName, 'Title Differs': entry.title.trim() !== sourceName.trim() ? 'TRUE' : 'FALSE', 'Blog Handle': blogHandle, 'Post Handle': handle, Status: status, 'Content Source': found.source, 'Source Fetched At': found.at, 'Component Count': found.category.data.items.length, 'Rendered Image Count': rendered.images.length, 'Source SEO Title': source[0].source.pagetitle || '', 'Source SEO Description': source[0].source.metadescription || '', 'Unsupported Details JSON': JSON.stringify(rendered.review), Reason: status === 'HELD' ? 'Insufficient article body content' : rendered.review.length ? 'Review omitted linked or unsupported components before publication' : 'Review draft before publication' });
    if (status === 'HELD') continue;
    const firstImage = rendered.images[0] || {};
    posts.push({ 'Blog: Handle': blogHandle, Handle: handle, Command: 'NEW', Title: entry.title, 'Body HTML': rendered.html, 'Summary HTML': '', Published: 'FALSE', Tags: '', 'Image Src': firstImage.src || '', 'Image Alt Text': firstImage.alt || '' });
    const localized = {};
    for (const [locale, channel] of Object.entries(BLOG_LOCALES)) {
      const match = categories.filter(row => row.categoryId === entry.categoryId && row.culture === ({ no:'nb-NO', da:'da-DK', fi:'fi-FI', de:'de-DE', en:'en-GB', nl:'nl-NL' })[locale]);
      const foundLocalized = chooseSource(entry.categoryId, cache, channel);
      if (match.length !== 1 || !foundLocalized) { missingTranslations.push({ Handle: handle, Locale: locale, Field: 'Title and Body HTML' }); continue; }
      localized[locale] = { title: foundLocalized.category.name || '', body: renderComponents(foundLocalized.category.data.items).html };
      if (!localized[locale].title || !localized[locale].body) missingTranslations.push({ Handle: handle, Locale: locale, Field: !localized[locale].title && !localized[locale].body ? 'Title and Body HTML' : !localized[locale].title ? 'Title' : 'Body HTML' });
    }
    if (localized.de && categories.some(row => row.categoryId === entry.categoryId && row.culture === 'de-DE' && row.market === 'AT')) {
      const at = chooseSource(entry.categoryId, cache, 8);
      if (at && (localized.de.title !== (at.category.name || '') || localized.de.body !== renderComponents(at.category.data.items).html)) {
        conflicts.push({ Handle: handle, Locale: 'de', Markets: 'DE/AT', Issue: 'Different localized values; German translation omitted' });
        delete localized.de;
      }
    }
    for (const [field, valueKey] of [['Title', 'title'], ['Body HTML', 'body']]) {
      const row = { Entity: 'Blog Post', 'Entity ID': '', 'Entity Handle': handle, Field: field };
      for (const [locale, value] of Object.entries(localized)) if (value[valueKey]) row[`Translation Value: ${locale}`] = value[valueKey];
      if (Object.keys(row).some(key => key.startsWith('Translation Value: ') && row[key])) translations.push(row);
    }
    redirects.push({ Path: entry.route, Target: `/blogs/${blogHandle}/${handle}`, 'Category ID': entry.categoryId, Status: 'CANDIDATE ONLY', 'QA Note': 'Existing redirects and collection route use require collision and SEO review; do not import this row directly.' });
  }
  for (const row of qa.filter(row => row['Category ID'] === '610' || row['Category ID'] === '506')) row['NO-DK / SE-FI Content Review'] = 'Cross-market titles and source content require editorial and SEO review';
  return { posts, translations, missingTranslations, conflicts, qa, redirects };
}

function writeWorkbook(file, sheets) {
  const book = XLSX.utils.book_new();
  for (const [name, rows, headers] of sheets) XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(rows, { header: headers }), name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  XLSX.writeFile(book, file);
}

function main(args = process.argv.slice(2)) {
  const get = key => args.find(arg => arg.startsWith(`--${key}=`))?.slice(key.length + 3);
  const root = path.resolve(__dirname, '../../..');
  const categoryFile = get('categories') || 'C:/Users/Eddie Peters/Desktop/Fyrklövern/fyrklovern_custom_export.xlsx';
  const cacheFile = get('cache') || path.join(root, 'cache/norce-collections-cache.xlsx');
  const outputDir = get('output-dir') || path.join(root, 'outputs/Fyrklovern/Matrixify files/Blog Posts/Norce inspiration drafts');
  const categories = readCategoryWorkbook(categoryFile).categories;
  const result = build({ categories, cache: loadCache(cacheFile, 'collections'), blogHandle: get('blog-handle') || 'inspiration' });
  writeWorkbook(path.join(outputDir, 'Norce inspiration - Blog Posts drafts.xlsx'), [['Blog Posts', result.posts, BLOG_HEADERS]]);
  const localeHeaders = BLOG_TRANSLATION_HEADERS.filter(header => !header.startsWith('Translation Value: ') || result.translations.some(row => row[header]));
  writeWorkbook(path.join(outputDir, 'Norce inspiration - Blog Post translations.xlsx'), [['Translations', result.translations, localeHeaders], ['Missing translations', result.missingTranslations], ['Conflicts', result.conflicts]]);
  const preconditions = [
    { Check: 'Destination blog exists', Status: 'UNVERIFIED', Note: 'The user confirmed handle inspiration, but no Shopify Blogs export verifies that this blog exists. Blog: Title is intentionally blank.' },
    { Check: 'Post handles are unused', Status: 'UNVERIFIED', Note: 'No Shopify Blog Posts export was supplied. NEW should reject an existing handle; check before import.' },
    { Check: 'Draft content', Status: 'REVIEW REQUIRED', Note: 'All rows are unpublished drafts. Linked product and inspiration blocks are omitted and listed by component position in QA.' },
    { Check: 'Source images', Status: 'REVIEW REQUIRED', Note: 'Body HTML references Norce source image URLs. Verify asset migration, permissions, and URL longevity.' },
    { Check: 'Redirects', Status: 'REVIEW REQUIRED', Note: 'Redirect candidates are separate from the Blog Posts workbook. Existing redirects and collection routes were not checked for collisions.' },
  ];
  writeWorkbook(path.join(outputDir, 'Norce inspiration - QA.xlsx'), [['QA', result.qa], ['Redirect Candidates', result.redirects], ['Preconditions', preconditions]]);
  console.log(JSON.stringify({ outputDir, drafts: result.posts.length, held: result.qa.filter(row => row.Status === 'HELD').length, redirectCandidates: result.redirects.length }, null, 2));
  return result;
}
if (require.main === module) main();
module.exports = { ROUTES, HELD, BLOG_HEADERS, BLOG_LOCALES, BLOG_TRANSLATION_HEADERS, renderComponents, chooseSource, build, main, safeHtml };
