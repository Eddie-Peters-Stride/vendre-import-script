const fs = require('fs');
const path = require('path');
require('dotenv').config();
const { NorceExtractionClient } = require('../src/importers/fyrklovern/norce-extraction/client');
const { CHANNELS } = require('../src/importers/fyrklovern/norce-extraction/channels');

const handles = [
  'julminnen-tallriksset-36-delar-12-pers',
  'crown-glasset-8-delar-gron',
  'breath-of-nature-bordsduk-north-sea-green-145x250-cm',
  'dream-collection-plad-130-x-170-cm',
  'disney-wonder-bricka-46-cm',
  'dream-collection-burk-med-bambulock-18-cm',
  'diamond-vitvinsglas-35-cl2',
  'pepper-ugnsform-38-x-27-cm',
  'drop-karaff-12-l',
  'diamond-rodvinsglas-45-cl-ny',
];

async function main() {
  const source = require('../results/fyrklovern/fyrklovern-products.json').list;
  const client = new NorceExtractionClient();
  const records = [];
  for (const handle of handles) {
    const product = source.find(item => item.handle === handle);
    if (!product) throw new Error(`Source product missing: ${handle}`);
    const row = { handle, article: product.article_number, sourceId: product.id, shopifySwedish: product.specifications?.metafields?.care_advice || '', locales: {} };
    for (const channel of CHANNELS) {
      try {
        const response = await client.productGroup(String(product.article_number), channel, 'attributes');
        const fields = response?.customFields?.filter(field => String(field.key).toLowerCase() === 'careadvice') || [];
        row.locales[channel.code] = {
          channelId: channel.id, culture: channel.culture, status: response ? 'ok' : 'product_missing',
          productId: response?.id ?? null, careFields: fields.map(field => ({ key: field.key, title: field.title, value: field.value ?? null })),
        };
      } catch (error) {
        row.locales[channel.code] = { channelId: channel.id, culture: channel.culture, status: 'error', error: error.message };
      }
    }
    records.push(row);
    console.log(`${records.length}/${handles.length} ${handle}: ${Object.entries(row.locales).map(([code, result]) => `${code}=${result.careFields?.[0]?.value ?? result.status}`).join(' | ')}`);
  }
  const output = path.join(__dirname, 'care-advice-live-scan.json');
  fs.writeFileSync(output, JSON.stringify({ scannedAt: new Date().toISOString(), endpoint: client.endpoint, shopId: client.shopId, records }, null, 2));
  console.log(`Saved ${output}`);
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
