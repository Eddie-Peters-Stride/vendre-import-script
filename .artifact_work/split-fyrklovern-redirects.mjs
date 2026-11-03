import fs from 'node:fs';
import path from 'node:path';

const directory = path.resolve('outputs', 'Fyrklovern', '301 redirects', 'Full collection handles');
const source = path.join(directory, 'fyrklovern-301-redirects-staged.csv');
const lines = fs.readFileSync(source, 'utf8').trimEnd().split(/\r?\n/);
const header = lines.shift();
if (header !== 'Redirect from,Redirect to') throw new Error('Unexpected Shopify redirect header');

const groups = Object.fromEntries(['products', 'collections', 'blogs', 'pages'].map(type => [type, []]));
for (const line of lines) {
  const separator = line.indexOf(',');
  if (separator < 0) throw new Error(`Invalid redirect row: ${line}`);
  const destination = line.slice(separator + 1);
  const match = /^\/(?:[^/]+\/)?(products|collections|blogs|pages)\//.exec(destination);
  if (!match) throw new Error(`Unknown destination type: ${destination}`);
  groups[match[1]].push(line);
}

for (const [type, rows] of Object.entries(groups)) {
  const file = path.join(directory, `fyrklovern-301-${type}-staged.csv`);
  fs.writeFileSync(file, [header, ...rows].join('\r\n') + '\r\n', 'utf8');
}
console.log(JSON.stringify({ sourceRows: lines.length,
  splitRows: Object.values(groups).reduce((total, rows) => total + rows.length, 0),
  counts: Object.fromEntries(Object.entries(groups).map(([type, rows]) => [type, rows.length])) }, null, 2));
