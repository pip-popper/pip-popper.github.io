// Producer-only management metadata. This module never writes to tracks, docs,
// R2 or Git. Its data and history live inside the ignored .manager directory.
import { readFile, readdir, mkdir, writeFile, rename, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { listRegistrations } from './song-registration.mjs';

export const RELEASE_CLASSES = ['unknown','general','site','private'];
export const LYRIC_SCOPES = ['unknown','public','private','both','none'];
const ID = /^[a-z0-9-]{1,128}$/;
const HOSTS = {spotify:['open.spotify.com','spotify.link'], 'apple-music':['music.apple.com'], youtube:['www.youtube.com','youtube.com','youtu.be','music.youtube.com'], suno:['suno.com','www.suno.com','app.suno.ai','suno.ai']};
const digest = text => createHash('sha256').update(text).digest('hex');
const json = async file => JSON.parse(await readFile(file,'utf8'));
const serviceOf = host => Object.keys(HOSTS).find(s=>HOSTS[s].includes(host)) ?? 'other';
function linkOf(item) {
  if (!item || typeof item.url!=='string' || item.url.length>2000) throw new Error('配信URLを確認してください。');
  let url; try { url=new URL(item.url); } catch { throw new Error('配信URLは https:// で入力してください。'); }
  if (url.protocol!=='https:' || url.username || url.password) throw new Error('配信URLは認証情報を含まない https:// のみ登録できます。');
  const service=item.service ?? serviceOf(url.hostname);
  if (service!=='other' && (!Object.hasOwn(HOSTS,service) || !HOSTS[service].includes(url.hostname))) throw new Error('配信先とURLが一致しません。');
  const label=service==='other' ? String(item.label??'').trim() : '';
  if (service==='other' && (!label || label.length>100)) throw new Error('その他の配信先の名前を入力してください。');
  return {service,url:url.href,...(label?{label}:{})};
}
function normalizeLinks(input) {
  if (!Array.isArray(input)||input.length>30) throw new Error('配信先は30件以内で登録してください。');
  const links=input.map(linkOf);
  if (new Set(links.map(l=>l.url)).size!==links.length) throw new Error('同じURLが重複しています。');
  return links;
}
function sourceLinks(data) {
  const raw=[...(Array.isArray(data.links)?data.links:[]),...(data.streamingUrl?[{url:data.streamingUrl}]:[])];
  const result=[];
  for(const item of raw)try{const link=linkOf(item);if(!result.some(l=>l.url===link.url))result.push(link);}catch{} // never invent a replacement URL
  return result;
}
const empty=()=>({version:1,records:{}});
async function readStore(root) {
  const file=path.join(root,'.manager','release-status.json');
  let text;try{text=await readFile(file,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;return {file,text:null,data:empty(),rev:digest('missing')};}
  const data=JSON.parse(text);
  if(data.version!==1 || !data.records || Array.isArray(data.records) || typeof data.records!=='object')throw new Error('公開状況記録を読み込めません。元の記録を保護します。');
  for(const [id,row] of Object.entries(data.records)) {
    if(!ID.test(id)||!row||!RELEASE_CLASSES.includes(row.classification)||!LYRIC_SCOPES.includes(row.lyricsScope)||typeof row.title!=='string')throw new Error('公開状況記録の形式が正しくありません。');
    normalizeLinks(row.links);
  }
  return {file,text,data,rev:digest(text)};
}
async function readPublic(root) {
  const works=await json(path.join(root,'docs','works.json'));
  if(!Array.isArray(works))throw new Error('公式サイトのローカル作品一覧が読めません。');
  const rows=new Map();
  for(const work of works) {
    if(!ID.test(work.id)||typeof work.title!=='string')continue;
    const page=await readFile(path.join(root,'docs','tracks',work.id,'index.html'),'utf8');
    rows.set(work.id,{id:work.id,title:work.title,site:true,publicLyrics:/class="lyrics-text"/.test(page),sourceLinks:[]});
  }
  for(const id of await readdir(path.join(root,'tracks'))) {
    if(!ID.test(id))continue;
    let data;try{data=await json(path.join(root,'tracks',id,'track.json'));}catch(e){if(e.code==='ENOENT'||e.code==='ENOTDIR')continue;throw e;}
    const row=rows.get(id)??{id,title:data.title,site:false,publicLyrics:false,sourceLinks:[]};
    row.sourceLinks=sourceLinks(data);row.hasSource=true;rows.set(id,row);
  }
  return rows;
}
export function sanitizePrivateRows(songs) {
  if(!Array.isArray(songs))throw new Error('PRIVATE曲一覧を読み込めません。');
  return songs.map(s=>{
    if(!ID.test(s.id)||typeof s.title!=='string'||typeof s.lyrics!=='string')throw new Error('PRIVATE曲一覧の形式が正しくありません。');
    return {id:s.id,title:s.title,privateLyrics:!!s.lyrics.trim()};
  });
}
export function releaseView(rows, filter='all', query='') {
  const counts={all:rows.length,unknown:0,general:0,site:0,private:0};
  for(const row of rows)counts[row.classification]++;
  const q=query.trim().toLowerCase();
  return {counts,rows:rows.filter(r=>(filter==='all'||r.classification===filter)&&(!q||`${r.title} ${r.id}`.toLowerCase().includes(q)))};
}
export async function listReleaseStatus(root, privateRows=null) {
  const store=await readStore(root), rows=await readPublic(root);
  if(privateRows!==null)for(const p of privateRows){const prior=rows.get(p.id);rows.set(p.id,{...(prior??{id:p.id,title:p.title,site:false,publicLyrics:false,sourceLinks:[]}),private:true,privateLyrics:p.privateLyrics});}
  for(const [id,saved] of Object.entries(store.data.records))if(!rows.has(id))rows.set(id,{id,title:saved.title,site:false,publicLyrics:false,sourceLinks:[],savedOnly:true});
  for(const registration of await listRegistrations(root))if(!rows.has(registration.id))rows.set(registration.id,{id:registration.id,title:registration.title,site:false,publicLyrics:false,sourceLinks:[],registration});
  const result=[...rows.values()].map(row=>{
    const saved=Object.hasOwn(store.data.records,row.id)?store.data.records[row.id]:null;
    const draft=row.registration;
    const classification=draft?.classification??saved?.classification??'unknown', lyricsScope=draft?(draft.lyricsScope==='hidden'?'none':draft.lyricsScope):saved?.lyricsScope??'unknown';
    const links=draft?.links??saved?.links??row.sourceLinks;
    const privatePresent=privateRows===null?null:!!row.private;
    const privateLyrics=privatePresent===null?null:!!row.privateLyrics;
    const warnings=[];
    if(classification==='private'&&(row.site||row.sourceLinks.length||links.length))warnings.push('PRIVATEのみ指定と、既存の公式サイト掲載・配信先情報が一致していません。実際の公開状態は変更されません。');
    if(classification==='site'&&(row.sourceLinks.length||links.length))warnings.push('このサイトのみ指定と配信先情報が一致していません。');
    if(classification==='general'&&!links.length&&!row.sourceLinks.length)warnings.push('一般公開指定ですが配信先URLが未登録です。');
    if(classification==='site'&&!row.site)warnings.push('このサイトのみ指定ですが、公式サイトのローカル資料で掲載を確認できません。');
    if(classification==='private'&&privatePresent===false)warnings.push('PRIVATEのみ指定ですが、取得したPRIVATE一覧では登録を確認できません。');
    if((lyricsScope==='private'||lyricsScope==='none')&&row.publicLyrics)warnings.push('指定した歌詞範囲と、公式サイトにある歌詞が一致していません。実際の表示は変更されません。');
    if((lyricsScope==='public'||lyricsScope==='none')&&privateLyrics===true)warnings.push('指定した歌詞範囲と、PRIVATE登録歌詞が一致していません。');
    if((lyricsScope==='public'||lyricsScope==='both')&&!row.publicLyrics)warnings.push('指定した歌詞範囲と、公式サイトのローカル資料で確認できた歌詞が一致していません。');
    if((lyricsScope==='private'||lyricsScope==='both')&&privateLyrics===false)warnings.push('指定した歌詞範囲と、取得したPRIVATE歌詞の登録状態が一致していません。');
    if(draft)warnings.unshift('新曲登録の準備記録。現時点で公開・音源登録されていません。編集は新曲登録画面で行います。');
    return {id:row.id,title:row.title,classification,lyricsScope,links,sourceLinks:row.sourceLinks,site:row.site,publicLyrics:row.publicLyrics,privatePresent,privateLyrics,saved:!!saved,savedOnly:!!row.savedOnly,warnings,...(draft?{registrationState:draft.state}:{})};
  }).sort((a,b)=>a.title.localeCompare(b.title,'ja')||a.id.localeCompare(b.id));
  return {rev:store.rev,privateLoaded:privateRows!==null,...releaseView(result)};
}
export async function saveReleaseStatus(root, privateRows, input) {
  if(!input||!ID.test(input.id??'')||input.confirm!==true||!RELEASE_CLASSES.includes(input.classification)||!LYRIC_SCOPES.includes(input.lyricsScope))return {status:400,body:{error:'対象曲と公開区分・歌詞範囲を確認してください。'}};
  let links;try{links=normalizeLinks(input.links);}catch(e){return {status:400,body:{error:e.message}};}
  const store=await readStore(root);
  if(input.rev!==store.rev)return {status:409,body:{error:'別の画面で変更されています。入力を控えて再読み込みしてください。'}};
  const view=await listReleaseStatus(root,privateRows);
  if(view.rev!==store.rev)return {status:409,body:{error:'別の画面で変更されています。再読み込みしてください。'}};
  const row=view.rows.find(r=>r.id===input.id);
  if(!row)return {status:404,body:{error:'対象曲が確認できません。曲一覧を再読み込みしてください。'}};
  if(row.registrationState)return {status:409,body:{error:'新曲の設定は新曲登録画面で編集してください。'}};
  store.data.records[input.id]={title:row.title,classification:input.classification,lyricsScope:input.lyricsScope,links,updatedAt:new Date().toISOString()};
  const directory=path.dirname(store.file);await mkdir(directory,{recursive:true});
  const stamp=randomUUID();
  if(store.text!==null){const backup=path.join(directory,'release-status-backups');await mkdir(backup,{recursive:true});await copyFile(store.file,path.join(backup,`${stamp}.json`));}
  const next=JSON.stringify(store.data,null,2)+'\n', temp=path.join(directory,`release-status-${stamp}.tmp`);
  await writeFile(temp,next,{encoding:'utf8',flag:'wx'});
  // The normal manager server serializes writes; also recheck external changes
  // immediately before replacing the file.
  if((await readStore(root)).rev!==store.rev)return {status:409,body:{error:'別の画面で変更されています。再読み込みしてください。'}};
  await rename(temp,store.file);
  return {status:200,body:await listReleaseStatus(root,privateRows)};
}
