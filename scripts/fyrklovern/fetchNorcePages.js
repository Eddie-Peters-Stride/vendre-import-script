/** Read-only StoreAPI page snapshots, one atomic checkpoint per channel. */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { NorceExtractionClient } = require('../../src/importers/fyrklovern/norce-extraction/client');
const { CHANNELS } = require('../../src/importers/fyrklovern/norce-extraction/channels');

const PAGE_FIELDS = `
    id name mainHeader content allowWebIndexing
    primaryRoute { path }
    head { title metaTags { name content } }
    data {
      id name tags
      items {
        name type
        properties { name type valueType value { __typename ... on StringValue { value } ... on BoolValue { value } } }
        children {
          name type
          properties { name type valueType value { __typename ... on StringValue { value } ... on BoolValue { value } } }
          children {
            name type
            properties { name type valueType value { __typename ... on StringValue { value } ... on BoolValue { value } } }
          }
        }
      }
    }
`;
const QUERY = `query GetNorcePages { pages { ${PAGE_FIELDS} } }`;
const HIDDEN_IDS = [52, 55, 63, 64, 70, 72, 73, 75, 86];
const HIDDEN_QUERY = `query GetHiddenNorcePages { ${HIDDEN_IDS.map(id => `p${id}: page(id: ${id}) { ${PAGE_FIELDS} }`).join(' ')} }`;

async function main(args = process.argv.slice(2)) {
  const channelArg = args.find(arg => arg.startsWith('--channel='))?.slice(10);
  const refresh = args.includes('--refresh');
  const channels = channelArg ? CHANNELS.filter(channel => String(channel.id) === channelArg) : CHANNELS;
  if (!channels.length) throw new Error(`Unknown channel ${channelArg}`);
  const outputDir = path.resolve('cache/norce-pages');
  fs.mkdirSync(outputDir, { recursive: true });
  const client = new NorceExtractionClient({ timeoutMs: 60000 });
  for (const channel of channels) {
    const file = path.join(outputDir, `channel-${channel.id}.json`);
    if (!refresh && fs.existsSync(file)) { console.log(`channel ${channel.id}: existing checkpoint`); continue; }
    const data = await client.query(QUERY, {}, channel);
    const hidden = await client.query(HIDDEN_QUERY, {}, channel);
    const pages = new Map((data.pages || []).map(page => [String(page.id), page]));
    for (const page of Object.values(hidden).filter(Boolean)) pages.set(String(page.id), page);
    const snapshot = { fetchedAt: new Date().toISOString(), channel, pages: [...pages.values()], publishedPageIds: (data.pages || []).map(page => String(page.id)), hiddenLookups: HIDDEN_IDS };
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(snapshot, null, 2));
    fs.renameSync(temporary, file);
    console.log(`channel ${channel.id}: ${snapshot.pages.length} pages`);
  }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { QUERY, HIDDEN_QUERY, main };
