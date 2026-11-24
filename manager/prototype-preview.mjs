// Isolated, local-only preview of the real PRIVATE Worker and manager UI.
// Never loads the project's track data, actual credentials, R2 or Git remotes.
import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import worker, { LoginGuard } from '../private/worker/src/index.js';
import { privateLyricsCall } from './private-lyrics.mjs';
import { listReleaseStatus, saveReleaseStatus, sanitizePrivateRows } from './release-status.mjs';
import { publicListening } from '../public-listening/worker.mjs';
import { registrationAction, listRegistrations } from './song-registration.mjs';

const HERE=path.dirname(fileURLToPath(import.meta.url));
const PROJECT=path.dirname(HERE);
const MEMBER='preview-member', ADMIN='preview-admin'; // fictitious preview-only passwords, not production credentials
const types={'.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.ico':'image/x-icon','.html':'text/html; charset=utf-8'};
const json=(status,data)=>Response.json(data,{status,headers:{'Cache-Control':'no-store'}});
const plain=(status,text)=>new Response(text,{status,headers:{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'}});
const crc=bytes=>{let v=0xffffffff;for(const x of bytes){v^=x;for(let n=0;n<8;n++)v=(v>>>1)^((v&1)?0xedb88320:0);}return (v^0xffffffff)>>>0;};
function chunk(name,bytes){const type=Buffer.from(name),len=Buffer.alloc(4),check=Buffer.alloc(4);len.writeUInt32BE(bytes.length);check.writeUInt32BE(crc(Buffer.concat([type,bytes])));return Buffer.concat([len,type,bytes,check]);}
function demoPng(v){
  const w=320,h=320,raw=Buffer.alloc((w*3+1)*h),pals=[[190,45,65],[35,117,166],[180,118,42],[99,57,154],[29,140,119],[160,62,108]],c=pals[v%pals.length];
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const at=y*(w*3+1)+1+x*3,r=Math.hypot(x-160,y-160),stripe=(Math.sin((x+y+v*27)/29)+1)/2;
    for(let k=0;k<3;k++)raw[at+k]=Math.max(8,Math.min(255,c[k]*(.32+.56*stripe)+(r>72&&r<95?42:0)));
  }
  const header=Buffer.alloc(13);header.writeUInt32BE(w);header.writeUInt32BE(h,4);header[8]=8;header[9]=2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
}
function demoWav(v){
  const rate=16000,seconds=24,n=rate*seconds,b=Buffer.alloc(44+n*2),notes=[220,261.63,293.66,329.63,349.23,392,440];
  b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(rate,24);b.writeUInt32LE(rate*2,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(n*2,40);
  for(let i=0;i<n;i++){const t=i/rate,beat=t%0.8,f=notes[(Math.floor(t/.8)+v)%notes.length],fade=Math.min(1,beat/.05,(.8-beat)/.12,(seconds-t)/.3);b.writeInt16LE(Math.round(2100*Math.sin(2*Math.PI*f*t)*Math.max(0,fade)),44+i*2);}
  return b;
}
const names=['星の道','夜のドライブ','まちの灯り','夏の風','月の向こう','レコードの午後','青い朝','雨上がり','スローモーション','遠い空','ダンスの時間','長い曲名の表示確認 — いつまでも続く架空のメロディ'];
const demoTitles={2:'カナリア',3:'あさの光',4:'虹の向こう',5:'Blue Sky',6:'10分間',7:'2人の夜',8:'漢字の曲',9:'うたの時間',10:'エコー',11:'波の音',12:'あおい空'};
const demoReadings={1:'ほしのみち',4:'にじのむこう',11:'なみのおと'};
function publicFixture(){
  const objects=new Map(),songs=[];
  for(const [i,title,classification,scope,approved] of [[1,'あさのメロディ','general','public',true],[2,'Blue Coast','site','private',true],[3,'星のワルツ','site','both',true],[4,'非公開テスト曲','private','public',true],[5,'未設定テスト曲','unknown','public',true],[6,'未承認テスト曲','general','public',false]]){
    const id=`listen-${i}`,bytes=demoWav(i),audioKey=`public-audio/${id}.wav`,jacketKey=`public-jackets/${id}.png`;
    songs.push({id,title,classification,publicAudioApproved:approved,audioKey,size:bytes.length,lyricsScope:scope,publicLyricsApproved:true,lyrics:i===2?'NONPUBLIC_LYRIC_TEST_MARKER':`架空の公開歌詞 ${i}\n\n音楽を楽しもう`,publicJacketApproved:i!==2,jacketKey,...(i===3?{reading:'ほしのわるつ'}:{})});
    objects.set(audioKey,{bytes,type:'audio/wav'});objects.set(jacketKey,{bytes:demoPng(i),type:'image/png'});
  }
  objects.set('public-catalog.json',{bytes:Buffer.from(JSON.stringify({version:1,songs})),type:'application/json'});
  return {PUBLIC_BUCKET:{get:async(key,options)=>{const o=objects.get(key);if(!o)return null;return {body:options?.range?o.bytes.subarray(options.range.offset,options.range.offset+options.range.length):o.bytes,httpMetadata:{contentType:o.type},json:async()=>JSON.parse(o.bytes.toString('utf8'))};}}};
}
const line=(i)=>`これはプレビュー専用の架空歌詞です。\nDEMO ${String(i).padStart(2,'0')} の最初の一行\n見知らぬ街の明かりが揺れる\n音に合わせてページをめくる\n\n二つ目の段落\nゆっくり歩いていこう\n歌詞の改行と空行を確認する\n\n`+Array.from({length:i===1?10:2},(_,n)=>`テストの段落 ${n+3}\n夜空を見上げて\n架空の言葉が続く\n\n`).join('');

async function fixture(){
  const parent=path.join(PROJECT,'.manager','prototype-preview');await mkdir(parent,{recursive:true});
  const root=await mkdtemp(path.join(parent,'run-'));
  const write=async(rel,text)=>{const file=path.join(root,rel);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,text);};
  const objects=new Map(), songs=[], works=[];
  const audio=[demoWav(0),demoWav(2),demoWav(4)], covers=Array.from({length:6},(_,i)=>demoPng(i));
  for(let i=1;i<=30;i++){
    const id=`demo-${String(i).padStart(2,'0')}`,title=demoTitles[i]?`${demoTitles[i]}（DEMO ${String(i).padStart(2,'0')}）`:`DEMO ${String(i).padStart(2,'0')}｜${names[(i-1)%names.length]}`,file=`audio/${id}.wav`,coverKey=`jackets/${id}.png`, bytes=audio[i%audio.length];
    objects.set(file,{bytes,type:'audio/wav',etag:randomUUID()});
    if(i!==3)objects.set(coverKey,{bytes:covers[i%covers.length],type:'image/png',etag:randomUUID()});
    const song={id,title,file,size:bytes.length,type:'audio/wav',duration:24,sha256:`demo-${i}`,audioUpdatedAt:'2026-01-01T00:00:00Z',...(demoReadings[i]?{reading:demoReadings[i]}:{}),...(i!==3?{coverKey}:{}),...(i%5!==0?{lyrics:line(i)}:{})};
    songs.push(song);
    if(i<=10){works.push({id,title});await write(`tracks/${id}/track.json`,JSON.stringify({title, ...(i===1?{links:[{service:'spotify',url:'https://open.spotify.com/track/preview-only-not-real'}]}:{})}));await write(`docs/tracks/${id}/index.html`,i%3===0?'no lyrics':'<div class="lyrics-text">公開歌詞の架空サンプル</div>');}
  }
  await write('docs/works.json',JSON.stringify(works));
  const records={
    'demo-01':{title:songs[0].title,classification:'general',lyricsScope:'both',links:[{service:'spotify',url:'https://open.spotify.com/track/preview-only-not-real'}]},
    'demo-02':{title:songs[1].title,classification:'site',lyricsScope:'public',links:[]},
    'demo-11':{title:songs[10].title,classification:'private',lyricsScope:'private',links:[]},
  };
  await write('.manager/release-status.json',JSON.stringify({version:1,records},null,2));
  objects.set('catalog.json',{bytes:Buffer.from(JSON.stringify({version:2,rev:1,songs,retired:[]})),type:'application/json',etag:randomUUID()});
  return {root,objects};
}
function makeEnv(objects){
  const guards=new Map();
  const getGuard=id=>{if(!guards.has(id)){const storage=new Map();guards.set(id,new LoginGuard({storage:{get:async k=>storage.get(k),put:async(k,v)=>storage.set(k,v),deleteAll:async()=>storage.clear()}}));}return guards.get(id);};
  return {PRIVATE_PASSWORD:MEMBER,ADMIN_PASSWORD:ADMIN,SESSION_KEY:randomBytes(32).toString('hex'),
    LOGIN_GUARD:{idFromName:name=>name,get:id=>({fetch:(url,init)=>getGuard(id).fetch(new Request(url,init))})},
    BUCKET:{get:async(key,options)=>{const o=objects.get(key);if(!o)return null;const bytes=options?.range?o.bytes.subarray(options.range.offset,options.range.offset+options.range.length):o.bytes;return {etag:o.etag,size:o.bytes.length,httpMetadata:{contentType:o.type},body:bytes,json:async()=>JSON.parse(o.bytes.toString('utf8'))};},
      put:async(key,body,options)=>{if(key!=='catalog.json')throw new Error('preview: read-only objects');const old=objects.get(key);if(options?.onlyIf?.etagMatches!==old.etag)return null;const bytes=Buffer.from(typeof body==='string'?body:await new Response(body).arrayBuffer());const etag=randomUUID();objects.set(key,{bytes,type:'application/json',etag});return {etag};}},
    ASSETS:{fetch:async request=>{const p=new URL(request.url).pathname;if(!/^\/(?:assets\/[a-z0-9.-]+|favicon\.ico)$/.test(p))return plain(404,'Not found');try{const file=path.join(PROJECT,'private','worker','public',p.slice(1));return new Response(await readFile(file),{headers:{'Content-Type':types[path.extname(file)]??'application/octet-stream','Cache-Control':'no-store'}});}catch{return plain(404,'Not found');}}},
  };
}
const previewCss=`body{--preview-accent:#e8ac59}.prototype-hub{margin:0;background:#121115;color:#f0e9e1;font:16px/1.65 'Segoe UI',sans-serif}.prototype-hub main{max-width:880px;margin:0 auto;padding:42px 24px}.prototype-hub h1{font-size:30px;line-height:1.2;margin:10px 0}.prototype-hub .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px;margin:24px 0}.prototype-hub section{background:#201b20;border:1px solid #44383b;padding:20px;border-radius:8px}.prototype-hub a,.prototype-hub button{display:inline-block;background:#ad273d;color:white;border:0;border-radius:5px;padding:12px;margin:5px 4px 5px 0;font:inherit;text-decoration:none;cursor:pointer}.prototype-hub code{color:#ffe0ae}.preview-badge{position:fixed;bottom:12px;left:12px;z-index:9999;background:#20130e;border:1px solid #e8ac59;color:#ffdb9d;padding:8px 12px;font:13px/1.5 sans-serif;text-decoration:none;border-radius:5px}.prototype-manager #btn-publish,.prototype-manager #btn-discard,.prototype-manager #btn-history{display:none}.prototype-manager .bar .brand small::after{content:'（架空データ）';color:#e8ac59}.prototype-manager .welcome ol,.prototype-manager .welcome .kinds{display:none}`;
const previewScript=`document.querySelectorAll('[data-mobile]').forEach(b=>b.addEventListener('click',()=>{window.open(b.dataset.mobile,'ppPrototypeMobile','popup,width=390,height=840,resizable,scrollbars');}));document.getElementById('stop').addEventListener('click',async()=>{if(!confirm('試作品を終了しますか？'))return;try{await fetch('/api/quit',{method:'POST',headers:{'Content-Type':'application/json','X-PP-Token':document.body.dataset.token},body:'{}'});}catch{}document.querySelector('main').textContent='試作品を終了しました。このタブを閉じてください。';});`;
function hub(token){return `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PIP POPPER 試作品プレビュー</title><link rel="stylesheet" href="/__preview.css"><body class="prototype-hub" data-token="${token}"><main><p>LOCAL PREVIEW / 本番未反映</p><h1>PIP POPPER 試作品プレビュー</h1><p>全30曲の架空データです。本番には接続しません。音は24秒の合成試聴音、ジャケット・歌詞・配信先はすべて架空です。</p><div class="cards"><section><h2>PRIVATE鑑賞画面</h2><p>入室用テストパスワード：<code>${MEMBER}</code></p><a href="/" target="_blank" rel="noopener">PC表示を開く</a><button type="button" data-mobile="/">スマホ幅で開く</button></section><section><h2>Windows管理ツール</h2><p>管理者用テストパスワード：<code>${ADMIN}</code></p><a href="/manager/#t=${token}" target="_blank" rel="noopener">管理ツールを開く</a><button type="button" data-mobile="/manager/#t=${token}">スマホ幅で開く</button><p>左の「PRIVATE楽曲の歌詞・よみがな」と「全楽曲の公開状況」で確認。歌詞・よみがなを保存したらPRIVATEを再読み込み。</p></section></div><p>スマホ幅のウィンドウが開かない場合は、ブラウザの開発者ツール（F12 → Ctrl+Shift+M）で幅390pxにしてください。</p><p>管理情報の保存は試作品専用フォルダーのみ。実際の公開変更、パスワード変更、Git送信は無効です。</p><button id="stop">試作品を終了</button></main><script src="/__preview.js"></script></body></html>`;}

export async function createPrototype({onStop=()=>{}}={}){
  const {root,objects}=await fixture(),env=makeEnv(objects),token=randomBytes(24).toString('hex');
  const publicEnv=publicFixture(),officialRoot=path.join(root,'official');
  const built=spawnSync(process.execPath,[path.join(PROJECT,'build.mjs'),'--out',officialRoot,'--public-listening-url','/listen/'],{cwd:PROJECT,encoding:'utf8',windowsHide:true});
  if(built.status!==0)throw new Error('公開サイト試作品の生成に失敗しました：'+(built.stderr||built.error?.message||''));
  const mockFetch=(url,init)=>{const u=new URL(url);if(u.hostname!=='localhost'||!/^\/admin\/(?:login|logout|api\/lyrics|api\/songs\/[a-z0-9-]+\/lyrics)$/.test(u.pathname))throw new Error('preview: request blocked');return worker.fetch(new Request(u,init),env);};
  let privateRows=null,busy=false;
  async function managerApi(request,url){
    if(request.headers.get('X-PP-Token')!==token)return json(403,{error:'試作品の起動画面から開いてください。'});
    if(request.method==='GET'&&url.pathname==='/api/state')return json(200,{list:{tracks:[],history:[],other:[],site:[]},registrations:await listRegistrations(root),changes:{items:[],files:[],other:[]},pendingPush:0,otherUnpushed:0,liveUrl:'試作品専用',privateUrl:'試作品専用',remoteOk:false});
    if(request.method!=='POST')return json(404,{error:'試作品で使用できない操作です。'});
    if(busy)return json(409,{error:'処理中です。'});busy=true;
    try{
      const raw=await request.text();if(Buffer.byteLength(raw)>(url.pathname==='/api/song-registration/save'?30e6:2e6))return json(413,{error:'入力が大きすぎます。'});
      const body=JSON.parse(raw||'{}');let r;
      if(url.pathname==='/api/private/lyrics/list')r=await privateLyricsCall(new URL('http://localhost/'),body,false,mockFetch);
      else if(url.pathname==='/api/private/lyrics/save'){
        r=await privateLyricsCall(new URL('http://localhost/'),body,true,mockFetch);
        if(r.status===200&&privateRows){const p=privateRows.find(x=>x.id===r.body.song.id);if(p)p.privateLyrics=!!r.body.song.lyrics.trim();}
      }else if(url.pathname==='/api/release-status/list'){
        if(body.adminPassword!==undefined){privateRows=null;const a=await privateLyricsCall(new URL('http://localhost/'),body,false,mockFetch);if(a.status!==200)return json(a.status,a.body);privateRows=sanitizePrivateRows(a.body.songs);}
        r={status:200,body:await listReleaseStatus(root,privateRows)};
      }else if(url.pathname==='/api/release-status/save')r=await saveReleaseStatus(root,privateRows,body);
      else if(url.pathname.startsWith('/api/song-registration/'))r=await registrationAction(root,url.pathname.slice('/api/song-registration/'.length),body);
      else if(url.pathname==='/api/quit'){onStop();return json(200,{ok:true});}
      else return json(403,{error:'試作品では本番公開・パスワード変更・通常の公開データ操作はできません。'});
      return json(r.status,r.body);
    }catch{return json(500,{error:'試作品で処理できませんでした。入力を確認してください。'});}finally{busy=false;}
  }
  const pageResponse=(html)=>new Response(html,{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'"}});
  async function route(request){
    const url=new URL(request.url),p=url.pathname;
    if(url.hostname!=='localhost')return plain(403,'Local preview only');
    if(p==='/preview')return pageResponse(hub(token).replace('<div class="cards">','<div class="cards"><section><h2>一般公開HP・一般視聴</h2><p>既存の公開済みサイト資料の並び替えと、架空の公開許可済み3曲の視聴を確認します。</p><a href="/public-site/#works" target="_blank" rel="noopener">一般公開HPを開く</a><button type="button" data-mobile="/public-site/#works">HPをスマホ幅で開く</button><a href="/listen/" target="_blank" rel="noopener">一般視聴を開く</a><button type="button" data-mobile="/listen/">一般視聴をスマホ幅で開く</button></section>').replace('左の「PRIVATE楽曲の歌詞・よみがな」と「全楽曲の公開状況」で確認。','左の「＋ 新曲を登録」「PRIVATE楽曲の歌詞・よみがな」「全楽曲の公開状況」で確認。新曲は試作品専用に保存します。'));
    if(p==='/public-site/'||p.startsWith('/public-site/')){
      if(request.method!=='GET')return plain(405,'試作品は読み取り専用です。');
      const rel=decodeURIComponent(p.slice('/public-site/'.length)),file=path.resolve(officialRoot,rel||'index.html');
      if(!file.startsWith(officialRoot+path.sep))return plain(404,'Not found');
      try{const bytes=await readFile(file);const type=types[path.extname(file)]??(file.endsWith('.ttf')?'font/ttf':'application/octet-stream');
        if(file.endsWith('.html'))return new Response(bytes.toString('utf8').replace('</head>','<link rel="stylesheet" href="/__preview.css"></head>').replace(/<body([^>]*)>/, '<body$1><a class="preview-badge" href="/preview">公開済み資料の試作品｜プレビュー案内</a>'),{headers:{'Content-Type':type,'Cache-Control':'no-store','Content-Security-Policy':"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; form-action 'none'; frame-ancestors 'none'"}});
        return new Response(bytes,{headers:{'Content-Type':type,'Cache-Control':'no-store'}});
      }catch{return plain(404,'Not found');}
    }
    if(p==='/listen/'||p.startsWith('/listen/')){
      const inner=new URL(request.url);inner.pathname=p.slice('/listen'.length);const result=await publicListening(new Request(inner,{method:request.method,headers:request.headers}),publicEnv,{base:'/listen',siteUrl:'/public-site/'});
      if(!result.headers.get('Content-Type')?.startsWith('text/html'))return result;
      const html=(await result.text()).replace(/<link[^>]+https:\/\/fonts\.[^>]+>\s*/g,'').replace('</head>','<link rel="stylesheet" href="/__preview.css"></head>').replace('<body>','<body><a class="preview-badge" href="/preview">一般視聴・架空データ｜プレビュー案内</a>');
      return new Response(html,{status:result.status,headers:result.headers});
    }
    if(p==='/__preview.css'||p==='/__preview.js')return new Response(p.endsWith('.css')?previewCss:previewScript,{headers:{'Content-Type':types[path.extname(p)],'Cache-Control':'no-store'}});
    if(p.startsWith('/api/'))return managerApi(request,url);
    if(['/manager/','/manager/app.js','/manager/app.css'].includes(p)){
      const file=p==='/manager/'?'index.html':p.slice('/manager/'.length),bytes=await readFile(path.join(HERE,'ui',file));
      if(file==='index.html')return pageResponse(bytes.toString('utf8').replace('</head>','<link rel="stylesheet" href="/__preview.css"></head>').replace('<body>','<body class="prototype-manager"><a class="preview-badge" href="/preview">架空データ｜プレビュー案内</a>'));
      return new Response(bytes,{headers:{'Content-Type':types[path.extname(file)],'Cache-Control':'no-store'}});
    }
    // Only the invitee's actual Worker routes. Admin calls enter through the test manager above.
    if(!(p==='/'||p==='/login'||p==='/logout'||p==='/robots.txt'||p==='/favicon.ico'||/^\/assets\/[a-z0-9.-]+$/.test(p)||/^\/audio\/demo-[0-9]+(?:\.(?:mp3|wav))?$/.test(p)||/^\/jacket\/demo-[0-9]+$/.test(p)))return plain(404,'Not found');
    const response=await worker.fetch(request,env);
    if(!response.headers.get('Content-Type')?.startsWith('text/html'))return response;
    // On the isolated preview only, avoid all public-site/font requests and add a visible marker.
    const html=(await response.text()).replace(/<link[^>]+https:\/\/fonts\.[^>]+>\s*/g,'').replaceAll('https://pip-popper.github.io/','/preview').replace('</head>','<link rel="stylesheet" href="/__preview.css"></head>').replace('<body>','<body><a class="preview-badge" href="/preview">架空データ｜プレビュー案内</a>');
    const headers=new Headers(response.headers);headers.delete('Content-Length');
    return new Response(html,{status:response.status,headers});
  }
  return {root,token,route};
}

function listen(preview){
  const server=http.createServer(async(req,res)=>{
    try{
      if(req.headers.host!==`localhost:${server.address().port}`){res.writeHead(403);res.end('Local preview only');return;}
      const body=['GET','HEAD'].includes(req.method)?undefined:Readable.toWeb(req);
      const response=await preview.route(new Request(`http://localhost:${server.address().port}${req.url}`,{method:req.method,headers:req.headers,body,duplex:body?'half':undefined}));
      const headers={};response.headers.forEach((v,k)=>{headers[k]=k==='set-cookie'?response.headers.getSetCookie():v;});res.writeHead(response.status,headers);
      if(response.body&&req.method!=='HEAD')Readable.fromWeb(response.body).pipe(res);else res.end();
    }catch{if(!res.headersSent)res.writeHead(500);res.end('Preview error');}
  });
  return new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>resolve(server));});
}
async function main(){
  let server;const preview=await createPrototype({onStop:()=>setTimeout(()=>{server?.close();server?.closeAllConnections();},250)});
  if(process.argv.includes('--check')){
    const req=(p,init)=>preview.route(new Request('http://localhost'+p,init));
    const auth={'X-PP-Token':preview.token,'Content-Type':'application/json'},post=(p,data)=>req(p,{method:'POST',headers:auth,body:JSON.stringify(data)});
    assert.ok((await (await req('/preview')).text()).includes('架空データ'));
    const publicSite=await req('/public-site/');assert.equal(publicSite.status,200);const siteHtml=await publicSite.text();assert.ok(siteHtml.includes('id="works-order"'));assert.ok(siteHtml.includes('href="/listen/"'));assert.equal((await req('/public-site/assets/works-sort.js')).status,200);
    const general=await req('/listen/');assert.equal(general.status,200);const generalHtml=await general.text();assert.equal((generalHtml.match(/class="pv-item"/g)||[]).length,3);assert.ok(!generalHtml.includes('NONPUBLIC_LYRIC_TEST_MARKER'));assert.ok(!generalHtml.includes('非公開テスト曲'));
    assert.equal((await req('/listen/audio/listen-1.wav',{headers:{Range:'bytes=0-43'}})).status,206);assert.equal((await req('/listen/audio/listen-4.wav')).status,404);assert.equal((await req('/listen/jacket/listen-2')).status,404);
    const login=await req('/login',{method:'POST',headers:{Origin:'http://localhost'},body:new URLSearchParams({password:MEMBER})});assert.equal(login.status,303);
    const member={Cookie:login.headers.get('Set-Cookie').split(';')[0]};
    const library=await (await req('/',{headers:member})).text();assert.equal((library.match(/class="pv-item"/g)||[]).length,30);assert.ok(!library.includes('https://pip-popper.github.io/'));
    assert.equal((await req('/jacket/demo-01',{headers:member})).status,200);assert.equal((await req('/jacket/demo-01')).status,401);
    assert.ok(library.includes('/audio/demo-01.wav?download=1'));assert.ok(library.includes('WAVをダウンロード'));assert.ok(library.includes('download="PIP POPPER - DEMO 01｜星の道.wav"'));
    const ranged=await req('/audio/demo-01.wav',{headers:{...member,Range:'bytes=0-43'}});assert.equal(ranged.status,206);assert.equal(ranged.headers.get('Content-Type'),'audio/wav');
    assert.equal(Buffer.from(await ranged.arrayBuffer()).subarray(0,4).toString(),'RIFF');
    const download=await req('/audio/demo-01.wav?download=1',{headers:member});assert.equal(download.status,200);assert.equal(download.headers.get('Content-Type'),'audio/wav');
    assert.ok(download.headers.get('Content-Disposition').includes('attachment; filename="pip-popper-demo-01.wav"'));
    const wav=Buffer.from(await download.arrayBuffer());assert.equal(wav.subarray(0,4).toString(),'RIFF');assert.equal(wav.subarray(8,12).toString(),'WAVE');assert.equal(wav.length,Number(download.headers.get('Content-Length')));
    assert.equal((await req('/audio/demo-01.mp3?download=1',{headers:member})).status,404);assert.equal((await req('/audio/demo-01.wav?download=1')).status,401);
    assert.ok(library.indexOf('/audio/demo-03.wav?')<library.indexOf('/audio/demo-02.wav?'));assert.ok(library.indexOf('/audio/demo-07.wav?')<library.indexOf('/audio/demo-06.wav?'));
    const listed=await (await post('/api/private/lyrics/list',{adminPassword:ADMIN})).json();assert.equal(listed.songs.length,30);
    const saved=await post('/api/private/lyrics/save',{adminPassword:ADMIN,id:'demo-05',rev:listed.rev,lyrics:'試作品で編集した歌詞\n\n確認',confirm:true});assert.equal(saved.status,200);
    assert.ok((await (await req('/',{headers:member})).text()).includes('試作品で編集した歌詞'));
    const reading=await post('/api/private/lyrics/save',{adminPassword:ADMIN,id:'demo-05',rev:listed.rev+1,reading:'あい',confirm:true});assert.equal(reading.status,200);
    const updated=await reading.json();assert.equal(updated.song.lyrics,'試作品で編集した歌詞\n\n確認');assert.equal(updated.orderedIds[0],'demo-05');
    const reordered=await (await req('/',{headers:member})).text();assert.ok(reordered.indexOf('/audio/demo-05.wav?')<reordered.indexOf('/audio/demo-03.wav?'));
    const releases=await (await post('/api/release-status/list',{adminPassword:ADMIN})).json();assert.equal(releases.counts.all,30);
    assert.equal((await post('/api/release-status/save',{id:'demo-05',rev:releases.rev,classification:'site',lyricsScope:'both',links:[],confirm:true})).status,200);
    const registration=await (await post('/api/song-registration/save',{fields:{title:'架空新曲の登録確認',reading:'かくうしんきょく',artist:'PIP POPPER',lyrics:'非公開テスト歌詞',impression:'非公開テスト感想',classification:'site',lyricsScope:'private',impressionScope:'hidden',channels:{hp:true,listen:true,private:true},state:'draft',urls:[],memo:'非公開メモ'},confirm:true})).json();
    assert.ok(registration.record.id.startsWith('new-'));const draftId=registration.record.id;
    const regPreview=await (await post('/api/song-registration/preview',{id:draftId,audience:'hp'})).json();assert.equal(regPreview.visible,true);assert.equal(regPreview.lyrics,'');assert.equal(regPreview.impression,'');
    const privatePreview=await (await post('/api/song-registration/preview',{id:draftId,audience:'private'})).json();assert.equal(privatePreview.lyrics,'非公開テスト歌詞');assert.equal(privatePreview.impression,'');
    assert.ok(!(await (await req('/listen/')).text()).includes(draftId));assert.ok(!(await (await req('/public-site/')).text()).includes(draftId));
    assert.equal((await (await post('/api/release-status/list',{})).json()).counts.all,31);
    assert.equal((await post('/api/publish',{confirm:true})).status,403);assert.equal((await post('/api/private/password',{})).status,403);
    assert.equal((await req('/manager/')).status,200);assert.equal((await req('/manager/app.js')).status,200);
    server=await listen(preview);console.log(`PASS: actual preview router, 30 fake tracks, login/jacket/audio range, manager lyrics and release save, production actions blocked; listening on 127.0.0.1:${server.address().port}`);await new Promise(r=>server.close(r));return;
  }
  server=await listen(preview);const url=`http://localhost:${server.address().port}/preview`;
  console.log('PIP POPPER 試作品（架空データ・本番未接続）');console.log(url);console.log('終了は案内画面または管理ツールの「終了」。ブラウザが開かない場合は上のURLを開いてください。');
  if(!process.argv.includes('--no-open')){const child=spawn('cmd.exe',['/c','start','',url],{detached:true,stdio:'ignore',windowsHide:true});child.on('error',()=>{});child.unref();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error('試作品を起動できませんでした：',e.message);process.exitCode=1;});
