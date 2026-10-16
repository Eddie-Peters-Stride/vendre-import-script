import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {Workbook, SpreadsheetFile, FileBlob} from '@oai/artifact-tool';
import JSZip from 'jszip';

const root = 'C:/Users/Eddie Peters/Desktop/Dragons Lair/import_script';
const outDir = `${root}/outputs/fyrklovern_collection_updates`;
const source = 'C:/Users/Eddie Peters/Desktop/Fyrklövern/response_1790758605812.json';
const entries = JSON.parse(await fs.readFile(source, 'utf8'));
const categories = JSON.parse(await fs.readFile(`${root}/results/fyrklovern/fyrklovern-categories.json`, 'utf8')).list;
const exportWb = await SpreadsheetFile.importXlsx(await FileBlob.load(`${root}/exports/Export_2026-10-06_132403.xlsx`));
const exportValues = exportWb.worksheets.getItem('Collections').getUsedRange().values;
const exportHeaders = exportValues.shift();
const exportMap = new Map(exportValues.filter(r=>r[exportHeaders.indexOf('Handle')]).map(r=>[String(r[exportHeaders.indexOf('Handle')]),String(r[exportHeaders.indexOf('ID')])]));
const locales = {'sv-SE':'sv','da-DK':'da','fi-FI':'fi','nb-NO':'nb','en-GB':'en','de-DE':'de','nl-NL':'nl'};
const targetLocales = Object.values(locales).filter(v=>v!=='sv');
const audit = [], excluded = [], mapped = [], files = new Map(), collectionRows = [];
const translations = Object.fromEntries(targetLocales.map(l=>[l,[]]));
const clean = v=>typeof v==='string'?v.replace(/^\uFEFF/,'').trim():v;
const present = v=>v!==null&&v!==undefined&&(typeof v!=='string'||clean(v)!=='');
const pad = n=>String(n).padStart(2,'0');
const escape = s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const decode = s=>s.replace(/&(#x[\da-f]+|#\d+|nbsp|quot|amp|lt|gt|apos);/gi,(_,x)=>x[0]==='#'?String.fromCodePoint(x[1].toLowerCase()==='x'?parseInt(x.slice(2),16):Number(x.slice(1))):({nbsp:'\u00a0',quot:'"',amp:'&',lt:'<',gt:'>',apos:"'"}[x.toLowerCase()]));
const normalizedText = s=>s.replace(/\s+/g,' ').trim();

// Small HTML parser for the source's verified tag vocabulary; unknown tags fail.
function parseHtml(html) {
  const root={tag:'root',children:[]}, stack=[root];
  const allowed=new Set(['p','h1','h2','h3','h4','h5','h6','em','i','strong','b','ul','ol','li','br','span','a']);
  const tokens=html.match(/<!--[\s\S]*?-->|<\/?[a-zA-Z][^>]*>|[^<]+|</g)||[];
  for(const token of tokens){
    if(token.startsWith('<!--'))continue;
    if(token.startsWith('</')){const tag=token.match(/^<\/([\w]+)/)[1].toLowerCase();let i=stack.length-1;while(i>0&&stack[i].tag!==tag)i--;if(i>0)stack.length=i;continue;}
    if(/^<[a-z]/i.test(token)){
      const tag=token.match(/^<([\w]+)/)[1].toLowerCase();assert(allowed.has(tag),`Unsupported HTML tag ${tag}`);
      const attrs={};for(const m of token.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g))attrs[m[1].toLowerCase()]=decode(m[2]??m[3]??m[4]);
      const n={tag,attrs,children:[]};stack.at(-1).children.push(n);if(tag!=='br'&&!token.endsWith('/>'))stack.push(n);
    }else stack.at(-1).children.push({tag:'#text',value:decode(token)});
  }return root;
}
const domText = n=>n.tag==='#text'?n.value:n.tag==='br'?'\n':n.children.map(domText).join(['p','li','ul','ol','root'].includes(n.tag)?' ':'');
const richText = n=>n.type==='text'?n.value:n.children.map(richText).join(['paragraph','heading','root','list','list-item'].includes(n.type)?' ':'');
function inline(nodes, style={}) {
  return nodes.flatMap(n=>{
    if(n.tag==='#text')return n.value?[{type:'text',value:n.value,...style}]:[];
    if(n.tag==='br')return [{type:'text',value:'\n',...style}];
    const next={...style,...(['b','strong'].includes(n.tag)?{bold:true}:{}),...(['i','em'].includes(n.tag)?{italic:true}:{})};
    const children=inline(n.children,next);
    if(n.tag==='a'&&n.attrs.href){const url=new URL(n.attrs.href,'https://www.fyrklovern.com').href;assert(/^(https?:|mailto:|tel:)/.test(url));return [{type:'link',url,...(n.attrs.title?{title:n.attrs.title}:{}),children}];}
    return children;
  });
}
function blocks(nodes) {
  const out=[];let pending=[];
  const flush=()=>{const children=inline(pending);if(children.some(n=>normalizedText(richText(n))))out.push({type:'paragraph',children});pending=[];};
  for(const n of nodes){
    if(n.tag==='p'||/^h[1-6]$/.test(n.tag)){flush();const children=inline(n.children);if(children.some(n=>normalizedText(richText(n))))out.push({type:n.tag==='p'?'paragraph':'heading',...(n.tag==='p'?{}:{level:Number(n.tag[1])}),children});}
    else if(n.tag==='ul'||n.tag==='ol'){flush();const children=n.children.filter(x=>x.tag==='li').map(x=>({type:'list-item',children:inline(x.children)})).filter(x=>normalizedText(richText(x)));if(children.length)out.push({type:'list',listType:n.tag==='ol'?'ordered':'unordered',children});}
    else pending.push(n);
  }flush();return out;
}
function validateRich(n,parent=''){
  assert(['root','paragraph','heading','list','list-item','text','link'].includes(n.type));
  if(n.type==='text'){assert.equal(typeof n.value,'string');return;}
  assert(n.children?.length>0,`Empty rich node ${n.type}`);
  if(n.type==='root')assert(n.children.every(x=>['paragraph','heading','list'].includes(x.type)));
  if(['paragraph','heading','list-item','link'].includes(n.type))assert(n.children.every(x=>['text','link'].includes(x.type)));
  if(n.type==='heading')assert(n.level>=1&&n.level<=6);
  if(n.type==='list')assert(n.children.every(x=>x.type==='list-item'));
  n.children.forEach(x=>validateRich(x,n.type));
}
function htmlToRich(html){const dom=parseHtml(html);const rich={type:'root',children:blocks(dom.children)};if(!rich.children.length)return null;validateRich(rich);assert.equal(normalizedText(richText(rich)),normalizedText(domText(dom)),'HTML conversion changed text');return JSON.stringify(rich);}
function fieldHtml(key,p,value){if(p.type==='html')return clean(value);const tag=['heading','title'].includes(key)?'h2':'p';return `<${tag}>${escape(clean(value))}</${tag}>`;}
function allProperties(node,prefix=''){
  const result=[];
  for(const [key,p] of Object.entries(node.properties||{}))result.push({key,p,path:`${prefix}.properties.${key}`,owner:node});
  for(const [component,c] of Object.entries(node.components||{}))for(let i=0;i<(c.items||[]).length;i++)result.push(...allProperties(c.items[i],`${prefix}.components.${component}.items.${i}`));
  return result;
}
function addTranslations(ctx,field,original,values){for(const [src,locale] of Object.entries(locales))if(locale!=='sv'&&present(values[src]))translations[locale].push(['Collection',ctx.id,ctx.handle,field,original,values[src]]);}
function addMetafield(ctx,key,type,base,values={}){
  if(!present(base))return;
  if(type==='rich_text_field')validateRich(JSON.parse(base));
  collectionRows.push([ctx.id,ctx.handle,'UPDATE',ctx.title,ctx.description,'custom',key,type,base]);
  mapped.push({collection:ctx.name,handle:ctx.handle,key:`custom.${key}`,type});
  if(type==='rich_text_field')addTranslations(ctx,`Metafield: custom.${key}`,base,values);
}

for(const entry of entries){
  const connections=entry.contentConnections.filter(c=>c.entityType===2);
  if(!connections.length){excluded.push({id:entry.id,name:entry.name,reason:entry.contentConnections.length?'Linked to a non-collection entity':'No collection connection'});continue;}
  assert.equal(connections.length,1);
  const category=categories.find(c=>String(c.id)===String(connections[0].entityId));assert(category);
  const id=exportMap.get(category.handle);assert(id,`Unmatched collection ${entry.name}`);
  const intro=entry.items.find(b=>b.type==='Category Page Header'||b.type==='Content Page Header');assert(intro);
  const heading=intro.properties.heading?.values||{};
  const descProperty=intro.properties[intro.type==='Category Page Header'?'text':'content'];assert(descProperty);
  const descs=Object.fromEntries(Object.entries(descProperty.values||{}).filter(([,v])=>present(v)).map(([l,v])=>[l,descProperty.type==='html'?clean(v):`<p>${escape(clean(v))}</p>`]));
  const ctx={id,handle:category.handle,name:entry.name,title:clean(heading['sv-SE'])||category.name.sv,description:descs['sv-SE']};assert(present(ctx.description));
  addTranslations(ctx,'Title',ctx.title,Object.fromEntries(Object.entries(heading).map(([l,v])=>[l,clean(v)])));
  addTranslations(ctx,'Body HTML',ctx.description,descs);
  for(let bi=0;bi<entry.items.length;bi++){
    const block=entry.items[bi],baseKey=`content_block_${pad(bi+1)}`;
    const props=allProperties(block,`items.${bi}`),assigned=new Map();
    const sections=block.type==='Category Page Footer'?block.components?.headingAndParagraphs?.items:null;
    const units=sections?sections.map((s,i)=>({key:`${baseKey}_section_${pad(i+1)}`,props:allProperties(s,`items.${bi}.components.headingAndParagraphs.items.${i}`)})):[{key:baseKey,props}];
    for(const unit of units){
      const textProps=unit.props.filter(x=>['text','html'].includes(x.p.type)&&x.key!=='alt');
      const values={};
      for(const locale of Object.keys(locales)){
        const applicable=textProps.filter(x=>present(x.p.values?.[locale]));
        const html=applicable.map(x=>fieldHtml(x.key,x.p,x.p.values[locale])).join('\n');
        const value=htmlToRich(html);if(value)values[locale]=value;
        for(const x of applicable)assigned.set(`${x.path}|${locale}`,values['sv-SE']?`custom.${unit.key}`:'Reported: no Swedish base content');
      }
      addMetafield(ctx,unit.key,'rich_text_field',values['sv-SE'],values);
    }
    const blockImages=[];
    for(const x of props.filter(x=>x.p.type==='image'))for(const [locale,v] of Object.entries(x.p.values||{}))if(present(v)){
      const name=path.posix.basename(v);assert(name&&name.endsWith('.jpg'));
      if(!blockImages.includes(name))blockImages.push(name);
      const alt=x.owner.properties?.alt?.values?.['sv-SE'];
      if(!files.has(name))files.set(name,{name,url:`https://www.fyrklovern.com/pub_docs/files${v.startsWith('/')?v:'/'+v}`,alt:present(alt)?clean(alt):null});
      assigned.set(`${x.path}|${locale}`,`custom.${baseKey}_images`);
    }
    if(blockImages.length)addMetafield(ctx,`${baseKey}_images`,'list.file_reference',JSON.stringify(blockImages));
    for(const x of props){
      const values=Object.entries(x.p.values||{});
      if(!values.length)audit.push({collection:entry.name,block:block.name,path:x.path,type:x.p.type,locale:'',status:'Skipped empty values',value:null});
      for(const [locale,v]of values){
        let status=assigned.get(`${x.path}|${locale}`);
        if(!present(v))status='Skipped empty value';
        else if(!status)status=x.key==='alt'?'Image alt text retained in report (not imported)': ['text','html'].includes(x.p.type)?'Text retained in report; unsupported locale or no Swedish base':'Source layout/reference setting retained in report';
        audit.push({collection:entry.name,block:block.name,path:x.path,type:x.p.type,locale,status,value:v});
      }
    }
  }
}

assert.equal(new Set(collectionRows.map(r=>r[0])).size,4);assert.equal(excluded.length,6);assert.equal(files.size,24);
assert.equal(new Set(collectionRows.map(r=>`${r[0]}:${r[6]}`)).size,collectionRows.length);
for(const r of collectionRows){assert(r.every(present));assert.equal(r[2],'UPDATE');if(r[7]==='list.file_reference')for(const name of JSON.parse(r[8]))assert(files.has(name));}
for(const [locale,rows]of Object.entries(translations)){assert(rows.length);assert(rows.every(r=>r.every(present)));assert.equal(new Set(rows.map(r=>`${r[1]}:${r[3]}`)).size,rows.length);}
const headings=['ID','Handle','Command','Title','Body HTML','Metafield Namespace','Metafield Key','Metafield Value Type','Metafield Value'];
await fs.mkdir(outDir,{recursive:true});
const outputs=[];
async function writeWorkbook(filename,sheetName,headers,rows,widths){
  for(const row of rows)for(const value of row)assert(String(value??'').length<32767,'Excel cell limit');
  if(process.argv.includes('--reports-only')){outputs.push({filename,sheetName,rows:rows.length});return;}
  const wb=Workbook.create(),s=wb.worksheets.add(sheetName),matrix=[headers,...rows];
  const range=s.getRangeByIndexes(0,0,matrix.length,headers.length);range.values=matrix;
  range.format.font={name:'Arial',size:10};range.format.verticalAlignment='top';range.format.rowHeight=30;
  s.getRangeByIndexes(0,0,1,headers.length).format={fill:'#1F4E78',font:{name:'Arial',bold:true,color:'#FFFFFF',size:10},wrapText:true,rowHeight:42};
  for(let i=0;i<headers.length;i++)s.getRangeByIndexes(0,i,matrix.length,1).format.columnWidth=widths[i]||24;
  s.freezePanes.freezeRows(1);s.showGridLines=false;
  wb.recalculate();
  const check=await wb.inspect({kind:'table',sheetId:sheetName,range:`A1:C${Math.min(3,matrix.length)}`,tableMaxRows:3,tableMaxCols:3,maxChars:800});
  console.log(filename,rows.length,check.ndjson);
  const preview=await wb.render({sheetName,range:`A1:D${Math.min(5,matrix.length)}`,scale:1,format:'png'});
  await fs.writeFile(`${root}/.artifact_work/${filename}.png`,new Uint8Array(await preview.arrayBuffer()));
  const output=await SpreadsheetFile.exportXlsx(wb);await output.save(`${outDir}/${filename}`);
  const reopened=await SpreadsheetFile.importXlsx(await FileBlob.load(`${outDir}/${filename}`));
  const actual=reopened.worksheets.getItem(sheetName).getRangeByIndexes(0,0,matrix.length,headers.length).values;
  assert.deepEqual(actual,matrix,`Round-trip values changed in ${filename}`);
  outputs.push({filename,sheetName,rows:rows.length});
}

// Alt text is incomplete across files; retain it in the report without blank overwrite cells.
const fileRows=[...files.values()].map(f=>[f.name,'MERGE',f.url]);
await writeWorkbook('01_files.xlsx','Files',['File Name','Command','Link'],fileRows,[58,16,95]);
await writeWorkbook('02_collections.xlsx','Collections',headings,collectionRows,[20,66,16,42,75,18,38,24,95]);
for(const locale of targetLocales)await writeWorkbook(`03_translations_${locale}.xlsx`,'Translations',['Entity','Entity ID','Entity Handle','Field','Original Value',`Translation Value: ${locale}`],translations[locale],[18,20,66,48,90,90]);
const summary={collections:4,collectionMetafields:collectionRows.length,richTextMetafields:collectionRows.filter(r=>r[7]==='rich_text_field').length,imageListMetafields:collectionRows.filter(r=>r[7]==='list.file_reference').length,images:files.size,translationRows:Object.fromEntries(Object.entries(translations).map(([k,v])=>[k,v.length])),sourceFields:audit.length,excludedEntries:excluded.length,outputs};
await fs.writeFile(`${outDir}/mapping_report.json`,JSON.stringify({source,summary,excludedEntries:excluded,metafieldMapping:mapped,sourceFieldAccounting:audit},null,2));
const csv=(rows)=>'\uFEFF'+rows.map(r=>r.map(v=>'"'+String(v??'').replaceAll('"','""')+'"').join(',')).join('\r\n')+'\r\n';
await fs.writeFile(`${outDir}/mapping_report.csv`,csv([['Collection','Source block','Source field path','Source type','Locale','Destination or reason','Source value'],...audit.map(x=>[x.collection,x.block,x.path,x.type,x.locale,x.status,x.value])]));
await fs.writeFile(`${outDir}/excluded_entries.csv`,csv([['Source ID','Name','Reason'],...excluded.map(x=>[x.id,x.name,x.reason])]));
await fs.writeFile(`${outDir}/IMPORT_INSTRUCTIONS.txt`,[
  'FYRKLOVERN COLLECTION CONTENT IMPORTS',
  '',
  '1. Upload 01_files.xlsx to Matrixify. Import the Files sheet (24 images). Wait until Shopify finishes processing all images and confirm the import succeeded.',
  '2. Upload 02_collections.xlsx. Import the Collections sheet. It updates four existing collections by ID/handle using UPDATE, with one nonempty metafield per row.',
  '3. Once the collection import succeeds, import each of the six 03_translations_<language>.xlsx workbooks. Each has a Translations sheet and only one target-language column. The corresponding language must be enabled in Shopify.',
  '',
  'Swedish is the base language. Language codes: da (Danish), fi (Finnish), nb (Norwegian Bokmal), en (English), de (German), nl (Dutch).',
  'Blank source values have been omitted. Missing translations are not filled with Swedish. No handles, memberships, sorting, or publishing settings are changed.',
  'Text metafields use rich_text_field JSON. Image metafields use list.file_reference, with Shopify filenames in source order.',
  'To expose these new fields as theme dynamic sources, add collection metafield definitions in Shopify using the exact namespace/key/type listed in mapping_report.json. For image-list definitions, restrict file references to images. Theme section configuration is separate from this content import.',
  'The mapping CSV/JSON records source block names, source fields, metafield destinations, and retained layout/reference settings. These reports and excluded_entries.csv are not import files.',
  'Image alt text is incomplete in the source. All supplied image alt text, including translations, is retained in the mapping report and is not imported.',
  'Six source entries were excluded because they were unlinked or connected to non-collection entities. See excluded_entries.csv.',
  '',
  'Validation: '+JSON.stringify(summary),
  '',
  'Documentation: https://matrixify.app/documentation/collections/ | https://matrixify.app/documentation/metafields/ | https://matrixify.app/documentation/files/ | https://matrixify.app/documentation/translations/',
].join('\r\n'));
const zip=new JSZip();for(const name of [...outputs.map(x=>x.filename),'mapping_report.json','mapping_report.csv','excluded_entries.csv','IMPORT_INSTRUCTIONS.txt'])zip.file(name,await fs.readFile(`${outDir}/${name}`));
await fs.writeFile(`${outDir}/fyrklovern_collection_updates.zip`,await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'}));
console.log('FINAL SUMMARY',JSON.stringify(summary));
