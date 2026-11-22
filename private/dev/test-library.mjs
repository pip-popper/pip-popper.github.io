// Local template + UI interaction checks. No HTTP, Cloudflare, R2 or real audio access.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { libraryPage, adminPage, loginPage } from '../worker/src/pages.js';
const songs=Array.from({length:50},(_,i)=>({id:'sample-'+i,title:i===1?'長い曲名'.repeat(20)+'<script>&"':'Song '+i,sha256:'a'.repeat(64)}));
const html=libraryPage({songs});
assert.equal((html.match(/class="pv-item"/g)||[]).length,50);
assert.equal((html.match(/<audio /g)||[]).length,50);
assert.equal((html.match(/download>MP3/g)||[]).length,50);
assert.ok(html.includes('&lt;script&gt;&amp;&quot;'));
assert.ok(!html.includes('<script>&'));
assert.ok(html.indexOf('/audio/sample-0?')<html.indexOf('/audio/sample-49?'));
assert.ok(!adminPage().includes('pv-library-list'));
assert.ok(!loginPage({}).includes('pv-player'));
assert.ok(libraryPage({songs:[]}).includes('現在、登録されている音源はありません。'));
const listeners=new Map();
const classes=()=>{const values=new Set();return {add:v=>values.add(v),toggle:(v,b)=>b?values.add(v):values.delete(v),contains:v=>values.has(v)};};
const entries=songs.map(s=>{
  const item={classList:classes()},button={hidden:true,attrs:{},setAttribute(k,v){this.attrs[k]=v;},addEventListener(k,v){this[k]=v;}};
  const body={insertBefore(a){a.parent=this;},querySelector(){return {};}};
  const events={};
  const audio={src:'/audio/'+s.id,currentTime:0,paused:true,ended:false,parent:body,
    setAttribute(){},addEventListener(k,v){events[k]=v;},
    pause(){this.paused=true;events.pause?.();},
    play(){for(const cb of listeners.get('play')||[])cb({target:this});this.paused=false;events.play?.();return Promise.resolve();},
    finish(){this.ended=true;this.paused=true;events.ended?.();},
    fail(){this.error={code:4};events.error?.();}};
  item.querySelector=q=>q==='audio'?audio:q==='.pv-body'?body:q==='.pv-select'?button:{textContent:s.title};
  return {item,button,body,audio};
});
const controls={append(a){a.parent=this;}},title={},status={};
const player={hidden:true,querySelector:q=>q==='.pv-player-controls'?controls:q==='.pv-player-title'?title:status};
const list={querySelectorAll:()=>entries.map(e=>e.item)};
const document={documentElement:{classList:classes()},querySelector:q=>q==='.pv-library-list'?list:player,
  querySelectorAll:()=>entries.map(e=>e.audio),addEventListener(k,v){listeners.set(k,[...(listeners.get(k)||[]),v]);}};
vm.runInNewContext(readFileSync(new URL('../worker/public/assets/private.js',import.meta.url),'utf8'),{document});
assert.equal(player.hidden,false);
assert.equal(entries[0].audio.paused,true); // never autoplay on entry
assert.equal(entries[0].audio.parent,controls);
entries[1].button.click();
assert.equal(title.textContent,songs[1].title);
assert.ok(entries[1].item.classList.contains('is-playing'));
entries[1].audio.currentTime=37;
entries[1].audio.pause();
assert.ok(!entries[1].item.classList.contains('is-playing'));
entries[1].button.click();
assert.equal(entries[1].audio.currentTime,37); // selecting current song resumes
entries[49].button.click();
assert.equal(entries[1].audio.paused,true);
assert.equal(entries[1].audio.parent,entries[1].body);
assert.equal(entries[49].audio.parent,controls);
assert.equal(entries.filter(e=>e.item.classList.contains('is-current')).length,1);
assert.equal(entries.filter(e=>e.item.classList.contains('is-playing')).length,1);
entries[1].button.click();
assert.equal(entries[1].audio.currentTime,37); // moving the element does not reset its state
entries[1].audio.finish();
assert.equal(status.textContent,'再生終了');
assert.ok(!entries[1].item.classList.contains('is-playing'));
entries[1].audio.fail();
assert.ok(status.textContent.includes('再生できません'));
assert.ok(entries.every(e=>e.button.hidden===false));
console.log('PASS: 50-song template, escaping/order/download/fallback, no autoplay, selection, single playback, pause/resume, seek state, ended/error, admin/login isolation');
