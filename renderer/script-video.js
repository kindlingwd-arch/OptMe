"use strict";
function scriptVideoTarget(nid,i){
 const line=i==null?null:P.N[nid].lines[i];let id=nid,rel=`vid/${nid}.mp4`,label='场景视频';
 if(line){
  if(line[0]==='@shot'){id=shotVid(line[1]);rel=`vid/${id}.mp4`;label='动作视频';}
  else if(String(line[0]).startsWith('@'))return null;
  else{const im=limgOf(nid,i);if(im){id=shotId(im);rel=`vid/${im}.mp4`;label='台词视频';}}
 }
 const shot=vsShot(id);if(shot&&shot.novideo)return null;if(shot)rel=vRel(shot);
 return {rel,label,id};
}
function scriptVideoLinks(nid,i){
 const target=scriptVideoTarget(nid,i);if(!target)return '';
 const playback=has(target.rel)?`<button type="button" class="sclink sc-video-link" data-script-video="${esc(target.rel)}" title="${esc(target.label+' · '+target.id)}">▶ 播放${target.label==='场景视频'?'场景视频':'视频'}</button>`:'<small class="dim sc-video-missing">视频未生成</small>';
 const finalLink=i==null&&vsShot(target.id)?` <button type="button" class="sclink" data-script-final="${esc(target.id)}" title="${esc('打开对应场景成片 · '+target.rel)}">④ 成片</button>`:'';
 return playback+finalLink;
}
function bindScriptVideos(card,nid){
 const lineIndex=el=>Number(el.closest('[data-sc-review-line]')?.dataset.scReviewLine ?? -1);
 const videoOpinion=i=>{
  const target=scriptVideoTarget(nid,i<0?null:i);
  return target&&regenQueueTarget({vid:target.id,nid,i},'final');
 };
 card.querySelectorAll('[data-script-final]').forEach(button=>button.onclick=e=>{e.stopPropagation();jumpToMediaReview('final',button.dataset.scriptFinal);});
 card.querySelectorAll('[data-script-video]').forEach(button=>button.onclick=e=>{
  e.stopPropagation();
  openScriptVideo(button.dataset.scriptVideo,button.title,null,videoOpinion(lineIndex(button)));
 });
 card.oncontextmenu=e=>{
  const img=e.target.closest('[data-sc-review-img]');
  const row=e.target.closest('[data-sc-review-line],.scenv');
  if(img){
   const target=regenQueueTarget({nid,i:lineIndex(img),im:img.dataset.scReviewImg},'img');
   if(target) imgMenu(e,img.src,target);
   return;
  }
  if(!row||e.target.closest('input,select'))return;
  const i=lineIndex(row), line=P.N[nid].lines[i];
  const im=i<0?nid:line[0]==='@shot'?shotImgs(line[1])[0]:limgOf(nid,i);
  const image=regenQueueTarget({nid,i,im},'img'), video=videoOpinion(i);
  const options=[];
  if(image)options.push(['图片审阅意见…',()=>scriptReviewOpinion(image)]);
  if(video)options.push(['视频审阅意见…',()=>scriptReviewOpinion(video)]);
  if(options.length)reviewJumpMenu(e,options);
 };
}
function openScriptVideo(rel,title,shot,reviewTarget){
 if(!has(rel))return toast('视频文件不存在，请刷新后再试',true);
 finStop();dialogueStop();pvCmd('pause');
 const modal=document.createElement('div');modal.className='modal script-video-modal';
 modal.innerHTML=`<div class="mbox script-video-box"><div class="row"><h3>${esc(title||'视频预览')}</h3><span class="grow"></span><button class="icon" data-sv-close title="关闭">✕</button></div><video controls preload="metadata" src="${fileUrl(rel)}"></video><div class="row"><span class="dim">${esc(rel)}</span><span class="grow"></span><button class="ghost" data-sv-reveal>在文件夹中显示</button><button class="ghost" data-sv-close>关闭</button></div><div class="dim" role="status"></div></div>`;
 document.body.appendChild(modal);const video=modal.querySelector('video');
 const close=()=>{if(FINMIX&&FINMIX.v===video)finStop();video.pause();video.removeAttribute('src');video.load();modal.remove();};
 video.oncontextmenu=e=>{
  const id=mediaReviewVideoId(rel);
  const options=[];
  if(reviewTarget)options.push(['审阅意见…',()=>{close();scriptReviewOpinion(reviewTarget);}]);
  if(id)options.push(['去「④ 成片」审阅',()=>{close();jumpToMediaReview('final',id);}]);
  if(options.length)reviewJumpMenu(e,options);
 };
 modal.querySelectorAll('[data-sv-close]').forEach(b=>b.onclick=close);
 modal.querySelector('[data-sv-reveal]').onclick=()=>S.reveal(absPath(rel)).catch(e=>toast(e.message,true));
 video.onerror=()=>modal.querySelector('[role="status"]').textContent='视频无法播放，请检查格式或文件是否完整。';
 modal.onkeydown=e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();close();}};
 modal.tabIndex=-1;modal.focus();
 if(shot){video.onplay=()=>{if(!FINMIX||FINMIX.v!==video)finMixOn(video,shot,P.TRIM[rel],P.VAUD[rel],null,video.currentTime);};finMixOn(video,shot,P.TRIM[rel],P.VAUD[rel]);}
 else video.play().catch(()=>{});
}
function mediaReviewImageId(src){
 try{
  const path=decodeURIComponent(new URL(src).pathname).toLocaleLowerCase();
  const item=reviewItems('all').find(it=>it.im&&decodeURIComponent(new URL(fileUrl(limgRel(it.im))).pathname).toLocaleLowerCase()===path);
  return item?item.sid:null;
 }catch{return null;}
}
function mediaReviewVideoId(rel){
 const shot=((VS()||{}).shots||[]).find(s=>vRel(s)===rel);return shot?shot.id:null;
}
function jumpToMediaReview(kind,id){
 if(!RV)openReview('all','all',kind);
 else{dialogueStop();finStop();RV.kind=kind;RV.scope='all';RV.filter='all';rvBuild();}
 if(!RV)return;
 const k=RV.items.findIndex(it=>(kind==='final'||kind==='video')?it.vid===id:it.sid===id);
 if(k>=0)rvFocus(k);else toast('审阅列表中没有找到这个镜头',true);
 try{localStorage.setItem('studio_rvkind',kind);}catch{}
}
async function jumpImageToDraft(it){
 if(!RV||!it)return;
 const id=it.sid||shotId(it.im);if(!id)return toast('这张图片还没有对应镜头',true);
 const view=RV;
 try{
  await ensureVsSlots();
  if(RV!==view)return;
  if(!vsShot(id))return toast('视频分镜表中没有对应镜头：'+id,true);
  jumpToMediaReview('video',id);
 }catch(error){toast('无法打开草稿：'+error.message,true);}
}
function reviewJumpMenu(e,label,action){
 e.preventDefault();e.stopPropagation();document.querySelectorAll('.ctxmenu').forEach(x=>x.remove());
 const menu=document.createElement('div');menu.className='ctxmenu';
 const options=Array.isArray(label)?label:[[label,action]]; const close=()=>{menu.remove();removeEventListener('mousedown',outside,true);removeEventListener('keydown',key,true);};
 const outside=event=>{if(!menu.contains(event.target))close();};
 const key=event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();}};
 addEventListener('keydown',key,true);setTimeout(()=>{if(menu.isConnected)addEventListener('mousedown',outside,true);},0);
 options.forEach(([text,run])=>{
  const button=document.createElement('button');
  button.textContent=text;
  button.onclick=()=>{close();run();};
  menu.appendChild(button);
 });
 document.body.appendChild(menu);
 menu.style.left=Math.max(6,Math.min(e.clientX,innerWidth-menu.offsetWidth-6))+'px';
 menu.style.top=Math.max(6,Math.min(e.clientY,innerHeight-menu.offsetHeight-6))+'px';
}
