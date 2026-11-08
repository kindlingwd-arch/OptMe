/* 项目音频选择器：分离原声优先，支持把同一人的多段录音合并为参考。 */
"use strict";
function projectAudioRows(){
 const text={};Object.entries(P.VOT||{}).forEach(([t,k])=>text[`vo/${k}.mp3`]=t);
 return Object.entries(P.files||{}).filter(([rel,f])=>/^(vo|sfx|bgm|amb|_studio\/inbox)\/.*\.(wav|mp3|m4a|ogg)$/i.test(rel)&&f.size>0).map(([rel,f])=>{
  const source=(Object.entries(P.VAUD||{}).find(([,v])=>v.file===rel)||[])[0]||'';
  return {rel,label:text[rel]||rel.split('/').pop(),source,extracted:/^sfx\/va_/i.test(rel),mtime:f.mtime||0};
 }).sort((a,b)=>Number(b.extracted)-Number(a.extracted)||b.mtime-a.mtime||a.rel.localeCompare(b.rel));
}
function joinAudioBuffers(buffers,ctx){
 if(!buffers.length)throw new Error('请先选择录音');
 const rate=buffers[0].sampleRate;if(buffers.some(b=>b.sampleRate!==rate))throw new Error('录音采样率不一致');
 const channels=Math.min(2,Math.max(...buffers.map(b=>b.numberOfChannels))),length=buffers.reduce((n,b)=>n+b.length,0);
 const result=ctx.createBuffer(channels,length,rate);let offset=0;
 for(const b of buffers){for(let c=0;c<channels;c++)result.getChannelData(c).set(b.getChannelData(Math.min(c,b.numberOfChannels-1)),offset);offset+=b.length;}
 return result;
}
async function pickProjectAudio(){
 await refreshFiles();
 return new Promise(resolve=>{
  const m=document.createElement('div');m.className='modal audio-library-modal';
  m.innerHTML=`<div class="mbox audio-library-box"><div class="row"><h3>选择参考音频</h3><span class="grow"></span><button class="icon" data-close title="关闭">✕</button></div><div class="audio-library-tools"><select aria-label="音频分类" data-kind><option value="extracted">分离音频</option><option value="all">全部本地音频</option></select><input type="search" placeholder="搜索镜头名、台词或文件名" aria-label="搜索音频" data-query><button class="ghost" data-import>从电脑导入…</button></div><p class="dim">复刻请选择同一人的清晰录音，至少 10 秒；短片段可以勾选后合并。分离音轨会保留视频中的环境声。</p><div class="audio-library-list"></div><div class="row audio-library-foot"><span class="dim" data-count></span><span class="grow"></span><button class="ghost" data-close>取消</button><button class="pri" data-merge disabled>合并选中作为参考</button></div><div role="status" class="audio-library-error"></div></div>`;
  document.body.appendChild(m);const picked=new Set();let busy=false,ended=false;
  const q=s=>m.querySelector(s),stop=()=>m.querySelectorAll('audio').forEach(a=>a.pause());
  const close=value=>{if(busy||ended)return;ended=true;stop();m.remove();resolve(value);};
  m.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>close(null));m.onkeydown=e=>{if(e.key==='Escape'){e.stopPropagation();close(null);}};
  q('[data-import]').onclick=async()=>{try{stop();const paths=await S.pickAsset('audio');if(paths&&paths[0])close(paths[0]);}catch(e){q('.audio-library-error').textContent=e.message;}};
  const count=()=>{q('[data-count]').textContent=`已选 ${picked.size} 段（按勾选顺序合并，请确保同一人说话）`;q('[data-merge]').disabled=picked.size<2||busy;};
  function render(){
   stop();const term=q('[data-query]').value.trim().toLocaleLowerCase(),rows=projectAudioRows().filter(r=>(q('[data-kind]').value==='all'||r.extracted)&&(!term||[r.rel,r.label,r.source].join(' ').toLocaleLowerCase().includes(term)));
   q('.audio-library-list').innerHTML=rows.length?rows.map(r=>`<div class="audio-library-row"><input type="checkbox" aria-label="选择 ${esc(r.label)} 合并" data-select="${esc(r.rel)}" ${picked.has(r.rel)?'checked':''}><div><strong>${esc(r.label)}</strong><div class="dim">${esc(r.source?'来自 '+r.source:r.extracted?'视频分离音频':r.rel)}</div><small class="dim">${esc(r.rel)}</small></div><audio controls preload="metadata" src="${fileUrl(r.rel)}" aria-label="试听 ${esc(r.label)}"></audio><span class="dim" data-seconds>加载时长…</span><button class="ghost" data-use="${esc(r.rel)}">设为参考</button></div>`).join(''):'<div class="hint">暂无匹配音频。可以切换“全部本地音频”，或从电脑导入。</div>';
   m.querySelectorAll('[data-select]').forEach(c=>c.onchange=()=>{c.checked?picked.add(c.dataset.select):picked.delete(c.dataset.select);count();});
   m.querySelectorAll('[data-use]').forEach(b=>b.onclick=()=>close(absPath(b.dataset.use)));
   m.querySelectorAll('audio').forEach(a=>{a.onplay=()=>m.querySelectorAll('audio').forEach(x=>{if(x!==a)x.pause();});a.onloadedmetadata=()=>{const s=a.parentElement.querySelector('[data-seconds]');s.textContent=Number.isFinite(a.duration)?`${a.duration.toFixed(1)} 秒`:'';};a.onerror=()=>{a.parentElement.querySelector('[data-seconds]').textContent='无法播放';};});count();
  }
  q('[data-kind]').onchange=render;q('[data-query]').oninput=render;
  q('[data-merge]').onclick=async()=>{
   if(busy)return;busy=true;count();stop();m.querySelectorAll('button,input,select').forEach(x=>x.disabled=true);q('.audio-library-error').textContent='正在本地合并录音…';let ctx;
   try{
    ctx=new AudioContext({sampleRate:32000});const buffers=[];
    for(const rel of picked){const raw=await S.readAsset(P.dir,rel);buffers.push(await ctx.decodeAudioData(raw.buffer.slice(raw.byteOffset,raw.byteOffset+raw.byteLength)));}
    const audio=joinAudioBuffers(buffers,ctx),seconds=audio.length/audio.sampleRate;
    if(seconds<10||seconds>300)throw new Error(`合并后 ${seconds.toFixed(1)} 秒；请选取合计 10 秒～5 分钟的录音`);
    const bytes=wavBytes(audio);if(bytes.byteLength>20*1024*1024)throw new Error('合并音频超过 20 MB，请减少片段');
    const rel=`sfx/va_ref_${Date.now()}.wav`;await S.writeAsset(P.dir,rel,bytes);await refreshFiles();busy=false;close(absPath(rel));
   }catch(e){q('.audio-library-error').textContent=e.message;}
   finally{if(ctx)await ctx.close();busy=false;if(m.isConnected){m.querySelectorAll('button,input,select').forEach(x=>x.disabled=false);count();}}
  };
  render();
 });
}
function showExtractedAudioLibrary(){libTab='audio';libFilter='extracted';libQuery='';const input=$('libQ');if(input)input.value='';renderLib();}
