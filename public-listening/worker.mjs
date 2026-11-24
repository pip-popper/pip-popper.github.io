// Separate public Worker candidate. It has no PRIVATE bucket, auth, manager or
// catalog binding. Only an explicitly approved, curated public catalog is read.
import { libraryPage } from '../private/worker/src/pages.js';
import { streamAudio } from '../private/worker/src/audio.js';
import { validReading } from '../private/worker/src/song-order.js';

const ID=/^[a-z0-9-]{1,128}$/;
const ASSETS=new Set(['/assets/site.css','/assets/private.css','/assets/private.js','/assets/stage.jpg','/assets/favicon-32.png','/assets/apple-touch-icon.png','/favicon.ico']);
const IMAGE_TYPES={jpg:'image/jpeg',png:'image/png',webp:'image/webp'};
const response=(status,body,type='text/plain; charset=utf-8')=>new Response(body,{status,headers:{'Content-Type':type,'Cache-Control':'no-store'}});
function secure(res){const headers=new Headers(res.headers);headers.set('X-Content-Type-Options','nosniff');headers.set('Referrer-Policy','same-origin');headers.set('X-Frame-Options','DENY');headers.set('Content-Security-Policy',"default-src 'self'; img-src 'self'; media-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'");return new Response(res.body,{status:res.status,headers});}

export function approvedSongs(catalog){
  if(catalog?.version!==1||!Array.isArray(catalog.songs))throw new Error('Invalid public catalog');
  const counts=new Map();for(const s of catalog.songs)if(typeof s?.id==='string')counts.set(s.id,(counts.get(s.id)||0)+1);
  const result=[];
  for(const row of catalog.songs){
    if(!row||typeof row.id!=='string'||!ID.test(row.id)||counts.get(row.id)!==1||!['general','site'].includes(row.classification)||row.publicAudioApproved!==true||typeof row.title!=='string'||!row.title.trim())continue;
    const ext=['mp3','wav'].find(x=>row.audioKey===`public-audio/${row.id}.${x}`);
    if(!ext||!Number.isSafeInteger(row.size)||row.size<=0)continue;
    // Deliberately construct a new record; never spread raw catalog metadata.
    const song={id:row.id,title:row.title,file:row.audioKey,size:row.size,type:ext==='mp3'?'audio/mpeg':'audio/wav'};
    if(validReading(row.reading))song.reading=row.reading.trim();
    if(['public','both'].includes(row.lyricsScope)&&row.publicLyricsApproved===true&&typeof row.lyrics==='string')song.lyrics=row.lyrics;
    if(['public','both'].includes(row.impressionScope)&&row.publicImpressionApproved===true&&typeof row.impression==='string')song.impression=row.impression;
    const jacketExt=Object.keys(IMAGE_TYPES).find(x=>row.jacketKey===`public-jackets/${row.id}.${x}`);
    if(jacketExt&&row.publicJacketApproved===true)song.coverKey=row.jacketKey;
    result.push(song);
  }
  return result;
}
async function loadApproved(env){const bucket=env.PUBLIC_BUCKET;if(!bucket)throw new Error('Public storage not configured');const object=await bucket.get('public-catalog.json');if(!object)return [];return approvedSongs(await object.json());}

// base is supplied only by the local preview adapter. Production uses its own origin.
export async function publicListening(request, env, {base='',siteUrl='https://pip-popper.github.io/'}={}){
  try{
    const url=new URL(request.url);const pathname=url.pathname;
    if(request.method!=='GET')return secure(response(405,'受け付けられないリクエストです。'));
    if(ASSETS.has(pathname))return secure(await env.ASSETS.fetch(request));
    if(pathname!=='/'&&!/^\/(?:audio\/[a-z0-9-]+\.(?:mp3|wav)|jacket\/[a-z0-9-]+)$/.test(pathname))return secure(response(404,'見つかりません。'));
    const songs=await loadApproved(env);
    if(pathname==='/')return secure(response(200,libraryPage({songs,publicMode:true,base,siteUrl}),'text/html; charset=utf-8'));
    const audio=/^\/audio\/([a-z0-9-]+)\.(mp3|wav)$/.exec(pathname);
    if(audio){const song=songs.find(s=>s.id===audio[1]);if(!song)return secure(response(404,'見つかりません。'));return secure(await streamAudio(request,env.PUBLIC_BUCKET,song,url,audio[2],false));}
    const jacket=/^\/jacket\/([a-z0-9-]+)$/.exec(pathname),song=songs.find(s=>s.id===jacket?.[1]);
    if(!song?.coverKey)return secure(response(404,'見つかりません。'));
    const type=IMAGE_TYPES[song.coverKey.split('.').at(-1)],object=await env.PUBLIC_BUCKET.get(song.coverKey);
    if(!object||object.httpMetadata?.contentType!==type)return secure(response(404,'見つかりません。'));
    return secure(response(200,object.body,type));
  }catch{return secure(response(503,'一般視聴の準備中です。'));}
}
export default {fetch:publicListening};
