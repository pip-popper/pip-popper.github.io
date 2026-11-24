import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,readFile,rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';import os from 'node:os';import vm from 'node:vm';
import {registrationAction,listRegistrations} from './song-registration.mjs';
import {listReleaseStatus,saveReleaseStatus} from './release-status.mjs';
import {assertArchiveApproval} from '../public-listening/approval.mjs';
const parent=path.resolve(os.tmpdir()),root=await mkdtemp(path.join(parent,'pp-registration-test-'));
const write=async(rel,text)=>{const f=path.join(root,rel);await mkdir(path.dirname(f),{recursive:true});await writeFile(f,text);};
const bytes=rel=>readFileSync(new URL('../'+rel,import.meta.url));
// Known public, already-existing JPEG/PNG files are read only as image fixtures.
const image={original:{mime:'image/png',data:bytes('tracks/anniversary/cover.png').toString('base64')},web:{mime:'image/jpeg',data:bytes('tracks/anniversary/cover-web.jpg').toString('base64')},thumb:{mime:'image/jpeg',data:bytes('tracks/anniversary/cover-640.jpg').toString('base64')}};
const image2={original:{mime:'image/jpeg',data:bytes('tracks/manner/cover-640.jpg').toString('base64')},web:{mime:'image/jpeg',data:bytes('tracks/manner/cover-web.jpg').toString('base64')},thumb:{mime:'image/jpeg',data:bytes('tracks/manner/cover-640.jpg').toString('base64')}};
const initial={title:'架空新曲',reading:'かくうしんきょく',artist:'PIP POPPER',lyrics:'PRIVATE_LYRIC\n\n二行目',impression:'PRIVATE_IMPRESSION',classification:'unknown',lyricsScope:'private',impressionScope:'private',channels:{hp:false,listen:false,private:false},state:'draft',urls:[],memo:'LOCAL_MEMO_ONLY'};
const call=(a,b)=>registrationAction(root,a,b);
try{
  await write('docs/works.json','[]');await mkdir(path.join(root,'tracks'),{recursive:true});
  let res=await call('save',{fields:initial,confirm:true});assert.equal(res.status,200,JSON.stringify(res.body));let r=res.body.record;const id=r.id,first=r.rev;
  assert.match(id,/^new-[a-f0-9]{24}$/);assert.equal(r.image,null);assert.equal(r.actualPublication,'not-published');assert.equal(r.audioStatus,'unregistered');
  assert.deepEqual((await call('preview',{id,audience:'hp'})).body.visible,false);
  assert.equal((await call('save',{id,rev:r.rev,fields:{...initial,classification:'private',channels:{hp:true,listen:false,private:true}},confirm:true})).status,400);
  res=await call('save',{id,rev:r.rev,fields:{...initial,classification:'general',channels:{hp:true,listen:true,private:true},state:'ready'},image,confirm:true});assert.equal(res.status,200,JSON.stringify(res.body));r=res.body.record;const second=r.rev;assert.ok(res.body.thumbnail.startsWith('data:image/jpeg;base64,'));
  const version=path.join(root,'.manager','song-registrations',id,'versions',second);
  const candidate=JSON.parse(await readFile(path.join(version,'public-candidate','track.json'),'utf8'));
  assert.doesNotThrow(()=>assertArchiveApproval(id,candidate,new Set()));assert.ok(!JSON.stringify(candidate).includes('PRIVATE_'));assert.ok(!JSON.stringify(candidate).includes('LOCAL_MEMO_ONLY'));
  assert.deepEqual(await readFile(path.join(version,'original.png')),Buffer.from(image.original.data,'base64'));
  const listening=JSON.parse(await readFile(path.join(version,'public-listening-candidate.json'),'utf8'));assert.equal(listening.publicAudioApproved,false);assert.equal(listening.audioKey,undefined);assert.ok(!JSON.stringify(listening).includes('PRIVATE_'));
  for(const audience of ['hp','listen']){const p=(await call('preview',{id,audience})).body;assert.equal(p.visible,true);assert.equal(p.lyrics,'');assert.equal(p.impression,'');assert.ok(!JSON.stringify(p).includes('LOCAL_MEMO_ONLY'));}
  const p=(await call('preview',{id,audience:'private'})).body;assert.equal(p.lyrics,initial.lyrics);assert.equal(p.impression,initial.impression);
  assert.equal((await call('save',{id,rev:first,fields:initial,confirm:true})).status,409);
  assert.equal((await call('save',{id,rev:second,fields:initial,image:{...image,thumb:{mime:'image/jpeg',data:'YWJj'}},confirm:true})).status,400);
  const edited={...initial,title:'曲名変更',classification:'private',channels:{hp:false,listen:false,private:true},state:'draft',lyrics:'修正\n\n歌詞',impression:'修正した感想'};
  res=await call('save',{id,rev:second,fields:edited,image:image2,confirm:true});assert.equal(res.status,200);r=res.body.record;assert.equal(r.id,id);assert.equal(r.title,edited.title);assert.equal(r.lyrics,edited.lyrics);assert.equal(r.impression,edited.impression);assert.notEqual(r.rev,second);
  assert.equal((await call('preview',{id,audience:'hp'})).body.visible,false);assert.equal((await call('preview',{id,audience:'listen'})).body.visible,false);
  const reopened=(await call('get',{id})).body;assert.deepEqual(reopened.record,r);assert.equal(reopened.thumbnail,`data:image/jpeg;base64,${image2.thumb.data}`);
  const release=await listReleaseStatus(root);const row=release.rows.find(x=>x.id===id);assert.equal(row.registrationState,'draft');assert.equal(row.classification,'private');assert.equal((await saveReleaseStatus(root,null,{id,rev:release.rev,classification:'general',lyricsScope:'public',links:[],confirm:true})).status,409);
  res=await call('restore',{id,rev:r.rev,restoreRev:second,confirm:true});assert.equal(res.status,200);r=res.body.record;assert.equal(r.title,initial.title);assert.equal(r.lyrics,initial.lyrics);assert.equal(r.id,id);assert.equal(res.body.thumbnail,`data:image/jpeg;base64,${image.thumb.data}`);
  res=await call('save',{id,rev:r.rev,fields:{...initial,classification:'site',channels:{hp:true,listen:true,private:true},state:'ready',lyricsScope:'public',impressionScope:'hidden',lyrics:'公開承認した歌詞'},confirm:true});assert.equal(res.status,200);r=res.body.record;
  for(const audience of ['hp','listen','private']){const v=(await call('preview',{id,audience})).body;assert.equal(v.lyrics,'公開承認した歌詞');assert.equal(v.impression,'');}
  const latestCandidate=JSON.parse(await readFile(path.join(root,'.manager','song-registrations',id,'versions',r.rev,'public-candidate','track.json'),'utf8'));assert.equal(latestCandidate.lyrics,'公開承認した歌詞');assert.equal(latestCandidate.aiImpression,undefined);
  assert.equal((await listRegistrations(root)).length,1);assert.equal((await call('save',{id,rev:r.rev,fields:{...initial,state:'published'},confirm:true})).status,400);assert.equal((await call('save',{id,rev:r.rev,fields:{...initial,state:'registered'},confirm:true})).status,400);   // 2026-11-24: 登録済み is retired
  assert.equal(await readFile(path.join(root,'docs','works.json'),'utf8'),'[]');
  console.log('PASS: draft without image, durable ID/version/image replacement, lyrics/impression preservation, independent visibility, candidate projections, no publication, stale/invalid save rejection, restore, release-status integration');

  // Real UI handlers with a browser DOM imitation, including FileReader/canvas conversion.
  const roots=new Map();let answer='go';
  class Element{constructor(tag='div'){this.tag=tag;this.children=[];this.value='';this.textContent='';this.checked=false;}append(...x){this.children.push(...x);}replaceChildren(...x){this.children=x;}addEventListener(){}querySelector(){return{focus(){}};}removeAttribute(k){delete this[k];}showModal(){queueMicrotask(()=>{this.returnValue=answer;this.onclose?.();});}getContext(){return{fillRect(){},drawImage(){}};}toDataURL(){return 'data:image/jpeg;base64,'+(this.width===640?image.thumb.data:image.web.data);}}
  const doc={createElement:t=>new Element(t),body:new Element('body'),querySelector:id=>{if(!roots.has(id))roots.set(id,new Element());return roots.get(id);}};
  const find=(n,m)=>typeof n==='object'&&n!==null?(m(n)?n:n.children?.map(c=>find(c,m)).find(Boolean)):null;
  class Reader{readAsDataURL(){this.result='data:image/png;base64,'+image.original.data;queueMicrotask(()=>this.onload());}}
  class Img{constructor(){this.naturalWidth=1254;this.naturalHeight=1254;}set src(v){queueMicrotask(()=>this.onload());}}
  const request=async(url,init)=>{if(url==='/api/state')return Response.json({registrations:await listRegistrations(root),changes:{items:[],files:[],other:[]},list:{tracks:[],history:[],other:[],site:[]}});const response=await call(url.split('/').at(-1),JSON.parse(init.body));return Response.json(response.body,{status:response.status});};
  vm.runInNewContext(readFileSync(new URL('./ui/app.js',import.meta.url),'utf8'),{document:doc,window:{addEventListener(){}},location:{hash:'#t=fixture',pathname:'/'},history:{replaceState(){}},sessionStorage:{setItem(){},getItem(){}},URLSearchParams,URL:{createObjectURL:()=> 'blob:fixture',revokeObjectURL(){}},FileReader:Reader,Image:Img,fetch:request,setTimeout:()=>{},console});
  let menu;for(let i=0;i<100&&!menu;i++){await new Promise(r=>setTimeout(r,5));menu=find(roots.get('#menu'),e=>e.tag==='button'&&e.children?.[1]?.textContent==='新曲を登録');}assert.ok(menu);await menu.onclick();const main=roots.get('#main'),field=id=>find(main,e=>e.id===id),button=t=>find(main,e=>e.tag==='button'&&e.textContent===t);
  assert.equal(field('reg-artist').value,'PIP POPPER');field('reg-title').value='UI登録';field('reg-title').oninput();field('reg-lyrics').value='秘密のUI歌詞';field('reg-lyrics').oninput();
  field('reg-image').files=[{name:'fixture.png',type:'image/png',size:1000}];await field('reg-image').onchange();
  field('reg-classification').value='site';field('reg-classification').onchange();field('reg-hp').checked=true;field('reg-hp').onchange();field('reg-lyricsScope').value='private';field('reg-lyricsScope').onchange();
  await button('確認して保存').onclick();const ui=(await listRegistrations(root)).find(x=>x.title==='UI登録');assert.ok(ui);assert.ok(ui.image);
  field('reg-preview-mode').value='hp';field('reg-preview-mode').onchange();await button('掲載イメージを見る').onclick();assert.ok(find(main,e=>e.className==='reg-candidate hp'));assert.ok(!find(main,e=>e.className==='reg-candidate-text'&&e.textContent==='秘密のUI歌詞'));
  field('reg-preview-width').value='phone';field('reg-preview-width').onchange();assert.ok(find(main,e=>e.className==='registration-preview phone'));
  console.log('PASS: registration menu, actual UI file selection/preview handlers, saving, public-scope omission, PC/phone layout selection');
}finally{if(path.dirname(path.resolve(root))===parent&&path.basename(root).startsWith('pp-registration-test-'))await rm(root,{recursive:true,force:true});}
