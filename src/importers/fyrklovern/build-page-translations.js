/** Stage Shopify Page translations without changing the base-language Pages. */
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { loadCache, progressOf, rawOf } = require('./norce-extraction/cache');

const LOCALES = Object.freeze({ no: 2, da: 3, fi: 4, de: 5, en: 6, nl: 7 });
const FIELDS = Object.freeze(['Title', 'Body HTML', 'SEO Title', 'SEO Description']);
const TRANSLATION_HEADERS = ['Entity', 'Entity ID', 'Entity Handle', 'Field', ...Object.keys(LOCALES).map(locale => `Translation Value: ${locale}`)];
const PAGE_IDS = Object.freeze({
  reklamationsratt: 84, 'returer-reklamationer': 77, information: 69, integritetpolicy: 59,
  'vanliga-fragor': 62, 'kontakta-oss': 48, medlemsvillkor: 73, 'fyrklovern-club': 72,
  kopvillkor: 47, 'personlig-radgivning': 79, servisguiden: 81, hallbarhet: 83,
  tallriksgaranti: 80, retail: 70, press: 61, cookiepolicy: 58,
  'for-foretag-och-organisationer': 78, disney: 71, impressum: 76, skotselrad: 60,
  'prova-tallrik-hemma': 75, tavlingsvillkor: 64, yesfyrklovern: 63,
});
const htmlText = value => String(value || '').replace(/<[^>]*>/g, ' ').replace(/&(?:nbsp|#160);/gi, ' ').replace(/\s+/g, ' ').trim();
const property = (item, name) => item?.properties?.find(entry => entry.name === name)?.value?.value || '';

function readPages(file) {
  const workbook = XLSX.readFile(file, { raw: false });
  if (!workbook.Sheets.Pages) throw new Error('Expected a Matrixify Pages sheet');
  const pages = XLSX.utils.sheet_to_json(workbook.Sheets.Pages, { defval: '', raw: false });
  const ids = new Set(), handles = new Set();
  for (const page of pages) {
    const id = String(page.ID || '').trim(), handle = String(page.Handle || '').trim();
    if (!/^\d+$/.test(id) || !handle || ids.has(id) || handles.has(handle)) throw new Error(`Missing or duplicate Page identity: ${id} / ${handle}`);
    ids.add(id); handles.add(handle);
  }
  return pages;
}

function norceAboutUs(cache, page) {
  if (page.Handle !== 'om-oss') return null;
  if (progressOf(cache, '1294', 1, 'category')?.Status !== 'COMPLETE') return null;
  const records = {};
  for (const [locale, channel] of Object.entries(LOCALES)) {
    if (progressOf(cache, '1294', channel, 'category')?.Status !== 'COMPLETE') return null;
    const category = rawOf(cache, '1294', channel, 'category');
    const intro = category?.data?.items?.find(item => item.type === 'InspirationBlock');
    if (!category?.name || !intro || !property(intro, 'content')) return null;
    records[locale] = { title: category.name, miniTitle: property(intro, 'miniTitle'), heading: property(intro, 'title').trim(), body: property(intro, 'content') };
  }
  const source = rawOf(cache, '1294', 1, 'category');
  const intro = source?.data?.items?.find(item => item.type === 'InspirationBlock');
  const swedish = htmlText(property(intro, 'content'));
  const current = htmlText(page['Body HTML']);
  if (!swedish || !current.includes(swedish.slice(0, 90))) return null;
  return records;
}

function localizedAboutBody(base, content) {
  let html = String(base);
  const sections = [...html.matchAll(/<section\b[^>]*>[\s\S]*?<\/section>/gi)];
  if (sections.length !== 1) throw new Error('About us Page template has no unique section');
  html = html.replace(sections[0][0], `<section>\n${content.body}\n</section>`);
  html = html.replace(/(<h3\b[^>]*>)[\s\S]*?(<\/h3>)/i, (_, open, close) => `${open}${content.miniTitle}${close}`);
  html = html.replace(/(<h2\b[^>]*>)[\s\S]*?(<\/h2>)/i, (_, open, close) => `${open}${content.heading}${close}`);
  return html;
}

function loadPageSnapshots(directory) {
  return Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8].map(channel => {
    const file = path.join(directory, `channel-${channel}.json`);
    if (!fs.existsSync(file)) throw new Error(`Missing Norce Page checkpoint: ${file}`);
    const snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Number(snapshot.channel?.id) !== channel || !Array.isArray(snapshot.pages)) throw new Error(`Invalid Norce Page checkpoint: ${file}`);
    return [channel, snapshot];
  }));
}

function pageOf(snapshots, channel, id) {
  return snapshots?.[channel]?.pages?.find(page => String(page.id) === String(id)) || null;
}

function sourceTitle(page, targetTitle) {
  const header = page?.data?.items?.find(item => item.type === 'Content Page Header');
  const heading = property(header, 'heading');
  return heading && heading.trim() === String(targetTitle).trim() ? { mode: 'heading', value: heading } :
    page?.name?.trim() === String(targetTitle).trim() ? { mode: 'name', value: page.name } : null;
}

function localizedTitle(page, mode) {
  if (!page) return '';
  const header = page.data?.items?.find(item => item.type === 'Content Page Header');
  return mode === 'heading' ? property(header, 'heading') : page.name || '';
}

function mainBody(page) {
  const candidates = (page?.data?.items || []).flatMap(item => (item.properties || [])
    .filter(entry => entry.name === 'content' && typeof entry.value?.value === 'string')
    .map(entry => ({ type: item.type, html: entry.value.value })));
  return candidates.sort((a, b) => htmlText(b.html).length - htmlText(a.html).length)[0]?.html || '';
}

function bodyMatch(current, source) {
  const normalize = value => htmlText(value).replace(/\u00a0/g, ' ');
  if (!current || !source) return false;
  if (normalize(current).length < 30 || normalize(source).length < 30) return sameHtml(current, source);
  return normalize(current) === normalize(source);
}
function sameHtml(a, b) { return String(a || '').replace(/\s+/g, ' ').trim() === String(b || '').replace(/\s+/g, ' ').trim(); }
function hasLocalizedChange(source, localized) {
  return htmlText(source).length < 30 ? !sameHtml(source, localized) : !bodyMatch(source, localized);
}
function linksIn(html) {
  const links = [];
  for (const match of String(html || '').matchAll(/\b(href|src)\s*=\s*(["'])(.*?)\2/gi)) links.push({ Attribute: match[1].toLowerCase(), URL: match[3] });
  return links;
}

function build({ pages, cache, snapshots }) {
  const review = [], inputs = [], ready = [], coverage = [], links = [], pendingBodies = [];
  for (const page of pages) {
    const id = String(page.ID), handle = String(page.Handle);
    const about = norceAboutUs(cache, page);
    const norceId = PAGE_IDS[handle];
    const source = norceId ? pageOf(snapshots, 1, norceId) : null;
    const titleSource = sourceTitle(source, page.Title);
    const sourceBody = mainBody(source);
    const bodyVerified = bodyMatch(page['Body HTML'], sourceBody);
    const sourceKind = about ? 'category-1294' : source ? `page-${norceId}` : '';
    const base = { Entity: 'Page', 'Entity ID': id, 'Entity Handle': handle };
    const values = { Title: page.Title, 'Body HTML': page['Body HTML'], 'SEO Title': page['Metafield: title_tag [string]'], 'SEO Description': page['Metafield: description_tag [string]'] };
    const pageStatus = about || (source && (titleSource || bodyVerified)) ? 'VERIFIED_NORCE_PAGE' : source ? 'SOURCE_REVIEW' : 'NEEDS_LOCALIZED_SOURCE';
    if (source && page['Body HTML'] && sourceBody && !bodyVerified) {
      const pending = { ID: id, Handle: handle, 'Current Shopify Body HTML': page['Body HTML'],
        'Norce Swedish Body HTML': sourceBody, Status: 'HOLD_BASE_BODY_DIFFERENCE' };
      for (const [locale, channel] of Object.entries(LOCALES)) pending[`Norce Body HTML: ${locale}`] = mainBody(pageOf(snapshots, channel, norceId));
      pendingBodies.push(pending);
    }
    review.push({ ID: id, Handle: handle, Title: page.Title, Published: page.Published,
      'Body Characters': String(page['Body HTML'] || '').length, 'Body Text Characters': htmlText(page['Body HTML']).length,
      'Norce Snapshot Fetched At': source ? snapshots?.[1]?.fetchedAt || '' : '',
      'Norce Source': sourceKind, 'Norce Name': source?.name || '', 'Norce Route': source?.primaryRoute?.path || '',
      'Norce Content ID': source?.data?.id || '', 'Title Source Matched': Boolean(titleSource),
      'Body Source Matched': Boolean(bodyVerified), Status: pageStatus,
      Note: about ? 'Current category 1294 localized content matched Swedish body' :
        !source ? 'No verified Norce Page source; preserve Shopify base page' :
          !source.data?.items?.length ? 'Norce Page has no current CMS items' :
            !bodyVerified && page['Body HTML'] ? 'Shopify body differs from current Norce body; hold body translation for review' : 'Matched to current Norce Page content' });
    for (const field of FIELDS) {
      const original = String(values[field] || '');
      if (!original) continue;
      const row = { ...base, Field: field, 'Original Value': original,
        'Norce Swedish Value': field === 'Title' ? titleSource?.value || '' : field === 'Body HTML' ? sourceBody : '',
        Status: 'NEEDS_TRANSLATION' };
      if (about && field === 'Title') {
        for (const [locale, content] of Object.entries(about)) row[`Translation Value: ${locale}`] = content.title;
      } else if (about && field === 'Body HTML') {
        for (const [locale, content] of Object.entries(about)) row[`Translation Value: ${locale}`] = localizedAboutBody(original, content);
      } else if (source && field === 'Title' && titleSource) {
        for (const [locale, channel] of Object.entries(LOCALES)) {
          const localized = localizedTitle(pageOf(snapshots, channel, norceId), titleSource.mode);
          if (localized && localized.trim() !== titleSource.value.trim()) row[`Translation Value: ${locale}`] = localized;
        }
      } else if (source && field === 'Body HTML') {
        for (const [locale, channel] of Object.entries(LOCALES)) {
          const localized = mainBody(pageOf(snapshots, channel, norceId));
          if (localized && hasLocalizedChange(sourceBody, localized)) row[`Translation Value: ${locale}`] = localized;
        }
      }
      const de = field === 'Title' ? localizedTitle(pageOf(snapshots, 8, norceId), titleSource?.mode) : mainBody(pageOf(snapshots, 8, norceId));
      if (norceId && row['Translation Value: de'] && de && !sameHtml(row['Translation Value: de'], de)) {
        delete row['Translation Value: de'];
        coverage.push({ Handle: handle, Field: field, Locale: 'de', Issue: 'DE_AT_MARKET_CONFLICT' });
      }
      const present = Object.keys(LOCALES).filter(locale => row[`Translation Value: ${locale}`]);
      if (present.length) {
        row.Status = 'SOURCE_VERIFIED_REVIEW';
        for (const locale of present) {
          ready.push({ ...base, Field: field, [`Translation Value: ${locale}`]: row[`Translation Value: ${locale}`] });
          coverage.push({ Handle: handle, Field: field, Locale: locale, Issue: 'SOURCE_VERIFIED_REVIEW' });
          if (field === 'Body HTML') for (const link of linksIn(row[`Translation Value: ${locale}`]))
            links.push({ Handle: handle, Locale: locale, ...link, Status: 'REVIEW_LINK_TARGET' });
        }
      }
      inputs.push(row);
    }
  }
  const grouped = mergeTranslationRows(ready);
  return { review, inputs, ready: grouped.rows, coverage, links, pendingBodies,
    translationConflicts: grouped.conflicts, missingTranslations: inputs.flatMap(row => {
      const present = Object.keys(LOCALES).filter(locale => row[`Translation Value: ${locale}`]);
      return present.length ? Object.keys(LOCALES).filter(locale => !present.includes(locale)).map(locale => ({ Handle: row['Entity Handle'], Field: row.Field, Locale: locale, Issue: 'MISSING_TRANSLATION' })) : [];
    }) };
}

function mergeTranslationRows(rows) {
  const groups = new Map(), conflicts = [];
  for (const row of rows) {
    const context = String(row.Context || row.Market || '');
    const key = [row.Entity, row['Entity ID'], row['Entity Handle'], row.Field, context].join('\u0000');
    const target = groups.get(key) || { ...row };
    for (const [column, value] of Object.entries(row)) {
      if (!column.startsWith('Translation Value: ') || value === '' || value == null) continue;
      if (target[column] && target[column] !== value) conflicts.push({ key, column, existing: target[column], incoming: value });
      else target[column] = value;
    }
    groups.set(key, target);
  }
  return { rows: [...groups.values()].filter(row => Object.keys(row).some(key => key.startsWith('Translation Value: ') && row[key])), conflicts };
}

function writeWorkbook(file, sheets) {
  const book = XLSX.utils.book_new();
  for (const [name, rows, headers] of sheets) XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(rows, { header: headers }), name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  XLSX.writeFile(book, file);
}

function main(args = process.argv.slice(2)) {
  const arg = key => args.find(item => item.startsWith(`--${key}=`))?.slice(key.length + 3);
  const root = path.resolve(__dirname, '../../..');
  const pagesFile = arg('pages') || path.join(root, 'exports/Export_2026-10-22_150343.xlsx');
  const cacheFile = arg('cache') || path.join(root, 'cache/norce-collections-cache.xlsx');
  const snapshotsDir = arg('norce-pages') || path.join(root, 'cache/norce-pages');
  const outputDir = arg('output-dir') || path.join(root, 'outputs/Fyrklovern/Matrixify files/Pages/Translations staging');
  const result = build({ pages: readPages(pagesFile), cache: loadCache(cacheFile, 'collections'), snapshots: loadPageSnapshots(snapshotsDir) });
  writeWorkbook(path.join(outputDir, 'Shopify Pages - translation review.xlsx'), [
    ['Pages Review', result.review], ['Translation Inputs', result.inputs], ['Locale Coverage', result.coverage], ['Links Review', result.links], ['Pending Body Differences', result.pendingBodies],
    ['Preconditions', [
      { Check: 'Localized source', Status: 'REVIEW REQUIRED', Note: 'Blank translation values mean no verified localization was available. Do not import this review workbook.' },
      { Check: 'Page identity', Status: 'VERIFIED', Note: 'IDs and handles came from the October 22 Matrixify Pages export.' },
      { Check: 'Page publication', Status: 'UNCHANGED', Note: 'No Pages update workbook is generated.' },
      { Check: 'Existing translations', Status: 'UNVERIFIED', Note: 'A current Shopify Pages Translations export was not supplied; compare before importing rows that may overwrite localized text.' },
      { Check: 'Legal and market text', Status: 'REVIEW REQUIRED', Note: 'Review terms, privacy, returns, warranties, competitions, and locale-specific contact or link targets.' },
      { Check: 'Embedded links', Status: 'REVIEW REQUIRED', Note: 'Inspect the Links Review sheet for legacy domains, PDFs, email addresses, and locale-specific routes.' },
    ]],
  ]);
  const populatedLocales = Object.keys(LOCALES).filter(locale => result.ready.some(row => row[`Translation Value: ${locale}`]));
  const headers = TRANSLATION_HEADERS.filter(header => !header.startsWith('Translation Value: ') || populatedLocales.includes(header.slice('Translation Value: '.length)));
  writeWorkbook(path.join(outputDir, 'Shopify Pages - verified translations.xlsx'), [['Translations', result.ready, headers]]);
  console.log(JSON.stringify({ pages: result.review.length, translationInputs: result.inputs.length, verifiedRows: result.ready.length, pendingBodyDifferences: result.pendingBodies.length, outputDir }, null, 2));
  return result;
}

if (require.main === module) main();
module.exports = { LOCALES, FIELDS, PAGE_IDS, TRANSLATION_HEADERS, readPages, norceAboutUs, localizedAboutBody, loadPageSnapshots, sourceTitle, localizedTitle, mainBody, bodyMatch, mergeTranslationRows, build, main };
