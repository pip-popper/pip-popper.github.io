import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {publicListening,approvedSongs} from './worker.mjs';
import {assertArchiveApproval} from './approval.mjs';
import {sortedSongs} from '../private/worker/src/song-order.js';

const bytes=Buffer.from([0xff,0xfb,0x90,0xc0,1,2,3,4]);
const entry=(id,extra={})=>({id,title:`Title ${id}`,classification:'site',publicAudioApproved:true,audioKey:`public-audio/${id}.mp3`,size:bytes.length,...extra});
const catalog={version:1,songs:[entry('allowed',{classification:'general',lyricsScope:'public',publicLyricsApproved:true,lyrics:'PUBLIC_TEXT',impressionScope:'public',publicImpressionApproved:true,impression:'PUBLIC_IMPRESSION',publicJacketApproved:true,jacketKey:'public-jackets/allowed.png'}),
  entry('site-only',{lyricsScope:'private',publicLyricsApproved:true,lyrics:'PRIVATE_LYRIC_MARKER',impressionScope:'private',publicImpressionApproved:true,impression:'PRIVATE_IMPRESSION_MARKER',jacketKey:'public-jackets/site-only.png',publicJacketApproved:false}),
  entry('secret-song',{title:'PRIVATE_TITLE_MARKER',classification:'private',lyrics:'PRIVATE_TEXT'}),entry('unknown-song',{title:'UNKNOWN_TITLE_MARKER',classification:'unknown'}),entry('not-approved',{publicAudioApproved:false}),entry('wrong-key',{audioKey:'audio/private.mp3'}),entry('duplicate'),entry('duplicate',{classification:'private'})]};
assert.deepEqual(approvedSongs(catalog).map(s=>s.id),['allowed','site-only']);
const reads=[];const env={get BUCKET(){throw new Error('PRIVATE binding must not be touched');},PUBLIC_BUCKET:{get:async(key,options)=>{reads.push(key);if(key==='public-catalog.json')return {json:async()=>catalog};if(key==='public-audio/allowed.mp3'||key==='public-audio/site-only.mp3')return {body:options?.range?bytes.subarray(options.range.offset,options.range.offset+options.range.length):bytes};if(key==='public-jackets/allowed.png')return {body:Buffer.from([137,80,78,71]),httpMetadata:{contentType:'image/png'}};return null;}},ASSETS:{fetch:async()=>new Response('asset')}};
const call=(p,init)=>publicListening(new Request('https://public.example.invalid'+p,init),env);
const page=await call('/');assert.equal(page.status,200);const html=await page.text();
assert.ok(html.includes('一般視聴'));assert.ok(html.includes('PUBLIC_TEXT'));assert.ok(!html.includes('PRIVATE_LYRIC_MARKER'));assert.ok(!html.includes('PRIVATE_TITLE_MARKER'));assert.ok(!html.includes('UNKNOWN_TITLE_MARKER'));assert.ok(!html.includes('not-approved'));assert.ok(!html.includes('/logout'));assert.ok(!html.includes('download='));assert.ok(!html.includes('/jacket/site-only'));
assert.ok(html.includes('PUBLIC_IMPRESSION'));assert.ok(!html.includes('PRIVATE_IMPRESSION_MARKER'));
const audio=await call('/audio/allowed.mp3');assert.equal(audio.status,200);assert.equal(audio.headers.get('Content-Type'),'audio/mpeg');assert.deepEqual(Buffer.from(await audio.arrayBuffer()),bytes);
const segment=await call('/audio/site-only.mp3',{headers:{Range:'bytes=0-3'}});assert.equal(segment.status,206);assert.deepEqual(Buffer.from(await segment.arrayBuffer()),bytes.subarray(0,4));
assert.equal((await call('/jacket/allowed')).status,200);assert.equal((await call('/jacket/site-only')).status,404);
for(const id of ['secret-song','unknown-song','not-approved','wrong-key','duplicate']){assert.equal((await call(`/audio/${id}.mp3`)).status,404);assert.equal((await call(`/jacket/${id}`)).status,404);}
assert.equal((await call('/admin')).status,404);assert.equal((await call('/public-catalog.json')).status,404);assert.equal((await call('/assets/admin.js')).status,404);assert.equal((await call('/',{method:'POST'})).status,405);
assert.ok(reads.every(k=>['public-catalog.json','public-audio/allowed.mp3','public-audio/site-only.mp3','public-jackets/allowed.png'].includes(k)));
assert.equal((await publicListening(new Request('https://public.example.invalid/'),{})).status,503);
const prior=new Set(['already-public']);assert.doesNotThrow(()=>assertArchiveApproval('already-public',{lyrics:'already published'},prior));
assert.throws(()=>assertArchiveApproval('new',{title:'unknown'},prior));assert.throws(()=>assertArchiveApproval('new',{publicationClass:'private',publicArchiveApproved:true},prior));
assert.throws(()=>assertArchiveApproval('new',{publicationClass:'site',publicArchiveApproved:true,lyrics:'private',lyricsScope:'private'},prior));assert.doesNotThrow(()=>assertArchiveApproval('new',{publicationClass:'site',publicArchiveApproved:true,lyricsScope:'both',lyrics:'public'},prior));
const mixed=[{id:'a',title:'あさ'},{id:'b',title:'Blue'},{id:'c',title:'星',reading:'ほし'}];assert.deepEqual(sortedSongs(mixed).map(s=>s.id),['a','c','b']);assert.deepEqual(sortedSongs(mixed,'az').map(s=>s.id),['b','a','c']);
let order=[];const cards=[{dataset:{orderNew:0,orderKana:2,orderAz:1}},{dataset:{orderNew:1,orderKana:0,orderAz:2}},{dataset:{orderNew:2,orderKana:1,orderAz:0}}].map((x,i)=>({...x,id:i,style:{setProperty(){}},querySelector(){return this.no??={};}}));
const selector={value:'new',addEventListener(k,fn){this.change=fn;}};const grid={querySelectorAll:()=>cards,append(c){order.push(c.id);}};
vm.runInNewContext(readFileSync(new URL('../src/works-sort.js',import.meta.url),'utf8'),{document:{querySelector:q=>q==='#works-order'?selector:grid}});
for(const [mode,expected] of [['kana',[1,2,0]],['az',[2,0,1]],['new',[0,1,2]]]){selector.value=mode;order=[];selector.change();assert.deepEqual(order,expected);}
console.log('PASS: three public archive sort modes, explicit archive approval, independent public lyrics/jackets, approved public audio/range, hidden entries never served, no private bucket access');
