"use strict";
const finalPosterRel=s=>s._keyRel||s.keyframe||`img/${s.id}.jpg`;
function applyFileIndex(project,files){
  const previous=project.files||{};
  const keys=new Set([...Object.keys(previous),...Object.keys(files)]);let changed=false;
  for(const key of keys)if(JSON.stringify(previous[key])!==JSON.stringify(files[key])){delete meta[key];changed=true;}
  for(const shot of project.vs?.shots||[]){const rel=shot.keyframe;if(previous[rel]&&files[rel]&&JSON.stringify(previous[rel])!==JSON.stringify(files[rel]))(project.changedVideoFrames||=new Set()).add(rel)}
  project.files=files;if(changed)bust=Date.now();return changed;
}
let reviewAssetJob=null;
async function refreshReviewAssets(){
  if(!P)return false;const project=P;
  if(reviewAssetJob&&reviewAssetJob.project===project)return reviewAssetJob.promise;
  const promise=(async()=>{
    const results=await Promise.allSettled([S.files(project.dir),S.vsLoad(project.dir),S.sbLoad(project.dir)]);
    if(P!==project)return false;
    const [files,vs,sb]=results;
    if(files.status==='rejected')throw files.reason;
    let changed=applyFileIndex(project,files.value);
    for(const [name,result] of [['vs',vs],['sb',sb]]){
      if(result.status==='rejected')throw result.reason;
      if(result.value&&JSON.stringify(project[name])!==JSON.stringify(result.value)){project[name]=result.value;changed=true;bust=Date.now();}
    }
    const synced=await syncChangedVideoFrames(project);return changed||synced;
  })();
  const job={project,promise};reviewAssetJob=job;
  try{return await promise;}finally{if(reviewAssetJob===job)reviewAssetJob=null;}
}
const lineMuted=(nid,i)=>!!P.N[nid]?.lines[i]?.[2]?.mute;
// 游戏的 index.html 不认静音时（P.muteSupport 由 core.js 检测），提醒一次，避免「剪辑台里静音了、游戏里还在响」
const muteWarned=new Set();
function warnMuteUnsupported(kind){
  const s=P&&P.muteSupport;if(!s||s[kind]||muteWarned.has(kind))return;muteWarned.add(kind);
  toast(kind==='line'?'这个游戏的 index.html 不认台词静音，游戏里仍会播这句配音。请更新游戏文件。':'这个游戏的 index.html 不认视频原声静音，游戏里仍会播原声。请更新游戏文件。',true);
}
function setLineMuted(nid,i,value){
  const line=P.N[nid]?.lines[i];if(!line)return;
  line[2]={...(line[2]||{})};if(value)line[2].mute=true;else delete line[2].mute;
  if(value)warnMuteUnsupported('line');
}
function setOriginalMuted(rel,value){
  if(value)warnMuteUnsupported('original');
  if(value)(P.VAUD[rel] ||= {}).muted=true;
  else if(P.VAUD[rel]){
    delete P.VAUD[rel].muted;
    if(!Object.keys(P.VAUD[rel]).length)delete P.VAUD[rel];
  }
}
function timelineNoteTarget(block, clientX) {
  const {items} = schedule(cur), index = Number(block.dataset.timelineItem), item = items[index];
  if (!item) return null;
  const linked = item.i == null && item.rel ? items.find(x => x.i != null && x.rel === item.rel && x.t === item.t) : null;
  const line = item.i ?? linked?.i ?? -1, text = P.N[cur].lines[line]?.[1] || "";
  const asset = item.rel || (item.tr === "v" ? `vid/${cur}.mp4` : item.thumb || "");
  const textKey = line >= 0 ? JSON.stringify(P.N[cur].lines[line].slice(0,2)) : "";
  const occurrence = items.slice(0,index).filter(x => x.tr === item.tr && (x.rel || "") === (item.rel || "") &&
    (item.i == null || JSON.stringify(P.N[cur].lines[x.i]?.slice(0,2)) === textKey)).length;
  const identity = JSON.stringify([cur,item.tr,asset,textKey || item.kind || item.label,occurrence]);
  const rect = block.getBoundingClientRect(), fraction = rect.width ? Math.max(0,Math.min(1,(clientX-rect.left)/rect.width)) : 0;
  return {key:"timeline-note:"+hashStr(identity),scene:cur,line,track:item.tr,asset,label:item.label,
    start:item.t,end:+(item.t+item.d).toFixed(2),anchor:+(item.t+item.d*fraction).toFixed(2),
    script_text:text,source_revision:P.files[asset]?.revision || null,trim:P.TRIM[asset] || null};
}
async function saveTimelineNote(target, text) {
  const project=P, old=project.sb?.review?.[target.key], now=new Date().toISOString();
  const requirements=String(text).trim();
  const entry={...target,schema_version:1,type:"timeline_edit",requirements,
    status:requirements?"pending":"cancelled",requested_at:old?.requested_at || now,updated_at:now,
    generation_approval:"awaiting_user_command",hide_requirements:true};
  const saved=await S.sbReviewMany(project.dir,{[target.key]:entry});
  if(P===project)P.sb=saved;
}
function timelineNoteDialog(target) {
  if(!target)return;
  const project=P, old=project.sb?.review?.[target.key], modal=document.createElement("div");
  modal.className="modal";
  const stamp=value=>Number(value).toFixed(2)+" 秒";
  modal.innerHTML=`<div class="mbox" style="width:min(620px,94vw)"><h3>剪辑意见</h3>
    <p class="dim">${esc(sceneName(target.scene))} · ${esc(target.label)}</p>
    <p class="dim">片段 ${stamp(target.start)}–${stamp(target.end)} · 右键位置 ${stamp(target.anchor)}</p>
    <textarea rows="5" style="width:100%" placeholder="例如：这里停顿太久，提前半秒切走；或配音再延后一点。">${esc(old && old.status!=="cancelled"?old.requirements:"")}</textarea>
    <p class="dim">保存到项目，之后可让 AI 按剪辑意见批量调整。正文只在此窗口显示，清空后保存可撤销这条意见。</p>
    <p class="dim" data-note-status></p><div class="row" style="justify-content:flex-end"><button class="ghost" data-cancel>取消</button><button class="pri" data-save>保存意见</button></div></div>`;
  let saving=false;
  const close=()=>{if(!saving)modal.remove();};
  modal.querySelector("[data-cancel]").onclick=close;
  modal.onkeydown=e=>{if(e.key==="Escape"){e.preventDefault();e.stopPropagation();close();}};
  modal.querySelector("[data-save]").onclick=async()=>{
    if(saving||P!==project)return;
    const button=modal.querySelector("[data-save]");
    try {
      saving=true;button.disabled=true;
      await saveTimelineNote(target,modal.querySelector("textarea").value);
      if(P!==project)return;
      modal.remove();timelineReviewToolbar();toast("剪辑意见已保存");
    } catch(error){modal.querySelector("[data-note-status]").textContent=error.message;}
    finally{saving=false;button.disabled=false;}
  };
  document.body.appendChild(modal);modal.querySelector("textarea").focus();
}

function timelineAudioMenu(e,target){
  const note=timelineNoteTarget(target,e.clientX);
  const options=note?[["剪辑意见…",()=>timelineNoteDialog(note)]]:[];
  const voice=target.classList.contains("b-dlg")||target.classList.contains("b-nar");
  const original=target.classList.contains("b-va")&&hasOriginalAudio(target.dataset.rel);
  const nid=cur,i=Number(target.dataset.i),rel=target.dataset.rel;
  if(voice||original){
    const muted=voice?lineMuted(nid,i):!!P.VAUD[rel]?.muted;
    options.push([muted?"取消静音（Unmute）":"静音（Mute）",async()=>{
      finStop();edit(()=>voice?setLineMuted(nid,i,!muted):setOriginalMuted(rel,!muted));
      if(await save()===false)return;
      if(RV)rvRefresh();toast((muted?"已取消静音":"已静音")+"并保存");
    }]);
  }
  if(options.length)reviewJumpMenu(e,options);
}
function bindTimelineAudioMenu(){
  document.addEventListener("contextmenu",e=>{
    const target=e.target.closest&&e.target.closest("#tracks .blk");
    if(target)timelineAudioMenu(e,target);
  });
}
function dialogueVideoTarget(it){
  const all=scriptVids();let video=all.find(x=>x.nid===it.nid&&x.i===it.i&&x.kind==='line');
  if(!video){const scene=vsShot(it.nid);if(scene&&finSpeech(scene,false).some(x=>x.nid===it.nid&&x.i===it.i))video=all.find(x=>x.id===it.nid);}
  const shot=video&&vsShot(video.id);return shot&&!shot.novideo?shot:null;
}
function dialogueVideoHtml(it,index){
  const shot=dialogueVideoTarget(it);if(!shot)return '<div class="dim">本句没有对应视频镜头</div>';
  const rel=finRel(shot),ready=has(rel),state=(VS()?.state||{})[shot.id],count=(state?.tries||[]).filter(x=>x.video).length;
  return `<div class="dlg-video-link"><img src="${fileUrl(finalPosterRel(shot))}" loading="lazy" alt="当前首帧"><div><div class="dim">${esc(shot.id)} · ${ready?'已有成片':count?`已生成 ${count} 个版本，待在④选用`:'视频未生成'}</div>${ready?`<button class="ghost" data-dlg-video="${index}">▶ 视频和配音一起试听</button>`:''}</div></div>`;
}
if(typeof document!=='undefined')bindTimelineAudioMenu();
if(typeof window!=='undefined')window.addEventListener('focus',async()=>{
  if(!P||document.querySelector('.modal')||document.activeElement?.matches('input,textarea,select'))return;
  const project=P,view=RV,context=view?reviewFlowContext(reviewFlowCurrent(),view.kind):null;
  try{
    const changed=await refreshReviewAssets();if(!changed||P!==project)return;
    if(document.querySelector('.modal')||document.activeElement?.matches('input,textarea,select'))return;
    renderAll(false);
    if(RV===view&&view){rvRefresh();const k=reviewFlowIndex(view.kind,context,RV.items);if(k>=0)rvFocus(k,false);}
  }catch(error){toast('素材刷新失败：'+error.message,true);}
});

// 图片替换后，草稿的自定义首帧应回到这张最新图片；旧自定义文件保留。
async function syncChangedVideoFrames(project) {
  const pending=project.changedVideoFrames;if(!pending?.size)return false;
  const targets=[...pending];let touched=false;
  for(const shot of project.vs?.shots||[]){
    if(!targets.includes(shot.keyframe)||!shot.key)continue;
    const patch={key:'',keyframe_previous_key:shot.key,keyframe_synced_revision:project.files[shot.keyframe]?.revision||'',keyframe_tail_review:shot.last||''};
    const updated=await S.vsSave(project.dir,shot.id,patch);if(P!==project)return false;project.vs=updated;touched=true;
  }
  if(P!==project)return false;
  const updated=await S.vsLoad(project.dir);if(P!==project)return false;project.vs=updated;
  targets.forEach(rel=>pending.delete(rel));return touched;
}


function timelineReviewEntries() {
  return Object.entries(P?.sb?.review || {}).filter(([key, row]) => key.startsWith('timeline-note:') && row.type === 'timeline_edit' && row.status !== 'cancelled');
}
function timelineReviewToolbar() {
  const host = document.getElementById('tDur');
  if (!host || !P) return;
  let button = document.getElementById('timeline-note-review');
  if (!button) {
    button = document.createElement('button'); button.id = 'timeline-note-review'; button.className = 'ghost';
    button.onclick = openTimelineNoteReview; host.before(button);
  }
  const count = timelineReviewEntries().filter(([, row]) => row.status === 'applied' && !row.reviewed).length;
  button.textContent = `剪辑意见复核${count ? `（${count}）` : ''}`;
}
function timelineReviewCurrent(clip) {
  const line = P.N[clip.scene]?.lines[clip.line];
  const key = line && !String(line[0]).startsWith('@') ? voKey(line[1]) : null;
  const va = P.VAUD[clip.video] || null;
  return {trim:P.TRIM[clip.video] || null, va,
    voice:key ? `vo/${key}.mp3` : null, offset:line?.[2]?.vo_offset || 0, muted:!!line?.[2]?.mute,
    volume:va?.vol ?? (clip.id.startsWith('s_') ? .15 : key && !line?.[2]?.mute ? .45 : 1),
    sfx:clip.id.startsWith('s_') && P.SHOT_SFX?.[clip.id.slice(2)] ? `sfx/${P.SHOT_SFX[clip.id.slice(2)]}.mp3` : null};
}
async function confirmTimelineReview(key, expectedUpdatedAt) {
  const project = P;
  const latest = await S.sbLoad(project.dir);
  const row = latest.review?.[key];
  if (P !== project || !row || row.status !== 'applied' || row.updated_at !== expectedUpdatedAt) throw new Error('意见已变化，请重新打开复核窗口');
  const entry = {...row, reviewed:true, reviewed_at:new Date().toISOString(),
    reviewed_clips:(row.result?.clips || []).map(clip => ({video:clip.video, revision:P.files[clip.video]?.revision, settings:timelineReviewCurrent(clip)}))};
  const saved = await S.sbReviewMany(project.dir, {[key]:entry});
  if (P === project) { P.sb = saved; timelineReviewToolbar(); }
}
async function openTimelineNoteReview() {
  const project = P;
  try { await refreshReviewAssets(); } catch (error) { toast(error.message, true); return; }
  if (P !== project) return;
  const modal = document.createElement('div'); modal.className = 'modal'; document.body.appendChild(modal);
  let selected = '', clipIndex = 0, before = false, saving = false, showAll = false;
  const close = () => { if (!saving) { finStop(); modal.remove(); } };
  modal.onkeydown = event => { if (event.key === 'Escape') { event.stopPropagation(); close(); } };
  function draw() {
    finStop();
    const entries = timelineReviewEntries();
    const pending = entries.filter(([, row]) => row.status === 'applied' && !row.reviewed);
    const rows = showAll ? entries : pending;
    if (!rows.some(([key]) => key === selected)) { selected = rows[0]?.[0] || ''; clipIndex = 0; before = false; }
    const index = rows.findIndex(([key]) => key === selected), row = rows[index]?.[1];
    const clips = row?.result?.clips || [], clip = clips[clipIndex] || clips[0];
    const state = clip && (before ? clip.before : timelineReviewCurrent(clip));
    const changed = clip && JSON.stringify(timelineReviewCurrent(clip)) !== JSON.stringify(clip.after);
    modal.innerHTML = `<div class="mbox" style="width:min(1000px,96vw);max-height:94vh;overflow:auto">
      <div class="row" style="justify-content:space-between"><h3>剪辑意见复核 · 待确认 ${pending.length} 条</h3><button class="ghost" data-close>关闭</button></div>
      <label><input type="checkbox" data-all ${showAll ? 'checked' : ''}> 显示全部意见（含已确认和待处理）</label>
      ${row ? `<select data-note style="width:100%;margin:12px 0">${rows.map(([key, item], i) => `<option value="${esc(key)}" ${key === selected ? 'selected' : ''}>${i + 1}. ${esc(sceneName(item.scene))} · ${esc(item.label)} · ${item.status === 'pending' ? '待处理' : item.reviewed ? '已确认' : '待复核'}</option>`).join('')}</select>
      <p style="white-space:pre-wrap"><b>原剪辑意见</b>　${esc(row.requirements)}</p>
      <p style="white-space:pre-wrap"><b>调整结果</b>　${esc(row.result?.summary || '等待 AI 按意见处理')}</p>
      ${changed ? '<p class="dim">此片段在本次调整后又有修改，试听将使用当前项目设置。</p>' : ''}
      ${clip ? `<div class="row">${clips.map((item, i) => `<button class="${i === clipIndex ? 'pri' : 'ghost'}" data-clip="${i}">${i + 1}. ${esc(item.id)}</button>`).join('')}</div>
      <video class="fnv" controls playsinline preload="none" style="width:100%;max-height:45vh;background:#000;margin-top:10px" data-final-rel="${esc(clip.video)}"></video>
      <div class="row"><button class="${before ? 'pri' : 'ghost'}" data-before>▶ 修改前</button><button class="${before ? 'ghost' : 'pri'}" data-after>▶ 修改后（当前）</button><button class="ghost" data-context>定位剪辑台</button></div>
      <p class="dim">${before ? '修改前' : '当前'} · ${state.trim ? `${state.trim[0].toFixed(2)}–${state.trim[1].toFixed(2)} 秒` : '完整播放'} · ${esc(clip.video)}</p>` : ''}
      <p class="dim" data-status></p><div class="row" style="justify-content:flex-end"><button class="ghost" data-prev ${index <= 0 ? 'disabled' : ''}>上一条</button><button class="ghost" data-next ${index >= rows.length - 1 ? 'disabled' : ''}>下一条</button><button class="pri" data-confirm ${row.status !== 'applied' || row.reviewed ? 'disabled' : ''}>确认通过并看下一条</button></div>` : '<p>本轮剪辑修改已全部复核。勾选“显示全部意见”可重新查看。</p>'}
      </div>`;
    modal.querySelector('[data-close]').onclick = close;
    modal.querySelector('[data-all]').onchange = event => { showAll = event.target.checked; draw(); };
    if (!row) return;
    modal.querySelector('[data-note]').onchange = event => { selected = event.target.value; clipIndex = 0; before = false; draw(); };
    for (const [selector, delta] of [['[data-prev]', -1], ['[data-next]', 1]]) modal.querySelector(selector).onclick = () => { selected = rows[index + delta]?.[0] || selected; clipIndex = 0; before = false; draw(); };
    modal.querySelector('[data-confirm]').onclick = async () => {
      if (saving) return;
      saving = true; modal.querySelector('[data-confirm]').disabled = true;
      try { await confirmTimelineReview(selected, row.updated_at); if (P === project) { selected = rows[index + 1]?.[0] || ''; clipIndex = 0; before = false; draw(); } }
      catch (error) { modal.querySelector('[data-status]').textContent = error.message; }
      finally { saving = false; const button = modal.querySelector('[data-confirm]'); if (button && !P.sb.review[selected]?.reviewed) button.disabled = false; }
    };
    if (!clip) return;
    const video = modal.querySelector('video'); video.dataset.finalSrc = fileUrl(clip.video);
    // The review player uses the same mixing logic as the final editor.
    const play = () => {
      const shot = vsShot(clip.id) || {id:clip.id};
      const speech = clip.line >= 0 && !String(P.N[clip.scene]?.lines[clip.line]?.[0]).startsWith('@') ?
        [{rel:state.voice, t:state.offset, muted:state.muted}] : [];
      if (state.sfx) speech.push({rel:state.sfx, t:0, muted:false});
      finMixOn(video, shot, state.trim, {...state.va, vol:state.volume}, speech);
    };
    video.timelinePlay = () => {
      if (video.readyState >= 1) play();
      else video.onloadedmetadata = () => { if (modal.isConnected && video.isConnected) play(); };
    };
    video.onplay = () => { if (!FINMIX || FINMIX.v !== video) video.timelinePlay(); };
    modal.querySelector('[data-before]').onclick = () => { before = true; draw(); modal.querySelector('video')?.timelinePlay(); };
    modal.querySelector('[data-after]').onclick = () => { before = false; draw(); modal.querySelector('video')?.timelinePlay(); };
    modal.querySelectorAll('[data-clip]').forEach(button => button.onclick = () => { clipIndex = Number(button.dataset.clip); draw(); });
    modal.querySelector('[data-context]').onclick = () => { close(); goScene(clip.scene); const line = clip.line >= 0 ? clip.line : 0; selectLine(line); setCenter('play'); playFrom(line); };
    loadFinalVideo(video);
  }
  draw();
}
