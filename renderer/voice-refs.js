/* 图片参考与声音音色共用参考入口；声音文件单独管理，不混入出图参考。 */
"use strict";
const VOICE_BUSY = new Set();
const voiceRefCount=()=>((P&&P.voiceRefs&&P.voiceRefs.voices)||[]).length;
function voiceError(message){
 return /insufficient balance/i.test(message) ? 'MiniMax 账户余额不足，音色尚未生成。请检查当前 API Key 所属账户的余额后重试。' : message;
}
function refHubBar(){return `<div class="ref-hubbar"><div class="fbseg"><button data-ref-mode="image" class="${RV.refMode!=="voice"?"on":""}">图片参考 ${REFS().length}</button><button data-ref-mode="voice" class="${RV.refMode==="voice"?"on":""}">声音音色 ${voiceRefCount()}</button></div>${RV.refMode==="voice"?'<button class="pri" id="voiceNew">＋ 添加声音参考</button>':""}</div>`;}
function bindRefHub(){
 RV.el.querySelectorAll('[data-ref-mode]').forEach(b=>b.onclick=()=>{dialogueStop();RV.refMode=b.dataset.refMode;rvBuild();});
 const add=RV.el.querySelector('#voiceNew');if(add)add.onclick=()=>voiceRefEdit();
}
function voiceRefsBuild(){
 finStop();dialogueStop();RV.io&&RV.io.disconnect();RV.G=null;
 RV.el.querySelector('#rvFilter').hidden=true;RV.el.querySelector('#rvScope').hidden=true;RV.el.querySelector('.rvtools').hidden=true;
 RV.el.querySelector('#rvKeys').textContent='管理角色参考声音 · 支持本地试听 · Esc 关闭';
 const voices=(P.voiceRefs&&P.voiceRefs.voices)||[];
 RV.items=[];
 RV.el.querySelector('#rvBody').innerHTML=refHubBar()+ (voices.length?voices.map(v=>`<article class="voice-ref-card"><div><div class="dlg-heading"><strong>${esc(v.name)}</strong><span class="chip">${esc(v.role||'未分配角色')}</span></div><p class="voice-ref-notes">${esc(v.notes||'暂无备注')}</p>${v.voice_id?`<div class="dim">MiniMax 音色 ID：${esc(v.voice_id)}</div>`:''}</div><div class="voice-ref-media"><span class="dim">参考录音</span>${v.exists?`<audio controls preload="metadata" data-voice-audio="${esc(v.id)}"></audio>`:'<div class="dim">还没有参考录音</div>'}${v.preview_exists?`<span class="dim">生成试听</span><audio controls preload="metadata" data-voice-preview="${esc(v.id)}"></audio>`:""}${v.clone_status==="error"?`<div class="voice-ref-error" role="status">${esc(voiceError(v.clone_error || '音色生成失败，请重试'))}</div>`:""}${v.clone_status==="pending"?`<div class="dim">复刻状态待核实，音色 ID：${esc(v.pending_voice_id||"")}</div>`:""}${v.cloned_from&&v.cloned_from!==v.file?`<div class="dim">参考录音已更换，当前音色仍来自旧录音</div>`:""}<div class="row"><button class="pri" data-voice-clone="${esc(v.id)}" ${!v.exists||v.voice_id||v.clone_status==="pending"||VOICE_BUSY.has(v.id)?"disabled":""}>${VOICE_BUSY.has(v.id)?"处理中…":v.voice_id?"音色已生成":"生成音色"}</button><button class="ghost" data-voice-preview-pick="${esc(v.id)}" ${!v.voice_id||VOICE_BUSY.has(v.id)?"disabled":""}>生成试听…</button></div><div class="row"><button class="ghost" data-voice-pick="${esc(v.id)}">${v.exists?'更换参考声音…':'选择参考声音…'}</button><button class="ghost" data-voice-edit="${esc(v.id)}">编辑资料</button>${v.exists?`<button class="ghost" data-voice-reveal="${esc(v.id)}">显示文件</button>`:''}<button class="ghost" data-voice-remove="${esc(v.id)}">移除</button></div></div></article>`).join(''):'<div class="rvempty">还没有声音参考。点击“添加声音参考”，为角色保存一段参考录音。</div>');
 bindRefHub();
 const el=RV.el;
 el.querySelectorAll('[data-voice-audio]').forEach(async audio=>{
  const v=voices.find(v=>v.id===audio.dataset.voiceAudio);
  try{const file=await S.refPath(P.dir,v.file);if(!audio.isConnected)return;audio.src=voiceFileUrl(file)+'?t='+v.mtime;}
  catch(error){toast(error.message,true);}
  audio.onplay=()=>el.querySelectorAll('audio').forEach(other=>{if(other!==audio)other.pause();});
  audio.onerror=()=>toast('参考声音无法播放，请检查文件或换一段录音',true);
 });
 el.querySelectorAll('[data-voice-clone]').forEach(b=>b.onclick=()=>voiceRefGenerate(b.dataset.voiceClone,'clone'));
 el.querySelectorAll('[data-voice-preview-pick]').forEach(b=>b.onclick=()=>voiceRefGenerate(b.dataset.voicePreviewPick,'preview'));
 el.querySelectorAll('[data-voice-preview]').forEach(async audio=>{const v=voices.find(v=>v.id===audio.dataset.voicePreview);try{audio.src=voiceFileUrl(await S.refPath(P.dir,v.preview_file));}catch(error){toast(error.message,true);}audio.onplay=()=>el.querySelectorAll('audio').forEach(other=>{if(other!==audio)other.pause();});});
 el.querySelectorAll('[data-voice-edit]').forEach(b=>b.onclick=()=>voiceRefEdit(voices.find(v=>v.id===b.dataset.voiceEdit)));
 el.querySelectorAll('[data-voice-pick]').forEach(b=>b.onclick=()=>voiceRefPick(b.dataset.voicePick));
 el.querySelectorAll('[data-voice-reveal]').forEach(b=>b.onclick=async()=>{try{const v=voices.find(v=>v.id===b.dataset.voiceReveal);await S.reveal(await S.refPath(P.dir,v.file));}catch(error){toast(error.message,true);}});
 el.querySelectorAll('[data-voice-remove]').forEach(b=>b.onclick=async()=>{
  if(await S.confirm('移除这条声音参考登记？原录音和历史备份会保留。',['移除登记','取消'])!==0)return;
  try{dialogueStop();P.voiceRefs=await S.voiceRefsSave(P.dir,{id:b.dataset.voiceRemove,_delete:true});voiceRefsBuild();}catch(error){toast(error.message,true);}
 });
 voiceRefsCounts();
}
function voiceRefsCounts(){
 const voices=(P.voiceRefs&&P.voiceRefs.voices)||[],ready=voices.filter(v=>v.exists).length;
 RV.el.querySelectorAll('#rvKind button').forEach(b=>b.classList.toggle('on',b.dataset.v==='ref'));
 RV.el.querySelector('#rvKind button[data-v="ref"] i').textContent=REFS().length+voices.length;
 RV.el.querySelector('.rvprog i').style.width=(voices.length?ready/voices.length*100:0)+'%';
 RV.el.querySelector('#rvProg').textContent=`声音参考 ${voices.length} 条 · 已有录音 ${ready} 条`;
}
function voiceFileUrl(file){const p=file.replace(/\\/g,'/');return (p.startsWith('/')?'file://':'file:///')+p.split('/').map(encodeURIComponent).join('/').replace(/^([A-Za-z])%3A/,'$1:');}
async function voiceRefPick(id){
 try{const source=await pickProjectAudio();if(!source)return;dialogueStop();P.voiceRefs=await S.voiceRefsImport(P.dir,id,source);if(RV&&RV.kind==='ref'&&RV.refMode==='voice')voiceRefsBuild();toast('参考声音已保存，旧文件保留。');}catch(error){toast(error.message,true);}
}
function voiceRefEdit(old){
 const modal=document.createElement('div');modal.className='modal voice-ref-modal';
 const value=old||{},roles=[...new Set(Object.values(P.N).flatMap(n=>(n.lines||[]).map(l=>l[0])).filter(w=>w&&!w.startsWith('@')))];
 modal.innerHTML=`<form class="mbox voice-ref-form"><h3>${old?'编辑声音参考':'添加声音参考'}</h3><label>音色名称<input name="name" required maxlength="100" value="${esc(value.name||'')}" placeholder="例如：司机 · 低沉成熟男声"></label><label>对应角色<input name="role" list="voiceRefRoles" value="${esc(value.role||'')}"><datalist id="voiceRefRoles">${roles.map(w=>`<option value="${esc(w)}">`).join('')}</datalist></label><label>声音特点与备注<textarea name="notes" rows="3" placeholder="口音、年龄感、情绪、来源或使用说明">${esc(value.notes||'')}</textarea></label><label>MiniMax 音色 ID（可选）<input name="voice_id" value="${esc(value.voice_id||'')}" placeholder="已有复刻音色时填写"></label><p class="dim">保存资料后，可以点击“生成音色”复刻参考录音，再生成试听；已有台词配音保持不变。</p><div class="row"><button type="button" class="ghost" data-cancel>取消</button><button type="submit" class="pri">${old?'保存资料':'保存并选择录音…'}</button></div><div class="voice-ref-error" role="status"></div></form>`;
 document.body.appendChild(modal);const form=modal.querySelector('form');
 modal.querySelector('[data-cancel]').onclick=()=>modal.remove();modal.onkeydown=e=>{if(e.key==='Escape'){e.stopPropagation();modal.remove();}};
 form.onsubmit=async e=>{
  e.preventDefault();const button=form.querySelector('[type="submit"]');button.disabled=true;
  try{const data=new FormData(form),entry={id:old?old.id:'voice_'+Date.now().toString(36)};for(const k of ['name','role','notes','voice_id'])entry[k]=data.get(k);
   P.voiceRefs=await S.voiceRefsSave(P.dir,entry);modal.remove();if(RV)voiceRefsBuild();if(!old)await voiceRefPick(entry.id);
  }catch(error){modal.querySelector('.voice-ref-error').textContent=error.message;button.disabled=false;}
 };
 form.querySelector('[name="name"]').focus();
}

async function voiceRefGenerate(id,action){
 if(VOICE_BUSY.has(id))return;
 const v=((P.voiceRefs||{}).voices||[]).find(v=>v.id===id);if(!v)return;
 let text='你好，这是角色的声音试听。';
 if(action==='clone'){
  if(await S.confirm(`将“${v.name}”的参考录音上传到 MiniMax 并复刻音色？\n录音需为 10 秒～5 分钟的 MP3、M4A 或 WAV。请使用你有权使用的声音。\n复刻及后续试听可能产生费用，以平台账单为准；这一步不生成全部台词。`,['生成音色','取消'])!==0)return;
 }else{
  const input=await askText('试听台词（1～300字，调用 MiniMax 语音合成，可能产生费用）',v.preview_text||text);
  if(!input||!input.text||!input.text.trim())return;text=input.text.trim();if(text.length>300)return toast('试听台词最多300字',true);
 }
 VOICE_BUSY.add(id);if(RV&&RV.kind==='ref'&&RV.refMode==='voice')voiceRefsBuild();
 try{
  P.voiceRefs=await S.voiceRefsGenerate(P.dir,id,action,text);
  toast(action==='clone'?'音色已保存，可以点击“生成试听”听效果':'试听已生成，点击播放器试听');
 }catch(error){
  try{P.voiceRefs=await S.voiceRefsLoad(P.dir);}catch{}
  toast(voiceError(error.message),true);
 }finally{VOICE_BUSY.delete(id);if(RV&&RV.kind==='ref'&&RV.refMode==='voice')voiceRefsBuild();}
}
