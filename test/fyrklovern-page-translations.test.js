const assert = require('assert');
const { build, localizedAboutBody, bodyMatch } = require('../src/importers/fyrklovern/build-page-translations');
const { loadCache, setProgress, setRaw } = require('../src/importers/fyrklovern/norce-extraction/cache');

const cache = loadCache('__missing_page_translation_test_cache__.xlsx', 'collections');
const body = '<h3 class="header">Fyrklövern</h3><h2>For special moments</h2><div><section><p>Sedan 1974 har Fyrklövern skapat kollektioner för det dukade bordet med skandinavisk designkänsla och hög kvalitet.</p></section></div>';
const page = { ID: '716035293524', Handle: 'om-oss', Title: 'Om oss', 'Body HTML': body };
const property = (name, value) => ({ name, value: { value } });
for (const [channel, name, paragraph] of [
  [1, 'Om oss', 'Sedan 1974 har Fyrklövern skapat kollektioner för det dukade bordet med skandinavisk designkänsla och hög kvalitet.'],
  [2, 'Om oss', 'Siden 1974 har Fyrklövern skapt kolleksjoner for bordet.'],
  [3, 'Om os', 'Siden 1974 har Fyrklövern skabt kollektioner til bordet.'],
  [4, 'Meistä', 'Vuodesta 1974 Fyrklövern on luonut mallistoja kattaukseen.'],
  [5, 'Über uns', 'Seit 1974 entwirft Fyrklövern Kollektionen für den gedeckten Tisch.'],
  [6, 'About us', 'Since 1974 Fyrklövern has created tableware collections.'],
  [7, 'Over ons', 'Sinds 1974 maakt Fyrklövern collecties voor de gedekte tafel.'],
]) {
  setProgress(cache, '1294', channel, 'category', { Status: 'COMPLETE' });
  setRaw(cache, '1294', channel, 'category', { name, data: { items: [{ type: 'InspirationBlock', properties: [
    property('miniTitle', 'Fyrklövern'), property('title', 'For special moments'), property('content', `<p>${paragraph}</p>`),
  ] }] } });
}
const result = build({ pages: [page, { ID: '1', Handle: 'kopvillkor', Title: 'Köpvillkor', 'Body HTML': '<p>Swedish terms</p>' }], cache });
assert.strictEqual(result.review.length, 2);
assert.strictEqual(result.ready.length, 12);
assert(result.ready.every(row => row.Entity === 'Page' && row['Entity ID'] === page.ID && row['Entity Handle'] === page.Handle));
assert(result.ready.find(row => row.Field === 'Body HTML' && row['Translation Value: en'])['Translation Value: en'].includes('Since 1974'));
assert(result.inputs.some(row => row['Entity Handle'] === 'kopvillkor' && row.Status === 'NEEDS_TRANSLATION'));
assert(!result.ready.some(row => row['Entity Handle'] === 'kopvillkor'));
assert(localizedAboutBody(body, { miniTitle: 'Fyrklövern', heading: 'About', body: '<p>Translated</p>' }).includes('<section>\n<p>Translated</p>\n</section>'));
assert(bodyMatch('<p>The same <strong>words in this longer paragraph</strong> are preserved.</p>', '<p>The same words in this longer paragraph are preserved.</p>'));
assert(!bodyMatch('<iframe src="/sv"></iframe>', '<iframe src="/en"></iframe>'));
const sourceBody = '<p>Returer och reklamationer har samma svenska text på sidan och i Norce.</p>';
const pageNode = (name, html) => ({ id: '77', name, data: { id: 'content-77', items: [{ type: 'Text Block', properties: [property('content', html)] }] } });
const snapshots = {
  1: { pages: [pageNode('Returer & reklamationer', sourceBody)] },
  6: { pages: [pageNode('Returns & complaints', '<p>Returns and complaints have localized English text in Norce.</p>')] },
  7: { pages: [pageNode('Returer & reklamationer', sourceBody)] },
};
const mapped = build({ pages: [{ ID: '715413455188', Handle: 'returer-reklamationer', Title: 'Returer & reklamationer', 'Body HTML': sourceBody }], cache, snapshots });
assert.strictEqual(mapped.ready.length, 2);
assert(mapped.ready.some(row => row.Field === 'Title' && row['Translation Value: en'] === 'Returns & complaints'));
assert(mapped.ready.some(row => row.Field === 'Body HTML' && row['Translation Value: en']?.includes('localized English')));
assert(!mapped.ready.some(row => row['Translation Value: nl']));
console.log('fyrklovern page translations tests passed');
