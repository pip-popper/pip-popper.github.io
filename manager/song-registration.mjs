// Local, non-public song registration. The only writable tree is .manager/song-registrations.
import path from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile, rename, copyFile } from 'node:fs/promises';
import { validReading } from '../private/worker/src/song-order.js';

const ID=/^new-[a-f0-9]{24}$/;const REV=/^[a-f0-9-]{36}$/;
const classes=['unknown','general','site','private'], scopes=['public','private','hidden'], states=['draft','registered','ready'];
const audiences=['hp','listen','private'];
const dir=root=>path.join(root,'.manager','song-registrations');
const file=(root,id,...parts)=>{if(!ID.test(id))throw new Error('曲IDが正しくありません。');return path.join(dir(root),id,...parts);};
const readJson=async f=>JSON.parse(await readFile(f,'utf8'));
const problem=(status,error)=>({status,body:{error}});
const result=body=>({status:200,body});
const str=(v,max,name,required=false)=>{if(typeof v!=='string'||v.length>max||(required&&!v.trim()))throw new Error(`${name}を確認してください。`);return v;};
const hostService=h=>['open.spotify.com','spotify.link'].includes(h)?'spotify':h==='music.apple.com'?'apple-music':['youtube.com','www.youtube.com','youtu.be','music.youtube.com'].includes(h)?'youtube':['suno.com','www.suno.com','app.suno.ai','suno.ai'].includes(h)?'suno':'other';
function linksOf(values){if(!Array.isArray(values)||values.length>20)throw new Error('配信先URLを確認してください。');const links=[];for(const text of values){let url;try{url=new URL(text);}catch{throw new Error('配信先URLはhttps://で入力してください。');}if(url.protocol!=='https:'||url.username||url.password||url.href.length>2000)throw new Error('配信先URLは認証情報を含まないhttpsのみです。');if(links.some(x=>x.url===url.href))throw new Error('同じ配信先URLがあります。');const service=hostService(url.hostname);links.push({service,url:url.href,...(service==='other'?{label:url.hostname}:{})});}return links;}
function fields(input){
  const d=input.fields;if(!d||typeof d!=='object')throw new Error('登録内容を確認してください。');
  const title=str(d.title,150,'曲名',true).trim(),reading=str(d.reading,100,'よみがな');if(!validReading(reading))throw new Error('よみがなはひらがな・カタカナ・英数字で入力してください。');
  if(!classes.includes(d.classification)||!scopes.includes(d.lyricsScope)||!scopes.includes(d.impressionScope)||!states.includes(d.state))throw new Error('公開区分・公開範囲・準備状態を確認してください。');
  const channels={};for(const a of audiences){if(typeof d.channels?.[a]!=='boolean')throw new Error('掲載先を確認してください。');channels[a]=d.channels[a];}
  if((channels.hp||channels.listen)&&!['general','site'].includes(d.classification))throw new Error('一般公開HP・一般視聴は一般公開またはこのサイトのみの曲に限ります。');
  return {title,reading:reading.trim(),artist:str(d.artist,100,'アーティスト名',true).trim(),lyrics:str(d.lyrics,100000,'歌詞'),impression:str(d.impression,100000,'AIの感想'),classification:d.classification,lyricsScope:d.lyricsScope,impressionScope:d.impressionScope,channels,state:d.state,links:linksOf(d.urls),memo:str(d.memo,10000,'公開メモ')};
}
// Validate actual image headers and dimensions, never trust the extension or submitted MIME.
function imageDimensions(b,mime){
  if(mime==='image/png'&&b.length>=33&&b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&b.subarray(12,16).toString()==='IHDR'&&b.subarray(-8,-4).toString()==='IEND')return [b.readUInt32BE(16),b.readUInt32BE(20)];
  if(mime==='image/jpeg'&&b.length>8&&b[0]===255&&b[1]===216&&b.at(-2)===255&&b.at(-1)===217){let p=2;while(p+4<b.length){if(b[p++]!==255)break;while(b[p]===255)p++;const marker=b[p++];if(marker===0xda||marker===0xd9)break;const n=b.readUInt16BE(p);if(n<2||p+n>b.length)break;if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)&&n>=7)return [b.readUInt16BE(p+5),b.readUInt16BE(p+3)];p+=n;}}
  throw new Error('PNG/JPEG画像を確認できません。');
}
function decodeImage(item,max,expected){if(!item||!['image/png','image/jpeg'].includes(item.mime)||(expected&&item.mime!==expected)||typeof item.data!=='string'||item.data.length>Math.ceil(max/3)*4+4||!/^[A-Za-z0-9+/]*={0,2}$/.test(item.data))throw new Error('画像形式または容量を確認してください。');const bytes=Buffer.from(item.data,'base64');if(!bytes.length||bytes.length>max)throw new Error('画像の容量が上限を超えています。');const [width,height]=imageDimensions(bytes,item.mime);if(width<1||height<1||width>12000||height>12000||width*height>40e6)throw new Error('画像のサイズを確認してください。');return {bytes,width,height,mime:item.mime};}
function images(input){if(!input)return null;const original=decodeImage(input.original,12*1024*1024),web=decodeImage(input.web,4*1024*1024,'image/jpeg'),thumb=decodeImage(input.thumb,2*1024*1024,'image/jpeg');if(thumb.width!==640||web.width>1254||web.height>4000||thumb.height>4000)throw new Error('表示画像のサイズを確認してください。');return {original,web,thumb};}
async function current(root,id){try{const p=await readJson(file(root,id,'current.json'));if(!REV.test(p.rev))throw new Error('保存記録を確認できません。');return p.rev;}catch(e){if(e.code==='ENOENT')return null;throw e;}}
async function record(root,id,rev){if(!REV.test(rev))throw new Error('保存版を確認してください。');const r=await readJson(file(root,id,'versions',rev,'record.json'));if(r.id!==id||r.rev!==rev)throw new Error('曲と保存版が一致しません。');return r;}
async function thumbData(root,r){if(!r.image)return null;const b=await readFile(file(root,r.id,'versions',r.rev,'cover-640.jpg'));return `data:image/jpeg;base64,${b.toString('base64')}`;}
async function history(root,id){const rows=[];for(const rev of await readdir(file(root,id,'versions'))){if(!REV.test(rev))continue;try{const r=await record(root,id,rev);rows.push({rev,updatedAt:r.updatedAt,title:r.title});}catch{}}return rows.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));}
export async function listRegistrations(root){let ids;try{ids=await readdir(dir(root));}catch(e){if(e.code==='ENOENT')return [];throw e;}const rows=[];for(const id of ids){if(!ID.test(id))continue;const rev=await current(root,id);if(!rev)continue;const r=await record(root,id,rev);rows.push({id,rev,title:r.title,reading:r.reading,classification:r.classification,lyricsScope:r.lyricsScope,links:r.links,state:r.state,channels:r.channels,image:!!r.image,updatedAt:r.updatedAt});}return rows.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));}
async function get(root,id){const rev=await current(root,id);if(!rev)return problem(404,'新曲の登録が見つかりません。');const r=await record(root,id,rev);return result({record:r,thumbnail:await thumbData(root,r),history:await history(root,id)});}
async function writeVersion(root,id,expected,data,source,upload){
  const rev=randomUUID(),base=file(root,id,'versions',rev);await mkdir(base,{recursive:true});
  let image=null;
  if(upload){const originalName=upload.original.mime==='image/png'?'original.png':'original.jpg';await writeFile(path.join(base,originalName),upload.original.bytes,{flag:'wx'});await writeFile(path.join(base,'cover-web.jpg'),upload.web.bytes,{flag:'wx'});await writeFile(path.join(base,'cover-640.jpg'),upload.thumb.bytes,{flag:'wx'});image={originalName,width:upload.original.width,height:upload.original.height};}
  else if(source?.image){image=source.image;for(const name of [image.originalName,'cover-web.jpg','cover-640.jpg'])await copyFile(file(root,id,'versions',source.rev,name),path.join(base,name));}
  const r={...data,id,rev,image,actualPublication:'not-published',audioStatus:'unregistered',updatedAt:new Date().toISOString()};
  await writeFile(path.join(base,'record.json'),JSON.stringify(r,null,2)+'\n',{flag:'wx'});
  // Optional prepared official-site candidate. It is still inside the ignored
  // registration directory, and contains only explicitly public information.
  if(r.state==='ready'&&image&&r.channels.hp&&['general','site'].includes(r.classification)){
    const candidate=path.join(base,'public-candidate');await mkdir(candidate);
    const track={title:r.title,artist:r.artist,reading:r.reading,artwork:'cover-web.jpg',audio:null,publicationClass:r.classification,publicArchiveApproved:true,
      ...(r.lyricsScope==='public'?{lyricsScope:'public',lyrics:r.lyrics}:{}),...(r.impressionScope==='public'?{impressionScope:'public',aiImpression:r.impression}:{}),...(r.classification==='general'&&r.links.length?{links:r.links}:{})};
    await writeFile(path.join(candidate,'track.json'),JSON.stringify(track,null,2)+'\n',{flag:'wx'});
    for(const name of ['cover-web.jpg','cover-640.jpg'])await copyFile(path.join(base,name),path.join(candidate,name));
  }
  if(r.state==='ready'&&r.channels.listen&&['general','site'].includes(r.classification)){
    const candidate={id:r.id,title:r.title,artist:r.artist,reading:r.reading,classification:r.classification,publicAudioApproved:false,audioStatus:'unregistered',...(image?{localJacket:'cover-640.jpg',publicJacketApproved:false}:{}),
      ...(r.lyricsScope==='public'?{lyricsScope:'public',publicLyricsApproved:true,lyrics:r.lyrics}:{}),...(r.impressionScope==='public'?{impressionScope:'public',publicImpressionApproved:true,impression:r.impression}:{})};
    await writeFile(path.join(base,'public-listening-candidate.json'),JSON.stringify(candidate,null,2)+'\n',{flag:'wx'});
  }
  if(r.state==='ready'&&r.channels.private&&r.classification!=='unknown'){
    const candidate={id:r.id,title:r.title,artist:r.artist,reading:r.reading,audioStatus:'unregistered',...(r.lyricsScope!=='hidden'?{lyrics:r.lyrics}:{}),...(r.impressionScope!=='hidden'?{impressionScope:r.impressionScope,impression:r.impression}:{}),...(image?{localJacket:'cover-640.jpg'}:{})};
    await writeFile(path.join(base,'private-candidate.json'),JSON.stringify(candidate,null,2)+'\n',{flag:'wx'});
  }
  if(await current(root,id)!==expected)return problem(409,'別の画面で変更されています。再読み込みしてください。');
  const pointer=file(root,id,`current-${rev}.tmp`);await writeFile(pointer,JSON.stringify({rev}),{flag:'wx'});await rename(pointer,file(root,id,'current.json'));
  return get(root,id);
}
export async function registrationAction(root,action,input={}){
  try{
    if(action==='list')return result({songs:await listRegistrations(root)});
    if(action==='get')return await get(root,input.id);
    if(action==='save'){
      if(input.confirm!==true)return problem(400,'保存前の確認が必要です。');const data=fields(input),upload=images(input.image);
      const id=input.id??`new-${randomBytes(12).toString('hex')}`;if(!ID.test(id))return problem(400,'曲IDが正しくありません。');const rev=await current(root,id);
      if(input.id&&(!rev||input.rev!==rev))return problem(409,'対象曲または保存版が変わりました。再読み込みしてください。');if(!input.id&&rev)return problem(409,'新しい曲IDを作れませんでした。');
      const old=rev?await record(root,id,rev):null;
      if(data.state==='ready'&&(!upload&&!old?.image||data.classification==='unknown'||!Object.values(data.channels).some(Boolean)))return problem(400,'公開準備完了にはジャケット・公開区分・掲載先の設定が必要です。');
      return await writeVersion(root,id,rev,data,old,upload);
    }
    if(action==='restore'){
      if(input.confirm!==true)return problem(400,'復元前の確認が必要です。');const rev=await current(root,input.id);if(!rev||rev!==input.rev)return problem(409,'対象曲の保存版が変わりました。');const old=await record(root,input.id,input.restoreRev);const {id,rev:oldRev,image,actualPublication,audioStatus,updatedAt,...data}=old;
      return await writeVersion(root,input.id,rev,data,old,null);
    }
    if(action==='preview'){
      if(!audiences.includes(input.audience))return problem(400,'掲載先を確認してください。');const rev=await current(root,input.id);if(!rev)return problem(404,'新曲の登録が見つかりません。');const r=await record(root,input.id,rev),isPrivate=input.audience==='private';
      const allowed=r.channels[input.audience]&&(isPrivate?r.classification!=='unknown':['general','site'].includes(r.classification));
      if(!allowed)return result({visible:false,message:'この掲載先への公開許可が設定されていません。'});
      const canShow=scope=>scope==='public'||(isPrivate&&scope==='private');
      // Only the audience-approved projection leaves this API; no raw record, memo, revision or private text.
      return result({visible:true,title:r.title,artist:r.artist,thumbnail:await thumbData(root,r),lyrics:canShow(r.lyricsScope)?r.lyrics:'',impression:canShow(r.impressionScope)?r.impression:'',links:!isPrivate&&r.classification==='general'?r.links:[],audioStatus:'unregistered',notice:'掲載イメージ（未公開・音源未登録）'});
    }
    return problem(404,'見つかりません。');
  }catch(e){return problem(e.code?500:400,e.code?'保存・読込みを完了できませんでした。以前の保存内容を保持しています。':(e.message||'登録内容を確認してください。'));}
}
