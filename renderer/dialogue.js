/* ⑤ 台词：按剧本和 VOT 映射显示对应配音，不使用分镜编号猜音频名。 */
"use strict";
function dialogueItems(scope = "all") {
  const nodes = scope === "scene" ? [cur] : flatOrder();
  return nodes.filter(nid => P.N[nid]).flatMap(nid => (P.N[nid].lines || []).flatMap((l, i) => {
    const who = String(l[0] || ""), text = String(l[1] || "");
    if (who.startsWith("@") || isSilent(text)) return [];
    const key = P.VOT[cleanKey(text)], rel = key ? `vo/${key}.mp3` : "";
    return [{nid, i, who: who || "旁白", text, rel, key,
      ok: !!(rel && P.files[rel] && P.files[rel].size !== 0), changed: stale.has(nid + ":" + i)}];
  }));
}
const dialogueStatus = it => !it.ok ? "missing" : it.changed ? "stale" : "ready";
function dialogueStop() {
  if (RV) RV.el.querySelectorAll("audio,video").forEach(m => m.pause());
}
function dialogueCounts() {
  const all = dialogueItems(RV.scope), ready = all.filter(x => dialogueStatus(x) === "ready").length;
  const kb = RV.el.querySelectorAll("#rvKind button i"), li = reviewItems("all");
  const counts = [scriptItems("all").filter(it => scriptState(it) === "todo").length,
    REFS().length + voiceRefCount(),
    li.filter(it => promptState(it) === "todo").length, li.filter(it => rvState(it) === "todo").length,
    vsItems("all").filter(it => vpState(it) === "todo").length,
    vsItems("all").filter(it => ["todo", "missing"].includes(finState(it))).length, dialogueItems("all").length];
  kb.forEach((b, i) => b.textContent = counts[i] || "");
  RV.el.querySelectorAll("#rvKind button").forEach(b => b.classList.toggle("on", b.dataset.v === RV.kind));
  RV.el.querySelectorAll("#rvScope button").forEach(b => b.classList.toggle("on", b.dataset.v === RV.scope));
  RV.el.querySelector(".rvprog i").style.width = (all.length ? ready / all.length * 100 : 0) + "%";
  RV.el.querySelector("#rvProg").textContent = `台词 ${all.length} 句 · 配音齐全 ${ready} · 缺失 ${all.filter(x => !x.ok).length} · 改字待更新 ${all.filter(x => x.ok && x.changed).length}`;
}
function dialogueBuild() {
  finStop(); dialogueStop(); RV.io && RV.io.disconnect(); RV.G = null;
  RV.el.querySelector("#rvFilter").hidden = true;
  RV.el.querySelector(".rvtools").hidden = true;
  RV.el.querySelector("#rvScope").hidden = false;
  RV.el.querySelector("#rvKeys").textContent = "按角色或文字筛选 · 播放对应配音 · Esc 关闭";
  RV.dialogue = RV.dialogue || {who:"", status:"", query:""};
  const d = RV.dialogue, all = dialogueItems(RV.scope), speakers = [...new Set(all.map(x => x.who))];
  if (d.who && !speakers.includes(d.who)) d.who = "";
  const body = RV.el.querySelector("#rvBody");
  body.innerHTML = `<div class="dlg-toolbar"><label>角色 <select id="dlgWho"><option value="">全部角色</option>${speakers.map(w => `<option value="${esc(w)}" ${d.who === w ? "selected" : ""}>${esc(w)}</option>`).join("")}</select></label><label>配音 <select id="dlgStatus"><option value="">全部状态</option><option value="ready">配音齐全</option><option value="missing">缺失配音</option><option value="stale">改字待更新</option></select></label><input id="dlgQuery" type="search" aria-label="搜索台词" placeholder="搜索台词、场景或文件名" value="${esc(d.query)}"><button class="ghost" id="dlgStop">停止试听</button><span class="dim" id="dlgCount"></span></div><div id="dlgRows"></div>`;
  body.querySelector("#dlgStatus").value = d.status;
  body.querySelector("#dlgWho").onchange = e => { d.who = e.target.value; dialogueRenderRows(); };
  body.querySelector("#dlgStatus").onchange = e => { d.status = e.target.value; dialogueRenderRows(); };
  body.querySelector("#dlgQuery").oninput = e => { d.query = e.target.value; dialogueRenderRows(); };
  body.querySelector("#dlgStop").onclick = dialogueStop;
  dialogueRenderRows(); dialogueCounts();
}
const dialogueJobs = new Set();
function dialogueVoiceControls(it, index) {
  const voices = ((P.voiceRefs || {}).voices || []).filter(v => v.voice_id);
  if (!voices.length) return '<div class="dim">请先在「参考 → 声音音色」生成音色。</div>';
  const matched = voices.filter(v => v.role === it.who);
  const selected = matched.length === 1 ? matched[0].id : "";
  const busy = dialogueJobs.has(P.dir + ":" + cleanKey(it.text));
  return `<label>配音音色 <select data-dlg-voice="${index}"><option value="">请选择音色</option>${voices.map(v => `<option value="${esc(v.id)}" ${v.id === selected ? "selected" : ""}>${esc(v.name)}${v.role ? " · " + esc(v.role) : ""}</option>`).join("")}</select></label><button class="pri" data-dlg-generate="${index}" ${busy ? "disabled" : ""}>${busy ? "生成中…" : "生成这句配音…"}</button>`;
}
async function generateDialogue(it, voiceId) {
  const project = P, key = cleanKey(it.text), job = project.dir + ":" + key;
  if (!voiceId) return toast("请先选择配音音色", true);
  if (it.text.trim().length > 300) return toast("单句配音最多 300 字", true);
  if (dialogueJobs.has(job)) return;
  const voice = project.voiceRefs.voices.find(v => v.id === voiceId && v.voice_id);
  if (!voice) return toast("这个音色尚未准备好", true);
  const shared = dialogueItems("all").filter(line => cleanKey(line.text) === key).length;
  const note = shared > 1 ? "\n项目中相同台词共用配音，这次会更新对应的 " + shared + " 句。" : "";
  if (await S.confirm(`用「${voice.name}」生成这句台词的配音？MiniMax 可能计费。${note}`, ["生成配音", "取消"]) !== 0) return;
  if (P !== project || dialogueJobs.has(job)) return;
  dialogueJobs.add(job);
  const refresh = () => { if (P === project && RV && RV.kind === "dialogue") dialogueBuild(); };
  refresh();
  try {
    const audio = await S.voiceRefsGenerate(project.dir, voiceId, "dialogue", it.text);
    const line = project.N[it.nid]?.lines?.[it.i];
    if (P !== project || !line || line[1] !== it.text || (line[0] || "旁白") !== it.who) throw new Error("生成期间台词或项目已变更，请重新选择");
    const generated = "ai_" + crypto.randomUUID().replace(/-/g, "");
    await S.writeAsset(project.dir, "vo/" + generated + ".mp3", audio);
    if (P !== project || project.N[it.nid]?.lines?.[it.i]?.[1] !== it.text) throw new Error("音频已保存到 vo 文件夹，请重新绑定台词");
    edit(() => {
      project.VOT[key] = generated;
      for (const row of dialogueItems("all")) if (cleanKey(row.text) === key) {
        const line = project.N[row.nid].lines[row.i];
        if (line[2]?.vo_bind) line[2].vo_bind = {...line[2].vo_bind, voice:generated};
        stale.delete(row.nid + ":" + row.i);
      }
    });
    await refreshFiles();
    toast("配音已生成，可以试听。按 Ctrl+S 保存台词绑定。");
  } catch (error) {
    toast(voiceError(error.message), true);
  } finally {
    dialogueJobs.delete(job);
    refresh();
  }
}
function dialogueRenderRows() {
  dialogueStop();
  const d = RV.dialogue, query = d.query.trim().toLocaleLowerCase();
  RV.items = dialogueItems(RV.scope).filter(it => (!d.who || it.who === d.who) &&
    (!d.status || dialogueStatus(it) === d.status) && (!query ||
      [it.text, it.who, it.nid, sceneName(it.nid), it.rel].join(" ").toLocaleLowerCase().includes(query)));
  RV.k = 0;
  const box = RV.el.querySelector("#dlgRows");
  box.innerHTML = RV.items.length ? RV.items.map((it, k) => `<article class="rvcard dlg-card" data-k="${k}"><div><div class="dlg-heading"><strong>${esc(it.who)}</strong><span class="tag ${it.ok && !it.changed ? "pass" : "best"}">${{ready:"配音齐全",missing:"缺失配音",stale:"台词改过，配音待更新"}[dialogueStatus(it)]}</span><span class="dim">${esc(sceneName(it.nid))} · 第 ${it.i + 1} 行</span></div><p class="dlg-text">${esc(it.text)}</p>${lineMuted(it.nid,it.i)?'<span class="dlg-muted">🔇 台词配音已静音</span>':""}${dialogueVideoHtml(it,k)}<div class="row"><button class="ghost" data-dlg-edit="${k}">定位到台词编辑</button>${dialogueOpinionButton(it,k)}</div></div><div class="dlg-audio">${it.ok ? `<div class="dim">独立配音试听</div><audio controls preload="none" aria-label="${esc(it.who)}的配音" src="${fileUrl(it.rel)}"></audio>` : '<div class="dim">尚无可播放的对应音频</div>'}<div class="dlg-file dim">${esc(it.rel || "尚未绑定配音文件")}</div>${dialogueSoundControls(it,k)}<div class="row">${it.rel ? `<button class="ghost" data-dlg-replace="${k}">${it.ok ? "替换配音…" : "选择配音…"}</button>` : ""}${it.ok ? `<button class="ghost" data-dlg-reveal="${k}">在文件夹中显示</button>` : ""}</div><div class="row">${dialogueVoiceControls(it,k)}</div></div></article>`).join("") : '<div class="rvempty">没有符合条件的台词，试试切换角色或清空搜索。</div>';
  RV.el.querySelector("#dlgCount").textContent = `显示 ${RV.items.length} 句`;
  box.querySelectorAll('.rvcard').forEach(card=>bindReviewFlow(card,+card.dataset.k));
  RV.io && RV.io.disconnect();
  RV.io = new IntersectionObserver(entries=>entries.forEach(entry=>{if(entry.isIntersecting&&entry.intersectionRatio>.55&&RV&&RV.kind==='dialogue')RV.k=+entry.target.dataset.k;}),{root:RV.el.querySelector('#rvBody'),threshold:[.55]});
  box.querySelectorAll('.rvcard').forEach(card=>RV.io.observe(card));
  bindDialogueReviewActions(box);
  box.querySelectorAll('[data-dlg-video]').forEach(button=>button.onclick=()=>{
    const it=RV.items[+button.dataset.dlgVideo],shot=dialogueVideoTarget(it);
    if(shot)openScriptVideo(finRel(shot),it.who+'：'+it.text,shot);
  });
  box.querySelectorAll("audio").forEach(audio => {
    audio.onplay = () => box.querySelectorAll("audio").forEach(other => { if (other !== audio) other.pause(); });
    audio.onerror = () => { const note = audio.parentElement.querySelector(".dlg-file"); note.textContent = "音频无法播放，请检查文件：" + note.textContent; };
  });
  box.querySelectorAll("[data-dlg-edit]").forEach(b => b.onclick = () => {
    const it = RV.items[+b.dataset.dlgEdit]; dialogueStop(); closeReview(); cur = it.nid;
    sel = {kind:"line", i:it.i}; renderAll(false); selectLine(it.i);
  });
  box.querySelectorAll("[data-dlg-reveal]").forEach(b => b.onclick = () => S.reveal(absPath(RV.items[+b.dataset.dlgReveal].rel)).catch(e => toast(e.message, true)));
  box.querySelectorAll("[data-dlg-generate]").forEach(button => button.onclick = () => {
    const index = button.dataset.dlgGenerate;
    return generateDialogue(RV.items[+index], box.querySelector(`[data-dlg-voice="${index}"]`).value);
  });
  box.querySelectorAll("[data-dlg-replace]").forEach(b => b.onclick = async () => {
    const it = RV.items[+b.dataset.dlgReplace]; dialogueStop();
    try { const paths = await S.pickAsset("audio"); if (paths && paths[0]) await replaceWith(it.rel, paths[0]); if (RV && RV.kind === "dialogue") dialogueBuild(); }
    catch (e) { toast(e.message, true); }
  });
}


function dialogueSoundState(it) {
  const shot = dialogueVideoTarget(it), video = shot ? finRel(shot) : '';
  const rawFile = P.VAUD[video]?.file;
  const original = !!(video && has(video) && hasOriginalAudio(video) && (!rawFile || has(rawFile)));
  const voiceOn = it.ok && !lineMuted(it.nid, it.i), originalOn = original && !P.VAUD[video]?.muted;
  return {video, original, mode:voiceOn ? (originalOn ? 'both' : 'ai') : (originalOn ? 'original' : 'silent'),
    shared:!!shot && finSpeech(shot, false).length > 1};
}
function dialogueSoundControls(it, index) {
  const state = dialogueSoundState(it);
  const labels = {ai:'使用配音',original:'使用视频原声',both:'原声和配音都开启',silent:'声音已静音'};
  return `<div class="dim" style="margin-top:8px">当前声音 · ${labels[state.mode]}</div>
    <div class="row"><button class="${state.mode === 'ai' ? 'pri' : 'ghost'}" data-dlg-sound="${index}" data-mode="ai" ${it.ok ? '' : 'disabled'}>使用配音</button>
    <button class="${state.mode === 'original' ? 'pri' : 'ghost'}" data-dlg-sound="${index}" data-mode="original" ${state.original ? '' : 'disabled'}>使用视频原声</button></div>
    ${state.shared ? '<div class="dim">多句台词共用此视频，原声开关会影响共用它的台词。</div>' : ''}`;
}
function applyDialogueSound(it, mode) {
  const line = P.N[it.nid]?.lines[it.i];
  if (!line || line[1] !== it.text || (line[0] || '旁白') !== it.who) throw new Error('台词已变化，请重新打开这句台词');
  const state = dialogueSoundState(it), key = voKey(line[1]);
  if (mode !== 'ai' && mode !== 'original') throw new Error('声音来源无效');
  if (mode === 'ai' && (!key || !has(`vo/${key}.mp3`))) throw new Error('请先选择或生成这句配音');
  if (mode === 'original' && !state.original) throw new Error('这条视频没有可用的原声');
  setLineMuted(it.nid, it.i, mode === 'original');
  if (state.video) {
    setOriginalMuted(state.video, mode === 'ai');
    line[2].vo_bind = {video:state.video, voice:key || null, mode};
  }
}
async function chooseDialogueSound(it, mode) {
  const project = P;
  try {
    dialogueStop(); finStop(); pvCmd('pause');
    // Validate before edit() takes an undo snapshot or changes dirty state.
    const line = project.N[it.nid]?.lines[it.i], state = dialogueSoundState(it);
    if (!line || line[1] !== it.text || (line[0] || '旁白') !== it.who) throw new Error('台词已变化，请重新打开这句台词');
    if (mode === 'original' && !state.original) throw new Error('这条视频没有可用的原声');
    if (mode === 'ai' && !it.ok) throw new Error('请先选择或生成这句配音');
    edit(() => applyDialogueSound(it, mode));
    if (!await save() || P !== project) return;
    toast(mode === 'ai' ? '已使用配音，视频原声已静音并保存' : '已使用视频原声，独立配音已静音并保存');
  } catch (error) { toast(error.message, true); }
  finally { if (P === project && RV?.kind === 'dialogue') dialogueRenderRows(); }
}
function dialogueOpinionTarget(it) {
  const line = P.N[it.nid]?.lines[it.i];
  if (!line || line[1] !== it.text || (line[0] || '旁白') !== it.who) throw new Error('台词已变化，请重新打开这句台词');
  const occurrence = P.N[it.nid].lines.slice(0, it.i).filter(other => other[0] === line[0] && other[1] === line[1]).length;
  const state = dialogueSoundState(it);
  return {key:'dialogue-note:' + hashStr(JSON.stringify([it.nid, line[0], line[1], occurrence])),
    scene:it.nid, line:it.i, speaker:it.who, script_text:it.text, asset:it.rel || '',
    source_revision:P.files[it.rel]?.revision || null, video:state.video,
    video_revision:P.files[state.video]?.revision || null,
    sound_mode:state.mode, voice_muted:lineMuted(it.nid, it.i),
    voice_offset:voiceOffset(line), original_settings:state.video ? {...P.VAUD[state.video]} : null};
}
async function saveDialogueOpinion(target, requirements, scope) {
  const project = P, line = project.N[target.scene]?.lines[target.line];
  if (!line || line[1] !== target.script_text || (line[0] || '旁白') !== target.speaker) throw new Error('台词已变化，请重新打开审阅意见');
  if (scope !== 'voiceover' && scope !== 'current_mix') throw new Error('请选择意见针对的声音');
  const text = String(requirements).trim(), old = project.sb?.review?.[target.key], now = new Date().toISOString();
  const record = {...target, schema_version:1, type:'dialogue_voice', review_scope:scope,
    requirements:text, status:text ? 'pending' : 'cancelled', hide_requirements:true,
    requested_at:old?.requested_at || now, updated_at:now, generation_approval:'awaiting_user_command'};
  const saved = await S.sbReviewMany(project.dir, {[target.key]:record});
  if (P === project) P.sb = saved;
}
function dialogueOpinionButton(it, index) {
  const target = dialogueOpinionTarget(it), old = P.sb?.review?.[target.key];
  return `<button class="ghost" data-dlg-opinion="${index}">${old && old.status !== 'cancelled' ? '编辑配音审阅意见…' : '配音审阅意见…'}</button>`;
}
function dialogueOpinionDialog(it) {
  let target;
  try { target = dialogueOpinionTarget(it); } catch (error) { toast(error.message, true); return; }
  const project = P, old = project.sb?.review?.[target.key], modal = document.createElement('div');
  const scope = old?.review_scope || 'voiceover';
  dialogueStop(); finStop(); modal.className = 'modal';
  modal.innerHTML = `<div class="mbox" style="width:min(640px,94vw)"><h3>配音审阅意见</h3>
    <p class="dim">${esc(sceneName(it.nid))} · 第 ${it.i + 1} 行 · ${esc(it.who)}</p><p>${esc(it.text)}</p>
    <label>意见针对 <select data-opinion-scope><option value="voiceover" ${scope === 'voiceover' ? 'selected' : ''}>本句独立配音</option><option value="current_mix" ${scope === 'current_mix' ? 'selected' : ''}>游戏当前声音（跟随音轨选择）</option></select></label>
    <textarea rows="5" style="width:100%;margin-top:12px" placeholder="例如：语气太平，需要压低声音、说快一点；句中喘口气，末尾不要上扬。">${esc(old && old.status !== 'cancelled' ? old.requirements : '')}</textarea>
    <p class="dim">意见只在此窗口显示。保存后，可让 AI 按配音审阅意见批量修改。清空并保存可撤销这条意见。</p>
    <p class="dim" data-opinion-status></p><div class="row" style="justify-content:flex-end"><button class="ghost" data-opinion-cancel>取消</button><button class="pri" data-opinion-save>保存意见</button></div></div>`;
  let saving = false;
  const close = () => { if (!saving) modal.remove(); };
  modal.querySelector('[data-opinion-cancel]').onclick = close;
  modal.onkeydown = event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } };
  modal.querySelector('[data-opinion-save]').onclick = async () => {
    if (saving || P !== project) return;
    const button = modal.querySelector('[data-opinion-save]');
    try {
      saving = true; button.disabled = true;
      await saveDialogueOpinion(target, modal.querySelector('textarea').value, modal.querySelector('[data-opinion-scope]').value);
      if (P !== project) return;
      modal.remove();
      if (RV?.kind === 'dialogue') dialogueRenderRows();
      toast('配音审阅意见已保存');
    } catch (error) { modal.querySelector('[data-opinion-status]').textContent = error.message; }
    finally { saving = false; button.disabled = false; }
  };
  document.body.appendChild(modal); modal.querySelector('textarea').focus();
}
function bindDialogueReviewActions(box) {
  box.querySelectorAll('[data-dlg-opinion]').forEach(button => button.onclick = () => dialogueOpinionDialog(RV.items[+button.dataset.dlgOpinion]));
  box.querySelectorAll('[data-dlg-sound]').forEach(button => button.onclick = () => chooseDialogueSound(RV.items[+button.dataset.dlgSound], button.dataset.mode));
  box.querySelectorAll('.dlg-card').forEach(card => card.oncontextmenu = event => {
    if (event.target.closest('input,select,textarea')) return;
    const it = RV.items[+card.dataset.k];
    reviewJumpMenu(event, [['配音审阅意见…', () => dialogueOpinionDialog(it)]]);
  });
}
