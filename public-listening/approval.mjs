// Public archive gate. Previously published archive titles remain visible; no
// new publication is inferred from the old audioRelease flag or track presence.
export function assertArchiveApproval(id,data,priorArchive) {
  if(data.publicationClass!==undefined&&!['general','site'].includes(data.publicationClass))throw new Error(`公開区分未確定または非公開の曲を公開ソースに含められません: ${id}`);
  if(!priorArchive.has(id)&&(data.publicArchiveApproved!==true||!['general','site'].includes(data.publicationClass)))throw new Error(`新規曲の公式サイト掲載承認が未設定です: ${id}`);
  if(data.lyrics&&((!priorArchive.has(id)||data.lyricsScope!==undefined)&&!['public','both'].includes(data.lyricsScope)))throw new Error(`公開歌詞の承認が未設定です: ${id}`);
  if(data.aiImpression&&((!priorArchive.has(id)||data.impressionScope!==undefined)&&!['public','both'].includes(data.impressionScope)))throw new Error(`AIの感想の公開承認が未設定です: ${id}`);
}
