// Local fixture only. No HTTP server, Git, Cloudflare or production files.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { listReleaseStatus, saveReleaseStatus, sanitizePrivateRows, releaseView } from './release-status.mjs';

const parent=path.resolve(os.tmpdir());
const root=await mkdtemp(path.join(parent,'pp-release-test-'));
const write=async(rel,text)=>{const p=path.join(root,rel);await mkdir(path.dirname(p),{recursive:true});await writeFile(p,text);};
try {
  const publicWorks=[{id:'shared',title:'Shared'},{id:'public-only',title:'Public only'}];
  await write('docs/works.json',JSON.stringify(publicWorks));
  await write('docs/tracks/shared/index.html','<div class="lyrics-text">Public text</div>');
  await write('docs/tracks/public-only/index.html','No lyrics');
  const publicSource=JSON.stringify({title:'Shared',streamingUrl:'https://open.spotify.com/track/fixture'});
  await write('tracks/shared/track.json',publicSource);
  await write('tracks/public-only/track.json',JSON.stringify({title:'Public only'}));
  const secretTitle='FICTITIOUS PRIVATE ONLY TITLE', secretLyric='FICTITIOUS PRIVATE LYRIC';
  const privateRows=sanitizePrivateRows([{id:'shared',title:'Shared',lyrics:'some lyrics'},...Array.from({length:199},(_,i)=>({id:`private-${i}`,title:i===0?secretTitle:`Private ${i}`,lyrics:i===0?secretLyric:''}))]);
  const offline=await listReleaseStatus(root);
  assert.equal(offline.counts.all,2);assert.equal(offline.privateLoaded,false);assert.equal(offline.rows[0].privatePresent,null);
  const merged=await listReleaseStatus(root,privateRows);
  assert.equal(merged.counts.all,201);assert.equal(merged.counts.unknown,201);assert.equal(merged.counts.private,0);
  assert.equal(merged.rows.find(r=>r.id==='shared').links[0].service,'spotify');
  assert.equal(merged.rows.find(r=>r.id==='shared').privateLyrics,true);
  assert.equal(merged.rows.find(r=>r.id==='private-0').publicLyrics,false);
  assert.ok(!JSON.stringify(merged).includes(secretLyric));
  const input={id:'private-0',rev:merged.rev,classification:'private',lyricsScope:'private',links:[],confirm:true};
  let result=await saveReleaseStatus(root,privateRows,input);
  assert.equal(result.status,200);assert.equal(result.body.counts.private,1);
  assert.equal(result.body.rows.find(r=>r.id==='private-0').lyricsScope,'private');
  assert.equal(releaseView(result.body.rows,'private').rows.length,1);
  assert.equal(releaseView(result.body.rows,'all','private-0').rows[0].id,'private-0');
  assert.equal((await saveReleaseStatus(root,privateRows,input)).status,409);
  assert.equal((await saveReleaseStatus(root,privateRows,{...input,rev:result.body.rev,id:'not-in-list'})).status,404);
  assert.equal((await saveReleaseStatus(root,privateRows,{...input,rev:result.body.rev,links:[{service:'spotify',url:'http://example.com'}]})).status,400);
  assert.equal((await saveReleaseStatus(root,privateRows,{...input,rev:result.body.rev,links:[{service:'spotify',url:'https://music.apple.com/track/x'}]})).status,400);
  const publicEdit={id:'shared',rev:result.body.rev,classification:'general',lyricsScope:'private',links:[{service:'spotify',url:'https://open.spotify.com/track/fixture'},{service:'apple-music',url:'https://music.apple.com/album/fixture'}],confirm:true};
  result=await saveReleaseStatus(root,privateRows,publicEdit);
  assert.equal(result.status,200);assert.equal(result.body.counts.general,1);assert.equal(result.body.counts.private,1);
  assert.ok(result.body.rows.find(r=>r.id==='shared').warnings.length); // intended scope differs from observed public lyric
  const stored=await readFile(path.join(root,'.manager','release-status.json'),'utf8');
  assert.ok(stored.includes(secretTitle));assert.ok(!stored.includes(secretLyric));
  assert.equal((await readdir(path.join(root,'.manager','release-status-backups'))).length,1);
  const restarted=await listReleaseStatus(root,[...privateRows].reverse().map(r=>r.id==='private-0'?{...r,title:'Renamed'}:r));
  assert.equal(restarted.rows.find(r=>r.id==='private-0').classification,'private');assert.equal(restarted.rows.find(r=>r.id==='private-0').title,'Renamed');
  assert.equal((await listReleaseStatus(root)).rows.find(r=>r.id==='private-0').savedOnly,true);
  assert.equal(await readFile(path.join(root,'tracks','shared','track.json'),'utf8'),publicSource);
  assert.ok(!(await readFile(path.join(root,'docs','works.json'),'utf8')).includes(secretTitle));
  console.log('PASS: 201-track union, unknown/confirmed counts, independent lyric scope, source URL preservation, ID stability, local save/reload/backup, filters, invalid URL/stale/unknown ID rejection, no private lyric or public file change');

  // Execute the actual manager UI against the local fixture, without sockets.
  const roots=new Map();let answer='go',auth=false;
  class Element {
    constructor(tag='div'){this.tag=tag;this.children=[];this.value='';this.textContent='';}
    append(...items){this.children.push(...items);}
    replaceChildren(...items){this.children=items;}
    addEventListener(){}
    querySelector(){return {focus(){}};}
    showModal(){queueMicrotask(()=>{this.returnValue=answer;this.onclose?.();});}
  }
  const document={createElement:tag=>new Element(tag),body:new Element('body'),querySelector:id=>{if(!roots.has(id))roots.set(id,new Element());return roots.get(id);}};
  const find=(node,match)=>typeof node==='object'&&node!==null?(match(node)?node:node.children?.map(c=>find(c,match)).find(Boolean)):null;
  const request=async(url,init)=>{
    if(url==='/api/state')return Response.json({changes:{items:[],files:[],other:[]},list:{tracks:[],history:[],other:[],site:[]}});
    const body=JSON.parse(init.body);
    if(url.endsWith('/list')){if(body.adminPassword)auth=true;return Response.json(await listReleaseStatus(root,auth?privateRows:null));}
    const r=await saveReleaseStatus(root,auth?privateRows:null,body);return Response.json(r.body,{status:r.status});
  };
  vm.runInNewContext(readFileSync(new URL('./ui/app.js',import.meta.url),'utf8'),{document,window:{addEventListener(){}},location:{hash:'#t=fixture',pathname:'/'},history:{replaceState(){}},sessionStorage:{setItem(){},getItem(){}},URLSearchParams,fetch:request,setTimeout:()=>{},console});
  await new Promise(r=>setImmediate(r));
  const menu=find(roots.get('#lists'),e=>e.tag==='button'&&e.children?.[0]?.textContent==='全楽曲の公開状況');assert.ok(menu);await menu.onclick();
  const main=roots.get('#main'),field=id=>find(main,e=>e.id===id),button=text=>find(main,e=>e.tag==='button'&&e.textContent===text);
  assert.ok(button('すべて 3曲')); // public rows + the existing saved-only private record
  field('rs-password').value='fixture-only';await button('PRIVATE曲一覧も読み込む').onclick();
  assert.equal(field('rs-password').value,'');assert.ok(button('すべて 201曲'));
  field('rs-filter').value='private';field('rs-filter').onchange();assert.ok(button(secretTitle));assert.ok(!button('Shared'));
  await button(secretTitle).onclick();field('rs-class').value='site';field('rs-class').onchange();
  field('rs-scope').value='both';field('rs-scope').onchange();
  answer='cancel';await button('確認して管理情報を保存').onclick();assert.equal((await listReleaseStatus(root,privateRows)).rows.find(r=>r.id==='private-0').classification,'private');
  answer='go';await button('確認して管理情報を保存').onclick();
  assert.equal((await listReleaseStatus(root,privateRows)).rows.find(r=>r.id==='private-0').classification,'site');assert.equal((await listReleaseStatus(root,privateRows)).rows.find(r=>r.id==='private-0').lyricsScope,'both');
  assert.ok(button('PRIVATEのみ 0曲'));assert.ok(button('このサイトのみ 1曲'));
  field('rs-filter').value='general';field('rs-filter').onchange();await button('Shared').onclick();
  const urlInput=find(main,e=>e.tag==='input'&&e.type==='url');assert.equal(urlInput.value,'https://open.spotify.com/track/fixture');
  urlInput.value='https://open.spotify.com/track/revised-fixture';urlInput.oninput();
  await button('確認して管理情報を保存').onclick();assert.equal((await listReleaseStatus(root,privateRows)).rows.find(r=>r.id==='shared').links[0].url,'https://open.spotify.com/track/revised-fixture');
  assert.equal(await readFile(path.join(root,'tracks','shared','track.json'),'utf8'),publicSource);
  console.log('PASS: manager menu, local and PRIVATE inventory, count and filter, independent scope/class edit, cancel/confirm save and password clearing');
} finally {
  // Only the unique test fixture created by this script is removed.
  if(path.dirname(path.resolve(root))===parent && path.basename(root).startsWith('pp-release-test-'))await rm(root,{recursive:true,force:true});
}
