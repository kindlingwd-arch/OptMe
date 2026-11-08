"use strict";
function stopFinalLoading(){
 if(!RV)return;if(RV.finMediaIO){RV.finMediaIO.disconnect();RV.finMediaIO=null;}
 releaseFinalMedia(RV.el);RV.finCurrent=null;
}
function releaseFinalMedia(root){
 root.querySelectorAll('video[data-final-src]').forEach(video=>{
  video.pause();if(video.hasAttribute('src')){video.removeAttribute('src');video.load();}
  const button=video.parentElement&&video.parentElement.querySelector('.fin-start');if(button)button.hidden=false;
 });
}
function loadFinalVideo(video){
 if(!video||!video.dataset.finalSrc||video.hasAttribute('src'))return;
 if(RV&&RV.finCurrent&&RV.finCurrent!==video){
  const previous=RV.finCurrent;
  if(typeof FINMIX!=='undefined'&&FINMIX&&FINMIX.v===previous)finStop();
  releaseFinalMedia({querySelectorAll:()=>[previous]});
 }
 if(RV)RV.finCurrent=video;
 video.preload='auto';video.src=video.dataset.finalSrc;video.load();
 const button=video.parentElement&&video.parentElement.querySelector('.fin-start');if(button)button.hidden=true;
}
function finalCardStamp(it){
 const s=vsShot(it.vid);if(!s)return '';
 const rel=finRel(s),cands=finCands(s);
 return JSON.stringify([s,finState(it),vUp(s),cands,P.files[rel],P.files[finalPosterRel(s)],P.TRIM[rel],P.VAUD[rel],finSpeech(s,false),
  (RV.fsel||{})[s.id],P.BGM,P.AMB,(SB()||{}).review&&SB().review['final:'+s.id]]);
}
function watchFinalMedia(card){
 if(!RV||RV.kind!=='final')return;
 const it=RV.items[+card.dataset.k];if(it)card.__finalStamp=finalCardStamp(it);
 card.querySelectorAll('video[data-final-src]').forEach(video=>{
  if(video.__clickLoadBound)return;video.__clickLoadBound=true;
  const button=document.createElement('button');button.className='pri fin-start';button.textContent='▶ 播放视频';
  Object.assign(button.style,{position:'absolute',left:'50%',top:'50%',transform:'translate(-50%,-50%)',zIndex:'2',padding:'12px 24px'});
  video.parentElement.style.position='relative';video.parentElement.appendChild(button);
  button.onclick=e=>{e.preventDefault();e.stopPropagation();loadFinalVideo(video);video.play().catch(()=>{});};
  video.addEventListener('pointerdown',()=>loadFinalVideo(video));
  video.addEventListener('error',()=>{button.hidden=false;button.textContent='播放失败，点击重试';video.removeAttribute('src');});
 });
}
