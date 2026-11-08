/* ①—⑤共享镜头 / 台词定位，双向导航采用同一套关联。 */
"use strict";
const REVIEW_FLOW = ['prompt','img','video','final','dialogue'];
const REVIEW_FLOW_LABELS = ['① 提示词','② 图片','③ 草稿','④ 成片','⑤ 台词'];
function reviewFlowCurrent(){
  const body=RV.el&&RV.el.querySelector('#rvBody');
  if(!body)return RV.items[RV.k];
  const area=body.getBoundingClientRect(),middle=(area.top+area.bottom)/2;
  let selected=null,distance=Infinity;
  body.querySelectorAll('.rvcard').forEach(card=>{
    const rect=card.getBoundingClientRect();if(rect.bottom<=area.top||rect.top>=area.bottom)return;
    const d=middle<rect.top?rect.top-middle:middle>rect.bottom?middle-rect.bottom:0;
    if(d<distance){distance=d;selected=RV.items[+card.dataset.k];}
  });
  return selected||RV.items[RV.k];
}
function reviewFlowContext(it,kind){
  if(!it)return RV.flowAnchor||null;
  const old=RV.flowAnchor;
  if(old){
    const same=it.vid?it.vid===old.vid:kind==='dialogue'?
      it.nid===(old.dialogue||old).nid&&it.i===(old.dialogue||old).i:
      it.sid?it.sid===old.sid&&it.nid===old.nid:it.nid===old.nid&&it.i===old.i;
    if(same)return {...old};
  }
  const v=it.vid?scriptVids().find(x=>x.id===it.vid):null;
  const nid=v?v.nid:it.nid, i=v?v.i:it.i;
  const im=it.im||(v&&v.im)||(i>=0?limgOf(nid,i):nid);
  const sid=it.sid||(im?shotId(im):it.vid);
  let vid=it.vid;
  if(!vid){
    const exact=scriptVids().find(x=>x.nid===nid&&x.i===i);
    vid=exact?exact.id:it.x==='shot'&&it.l?shotVid(it.l[1]):i===-1?nid:null;
    if(!vid&&kind==='dialogue'){
      const scene=vsShot(nid);
      if(scene&&finSpeech(scene,false).some(x=>x.nid===nid&&x.i===i))vid=nid;
    }
  }
  return {nid,i,sid,vid};
}
function reviewFlowIndex(kind,context,items){
  if(!context)return -1;
  if(kind==='video'||kind==='final')return items.findIndex(x=>x.vid===context.vid);
  if(kind==='dialogue'){
    let k=items.findIndex(x=>x.nid===context.nid&&x.i===context.i);
    if(k>=0)return k;
    if(context.vid){
      const shot=vsShot(context.vid),speech=shot?finSpeech(shot,false):[];
      for(const line of speech){k=items.findIndex(x=>x.nid===line.nid&&x.i===line.i);if(k>=0)return k;}
    }
    return -1;
  }
  let k=items.findIndex(x=>x.nid===context.nid&&x.i===context.i&&(!context.sid||x.sid===context.sid));
  if(k<0)k=items.findIndex(x=>x.sid&&x.sid===context.sid&&x.nid===context.nid);
  return k;
}
async function switchReviewFlow(kind,it){
  if(!RV)return;
  const view=RV,source=RV.kind;
  if(kind===source&&!it)return;
  reviewRememberPage();if(!it){await switchReviewPage(kind);return;}
  const ticket=RV.flowJump=(RV.flowJump||0)+1;
  const context=reviewFlowContext(it||reviewFlowCurrent(),source);
  if(!REVIEW_FLOW.includes(kind)||!REVIEW_FLOW.includes(source)){
    dialogueStop();finStop();RV.kind=kind;rvBuild();return;
  }
  try{
    await refreshReviewAssets();if(RV!==view||RV.flowJump!==ticket)return;
    if(kind==='video'||kind==='final'){await ensureVsSlots();if(RV!==view||RV.flowJump!==ticket)return;}
    const available=kind==='dialogue'?dialogueItems('all'):
      kind==='video'||kind==='final'?vsItems('all'):
      reviewItems('all').filter(x=>kind!=='prompt'||x.x!=='cap'||shotOf(x.im));
    const k=reviewFlowIndex(kind,context,available);
    if(context&&k<0){toast(kind==='dialogue'?'这个镜头没有对应的台词配音；当前位置已保留':
      kind==='video'||kind==='final'?'这条内容没有对应的视频镜头；当前位置已保留':'没有找到对应的图片或提示词；当前位置已保留',true);return;}
    dialogueStop();finStop();
    RV.flowAnchor=context;
    if(context&&kind==='dialogue'&&k>=0)context.dialogue={nid:available[k].nid,i:available[k].i};
    RV.kind=kind;RV.scope='all';RV.filter='all';
    if(kind==='dialogue')RV.dialogue={who:'',status:'',query:''};
    rvBuild();
    const target=reviewFlowIndex(kind,context,RV.items);
    if(target>=0){
      rvFocus(target,false);
      const card=RV.el&&RV.el.querySelector(`.rvcard[data-k="${target}"]`);
      if(card)card.scrollIntoView({block:'center',behavior:'instant'});
    }
    try{localStorage.setItem('studio_rvkind',kind);}catch{}
  }catch(error){toast('跳转失败：'+error.message,true);}
}
function bindReviewFlow(card,k){
  if(!RV||!REVIEW_FLOW.includes(RV.kind)||card.querySelector('.review-flow'))return;
  const index=REVIEW_FLOW.indexOf(RV.kind),bar=document.createElement('div');bar.className='review-flow';
  for(const next of [index-1,index+1]){
    if(next<0||next>=REVIEW_FLOW.length)continue;
    const button=document.createElement('button');button.className='ghost';
    button.textContent=(next<index?'← ':'')+REVIEW_FLOW_LABELS[next]+(next>index?' →':'');
    button.onclick=e=>{e.stopPropagation();switchReviewFlow(REVIEW_FLOW[next],RV.items[k]);};bar.appendChild(button);
  }
  (card.querySelector('.rvinfo')||card.firstElementChild||card).appendChild(bar);
  const remember=()=>{if(RV)RV.k=k;};
  card.addEventListener('pointerdown',remember,true);card.addEventListener('focusin',remember);
}

// 每个项目、每个审阅页单独保存场景和场景内的滚动偏移。
function reviewReadPage(kind) {
  try{return JSON.parse(localStorage.getItem('studio_review_positions_v1')||'{}')[P.dir]?.[kind]||null}catch{return null}
}
function reviewRememberPage() {
  if(!RV||!P)return;const body=RV.el?.querySelector('#rvBody');if(!body)return;
  const item=reviewFlowCurrent(),k=Math.max(0,RV.items.indexOf(item)),card=RV.el.querySelector(`.rvcard[data-k="${k}"]`);
  const anchor=item?{nid:item.nid,i:item.i,sid:item.sid,vid:item.vid,ref:item.ref?.id}:null;
  const page={scope:RV.scope,filter:RV.filter,scrollTop:body.scrollTop,anchor,offset:card?card.getBoundingClientRect().top-body.getBoundingClientRect().top:0};
  try{const data=JSON.parse(localStorage.getItem('studio_review_positions_v1')||'{}');(data[P.dir]||={})[RV.kind]=page;localStorage.setItem('studio_review_positions_v1',JSON.stringify(data))}catch{}
}
function reviewRestorePage(page) {
  if(!RV)return;const body=RV.el.querySelector('#rvBody');if(!body)return;
  if(!page){body.scrollTop=0;return}
  const a=page.anchor;
  const k=a?RV.items.findIndex(x=>a.vid?x.vid===a.vid:a.ref?x.ref?.id===a.ref:x.nid===a.nid&&x.i===a.i&&x.sid===a.sid):-1;
  if(k>=0){rvFocus(k,false);const card=RV.el.querySelector(`.rvcard[data-k="${k}"]`);if(card){body.scrollTop+=card.getBoundingClientRect().top-body.getBoundingClientRect().top-(page.offset||0);return}}
  body.scrollTop=a?0:Math.max(0,page.scrollTop||0);
}
async function switchReviewPage(kind) {
  if(!RV)return;const view=RV,page=reviewReadPage(kind),context=reviewFlowContext(reviewFlowCurrent(),RV.kind),ticket=RV.flowJump=(RV.flowJump||0)+1;
  try{
    await refreshReviewAssets();if(RV!==view||RV.flowJump!==ticket)return;
    if(kind==='video'||kind==='final'){await ensureVsSlots();if(RV!==view||RV.flowJump!==ticket)return}
    dialogueStop();finStop();RV.kind=kind;RV.scope=page?.scope||'all';RV.filter=page?.filter||'all';rvBuild();
    if(page)reviewRestorePage(page);
    else{
      reviewRestorePage(null);
      let k=reviewFlowIndex(kind,context,RV.items);if(k<0&&context)k=RV.items.findIndex(x=>x.nid===context.nid);
      if(k>=0){rvFocus(k,false);RV.el.querySelector(`.rvcard[data-k="${k}"]`)?.scrollIntoView({block:'start',behavior:'instant'})}
    }
    try{localStorage.setItem('studio_rvkind',kind)}catch{}
  }catch(error){toast('切换审阅页失败：'+error.message,true)}
}
