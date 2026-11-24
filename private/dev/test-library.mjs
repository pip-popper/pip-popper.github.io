// Local template + UI interaction checks. No HTTP, Cloudflare, R2 or real audio access.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { libraryPage, adminPage, loginPage } from '../worker/src/pages.js';
import worker, { LoginGuard } from '../worker/src/index.js';
import { privateLyricsCall } from '../../manager/private-lyrics.mjs';
import { sortedSongs, validReading } from '../worker/src/song-order.js';
const mixed=[{id:'kanji',title:'星'},{id:'ten',title:'１０曲'},{id:'beta',title:'Beta'},{id:'flower-kata',title:'ﾊﾅ'},{id:'tokyo',title:'東京',reading:'とうきょう'},
  {id:'two',title:'2曲'},{id:'alpha',title:'alpha'},{id:'morning',title:'アサ'},{id:'love',title:'あい'},{id:'flower-hira',title:'はな'}];
const beforeSort=JSON.stringify(mixed);
assert.deepEqual(sortedSongs(mixed).map(s=>s.id),['love','morning','tokyo','flower-hira','flower-kata','alpha','beta','two','ten','kanji']);
assert.equal(JSON.stringify(mixed),beforeSort);
assert.ok(validReading('ﾊﾅ'));assert.ok(validReading('カタカナ'));assert.ok(validReading(''));assert.ok(!validReading('漢字'));assert.ok(!validReading('あ\nい'));
const newSong={id:'new',title:'うた'};
assert.equal(sortedSongs([...mixed,newSong])[2].id,'new');
const mixedPage=libraryPage({songs:mixed});assert.ok(mixedPage.indexOf('/audio/love.mp3?')<mixedPage.indexOf('/audio/morning.mp3?'));assert.ok(mixedPage.indexOf('/audio/two.mp3?')<mixedPage.indexOf('/audio/ten.mp3?'));assert.ok(mixedPage.includes('あいうえお順'));
const songs=Array.from({length:50},(_,i)=>({id:'sample-'+i,title:i===1?'長い曲名'.repeat(20)+'<script>&"':'Song '+i,sha256:'a'.repeat(64),
  ...(i===0?{lyrics:'一行目\n\n二行目',cover:'https://pip-popper.github.io/assets/covers/sample.jpg'}:i===1?{lyrics:'歌詞 < & >\n次の行',coverKey:'jackets/sample-1.png'}:i===2?{cover:'https://pip-popper.github.io/assets/covers/sample-2-640.jpg'}:{})}));
const html=libraryPage({songs});
assert.equal((html.match(/class="pv-item"/g)||[]).length,50);
assert.equal((html.match(/<audio /g)||[]).length,50);
assert.equal((html.match(/download="[^"]+\.mp3">MP3/g)||[]).length,50);
assert.ok(html.includes('&lt;script&gt;&amp;&quot;'));
assert.ok(!html.includes('<script>&'));
assert.ok(html.indexOf('/audio/sample-0.mp3?')<html.indexOf('/audio/sample-49.mp3?'));
const waveHtml=libraryPage({songs:[{id:'wav-sample',title:'試聴音',file:'audio/wav-sample.wav',type:'audio/wav'}]});
assert.ok(waveHtml.includes('/audio/wav-sample.wav?download=1'));
assert.ok(waveHtml.includes('download="PIP POPPER - 試聴音.wav">WAV'));
assert.ok(!adminPage().includes('pv-library-list'));
assert.ok(!loginPage({}).includes('pv-player'));
assert.ok(html.includes('歌詞 &lt; &amp; &gt;\n次の行'));
assert.ok(html.includes('src="/jacket/sample-1"'));
assert.ok(html.includes('https://pip-popper.github.io/tracks/sample-2/'));
assert.ok(!html.includes('jackets/sample-1.png'));
assert.ok(!loginPage({}).includes('一行目'));
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
    play(){for(const cb of listeners.get('play')||[])cb({target:this});this.paused=false;this.ended=false;events.play?.();return Promise.resolve();},
    finish(){this.ended=true;this.paused=true;events.ended?.();},
    fail(){this.error={code:4};events.error?.();}};
  item.querySelector=q=>q==='audio'?audio:q==='.pv-body'?body:q==='.pv-select'?button:q==='.pv-song-lyrics'?{textContent:s.lyrics||''}:q==='.pv-public-work'?null:q==='.pv-jacket img'?(s.cover||s.coverKey?{getAttribute:()=>s.cover||'/jacket/'+s.id}:null):{textContent:s.title};
  return {item,button,body,audio};
});
const controls={append(a){a.parent=this;}},title={},status={};
const player={hidden:true,querySelector:q=>q==='.pv-player-controls'?controls:q==='.pv-player-title'?title:status};
const lyrics={scrollTop:0}, jacket={hidden:true,attrs:{},setAttribute(k,v){this.attrs[k]=v;},removeAttribute(k){delete this.attrs[k];},addEventListener(k,v){this[k]=v;}};
const listening={hidden:true,querySelector:q=>q==='.pv-current-lyrics'?lyrics:q==='.pv-current-jacket img'?jacket:null};
const list={querySelectorAll:()=>entries.map(e=>e.item)};
const document={documentElement:{classList:classes()},querySelector:q=>q==='.pv-library-list'?list:q==='.pv-listening'?listening:player,
  querySelectorAll:()=>entries.map(e=>e.audio),addEventListener(k,v){listeners.set(k,[...(listeners.get(k)||[]),v]);}};
vm.runInNewContext(readFileSync(new URL('../worker/public/assets/private.js',import.meta.url),'utf8'),{document});
assert.equal(player.hidden,false);
assert.equal(entries[0].audio.paused,true); // never autoplay on entry
assert.equal(entries[0].button.textContent,'▶ 再生');
assert.equal(entries[0].button.attrs['aria-current'],'true');
assert.equal(entries[0].button.attrs['aria-pressed'],'false');
assert.equal(entries[0].audio.parent,controls);
assert.equal(listening.hidden,false);
assert.equal(lyrics.textContent,songs[0].lyrics);
assert.equal(jacket.attrs.src,songs[0].cover);
lyrics.scrollTop=42;
entries[1].button.click();
assert.equal(lyrics.textContent,songs[1].lyrics);
assert.equal(lyrics.scrollTop,0);
assert.equal(jacket.attrs.src,'/jacket/sample-1');
assert.equal(title.textContent,songs[1].title);
assert.ok(entries[1].item.classList.contains('is-playing'));
assert.equal(entries[1].button.textContent,'⏸ 一時停止');
assert.equal(entries[1].button.attrs['aria-pressed'],'true');
entries[1].audio.currentTime=37;
entries[1].button.click(); // same card button pauses at the current time
assert.ok(!entries[1].item.classList.contains('is-playing'));
assert.equal(entries[1].button.textContent,'▶ 再生');
assert.equal(entries[1].button.attrs['aria-current'],'true');
assert.equal(status.textContent,'一時停止中');
entries[1].button.click();
assert.equal(entries[1].audio.currentTime,37); // selecting current song resumes
assert.equal(entries[1].button.textContent,'⏸ 一時停止');
entries[1].audio.pause(); // native upper player controls keep the card in sync
assert.equal(entries[1].button.textContent,'▶ 再生');
await entries[1].audio.play();
assert.equal(entries[1].button.textContent,'⏸ 一時停止');
entries[49].button.click();
assert.equal(lyrics.textContent,'歌詞はまだ登録されていません。');
assert.equal(jacket.hidden,true);
assert.equal(jacket.attrs.src,undefined);
assert.equal(entries[1].audio.paused,true);
assert.equal(entries[1].button.textContent,'▶ 再生');
assert.equal(entries[1].button.attrs['aria-current'],'false');
assert.equal(entries[49].button.textContent,'⏸ 一時停止');
assert.equal(entries[1].audio.parent,entries[1].body);
assert.equal(entries[49].audio.parent,controls);
assert.equal(entries.filter(e=>e.item.classList.contains('is-current')).length,1);
assert.equal(entries.filter(e=>e.item.classList.contains('is-playing')).length,1);
entries[1].button.click();
assert.equal(entries[1].audio.currentTime,37); // moving the element does not reset its state
entries[1].audio.finish();
assert.equal(status.textContent,'再生終了');
assert.equal(entries[1].button.textContent,'▶ 再生');
assert.ok(!entries[1].item.classList.contains('is-playing'));
entries[1].audio.fail();
assert.ok(status.textContent.includes('再生できません'));
assert.ok(entries.every(e=>e.button.hidden===false));
console.log('PASS: 50-song template, escaping/order/download/fallback, no autoplay, selection, single playback, pause/resume, seek state, ended/error, lyrics/jacket switching and missing-data fallback, admin/login isolation');

// Exercise the real Worker with only in-memory, fictitious data and a normal login.
const marker='PRIVATE_TEST_LYRICS_ONLY';
const imageBytes=new Uint8Array([137,80,78,71,13,10,26,10]);
const mp3Bytes=Buffer.concat([Buffer.from([0xff,0xfb,0x90,0xc0]),Buffer.alloc(413)]);
let inventory={version:2,rev:4,songs:[{id:'private-sample',title:'Sample',lyrics:marker,coverKey:'jackets/private-sample.png',file:'audio/sample.mp3',type:'audio/mpeg',size:mp3Bytes.length},{id:'second',title:'Second',file:'audio/second.mp3',size:20,cover:'https://pip-popper.github.io/assets/covers/second-640.jpg'}],retired:[]};
let etag='fixture-4', failWrite=false;
const store=new Map();
const guard=new LoginGuard({storage:{get:async k=>store.get(k),put:async(k,v)=>store.set(k,v),deleteAll:async()=>store.clear()}});
const env={PRIVATE_PASSWORD:'fixture-member-password',ADMIN_PASSWORD:'fixture-admin-password',SESSION_KEY:'fixture-only-'.repeat(5),
  LOGIN_GUARD:{idFromName:name=>name,get:()=>({fetch:(url,init)=>guard.fetch(new Request(url,init))})},
  BUCKET:{get:async (key,options)=>key==='catalog.json'?{json:async()=>structuredClone(inventory),etag}:key==='jackets/private-sample.png'?{body:imageBytes,httpMetadata:{contentType:'image/png'}}:key==='audio/sample.mp3'?{body:options?.range?mp3Bytes.subarray(options.range.offset,options.range.offset+options.range.length):mp3Bytes}:null,
    put:async(key,value,options)=>{assert.equal(key,'catalog.json'); if(failWrite||options.onlyIf?.etagMatches!==etag)return null; inventory=JSON.parse(value);etag=`fixture-${inventory.rev}`;return {etag};}},
  ASSETS:{fetch:async()=>new Response('static fixture')},
};
const call=(path,init={})=>worker.fetch(new Request('http://localhost'+path,init),env);
const guest=await call('/');
assert.ok(!(await guest.text()).includes(marker));
assert.equal((await call('/jacket/private-sample')).status,401);
assert.ok(!(await (await call('/assets/private.js')).text()).includes(marker));
const login=await call('/login',{method:'POST',headers:{Origin:'http://localhost'},body:new URLSearchParams({password:env.PRIVATE_PASSWORD})});
assert.equal(login.status,303);
const headers={Cookie:login.headers.get('Set-Cookie').split(';')[0]};
const member=await call('/',{headers});
assert.equal(member.headers.get('Cache-Control'),'no-store');
assert.ok((await member.text()).includes(marker));
const image=await call('/jacket/private-sample',{headers});
assert.equal(image.status,200);
assert.equal(image.headers.get('Content-Type'),'image/png');
assert.equal(image.headers.get('Cache-Control'),'no-store');
assert.deepEqual(new Uint8Array(await image.arrayBuffer()),imageBytes);
assert.equal((await call('/jacket/unknown',{headers})).status,404);
const mp3=await call('/audio/private-sample.mp3?download=1',{headers});
assert.equal(mp3.status,200);assert.equal(mp3.headers.get('Content-Type'),'audio/mpeg');
assert.match(mp3.headers.get('Content-Disposition'),/^attachment; filename="pip-popper-private-sample\.mp3"; filename\*=UTF-8''PIP%20POPPER%20-%20Sample\.mp3$/);
assert.deepEqual(Buffer.from(await mp3.arrayBuffer()),mp3Bytes);
const partial=await call('/audio/private-sample.mp3?v=test',{headers:{...headers,Range:'bytes=0-3'}});
assert.equal(partial.status,206);assert.match(partial.headers.get('Content-Disposition'),/^inline;/);assert.deepEqual(Buffer.from(await partial.arrayBuffer()),mp3Bytes.subarray(0,4));
assert.equal((await call('/audio/private-sample.wav?download=1',{headers})).status,404);
assert.equal((await call('/audio/private-sample.mp3?download=1')).status,401);
assert.equal((await call('/audio/private-sample',{headers})).status,200); // legacy link compatibility
console.log('PASS: authenticated library and private jacket, no-store responses, no private lyrics in guest/static responses, missing jacket fallback');

// The Windows transport talks directly to the same mock Worker, without HTTP sockets.
const mockFetch=(url,init)=>worker.fetch(new Request(url,init),env);
const base=new URL('http://localhost/');
const adminPassword=env.ADMIN_PASSWORD;
const getLyrics=()=>privateLyricsCall(base,{adminPassword},false,mockFetch);
const saveLyrics=(id,rev,lyrics)=>privateLyricsCall(base,{adminPassword,id,rev,lyrics,confirm:true},true,mockFetch);
const loaded=await getLyrics();
assert.equal(loaded.status,200); assert.equal(loaded.body.rev,4);
assert.equal(loaded.body.songs[0].lyrics,marker);assert.equal(loaded.body.songs[1].lyrics,'');
assert.equal(loaded.body.songs[0].publicWork,false);assert.equal(loaded.body.songs[1].publicWork,true);
assert.equal((await call('/admin/api/lyrics')).status,401);
assert.equal((await call('/admin/api/lyrics',{headers:{...headers,'X-PP-Admin':'1'}})).status,401);
const text=' 新規の一行\n\n二行目 < & >\n';
const saved=await saveLyrics('second',4,text);
assert.equal(saved.status,200);assert.equal(saved.body.song.id,'second');assert.equal(saved.body.song.lyrics,text);
assert.equal(inventory.songs[0].lyrics,marker);assert.equal(inventory.songs[1].file,'audio/second.mp3');assert.equal(inventory.songs[1].size,20);
assert.equal((await getLyrics()).body.songs[1].lyrics,text);
assert.equal((await saveLyrics('second',4,'stale')).status,409);assert.equal(inventory.songs[1].lyrics,text);
assert.equal((await saveLyrics('unknown',5,'wrong')).status,404);assert.equal(inventory.rev,5);
failWrite=true; assert.equal((await saveLyrics('second',5,'not saved')).status,409);assert.equal(inventory.songs[1].lyrics,text);failWrite=false;
const edited='編集済み\n\n改行';
assert.equal((await saveLyrics('second',5,edited)).status,200);
assert.ok((await (await call('/',{headers})).text()).includes(edited));
assert.ok(!(await (await call('/')).text()).includes(edited));
assert.equal((await privateLyricsCall(base,{adminPassword,id:'second',rev:6,lyrics:'no confirmation'},true,mockFetch)).status,400);
assert.equal(inventory.songs[1].lyrics,edited);
assert.equal((await saveLyrics('second',6,'')).status,200);assert.equal((await getLyrics()).body.songs[1].lyrics,'');
assert.equal(inventory.songs[0].lyrics,marker);assert.equal(inventory.songs[1].file,'audio/second.mp3');
console.log('PASS: manager transport + Worker lyrics list/register/edit/clear, exact line breaks, ID binding, stale revision/write failure protection, no audio writes, invitee-only display');

// DOM-level check of the Windows manager (no browser/network sockets required).
const roots=new Map();
let dialogAnswer='go';
class Element {
  constructor(tag='div'){this.tag=tag;this.children=[];this.value='';this.textContent='';}
  append(...items){this.children.push(...items);}
  replaceChildren(...items){this.children=items;}
  addEventListener(){}
  querySelector(){return {focus(){}};}
  showModal(){queueMicrotask(()=>{this.returnValue=dialogAnswer;this.onclose?.();});}
  get selectedOptions(){return this.children.filter(c=>c.value===this.value);}
}
const fakeDocument={createElement:tag=>new Element(tag),body:new Element('body'),querySelector:id=>{if(!roots.has(id))roots.set(id,new Element());return roots.get(id);}};
const find=(node,match)=>typeof node==='object'&&node!==null?(match(node)?node:node.children?.map(c=>find(c,match)).find(Boolean)):null;
const apiCalls=[];
const fakeApi=async(url,init)=>{
  if(url==='/api/state')return Response.json({changes:{items:[],files:[],other:[]},list:{tracks:[],history:[],other:[],site:[]}});
  const body=JSON.parse(init.body);apiCalls.push({url,id:body.id,lyrics:body.lyrics,reading:body.reading});
  const response=await privateLyricsCall(base,body,url.endsWith('/save'),mockFetch);
  return Response.json(response.body,{status:response.status});
};
vm.runInNewContext(readFileSync(new URL('../../manager/ui/app.js',import.meta.url),'utf8'),{
  document:fakeDocument,window:{addEventListener(){}},location:{hash:'#t=fixture',pathname:'/'},history:{replaceState(){}},sessionStorage:{setItem(){},getItem(){}},URLSearchParams,fetch:fakeApi,setTimeout:()=>{},console,
});
await new Promise(r=>setImmediate(r));
const menu=find(roots.get('#lists'),e=>e.tag==='button'&&e.children?.[0]?.textContent==='PRIVATE楽曲の歌詞・よみがな');
assert.ok(menu);await menu.onclick();
const main=roots.get('#main'), field=id=>find(main,e=>e.id===id), button=text=>find(main,e=>e.tag==='button'&&e.textContent===text);
field('pl-password').value=adminPassword;await button('PRIVATE曲一覧を読み込む').onclick();
assert.equal(field('pl-password').value,'');
assert.equal(field('pl-song').children.length,2);
field('pl-song').value='second';await field('pl-song').onchange();
assert.equal(field('pl-lyrics').value,'');
field('pl-lyrics').value='管理画面の歌詞\n\n二行目';field('pl-lyrics').oninput();
dialogAnswer='cancel';field('pl-song').value='private-sample';await field('pl-song').onchange();
assert.equal(field('pl-song').value,'second');assert.equal(field('pl-lyrics').value,'管理画面の歌詞\n\n二行目');
field('pl-password').value=adminPassword;await button('内容を確認して保存').onclick();
assert.equal(apiCalls.filter(r=>r.url.endsWith('/save')).length,0);assert.equal(field('pl-password').value,'');
dialogAnswer='go';field('pl-password').value=adminPassword;await button('内容を確認して保存').onclick();
assert.equal(apiCalls.at(-1).id,'second');assert.equal(inventory.songs[1].lyrics,'管理画面の歌詞\n\n二行目');
assert.ok(button('内容を確認して保存').disabled);assert.equal(field('pl-password').value,'');
const originalOrder=inventory.songs.map(s=>s.id);
field('pl-reading').value='あさ';field('pl-reading').oninput();field('pl-password').value=adminPassword;
await button('内容を確認して保存').onclick();
assert.equal(apiCalls.at(-1).reading,'あさ');assert.equal(apiCalls.at(-1).lyrics,undefined);
assert.equal(inventory.songs[1].lyrics,'管理画面の歌詞\n\n二行目');assert.equal(inventory.songs[1].reading,'あさ');
assert.deepEqual(inventory.songs.map(s=>s.id),originalOrder);assert.equal(field('pl-song').children[0].value,'second');
assert.equal((await getLyrics()).body.songs[0].id,'second');
const nowRev=inventory.rev;
const readingSave=(reading,rev=nowRev)=>privateLyricsCall(base,{adminPassword,id:'second',rev,reading,confirm:true},true,mockFetch);
assert.equal((await readingSave('漢字')).status,400);assert.equal((await readingSave('かき',nowRev-1)).status,409);
assert.equal((await readingSave('')).status,200);assert.equal(inventory.songs[1].reading,'');
assert.equal(inventory.songs[1].lyrics,'管理画面の歌詞\n\n二行目');assert.deepEqual(inventory.songs.map(s=>s.id),originalOrder);
console.log('PASS: manager UI navigation, list, password clearing, draft protection, canceled confirmation, confirmed save and success state');
console.log('PASS: kana/half-width/English/numeric/unset order, new track insertion, optional reading edit/clear, invalid/stale rejection, catalog order and lyrics preserved');
