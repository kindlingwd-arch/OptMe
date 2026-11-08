/* 影游剪辑台 · 界面逻辑 */
"use strict";
const S = window.studio;
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

let P = null;            // 当前项目
let cur = null;          // 当前场景 id
let sel = null;          // 选中：{kind:"scene"|"line"|"choice"|"lock"|"end"|"mus"|"amb", i?}
let dirty = false, bust = Date.now(), pvLine = null, libTab = "scenes", libFilter = "all", libQuery = "";
const meta = {};         // 媒体时长缓存
const stale = new Set(); // 改了字、配音没重录的台词 "场景:行"
const undoStack = [], redoStack = [];

let mode = (() => { try { return localStorage.getItem("studio_mode") || "board"; } catch { return "board"; } })();   // board = 故事板（图片）模式；video = 视频模式
let centerTab = mode === "board" ? "board" : "play";
const TRACKS_ALL = [
  ["pic", "画面 · 分镜", "#c4733a"],
  ["v", "画面", "var(--c-video)"], ["shot", "插入镜头", "var(--c-shot)"], ["va", "原声", "var(--c-va)"], ["dlg", "台词 · 配音", "var(--c-dlg)"],
  ["cap", "字幕卡", "var(--c-cap)"], ["evt", "事件", "var(--c-evt)"], ["mus", "音乐", "var(--c-mus)"], ["amb", "环境声", "var(--c-amb)"],
];
const TRACK_H = { pic: 58, v: 54, shot: 46, va: 28, dlg: 40, cap: 32, evt: 36, mus: 30, amb: 30 };
const TRACKS_OF = { board: ["pic", "dlg", "cap", "evt", "mus", "amb"], video: ["v", "shot", "va", "dlg", "cap", "evt", "mus", "amb"] };
const tracks = () => TRACKS_ALL.filter(t => TRACKS_OF[mode].includes(t[0]));
const MUSIC = ["theme", "cabin", "tension", "truth", "sad"], AMBS = ["", "station", "car", "road", "check", "rail", "kitchen"];

/* ============ 基础 ============ */
function toast(t, err) {
  const d = document.createElement("div"); d.className = "toast" + (err ? " err" : ""); d.textContent = t;
  $("toasts").appendChild(d); setTimeout(() => d.remove(), err ? 6500 : 3200);
}
function toastAct(t, label, fn, ms = 20000) {   // 带按钮、停留久一点的提示（比如后台修图完成）
  const d = document.createElement("div"); d.className = "toast act"; d.innerHTML = `<span></span><button class="pri"></button><button class="icon" title="关闭">✕</button>`;
  d.querySelector("span").textContent = t; d.querySelector(".pri").textContent = label;
  d.querySelector(".pri").onclick = () => { d.remove(); fn(); }; d.querySelector(".icon").onclick = () => d.remove();
  $("toasts").appendChild(d); setTimeout(() => d.remove(), ms);
}
const has = rel => !!(P && P.files[rel]);
function fileUrl(rel) {
  const base = P.dir.replace(/\\/g, "/");
  const u = (base.startsWith("/") ? "file://" : "file:///") + base.split("/").map(encodeURIComponent).join("/").replace(/^([A-Za-z])%3A/, "$1:");
  return u + "/" + rel.split("/").map(encodeURIComponent).join("/") + "?t=" + encodeURIComponent(P.files[rel] ? (P.files[rel].revision || `${P.files[rel].mtime}:${P.files[rel].size}`) : bust);
}
const absPath = rel => P.dir.replace(/[\\/]+$/, "") + (P.dir.includes("\\") ? "\\" + rel.replace(/\//g, "\\") : "/" + rel);
const cleanKey = t => String(t).replace(/（[^）]*）/g, "").trim();
const voKey = t => P.VOT[cleanKey(t)];
const isSilent = t => /^[…。.！？!?\s—-]*$/.test(t);
const fmt = s => { s = Math.max(0, Math.round(s)); return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0"); };
function outs(n) { return [...new Set([...(n.choices || []).map(c => c.to), ...(n.lock ? [n.lock.ok, n.lock.fail] : [])])]; }
const sceneName = id => { const n = P.N[id]; return n.end ? n.end : (n.title || id); };
function order() {
  const acts = P.ACTS.length ? P.ACTS : [["全部场景", Object.keys(P.N)]];
  const seen = new Set(acts.flatMap(a => a[1]).filter(i => P.N[i]));
  const extra = Object.keys(P.N).filter(i => !seen.has(i));
  return [...acts.map(([n, ids]) => [n, ids.filter(i => P.N[i])]), ...(extra.length ? [["未分幕", extra]] : [])];
}
const flatOrder = () => order().flatMap(a => a[1]);

function dur(rel, fallback) {
  if (meta[rel] !== undefined) return meta[rel] ?? fallback;
  if (!has(rel)) return fallback;
  meta[rel] = null;
  const m = document.createElement(rel.endsWith(".mp4") ? "video" : "audio"); m.preload = "metadata";
  m.onloadedmetadata = () => { meta[rel] = m.duration || fallback; laterRender(); };
  m.onerror = () => { meta[rel] = fallback; };
  m.src = fileUrl(rel); return fallback;
}
let lr = null; const laterRender = () => { clearTimeout(lr); lr = setTimeout(() => { renderTimeline(); renderStat(); if (libTab === "scenes") renderLib(); }, 150); };

function issues(id) {
  const n = P.N[id], out = [];
  if (!has(`img/${id}.jpg`)) out.push(["b", "缺关键帧"]);
  if (mode === "video" && !has(`vid/${id}.mp4`)) out.push(["w", "没有场景视频"]);
  n.lines.forEach((l, i) => {
    if (mode === "board" && isSpoken(l)) { const im = limgOf(id, i); if (!im || !has(limgRel(im))) out.push(["w", `第 ${i + 1} 行没有分镜图`]); else { const st = sbState(im); if (st && st.status === "best") out.push(["w", `第 ${i + 1} 行分镜图没通过质检`]); } }
    if (l[0] === "@shot") { if (mode === "video" && !has(`vid/s_${l[1]}.mp4`)) out.push(["w", `镜头 ${l[1]} 没有视频`]); if (mode === "board" && !has(`img/s_${l[1]}.jpg`)) out.push(["w", `镜头 ${l[1]} 没有图`]); }
    else if (l[0] !== "@cap" && !isSilent(l[1])) {
      const k = voKey(l[1]);
      if (!k || !has(`vo/${k}.mp3`)) out.push(["w", `第 ${i + 1} 行没有配音`]);
      else if (stale.has(id + ":" + i)) out.push(["w", `第 ${i + 1} 行改了字，配音是旧的`]);
    }
  });
  (n.choices || []).forEach(c => { if (!P.N[c.to]) out.push(["b", `选项指向不存在的场景 ${c.to}`]); });
  if (n.lock) [n.lock.ok, n.lock.fail].forEach(t => { if (!P.N[t]) out.push(["b", `密码锁指向不存在的场景 ${t}`]); });
  return out;
}
const level = iss => iss.some(x => x[0] === "b") ? "b" : iss.length ? "w" : "";

/* ============ 逐句分镜图 ============ */
const pad2 = i => String(i).padStart(2, "0");
const isSpoken = l => l && !String(l[0]).startsWith("@");
function limgOf(nid, i) {              // 这一句用的分镜图（"l/ride_00"），没有就 null
  const l = P.N[nid].lines[i]; if (!l) return null;
  if (l[2] && l[2].img) return l[2].img;
  const k = nid + "_" + pad2(i); return (P.LIMG || []).includes(k) ? "l/" + k : null;
}
const limgRel = img => `img/${img}.jpg`;
const shotId = img => img ? img.split("/").pop() : null;
const SB = () => P && P.sb && !P.sb.error ? P.sb : null;
function shotOf(img) { const sb = SB(); return sb && img ? sb.shots.find(x => x.id === shotId(img)) : null; }
function sbState(img) { const sb = SB(); return sb && img ? (sb.state.shots || {})[shotId(img)] : null; }
function pinLineImages() {             // 打开项目时把 LIMG 登记的图钉到台词上，之后插入、移动台词也不会对错图
  Object.entries(P.N).forEach(([nid, n]) => n.lines.forEach((l, i) => { const k = nid + "_" + pad2(i); if (isSpoken(l) && !(l[2] && l[2].img) && ((P.LIMG || []).includes(k) || (shotOf("l/" + k) && has(limgRel("l/" + k))))) l[2] = { img: "l/" + k }; }));
}
function newImgId(nid, i) {            // 给一句还没有分镜图的台词起个图名
  const used = new Set(Object.values(P.N).flatMap(n => n.lines.map(l => l[2] && l[2].img)).filter(Boolean));
  let base = nid + "_" + pad2(i), k = base, c = 0;
  while (used.has("l/" + k) || (has(limgRel("l/" + k)) && !(P.LIMG || []).includes(k))) k = base + String.fromCharCode(97 + c++);
  return "l/" + k;
}
function limgList() { return [...new Set(Object.values(P.N).flatMap(n => n.lines.map(l => l[2] && l[2].img)).filter(x => x && x.startsWith("l/")).map(shotId))].sort(); }

/* ============ 撤销 / 保存 ============ */
const snapshot = () => JSON.stringify({ N: P.N, VOT: P.VOT, CLUES: P.CLUES, BGM: P.BGM, AMB: P.AMB, SHOTS: P.SHOTS, TRIM: P.TRIM, VAUD: P.VAUD, stale: [...stale] });
function restore(js) { const d = JSON.parse(js); Object.assign(P, { N: d.N, VOT: d.VOT, CLUES: d.CLUES, BGM: d.BGM, AMB: d.AMB, SHOTS: d.SHOTS, TRIM: d.TRIM || {}, VAUD: d.VAUD || {} }); stale.clear(); d.stale.forEach(k => stale.add(k)); }
function edit(fn) {           // 所有修改都走这里：先存快照，便于撤销
  undoStack.push(snapshot()); if (undoStack.length > 200) undoStack.shift(); redoStack.length = 0;
  fn(); setDirty(true); renderAll(false);
}
function undo() { if (!undoStack.length) return toast("没有可以撤销的了"); redoStack.push(snapshot()); restore(undoStack.pop()); if (!P.N[cur]) cur = flatOrder()[0]; fixSel(); setDirty(true); renderAll(true); }
function redo() { if (!redoStack.length) return; undoStack.push(snapshot()); restore(redoStack.pop()); fixSel(); setDirty(true); renderAll(true); }
function fixSel() { const n = P.N[cur]; if (sel && sel.kind === "line" && (!n || !n.lines[sel.i])) sel = { kind: "scene" }; }
function setDirty(v) { dirty = v; $("tbSave").disabled = !v; $("dirtyDot").hidden = !v; }
async function save() {
  try {
    if (!P.hasLimg && limgList().length) toast("提示：这个游戏的 index.html 还不支持逐句分镜图，请先更新游戏文件", true);
    const bk = await S.save(P.dir, { N: P.N, VOT: P.VOT, CLUES: P.CLUES, BGM: P.BGM, AMB: P.AMB, SHOTS: P.SHOTS, TRIM: P.TRIM, VAUD: P.VAUD, LIMG: P.hasLimg ? limgList() : undefined, STALE: [...stale] });
    bust=Date.now();setDirty(false); toast("已保存" + (bk ? "（旧版本备份在 " + bk + "）" : "")); reloadPreview(); return true;
  } catch (e) { toast("保存失败：" + e.message, true); return false; }
}

/* ============ 打开项目 ============ */
async function showWelcome() {
  $("studio").hidden = true; $("welcome").hidden = false;
  try {
    const r = await S.recent();
    $("wRecent").innerHTML = r.length ? r.map(x => `<button data-dir="${esc(x.dir)}"><span>${esc(x.name)}<small>${esc(x.dir)}</small></span><span class="dim">${x.scenes} 个场景</span></button>`).join("") : '<div class="hint">还没有打开过项目</div>';
    $("wRecent").querySelectorAll("button").forEach(b => b.onclick = () => openProject(b.dataset.dir));
  } catch (e) { toast(e.message, true); }
}
async function pickAndOpen() {
  if (dirty && !(await askSave())) return;
  try { const dir = await S.pickProject(); if (dir) openProject(dir); } catch (e) { toast(e.message, true); }
}
async function openProject(dir) {
  try {
    P = await S.load(dir); P.TRIM = P.TRIM || {}; P.VAUD = P.VAUD || {}; P.LIMG = P.LIMG || []; pinLineImages(); stale.clear(); (P.STALE || []).forEach(k => stale.add(k));
    if (P.sb && P.sb.error) toast(P.sb.error, true);
    undoStack.length = redoStack.length = 0; Object.keys(meta).forEach(k => delete meta[k]); bust = Date.now();
    $("welcome").hidden = true; $("studio").hidden = false; $("projName").textContent = P.name; setDirty(false);
    cur = P.N.start ? "start" : flatOrder()[0]; sel = { kind: "scene" }; pvLoaded = false;
    renderAll(true); playFrom(0); ensureUpBase();
  } catch (e) { toast("打开失败：" + e.message, true); }
}
async function refreshFiles() { const project=P, files=await S.files(project.dir); if(P===project){applyFileIndex(project,files);await syncChangedVideoFrames(project);} }
async function askSave() {
  if (!dirty) return true;
  const r = await S.confirm("有未保存的改动，要先保存吗？", ["保存", "不保存", "取消"]);
  if (r === 0) { await save(); return true; } if (r === 1) return true; return false;
}

/* ============ 渲染总入口 ============ */
function renderAll(full) { renderTop(); renderLib(); renderTimeline(); renderProps(); renderStat(); renderNav(); renderBoard(); renderModes(); }
function renderTop() { const iss = Object.keys(P.N).reduce((s, id) => s + issues(id).length, 0); $("issueN").hidden = !iss; $("issueN").textContent = iss;
  const vv = SB() && VS() ? vsItems("all").filter(it => vpState(it) === "todo").length : 0, sv = SB() ? scriptItems("all").filter(it => scriptState(it) === "todo").length : 0, rv = pendingCount(), pv = SB() ? reviewItems("all").filter(it => promptState(it) === "todo").length : 0, fv = SB() ? refItems().filter(it => refState(it) !== "ok").length : 0;
  $("reviewN").hidden = !(sv + rv + pv + fv + vv); $("reviewN").textContent = `${sv} · ${fv} · ${pv} · ${rv}` + (VS() ? ` · ${vv}` : ""); $("tbReview").title = `剧本待审 ${sv} 场 · 参考图待审 ${fv} 张 · 提示词待审 ${pv} 条 · 图片待审 ${rv} 张` + (VS() ? ` · 视频提示词待审 ${vv} 条` : "") + "（Ctrl+Shift+A）"; }
function renderStat() {
  const ids = Object.keys(P.N); let total = 0; ids.forEach(id => total += schedule(id).total);
  $("tbStat").textContent = `${ids.length} 个场景 · ${ids.filter(i => P.N[i].end).length} 个结局 · 全部素材约 ${Math.round(total / 60)} 分钟 · ${Object.keys(P.CLUES).length} 条线索`;
}

/* ============ 素材面板 ============ */
document.querySelectorAll(".libtabs button").forEach(b => b.onclick = () => {
  libTab = b.dataset.lt; libFilter = "all"; libQuery = "";
  document.querySelectorAll(".libtabs button").forEach(x => x.setAttribute("aria-selected", x === b)); renderLib();
});
function libBar(segs, importKind) {
  $("libBar").innerHTML = `<input id="libQ" placeholder="搜索…" value="${esc(libQuery)}">` +
    (segs ? `<div class="seg">${segs.map(([k, t]) => `<button data-f="${k}" aria-pressed="${libFilter === k}">${t}</button>`).join("")}</div>` : "") +
    (importKind ? `<button class="ghost" id="libImport" title="把电脑里的文件导入到项目的素材箱">导入</button>` : "");
  $("libQ").oninput = e => { libQuery = e.target.value.trim(); renderLibBody(); };
  $("libBar").querySelectorAll("[data-f]").forEach(b => b.onclick = () => { libFilter = b.dataset.f; renderLib(); });
  if (importKind) $("libImport").onclick = importAssets;
}
let renderLibBody = () => {};
function renderLib() {
  if (!P) return;
  if (libTab === "scenes") { libBar(null); renderLibBody = libScenes; }
  else if (libTab === "media") { libBar([["all", "全部"], ["key", "关键帧"], ["vid", "视频"], ["inbox", "导入"]], "media"); renderLibBody = libMedia; }
  else if (libTab === "audio") { libBar([["all", "全部"], ["vo", "配音"], ["bgm", "音乐"], ["sfx", "音效"], ["extracted", "分离音频"], ["amb", "环境"], ["inbox", "导入"]], "audio"); renderLibBody = libAudio; }
  else if (libTab === "clues") { $("libBar").innerHTML = `<span class="dim">线索在游戏里自动记进线索本</span><span class="grow" style="flex:1"></span><button class="ghost" id="clueAdd">＋ 线索</button>`; $("clueAdd").onclick = () => { const k = prompt("线索编号（英文，例如 ticket）"); if (k && /^[A-Za-z_]\w*$/.test(k) && !P.CLUES[k]) edit(() => P.CLUES[k] = "新线索"); }; renderLibBody = libClues; }
  else { $("libBar").innerHTML = `<span class="dim">点场景跳过去 · 箭头是选项和密码锁的去向</span>`; renderLibBody = libGraph; }
  renderLibBody();
}
const q = s => !libQuery || String(s).toLowerCase().includes(libQuery.toLowerCase());
function libScenes() {
  $("libBody").innerHTML = order().map(([act, ids]) => `<div class="grid"><div class="act-h">${esc(act)}</div>` + ids.filter(id => q(id + sceneName(id))).map(id => {
    const n = P.N[id], iss = issues(id), t = schedule(id).total;
    return `<div class="card${id === cur ? " sel" : ""}" data-id="${id}" title="${esc(iss.map(x => x[1]).join("\n") || "素材齐全")}">
      <div class="th" style="background-image:url('${fileUrl("img/" + id + ".jpg")}')"></div>
      <span class="kind${n.end ? " end" : ""}">${n.end ? "结局" : n.lock ? "谜题" : n.timer ? "限时" : (n.choices || []).length > 1 ? "分支" : "场景"}</span>
      <span class="st ${level(iss)}"></span><span class="dur">${fmt(t)}</span>
      <div class="nm">${esc(sceneName(id))}<small>${esc(id)} · ${n.lines.length} 行</small></div></div>`;
  }).join("") + "</div>").join("");
  $("libBody").querySelectorAll(".card").forEach(c => c.onclick = () => goScene(c.dataset.id));
}
function mediaItems(kinds) {
  return Object.keys(P.files).filter(r => kinds.some(k => r.startsWith(k))).sort();
}
function libMedia() {
  let list = [];
  if (libFilter === "all" || libFilter === "key") list.push(...mediaItems(["img/"]));
  if (libFilter === "all" || libFilter === "vid") list.push(...mediaItems(["vid/"]));
  if (libFilter === "all" || libFilter === "inbox") list.push(...mediaItems(["_studio/inbox/"]).filter(r => /\.(jpe?g|png|webp|mp4|webm|mov)$/i.test(r)));
  list = list.filter(q);
  $("libBody").innerHTML = list.length ? `<div class="grid">${list.map(r => {
    const isV = /\.(mp4|webm|mov)$/i.test(r), name = r.split("/").pop();
    const thumb = isV ? (r.startsWith("vid/") ? "img/" + name.replace(/\.mp4$/, ".jpg") : null) : r;
    return `<div class="card" draggable="true" data-rel="${esc(r)}" title="拖到时间线的块上或属性面板里即可替换">
      <div class="th" ${thumb && has(thumb) ? `style="background-image:url('${fileUrl(thumb)}')"` : ""}>${thumb && has(thumb) ? "" : isV ? "▶" : "▣"}</div>
      <span class="kind">${isV ? "视频" : "图片"}</span>${isV && meta[r] ? `<span class="dur">${fmt(meta[r])}</span>` : ""}
      <div class="nm">${esc(name)}<small>${esc(r.split("/").slice(0, -1).join("/"))}</small></div></div>`;
  }).join("")}</div>` : '<div class="hint" style="padding:20px">没有素材。点“导入”把电脑里的图片或视频放进来。</div>';
  bindDragSources(); $("libBody").querySelectorAll(".card").forEach(c => c.ondblclick = () => preview(c.dataset.rel));
}
function libAudio() {
  const sets = { vo: ["vo/"], bgm: ["bgm/"], sfx: ["sfx/"], extracted: ["sfx/"], amb: ["amb/"], inbox: ["_studio/inbox/"] };
  let list = libFilter === "all" ? mediaItems(["vo/", "bgm/", "sfx/", "amb/", "_studio/inbox/"]) : mediaItems(sets[libFilter]);
  list = list.filter(r => /\.(mp3|wav|m4a|ogg)$/i.test(r));
  if (libFilter === "extracted") list = list.filter(r => /^sfx\/va_/i.test(r));
  const textOf = {}; Object.entries(P.VOT).forEach(([t, k]) => textOf[`vo/${k}.mp3`] = t);
  list = list.filter(r => q(r + (textOf[r] || "")));
  $("libBody").innerHTML = list.length ? `<div class="alist">${list.map(r => `<div class="arow" draggable="true" data-rel="${esc(r)}" title="拖到台词块或属性面板里即可替换">
      <button class="play" data-play="${esc(r)}">▶</button>
      <div style="min-width:0"><div class="nm">${esc(textOf[r] || r.split("/").pop())}</div><small>${esc(r)}</small></div>
      <span class="dim">${meta[r] ? meta[r].toFixed(1) + "s" : ""}</span></div>`).join("")}</div>` : '<div class="hint" style="padding:20px">没有音频。</div>';
  list.forEach(r => dur(r, 0));
  bindDragSources();
  $("libBody").querySelectorAll("[data-play]").forEach(b => b.onclick = e => { e.stopPropagation(); playAudio(b.dataset.play, b); });
}
function libClues() {
  const used = {}; Object.keys(P.N).forEach(id => (P.N[id].gain || []).forEach(c => (used[c] = used[c] || []).push(id)));
  $("libBody").innerHTML = Object.entries(P.CLUES).filter(([k, t]) => q(k + t)).map(([k, t]) => `<div class="clue-it">
    <div class="k"><span>${esc(k)}</span><span class="dim">${used[k] ? "在 " + used[k].map(esc).join("、") + " 获得" : "还没有场景给出"}</span></div>
    <textarea data-ck="${esc(k)}">${esc(t)}</textarea></div>`).join("");
  $("libBody").querySelectorAll("[data-ck]").forEach(x => x.onchange = () => edit(() => P.CLUES[x.dataset.ck] = x.value.trim()));
}
function libGraph() {
  const ids = Object.keys(P.N), depth = {}, start = P.N.start ? "start" : ids[0]; depth[start] = 0; const qq = [start];
  while (qq.length) { const id = qq.shift(); outs(P.N[id]).forEach(t => { if (P.N[t] && depth[t] == null) { depth[t] = depth[id] + 1; qq.push(t); } }); }
  ids.forEach(i => { if (depth[i] == null) depth[i] = 0; });
  const rows = {}; ids.forEach(i => (rows[depth[i]] = rows[depth[i]] || []).push(i));
  const W = 104, H = 42, pos = {}; let maxC = 0;
  Object.entries(rows).forEach(([d, list]) => { maxC = Math.max(maxC, list.length); list.forEach((id, c) => pos[id] = { x: 8 + c * (W + 10), y: 8 + (+d) * (H + 22) }); });
  const GW = 16 + maxC * (W + 10), GH = 16 + Object.keys(rows).length * (H + 22);
  let svg = ""; ids.forEach(id => outs(P.N[id]).forEach(t => { if (!pos[t]) return; const a = pos[id], b = pos[t];
    const x1 = a.x + W / 2, y1 = a.y + H, x2 = b.x + W / 2, y2 = b.y, my = (y1 + y2) / 2;
    svg += `<path d="M${x1} ${y1}C${x1} ${my} ${x2} ${my} ${x2} ${y2}" stroke="${b.y <= a.y ? "#8a4b40" : "#4b4b57"}" fill="none" stroke-width="1.4"/>`; }));
  $("libBody").innerHTML = `<div class="graph" style="width:${GW}px;height:${GH}px"><svg width="${GW}" height="${GH}">${svg}</svg>${ids.map(id => {
    const n = P.N[id], p = pos[id], lv = level(issues(id));
    return `<div class="gn${n.end ? " end" : ""}${id === cur ? " sel" : ""}" data-id="${id}" style="left:${p.x}px;top:${p.y}px"><i class="st ${lv}" style="position:absolute;right:5px;top:5px;width:6px;height:6px;border-radius:50%;background:var(--ok)"></i><b>${esc(sceneName(id))}</b><span>${esc(id)}</span></div>`;
  }).join("")}</div>`;
  $("libBody").querySelectorAll(".gn").forEach(g => g.onclick = () => goScene(g.dataset.id));
}
async function importAssets() {
  try {
    const paths = await S.pickAsset("multi"); if (!paths) return;
    const rels = await S.importFiles(P.dir, paths); await refreshFiles(); libFilter = "inbox"; renderLib();
    toast(`已导入 ${rels.length} 个文件到素材箱，拖到时间线上即可替换`);
  } catch (e) { toast("导入失败：" + e.message, true); }
}
let audioEl = null;
function playAudio(rel, btn) {
  if (audioEl && audioEl.__rel === rel && !audioEl.paused) { audioEl.pause(); btn.textContent = "▶"; return; }
  if (audioEl) audioEl.pause(); document.querySelectorAll("[data-play]").forEach(b => b.textContent = "▶");
  audioEl = new Audio(fileUrl(rel)); audioEl.__rel = rel; audioEl.play().catch(() => {}); btn.textContent = "■";
  audioEl.onended = () => btn.textContent = "▶";
}
function preview(rel) {
  const m = document.createElement("div"); m.className = "modal";
  const isV = /\.(mp4|webm|mov)$/i.test(rel);
  m.innerHTML = `<div class="mbox" style="width:min(900px,92vw)"><h3>${esc(rel)}</h3>${isV ? `<video src="${fileUrl(rel)}" controls autoplay style="width:100%"></video>` : `<img src="${fileUrl(rel)}" style="width:100%">`}</div>`;
  m.onclick = e => { if (e.target === m) m.remove(); }; document.body.appendChild(m);
}

/* ============ 拖拽替换 ============ */
function bindDragSources() {
  $("libBody").querySelectorAll("[draggable=true]").forEach(el => el.ondragstart = e => { e.dataTransfer.setData("text/x-studio-rel", el.dataset.rel); e.dataTransfer.effectAllowed = "copy"; });
}
function bindDropTarget(el, targetRel) {
  if (!el || !targetRel) return;
  el.addEventListener("dragover", e => { e.preventDefault(); el.classList.add("over"); });
  el.addEventListener("dragleave", () => el.classList.remove("over"));
  el.addEventListener("drop", async e => {
    e.preventDefault(); e.stopPropagation(); el.classList.remove("over");
    let src = null; const rel = e.dataTransfer.getData("text/x-studio-rel");
    if (rel) src = absPath(rel); else if (e.dataTransfer.files[0]) src = S.filePath(e.dataTransfer.files[0]);
    if (src) replaceWith(targetRel, src);
  });
}
async function replaceWith(targetRel, srcAbs) {
  const kind = targetRel.endsWith(".mp4") ? "video" : targetRel.endsWith(".mp3") ? "audio" : "image";
  const ext = (srcAbs.split(".").pop() || "").toLowerCase();
  const ok = { video: ["mp4", "webm", "mov"], audio: ["mp3", "wav", "m4a", "ogg"], image: ["jpg", "jpeg", "png", "webp"] }[kind];
  if (!ok.includes(ext)) return toast(`这里需要${kind === "video" ? "视频" : kind === "audio" ? "音频" : "图片"}，拖进来的是 .${ext}`, true);
  try {
    const r = await S.replace(P.dir, targetRel, srcAbs); await refreshFiles();
    stale.forEach(k => { const [nid, li] = k.split(":"); const l = P.N[nid] && P.N[nid].lines[+li]; if (l && `vo/${voKey(l[1])}.mp3` === targetRel) { stale.delete(k); setDirty(true); } });
    toast("已替换 " + targetRel + (r.backup ? "，旧文件备份在 " + r.backup : "") + (r.note ? "。" + r.note : ""));
    renderAll(false); reloadPreview();
  } catch (e) { toast("替换失败：" + e.message, true); }
}
async function pickReplace(targetRel) {
  const kind = targetRel.endsWith(".mp4") ? "video" : targetRel.endsWith(".mp3") ? "audio" : "image";
  try { const p = await S.pickAsset(kind); if (p && p[0]) replaceWith(targetRel, p[0]); } catch (e) { toast(e.message, true); }
}

/* ============ 时间线 ============ */
const hasOriginalAudio = rel => !!(P.VAUD[rel]?.file || P.files[rel]?.hasAudio);
function schedule(id) {
  const n = P.N[id], items = []; let t = 0;
  n.lines.forEach((l, i) => {
    if (l[0] === "@shot") {
      const rel = `vid/${shotVid(l[1])}.mp4`, full = dur(rel, 6), tr = P.TRIM[rel], d = tr ? Math.max(.3, (tr[1] || full) - (tr[0] || 0)) : full;
      items.push({ tr: "shot", i, t, d, rel, label: "镜头 · " + l[1] + (tr ? `（剪 ${tr[0]}–${tr[1]} 秒）` : ""), miss: !has(rel), thumb: `img/s_${l[1]}.jpg` });
      items.push({ tr: "pic", i, t, d, label: "插入 · " + l[1], thumb: `img/s_${l[1]}.jpg`, miss: !has(`img/s_${l[1]}.jpg`) });
      if (hasOriginalAudio(rel)) items.push({ tr: "va", i: null, t, d, rel, kind: "va", label: "原声 · " + l[1] });
      t += d;
    }
    else if (l[0] === "@cap") { items.push({ tr: "cap", i, t, d: 2.6, label: l[1] }); items.push({ tr: "pic", i, t, d: 2.6, label: "字幕卡", thumb: null }); t += 2.6; }
    else {
      const k = voKey(l[1]), rel = k ? `vo/${k}.mp3` : null, est = Math.max(1.6, l[1].length * .24);
      let d = rel && has(rel) ? dur(rel, est) + .5 : est;
      const voiceD=d,delay=voiceOffset(l);d+=delay;
      const im0 = limgOf(id, i), vr = im0 ? `vid/${im0}.mp4` : null;
      if (vr && has(vr)) {
        const full = dur(vr, 6), trim = P.TRIM[vr], vd = trim ? Math.max(.3, trim[1] - trim[0]) : full;
        d = Math.max(d, vd);
        items.push({ tr: "shot", i, t, d: vd, rel: vr, label: "台词视频 · " + (l[0] || "旁白"), miss: false, thumb: limgRel(im0) });
        if (hasOriginalAudio(vr)) items.push({tr:"va", i:null, t, d:vd, rel:vr, kind:"va", label:"原声 · " + (l[0] || "旁白")});
      }
      items.push({ tr: "dlg", i, t:t+delay, d:voiceD, label: (l[0] ? l[0] + "：" : "") + l[1], miss: !isSilent(l[1]) && (!rel || !has(rel)), stale: stale.has(id + ":" + i), nar: !l[0] });
      const im = limgOf(id, i), ok = im && has(limgRel(im));
      items.push({ tr: "pic", i, t, d, label: ok ? `${i + 1}` : `${i + 1} · 沿用场景图`, thumb: ok ? limgRel(im) : `img/${id}.jpg`, fb: !ok }); t += d;
    }
    if (n.gainAt) for (const c in n.gainAt) if (n.gainAt[c] === i) items.push({ tr: "evt", i, t: items.filter(x => x.i === i)[0].t, d: 0, clue: c, label: "获得线索：" + (P.CLUES[c] || c) });
  });
  if (!n.lines.length) t = 4.2;
  if (n.end) {
    const e = (n.epi || []).length;
    if (e) { items.push({ tr: "evt", t, d: e * 1.4 + 4.2, label: `尾声 · ${e} 句`, kind: "end" }); t += e * 1.4 + 4.2; }
    items.push({ tr: "evt", t, d: 3, label: `结局卡【${n.end}】`, kind: "end" }); t += 3;
  } else if (n.lock) { items.push({ tr: "evt", t, d: 4, label: `密码锁 · ${n.lock.answer.length} 位 · ${n.lock.tries} 次`, kind: "lock" }); t += 4; }
  else if (n.choices) {
    const one = n.choices.length === 1 && !n.timer;
    items.push({ tr: "evt", t, d: one ? 1.2 : 3, label: one ? "继续 → " + sceneName(n.choices[0].to) : (n.timer ? `限时 ${n.timer} 秒 · ` : "") + `${n.choices.length} 个选项`, kind: "choice" }); t += one ? 1.2 : 3;
  }
  const bgm = P.BGM[id] || (n.end ? "sad" : ""), amb = P.AMB[id] || "";
  const vrel = `vid/${id}.mp4`, vtr = P.TRIM[vrel], vlen = vtr ? (vtr[1] || dur(vrel, 6)) - (vtr[0] || 0) : dur(vrel, 6);
  if (hasOriginalAudio(vrel)) items.push({ tr: "va", i: null, t: 0, d: Math.min(vlen, t), rel: vrel, kind: "va", label: "原声 · 场景视频" });
  return {
    total: t, items: [
      { tr: "v", t: 0, d: t, label: `vid/${id}.mp4` + (vtr ? `（剪 ${vtr[0]}–${vtr[1]} 秒）` : ""), miss: !has(vrel), kind: "scene", thumb: `img/${id}.jpg` },
      { tr: "mus", t: 0, d: t, label: bgm ? "音乐 · " + bgm : "音乐 · 沿用上一场", kind: "mus", dim: !bgm },
      { tr: "amb", t: 0, d: t, label: amb ? "环境声 · " + amb : "环境声 · 无", kind: "amb", dim: !amb },
      ...items],
  };
}
function renderTimeline() {
  if (!P || !cur) return;
  const n = P.N[cur], { items, total } = schedule(cur), z = +$("zoom").value;
  const W = Math.max(total * z + 160, $("tBody").clientWidth - 120);
  $("tHeads").innerHTML = `<div class="rh"></div>` + tracks().map(([k, nm, c]) => `<div class="th-row" style="height:${TRACK_H[k]}px"><i style="background:${c}"></i>${nm}</div>`).join("");
  let ruler = ""; for (let s = 0; s <= total + 3; s++) { ruler += `<i style="left:${s * z}px;${s % 5 ? "" : "height:9px"}"></i>`; if (s % 5 === 0) ruler += `<span style="left:${s * z}px">${fmt(s)}</span>`; }
  const rows = tracks().map(([k]) => {
    const its = items.filter(x => x.tr === k);
    return `<div class="trk" style="width:${W}px;height:${TRACK_H[k]}px">${its.map(x => {
      if (x.clue) return `<span class="dia" data-i="${x.i}" title="${esc(x.label)}" style="left:${x.t * z - 6}px"></span>`;
      const isSel = sel && ((x.i != null && sel.kind === "line" && sel.i === x.i) || (x.i == null && sel.kind === x.kind && (x.kind !== "va" || sel.rel === x.rel)));
      const cls = ["blk", "b-" + (k === "v" ? "video" : k === "dlg" && x.nar ? "nar" : k), x.miss ? "miss" : "", x.fb ? "fallback" : "", x.stale ? "stale" : "", isSel ? "sel" : "", (k === "dlg" && lineMuted(cur,x.i)) || (k === "va" && P.VAUD[x.rel]?.muted) ? "is-muted" : "", pvLine === x.i && x.i != null ? "cur" : ""].join(" ");
      const bg = x.thumb && has(x.thumb) ? `background-image:url('${fileUrl(x.thumb)}');` : "";
      const inner = k === "dlg" ? `<i class="wave"></i><span>${lineMuted(cur,x.i)?"🔇 ":""}${esc(x.label)}</span>` : (k === "v" || k === "shot" || k === "pic") ? `<span class="lbl">${esc(x.label)}</span>` : `<span>${k==="va"&&P.VAUD[x.rel]?.muted?"🔇 ":""}${esc(x.label)}</span>`;
      const handles = k === "shot" && !x.miss ? '<b class="hl" title="拖动设置入点"></b><b class="hr" title="拖动设置出点"></b>' : "";
      return `<div class="${cls}" data-timeline-item="${items.indexOf(x)}" data-i="${x.i ?? ""}" data-kind="${x.kind || ""}" data-rel="${x.rel || ""}" title="${esc(x.label)}" style="${bg}left:${x.t * z}px;width:${Math.max(x.d * z - 2, 8)}px;${x.dim ? "opacity:.55;" : ""}">${inner}${handles}</div>`;
    }).join("")}</div>`;
  }).join("");
  $("tracks").innerHTML = `<div class="ruler" id="ruler" style="width:${W}px">${ruler}</div>${rows}<div class="ph" id="ph" style="left:-20px"></div>`;
  $("tDur").textContent = "本场约 " + fmt(total);
  timelineReviewToolbar();
  // 点击、双击、拖放
  $("tracks").querySelectorAll(".blk,.dia").forEach(b => {
    b.onclick = e => { e.stopPropagation(); if (b.dataset.i !== "") selectLine(+b.dataset.i); else select({ kind: b.dataset.kind, rel: b.dataset.rel || undefined }); };
    if (b.dataset.i !== "") b.ondblclick = () => { setCenter("play"); playFrom(+b.dataset.i); };
  });
  $("ruler").onclick = e => { const t = (e.offsetX + (e.target === $("ruler") ? 0 : e.target.offsetLeft)) / z; const it = items.filter(x => x.i != null && x.tr !== "evt").find(x => t >= x.t && t < x.t + x.d); if (it) playFrom(it.i); };
  // 拖动镜头块两端：设置入点 / 出点
  $("tracks").querySelectorAll(".blk .hl,.blk .hr").forEach(h => h.onmousedown = e => {
    e.stopPropagation(); e.preventDefault();
    const b = h.parentElement, rel = b.dataset.rel, full = dur(rel, 6), tr = P.TRIM[rel] || [0, full], left = h.classList.contains("hl");
    const x0 = e.clientX, w0 = b.offsetWidth, l0 = b.offsetLeft; let a = tr[0] || 0, c = tr[1] || full;
    const mv = ev => {
      const dt = (ev.clientX - x0) / z;
      if (left) { a = Math.min(Math.max(0, (tr[0] || 0) + dt), c - .3); b.style.left = (l0 + (a - (tr[0] || 0)) * z) + "px"; b.style.width = (w0 - (a - (tr[0] || 0)) * z) + "px"; }
      else { c = Math.max(Math.min(full, (tr[1] || full) + dt), a + .3); b.style.width = (w0 + (c - (tr[1] || full)) * z) + "px"; }
      $("tDur").textContent = `剪辑：${a.toFixed(1)} – ${c.toFixed(1)} 秒（共 ${(c - a).toFixed(1)} 秒）`;
    };
    const up = () => { removeEventListener("mousemove", mv); removeEventListener("mouseup", up); setTrim(rel, a, c); };
    addEventListener("mousemove", mv); addEventListener("mouseup", up);
  });
  // 拖素材到块上替换
  $("tracks").querySelectorAll(".blk").forEach(b => {
    const k = b.dataset.kind, i = b.dataset.i;
    let target = null;
    if (k === "scene") target = `vid/${cur}.mp4`;
    else if (i !== "") { const l = n.lines[+i]; if (b.classList.contains("b-pic")) { if (l[0] === "@shot") target = `img/s_${l[1]}.jpg`; else if (isSpoken(l)) { bindLineImgDrop(b, +i); return; } } else if (l[0] === "@shot") target = `vid/${shotVid(l[1])}.mp4`; else if (l[0] !== "@cap") target = ensureVoTarget(+i, true); }
    if (target) bindDropTarget(b, target);
  });
  movePlayhead();
}
$("zoom").oninput = renderTimeline;
// 播放头随时间连续往前走：每句开始时记下这句在时间线上的起点和长度，之后按真实流逝的时间推进（暂停就停）；
// 这一句实际播得比时间线上长（配音更长、等选择），就停在这一块的末尾等下一句，不会跑到下一块里去
let PH = null;
function phPos() {
  if (!PH) return null;
  const e = PH.acc + (PH.run ? (performance.now() - PH.t0) / 1000 : 0);
  return PH.base + Math.max(0, Math.min(e, Math.max(0, PH.dur - 0.04)));
}
function phStart(line) {
  const { items } = schedule(cur), it = items.find(x => x.i === line && x.tr !== "evt");
  PH = it ? { line, base: it.t, dur: it.d || 0, acc: 0, t0: performance.now(), run: !pvPaused } : null;
}
function phPause(p) { if (!PH) return; if (p && PH.run) { PH.acc += (performance.now() - PH.t0) / 1000; PH.run = false; } else if (!p && !PH.run) { PH.t0 = performance.now(); PH.run = true; } }
function movePlayhead() {
  const ph = $("ph"); if (!ph || pvLine == null || !P || !P.N[cur]) return;
  if (!PH || PH.line !== pvLine) phStart(pvLine);
  const { total } = schedule(cur), t = phPos();
  ph.style.left = (t == null ? -20 : t * +$("zoom").value) + "px";
  $("tc").innerHTML = `<b>${fmt(t || 0)}</b> / ${fmt(total)}`;
}
(function phTick() {
  if (PH && PH.run && $("ph")) {
    const ph = $("ph"), t = phPos(), x = t * +$("zoom").value; ph.style.left = x + "px"; const tc = $("tc").querySelector("b"); if (tc) tc.textContent = fmt(t);
    const sc = $("tBody"), hw = ($("tHeads") || {}).offsetWidth || 0;   // 播放头快走出可见范围时，时间线跟着往后滚
    if (sc && !sc.matches(":hover") && (x + hw > sc.scrollLeft + sc.clientWidth - 60 || x + hw < sc.scrollLeft + hw)) sc.scrollLeft = Math.max(0, x - 120);
  }
  requestAnimationFrame(phTick);
})();
function ensureVoTarget(i, peek) {     // 台词对应的配音路径；没有编号时生成一个
  const l = P.N[cur].lines[i], k = voKey(l[1]);
  if (k) return `vo/${k}.mp3`;
  if (peek) return `vo/${cur}_${String(i).padStart(2, "0")}n.mp3`;
  const nk = `${cur}_${String(i).padStart(2, "0")}n`; P.VOT[cleanKey(l[1])] = nk; setDirty(true); return `vo/${nk}.mp3`;
}

/* ============ 场景导航 ============ */
function goScene(id) { if (!P.N[id]) return; cur = id; sel = { kind: "scene" }; pvLine = null; renderAll(false); playFrom(0); }
function renderNav() {
  if (!P || !cur) return; const n = P.N[cur];
  $("sceneCrumb").textContent = `${sceneName(cur)}（${cur}）`;
  $("sceneOuts").innerHTML = outs(n).map(t => `<button data-go="${t}" title="去 ${t}">→ ${esc(P.N[t] ? sceneName(t) : t)}</button>`).join("");
  $("sceneOuts").querySelectorAll("[data-go]").forEach(b => b.onclick = () => goScene(b.dataset.go));
}
function stepScene(d) { const o = flatOrder(), i = o.indexOf(cur); if (o[i + d]) goScene(o[i + d]); }
$("tPrevScene").onclick = () => stepScene(-1); $("tNextScene").onclick = () => stepScene(1);

/* ============ 选择与属性面板 ============ */
function select(s) { sel = s; renderTimeline(); renderProps(); renderBoard(); }
function selectLine(i) { select({ kind: "line", i }); }
function mediaBox(rel, kind, label) {
  const ok = has(rel);
  const view = !ok ? `<div class="drop">缺：${esc(rel)}<br>把素材拖到这里，或点下面的按钮</div>`
    : kind === "video" ? `<video src="${fileUrl(rel)}" controls muted preload="metadata"></video>`
    : kind === "audio" ? `<audio src="${fileUrl(rel)}" controls preload="metadata"></audio>` : `<img src="${fileUrl(rel)}" alt="">`;
  return `<div class="media" data-drop="${esc(rel)}">${view}<div class="row"><span class="chip">${esc(rel)}</span><button class="ghost" data-pick="${esc(rel)}">替换${label}…</button>${ok ? `<button class="ghost" data-reveal="${esc(rel)}">在文件夹中显示</button>` : ""}</div></div>`;
}
function renderProps() {
  const box = $("props"); if (!P || !cur) { box.innerHTML = '<div class="pempty">打开一个项目</div>'; return; }
  const id = cur, n = P.N[id]; let h = "", tab = "场景";
  if (sel.kind === "line" && n.lines[sel.i]) {
    const i = sel.i, l = n.lines[i];
    if (l[0] === "@shot") {
      tab = "镜头";
      h = `<h3>插入镜头 · ${esc(l[1])}</h3><div class="sub">第 ${i + 1} 行 · 双击时间线上的块从这里预览</div>
      <div class="sec"><label>镜头名（对应 img/s_名.jpg 和 vid/s_名.mp4）</label><input id="pShot" value="${esc(l[1])}"></div>
      <div class="sec"><label>关键帧</label>${mediaBox(`img/s_${l[1]}.jpg`, "image", "图片")}</div>
      <div class="sec"><label>视频</label>${mediaBox(`vid/s_${l[1]}.mp4`, "video", "视频")}</div>${clipSection(`vid/s_${l[1]}.mp4`)}`;
    } else if (l[0] === "@cap") {
      tab = "字幕卡";
      h = `<h3>字幕卡</h3><div class="sub">第 ${i + 1} 行 · 画面左上的大字，停约 2.6 秒</div><div class="sec"><label>文字</label><textarea id="pText">${esc(l[1])}</textarea></div>`;
    } else {
      tab = mode === "board" ? "分镜 · 台词" : "台词";
      const rel = ensureVoTarget(i, true), clueHere = Object.keys(n.gainAt || {}).filter(c => n.gainAt[c] === i);
      h = `<h3>台词 · 第 ${i + 1} 行</h3><div class="sub">${esc(sceneName(id))} · 双击时间线上的块从这一句预览</div>${mode === "board" ? boardProps(id, i) : ""}
      <div class="sec"><label>说话的人（留空 = 旁白）</label><input id="pWho" value="${esc(l[0])}" list="speakers"><datalist id="speakers">${[...new Set(Object.values(P.N).flatMap(x => x.lines.map(y => y[0])).filter(x => x && !x.startsWith("@")))].map(x => `<option value="${esc(x)}">`).join("")}</datalist>
        <label style="margin-top:10px">台词</label><textarea id="pText">${esc(l[1])}</textarea>
        ${stale.has(id + ":" + i) ? '<div class="chip warn" style="margin-top:6px">文字改过了，配音还是旧的，需要重录</div>' : ""}</div>
      <div class="sec"><label>配音</label>${isSilent(l[1]) ? '<div class="hint">这一句是停顿，不需要配音</div>' : mediaBox(rel, "audio", "配音")}</div>
      <div class="sec"><label>这一句拿到的线索</label><select id="pClue"><option value="">（无）</option>${Object.entries(P.CLUES).map(([c, t]) => `<option value="${c}"${clueHere.includes(c) ? " selected" : ""}>${esc(c)} · ${esc(t.slice(0, 22))}</option>`).join("")}</select></div>`;
    }
    h += `<div class="sec row"><button class="ghost" id="pUp">上移</button><button class="ghost" id="pDown">下移</button><button class="ghost danger" id="pDel">删除这一行</button></div>`;
  } else if (sel.kind === "end") {
    tab = "结局";
    h = `<h3>结局 · ${esc(n.end)}</h3><div class="sub">${esc(id)}</div>
      <div class="sec"><label>结局名</label><input id="pEnd" value="${esc(n.end)}"></div>
      <div class="sec"><label>结局判词（结局卡上的两行字）</label><textarea id="pQuote">${esc(n.quote || "")}</textarea></div>
      <div class="sec"><label>尾声（一行一句，黑底字幕，不配音）</label><textarea id="pEpi" style="min-height:150px">${esc((n.epi || []).join("\n"))}</textarea></div>`;
  } else if (sel.kind === "choice" || sel.kind === "lock") {
    const ids = Object.keys(P.N), opt = v => ids.map(x => `<option value="${x}"${x === v ? " selected" : ""}>${esc(sceneName(x))}（${x}）</option>`).join("");
    tab = n.lock ? "密码锁" : "选项";
    if (n.lock) h = `<h3>密码锁</h3><div class="sub">${esc(sceneName(id))} 的结尾</div>
      <div class="sec"><label>答案（几位数字就是几个转轮）</label><input id="pAns" value="${esc(n.lock.answer)}"><label style="margin-top:10px">能试几次</label><input id="pTries" type="number" min="1" value="${n.lock.tries}"></div>
      <div class="sec"><label>打开后去</label><select id="pOk">${opt(n.lock.ok)}</select><label style="margin-top:10px">次数用完后去</label><select id="pFail">${opt(n.lock.fail)}</select></div>`;
    else h = `<h3>选项</h3><div class="sub">${esc(sceneName(id))} 的结尾 · 只有一个选项时游戏会直接点击继续</div>
      <div class="sec"><label>选项文字 · 去向 · 需要的线索（可空）</label>${n.choices.map((c, k) => `<div class="choice-it"><input data-ct="${k}" value="${esc(c.t)}"><select data-cto="${k}">${opt(c.to)}</select><button class="icon" data-cdel="${k}" title="删除">✕</button>
        <select class="if" data-cif="${k}"><option value="">不需要线索</option>${Object.keys(P.CLUES).map(x => `<option${x === c.if ? " selected" : ""}>${x}</option>`).join("")}</select></div>`).join("")}
        <button class="ghost" id="pCAdd">＋ 加一个选项</button></div>
      <div class="sec"><label>限时（秒，0 = 不限时）</label><input id="pTimer" type="number" min="0" value="${n.timer || 0}">
        <label style="margin-top:10px">超时默认选第几个</label><select id="pDef">${n.choices.map((c, k) => `<option value="${k}"${(n.def || 0) === k ? " selected" : ""}>${k + 1}. ${esc(c.t)}</option>`).join("")}</select>
        <label style="margin-top:10px"><input type="checkbox" id="pKey" style="width:auto"${n.key ? " checked" : ""}> 标记为“影响深远的选项”</label></div>`;
  } else if (sel.kind === "va" && sel.rel) {
    tab = "原声";
    h = `<h3>原声</h3><div class="sub">来自 ${esc(sel.rel)} · 跟随视频剪辑点</div>${vaSection(sel.rel)}`;
  } else if (sel.kind === "mus" || sel.kind === "amb") {
    tab = "音频";
    const isM = sel.kind === "mus", list = isM ? MUSIC : AMBS, v = (isM ? P.BGM : P.AMB)[id] || "", rel = v ? `${isM ? "bgm" : "amb"}/${isM ? v : "amb_" + v}.mp3` : null;
    h = `<h3>${isM ? "音乐" : "环境声"}</h3><div class="sub">${esc(sceneName(id))} · 整场循环播放，切场景时交叉淡入</div>
      <div class="sec"><label>${isM ? "曲目" : "环境声"}</label><select id="pAud">${list.map(m => `<option value="${m}"${m === v ? " selected" : ""}>${m || (isM ? "（沿用上一场）" : "（无）")}</option>`).join("")}</select></div>
      ${rel ? `<div class="sec"><label>文件</label>${mediaBox(rel, "audio", "音频")}</div>` : ""}`;
  } else {
    const iss = issues(id), t = schedule(id).total;
    h = `<h3>${esc(sceneName(id))}</h3><div class="sub">${esc(id)} · ${n.lines.length} 行 · 约 ${fmt(t)}</div>
      <div>${iss.length ? iss.map(x => `<span class="chip ${x[0] === "b" ? "bad" : "warn"}">${esc(x[1])}</span>`).join("") : '<span class="chip ok">素材齐全</span>'}</div>
      ${n.end ? "" : `<div class="sec"><label>场景标题</label><input id="pTitle" value="${esc(n.title || "")}" placeholder="${esc(id)}"></div>`}
      <div class="sec"><label>场景视频</label>${mediaBox(`vid/${id}.mp4`, "video", "视频")}</div>${clipSection(`vid/${id}.mp4`)}
      <div class="sec"><label>关键帧（视频没加载时先显示）</label>${mediaBox(`img/${id}.jpg`, "image", "图片")}</div>
      <div class="sec"><label>画面提示词（交给出图用）</label><textarea id="pImg">${esc(n.img || "")}</textarea></div>
      <div class="sec row"><span class="dim">去向：</span>${outs(n).map(o => `<button class="ghost" data-go="${o}">${esc(P.N[o] ? sceneName(o) : o)}</button>`).join("") || '<span class="dim">（结局）</span>'}</div>`;
  }
  box.innerHTML = `<div class="ptabs"><span>${tab}</span></div><div class="pbody">${h}</div>`;
  bindProps(id, n); bindClip(); bindBoardProps(id, n);
}
/* ---------- 剪辑与音画分离 ---------- */
function clipSection(rel) {
  if (!has(rel)) return "";
  const full = dur(rel, 6), tr = P.TRIM[rel], a = tr ? tr[0] : 0, b = tr ? tr[1] : +full.toFixed(2);
  return `<div class="sec clip" data-clip="${esc(rel)}"><label>剪辑（只播放其中一段，原文件不动）</label>
    <video class="cv" src="${fileUrl(rel)}" controls muted preload="metadata"></video>
    <div class="trimrow"><span>入点</span><input class="tIn" type="number" step="0.1" min="0" value="${a}"><span>出点</span><input class="tOut" type="number" step="0.1" min="0" value="${b}"><span class="dim">秒</span></div>
    <div class="row"><button class="ghost tSetIn">当前画面设为入点</button><button class="ghost tSetOut">当前画面设为出点</button>${tr ? '<button class="ghost tReset">恢复完整</button>' : ""}</div>
    <div class="hint">原长 ${full.toFixed(1)} 秒${tr ? `，现在只播 ${a}–${b} 秒（共 ${(b - a).toFixed(1)} 秒）` : "，现在播放完整视频"}。也可以在时间线上拖镜头块的两端。</div></div>
    ${vaSection(rel)}`;
}
function vaSection(rel) {
  const a = P.VAUD[rel];
  if (!a?.file) return `<div class="sec"><label>${P.files[rel]?.hasAudio ? "视频自带原声" : "音画分离"}</label><div class="row"><button class="ghost vaDo" data-rel="${esc(rel)}">分离音频</button></div>
    <div class="hint">带音轨的视频会自动显示在「原声」轨，可右键静音。分离后可单独试听、调音量或替换。</div></div>`;
  return `<div class="sec"><label>音画分离 · 已分离</label>${has(a.file) ? `<audio src="${fileUrl(a.file)}" controls preload="metadata"></audio>` : `<div class="chip bad">缺：${esc(a.file)}</div>`}
    <div class="trimrow"><span>音量</span><input class="vaVol" data-rel="${esc(rel)}" type="range" min="0" max="1" step="0.05" value="${a.vol ?? 1}" style="flex:1"><span class="dim">${Math.round((a.vol ?? 1) * 100)}%</span></div>
    <div class="row"><span class="chip">${esc(a.file)}</span><button class="ghost" data-pick="${esc(a.file)}">替换声音…</button><button class="ghost danger vaDel" data-rel="${esc(rel)}">取消分离</button></div>
    <div class="hint">取消分离后恢复播放视频自带的声音（分离出来的文件保留在 sfx 文件夹里）。</div></div>`;
}
let warnedClip = false;
function needEngine() { if (!P.hasClip && !warnedClip) { warnedClip = true; toast("提示：这个游戏的 index.html 是旧版，播放时不认剪辑和原声。请更新游戏文件后再预览。", true); } }
function setTrim(rel, a, b) {
  const full = dur(rel, 6); a = Math.max(0, +(+a).toFixed(2)); b = Math.min(full, +(+b).toFixed(2));
  if (!(b > a + .25)) return toast("出点要比入点晚至少 0.3 秒", true);
  needEngine();
  edit(() => { if (a <= .05 && b >= full - .05) delete P.TRIM[rel]; else P.TRIM[rel] = [a, b]; });
  reloadPreview();
}
function bindClip() {
  document.querySelectorAll("#props .clip").forEach(box => {
    const rel = box.dataset.clip, v = box.querySelector(".cv"), iIn = box.querySelector(".tIn"), iOut = box.querySelector(".tOut");
    iIn.onchange = iOut.onchange = () => setTrim(rel, iIn.value, iOut.value);
    box.querySelector(".tSetIn").onclick = () => setTrim(rel, v.currentTime, iOut.value);
    box.querySelector(".tSetOut").onclick = () => setTrim(rel, iIn.value, v.currentTime);
    const r = box.querySelector(".tReset"); if (r) r.onclick = () => { edit(() => delete P.TRIM[rel]); reloadPreview(); };
    v.onloadedmetadata = () => { try { v.currentTime = +iIn.value || 0; } catch {} };
  });
  document.querySelectorAll("#props .vaDo").forEach(b => b.onclick = () => detachAudio(b.dataset.rel));
  document.querySelectorAll("#props .vaDel").forEach(b => b.onclick = () => { edit(() => delete P.VAUD[b.dataset.rel]); reloadPreview(); });
  document.querySelectorAll("#props .vaVol").forEach(x => x.onchange = () => { edit(() => P.VAUD[x.dataset.rel].vol = +x.value); reloadPreview(); });
}
function wavBytes(ab) {
  const ch = Math.min(2, ab.numberOfChannels), sr = ab.sampleRate, n = ab.length, out = new DataView(new ArrayBuffer(44 + n * ch * 2));
  const w = (o, s) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF"); out.setUint32(4, 36 + n * ch * 2, true); w(8, "WAVEfmt "); out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, ch, true);
  out.setUint32(24, sr, true); out.setUint32(28, sr * ch * 2, true); out.setUint16(32, ch * 2, true); out.setUint16(34, 16, true); w(36, "data"); out.setUint32(40, n * ch * 2, true);
  const data = [...Array(ch)].map((_, c) => ab.getChannelData(c)); let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) { const v = Math.max(-1, Math.min(1, data[c][i])); out.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true); o += 2; }
  return new Uint8Array(out.buffer);
}
async function detachAudio(rel) {
  try {
    toast("正在分离音频…");
    const bytes = await S.readAsset(P.dir, rel);
    let ab; const ctx = new AudioContext();
    try { ab = await ctx.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)); } catch { ctx.close(); return toast("这个视频没有声音轨（AI 生成的视频一般没有声音）", true); }
    ctx.close();
    let peak = 0; for (let c = 0; c < ab.numberOfChannels; c++) { const d = ab.getChannelData(c); for (let i = 0; i < d.length; i += 64) peak = Math.max(peak, Math.abs(d[i])); }
    if (peak < .002) return toast("这个视频的声音是空的，不用分离", true);
    const base = rel.split("/").pop().replace(/\.\w+$/, ""), out = `sfx/va_${base}.wav`;
    await S.writeAsset(P.dir, out, wavBytes(ab)); await refreshFiles(); needEngine();
    edit(() => P.VAUD[rel] = { file: out, vol: 1 });
    select({ kind: "va", rel }); showExtractedAudioLibrary(); toastAct(`已分离到本地音频素材：${out}，原视频改为静音`, "查看分离音频", showExtractedAudioLibrary); reloadPreview();
  } catch (e) { toast("分离失败：" + e.message, true); }
}
function bindProps(id, n) {
  const box = $("props"), on = (x, ev, fn) => { const e = $(x); if (e) e[ev] = fn; };
  box.querySelectorAll("[data-pick]").forEach(b => b.onclick = () => { if (b.dataset.pick.startsWith("vo/") && sel.kind === "line") ensureVoTarget(sel.i); pickReplace(b.dataset.pick); });
  box.querySelectorAll("[data-reveal]").forEach(b => b.onclick = () => S.reveal(absPath(b.dataset.reveal)));
  box.querySelectorAll("[data-drop]").forEach(el => bindDropTarget(el, el.dataset.drop));
  box.querySelectorAll("[data-go]").forEach(b => b.onclick = () => goScene(b.dataset.go));
  const i = sel.i, l = sel.kind === "line" ? n.lines[i] : null;
  on("pTitle", "onchange", e => edit(() => { const v = e.target.value.trim(); if (v) n.title = v; else delete n.title; }));
  on("pImg", "onchange", e => edit(() => n.img = e.target.value));
  on("pWho", "onchange", e => edit(() => l[0] = e.target.value.trim()));
  on("pText", "onchange", e => {
    const old = l[1], nt = e.target.value.trim(); if (old === nt) return;
    edit(() => {
      if (l[0] !== "@cap") { const k = voKey(old); if (k) { delete P.VOT[cleanKey(old)]; P.VOT[cleanKey(nt)] = k; stale.add(id + ":" + i); } }
      l[1] = nt;
    });
  });
  on("pShot", "onchange", e => edit(() => { l[1] = e.target.value.trim(); if (!P.SHOTS.includes(l[1])) P.SHOTS.push(l[1]); }));
  on("pClue", "onchange", e => edit(() => {
    n.gainAt = n.gainAt || {}; n.gain = n.gain || [];
    for (const c in n.gainAt) if (n.gainAt[c] === i) { delete n.gainAt[c]; n.gain = n.gain.filter(x => x !== c); }
    const c = e.target.value; if (c) { n.gainAt[c] = i; if (!n.gain.includes(c)) n.gain.push(c); }
    if (!Object.keys(n.gainAt).length) delete n.gainAt; if (!n.gain.length) delete n.gain;
  }));
  on("pUp", "onclick", () => moveLine(-1)); on("pDown", "onclick", () => moveLine(1)); on("pDel", "onclick", delLine);
  on("pEnd", "onchange", e => edit(() => n.end = e.target.value.trim() || n.end));
  on("pQuote", "onchange", e => edit(() => n.quote = e.target.value));
  on("pEpi", "onchange", e => edit(() => n.epi = e.target.value.split("\n").map(s => s.trim()).filter(Boolean)));
  on("pAns", "onchange", e => edit(() => n.lock.answer = e.target.value.replace(/\D/g, "") || n.lock.answer));
  on("pTries", "onchange", e => edit(() => n.lock.tries = Math.max(1, +e.target.value || 3)));
  on("pOk", "onchange", e => edit(() => n.lock.ok = e.target.value)); on("pFail", "onchange", e => edit(() => n.lock.fail = e.target.value));
  box.querySelectorAll("[data-ct]").forEach(x => x.onchange = () => edit(() => n.choices[+x.dataset.ct].t = x.value));
  box.querySelectorAll("[data-cto]").forEach(x => x.onchange = () => edit(() => n.choices[+x.dataset.cto].to = x.value));
  box.querySelectorAll("[data-cif]").forEach(x => x.onchange = () => edit(() => { const c = n.choices[+x.dataset.cif]; if (x.value) c.if = x.value; else delete c.if; }));
  box.querySelectorAll("[data-cdel]").forEach(x => x.onclick = () => { if (n.choices.length <= 1) return toast("至少要留一个选项"); edit(() => n.choices.splice(+x.dataset.cdel, 1)); });
  on("pCAdd", "onclick", () => edit(() => n.choices.push({ t: "新选项", to: id })));
  on("pTimer", "onchange", e => edit(() => { const v = +e.target.value; if (v > 0) { n.timer = v; n.def = n.def || 0; } else { delete n.timer; } }));
  on("pDef", "onchange", e => edit(() => n.def = +e.target.value));
  on("pKey", "onchange", e => edit(() => { if (e.target.checked) n.key = 1; else delete n.key; }));
  on("pAud", "onchange", e => edit(() => { const tgt = sel.kind === "mus" ? P.BGM : P.AMB; if (e.target.value) tgt[id] = e.target.value; else delete tgt[id]; }));
}

/* ============ 时间线编辑 ============ */
function shiftGain(n, a, b) { if (n.gainAt) for (const c in n.gainAt) { if (n.gainAt[c] === a) n.gainAt[c] = b; else if (n.gainAt[c] === b) n.gainAt[c] = a; } }
function bump(n, from, d) { if (n.gainAt) for (const c in n.gainAt) if (n.gainAt[c] >= from) n.gainAt[c] += d; }
function moveStale(id, a, b) { const ka = id + ":" + a, kb = id + ":" + b, A = stale.has(ka), B = stale.has(kb); stale.delete(ka); stale.delete(kb); if (A) stale.add(kb); if (B) stale.add(ka); }
function moveLine(d) {
  const n = P.N[cur], i = sel.i, j = i + d; if (sel.kind !== "line" || j < 0 || j >= n.lines.length) return;
  edit(() => { [n.lines[i], n.lines[j]] = [n.lines[j], n.lines[i]]; shiftGain(n, i, j); moveStale(cur, i, j); sel.i = j; });
}
function delLine() {
  const n = P.N[cur]; if (sel.kind !== "line") return toast("先在时间线上选中一行");
  const i = sel.i; edit(() => { n.lines.splice(i, 1); if (n.gainAt) for (const c in n.gainAt) { if (n.gainAt[c] === i) { delete n.gainAt[c]; n.gain = (n.gain || []).filter(x => x !== c); } else if (n.gainAt[c] > i) n.gainAt[c]--; } stale.delete(cur + ":" + i); sel = { kind: "scene" }; });
}
function insertLine(line) {
  const n = P.N[cur], at = sel.kind === "line" ? sel.i + 1 : n.lines.length;
  edit(() => { n.lines.splice(at, 0, line); bump(n, at, 1); sel = { kind: "line", i: at }; });
}
$("tAddLine").onclick = () => { const n = P.N[cur], prev = sel.kind === "line" ? n.lines[sel.i] : null; insertLine([prev && prev[0] && !prev[0].startsWith("@") ? prev[0] : "", "（新台词）"]); };
$("tAddShot").onclick = async () => { const nm = await askLine("新镜头的名字（英文或拼音，用来找 img/s_名.jpg 和 vid/s_名.mp4）", "shot" + (Date.now() % 1000)); if (!nm) return; if (!/^[\w-]+$/.test(nm)) return toast("镜头名只能用英文、数字、下划线", true); insertLine(["@shot", nm]); if (!P.SHOTS.includes(nm)) P.SHOTS.push(nm); };
$("tAddCap").onclick = () => insertLine(["@cap", "时间 · 地点"]);
$("tDel").onclick = delLine; $("tUndo").onclick = undo; $("tRedo").onclick = redo;

/* ============ 预览 ============ */
function cluesBefore(id) {
  const prev = {}; Object.keys(P.N).forEach(a => outs(P.N[a]).forEach(b => (prev[b] = prev[b] || []).push(a)));
  const seen = new Set([id]), qq = [id], cl = new Set();
  while (qq.length) { const x = qq.shift(); (prev[x] || []).forEach(p => { if (!seen.has(p)) { seen.add(p); qq.push(p); (P.N[p].gain || []).forEach(c => cl.add(c)); } }); }
  return [...cl];
}
let pvLoaded = false;
function playFrom(line) {
  if (!P || !cur) return;
  if (RV || document.querySelector(".modal")) { pvCmd("pause"); pvLoaded = false; return; }   // 审阅页、对话框开着时不自动开播（不然后台一直放音乐）；关掉后点播放再重新加载
  setPausedUI(false); const clues = $("allClues").checked ? cluesBefore(cur) : [];
  if (!pvLoaded) { $("pv").src = fileUrl("index.html") + `&embed=1&jump=${encodeURIComponent(cur)}&line=${line}&clues=${clues.join(",")}` + stillParam(); return; }
  try { $("pv").contentWindow.postMessage({ src: "editor", cmd: "jump", node: cur, line, clues }, "*"); } catch { pvLoaded = false; playFrom(line); }
}
function reloadPreview() { pvLoaded = false; playFrom(sel && sel.kind === "line" ? sel.i : 0); }
$("pv").onload = () => { pvLoaded = $("pv").src.includes("index.html"); };
let pvPaused = false;
function pvCmd(cmd) { try { $("pv").contentWindow.postMessage({ src: "editor", cmd }, "*"); } catch {} }
function togglePause() { if (!pvLoaded) return playFrom(sel && sel.kind === "line" ? sel.i : 0); pvCmd(pvPaused ? "resume" : "pause"); }
function setPausedUI(p) {
  pvPaused = p; $("pPlay").textContent = p ? "▶" : "❚❚"; $("pPlay").title = p ? "继续（空格）" : "暂停（空格）";
  $("pvWhere").classList.toggle("paused", p);
}
$("pPlay").onclick = togglePause;
$("pRestart").onclick = () => playFrom(0);
$("pPrevLine").onclick = () => playFrom(Math.max(0, (pvLine ?? 0) - 1));
$("pNextLine").onclick = () => { const n = P.N[cur]; playFrom(Math.min(n.lines.length - 1, (pvLine ?? -1) + 1)); };
$("allClues").onchange = () => reloadPreview();
// 图片模式：预览里不播视频，只放分镜图（像幻灯片）；插入镜头停留的秒数取视频分镜表的 duration
// 草稿模式：所有视频换成 vid_draft/ 里的草稿（draft_video.py 出的），先用草稿把剧情过一遍，再花钱生成正式视频
// 审阅页顶部的批量工具收进「🛠 工具 ▾」下拉菜单：这一页没有可用的工具就把按钮藏起来，菜单标题显示有几项
function rvToolsSync() {
  if (!RV || !RV.el) return; const items = [...RV.el.querySelectorAll("#rvMenu .rvmi")].filter(b => !b.hidden), tb = RV.el.querySelector("#rvToolsBtn");
  if (tb) { tb.hidden = !items.length; tb.textContent = `🛠 工具（${items.length}）▾`; }
}
function stillParam() {
  const m = $("pvMode").value;
  if (m === "draft") return "&draft=1";
  if (m !== "still") return "";
  const sd = VS() ? VS().shots.filter(s => !P.N[s.id]).map(s => `${s.id}:${s.duration || 6}`).join(",") : "";
  return `&still=1&sdur=${encodeURIComponent(sd)}`;
}
try { $("pvMode").value = localStorage.getItem("studio_pvmode") || (localStorage.getItem("studio_still") === "1" ? "still" : "video"); } catch {}
$("pvMode").onchange = () => { const m = $("pvMode").value; try { localStorage.setItem("studio_pvmode", m); } catch {} reloadPreview();
  toast({ still: "图片模式：预览不播视频，只放分镜图，一张张过剧情", draft: `草稿模式：视频换成草稿（现在有 ${Object.keys(P.files).filter(f => f.startsWith("vid_draft/")).length} 条；没有草稿的定格）`, video: "视频模式：播正式视频" }[m]); };
window.addEventListener("message", e => {
  const d = e.data || {};
  const scene = P?.N[d.node];
  if (d.src !== "moban" || !scene) return;
  $("pvWhere").textContent = `${d.paused ? "已暂停 · " : ""}${sceneName(d.node)} · 第 ${d.line + 1} 行`;
  const wasPaused = pvPaused;
  setPausedUI(!!d.paused);
  if (d.node !== cur) {
    cur = d.node;
    sel = { kind: "scene" };
    pvLine = null;
    PH = null;
    renderAll(false);
  } else if (PH?.line === d.line) {
    phPause(!!d.paused);
  }
  // 暂停时自动选中正在播的那一句，右边直接改
  if (d.paused && !wasPaused && scene.lines[d.line]) selectLine(d.line);
  if (d.node === cur) {
    if (pvLine !== d.line || !PH || PH.line !== d.line) { pvLine = d.line; phStart(d.line); } document.querySelectorAll(".blk.cur").forEach(x => x.classList.remove("cur"));
    document.querySelectorAll(`.blk[data-i="${d.line}"]`).forEach(x => x.classList.add("cur")); movePlayhead();
    document.querySelectorAll(".scard.cur").forEach(x => x.classList.remove("cur")); document.querySelectorAll(`.scard[data-i="${d.line}"]`).forEach(x => x.classList.add("cur"));
  }
});

/* ============ 故事板模式 ============ */
const SPEAKER_REF = { "穿貂的女人": "refs/char_woman.png", "你": "refs/char_driver.png", "大军": "refs/char_dajun.png", "狗皮帽小伙": "refs/char_dajun.png", "民警": "refs/char_police.png" };
function renderModes() {
  document.querySelectorAll(".modes button").forEach(b => b.setAttribute("aria-selected", b.dataset.mode === mode));
  document.querySelectorAll(".ctabs button").forEach(b => b.setAttribute("aria-selected", b.dataset.ct === centerTab));
  document.querySelector(".player").classList.toggle("show-board", centerTab === "board");
}
function setMode(m) { if (m === mode) return; mode = m; try { localStorage.setItem("studio_mode", m); } catch {} centerTab = m === "board" ? "board" : "play"; renderAll(false); toast(m === "board" ? "故事板模式：一句一张图，先把剧情和画面定下来" : "视频模式：场景视频、插入镜头、剪辑和原声"); }
function setCenter(t) { centerTab = t; renderModes(); if (t === "board") renderBoard(); }
document.querySelectorAll(".modes button").forEach(b => b.onclick = () => setMode(b.dataset.mode));
document.querySelectorAll(".ctabs button").forEach(b => b.onclick = () => setCenter(b.dataset.ct));

function statusTag(im) {
  if (!im || !has(limgRel(im))) return ["fb", "沿用场景图"];
  const st = sbState(im);
  if (!st) return ["manual", "自选图"];
  return ({ pass: ["pass", "✓ 通过质检"], best: ["best", "⚠ 需人看"], manual: ["manual", "人工确认"], reuse: ["reuse", "沿用插图"], local: ["manual", "本地替换"] })[st.status] || ["none", "未质检"];
}
function renderBoard() {
  const b = $("board"); if (!P || !cur || !b) return;
  const n = P.N[cur]; let have = 0, total = 0;
  const cards = n.lines.map((l, i) => {
    const selc = sel && sel.kind === "line" && sel.i === i ? " sel" : "", curc = pvLine === i ? " cur" : "";
    if (l[0] === "@cap") return `<div class="scard${selc}${curc}" data-i="${i}"><div class="th capcard">${esc(l[1])}</div><span class="no">${i + 1}</span><div class="tx"><small>字幕卡</small></div></div>`;
    if (l[0] === "@shot") { const r = `img/s_${l[1]}.jpg`; return `<div class="scard${selc}${curc}" data-i="${i}" data-shot="${esc(l[1])}"><div class="th" ${has(r) ? `style="background-image:url('${fileUrl(r)}')"` : ""}>${has(r) ? "" : "缺插入镜头图"}</div><span class="no">${i + 1}</span><span class="tag reuse">插入镜头</span><div class="tx"><small>${esc(l[1])}${has(`vid/s_${l[1]}.mp4`) ? " · 有视频" : ""}</small></div></div>`; }
    total++; const im = limgOf(cur, i), ok = im && has(limgRel(im)); if (ok) have++;
    const [tc, tt] = statusTag(im), shot = shotOf(im), st = sbState(im);
    const issues = st && st.status === "best" ? ((st.refine && st.refine.length ? st.refine[st.refine.length - 1].issues : (st.tries || []).filter(t => t.file).slice(-1)[0]?.issues) || []) : [];
    return `<div class="scard${selc}${curc}" data-i="${i}" title="${esc(issues.join("\n") || (shot ? shot.desc : ""))}">
      <div class="th${ok ? "" : " fallback"}" style="background-image:url('${fileUrl(ok ? limgRel(im) : `img/${cur}.jpg`)}')"></div>
      <span class="no">${i + 1}</span><span class="tag ${tc}">${tt}</span>${im && (upFlags(shotId(im), "prompt").length || upFlags(shotId(im), "img").length) ? '<span class="tag best upq" title="上游（台词 / 提示词 / 参考图）改过，这一张要复查">↑ 上游改过</span>' : ""}${ok && SB() ? `<button class="fbquick" data-fix="${i}" title="审图 · 框选修图">✎ 修图</button>` : ""}
      <div class="tx"><b>${esc(l[0] || "旁白")}</b>${esc(l[1])}${shot ? `<small>${esc(shot.shot || "")} · ${esc(shot.layout || shot.desc || "")}</small>` : ""}</div></div>`;
  });
  if (n.choices && !(n.choices.length === 1 && !n.timer)) cards.push(`<div class="scard" data-kind="choice"><div class="th capcard">${n.choices.map(c => "◇ " + esc(c.t)).join("<br>")}</div><div class="tx"><small>${n.timer ? `限时 ${n.timer} 秒 · ` : ""}选择</small></div></div>`);
  if (n.lock) cards.push(`<div class="scard" data-kind="lock"><div class="th" style="background-image:url('${fileUrl(`img/${cur}.jpg`)}')"></div><div class="tx"><small>密码锁 · ${n.lock.answer.length} 位</small></div></div>`);
  if (n.end) cards.push(`<div class="scard" data-kind="end"><div class="th capcard">【${esc(n.end)}】<br><small>${esc((n.epi || []).slice(0, 2).join(" "))}</small></div><div class="tx"><small>尾声 ${(n.epi || []).length} 句 · 结局卡</small></div></div>`);
  const sb = SB(), pct = total ? Math.round(have / total * 100) : 100;
  b.innerHTML = `<div class="bhead"><h3>${esc(sceneName(cur))}</h3><span class="dim">${have} / ${total} 句有分镜图</span><div class="prog"><i style="width:${pct}%"></i></div>
    ${sb ? `<button class="ghost" id="bDrawMissing" ${have === total ? "disabled" : ""}>给缺图的句子出图</button><button class="ghost" id="bFixAll">整场检查并自动修</button><button class="ghost" id="bReview">审阅本场</button>` : '<span class="hint">没找到 storyboard\\shotlist.json，AI 出图不可用</span>'}</div>
    <div class="sgrid">${cards.join("")}</div>`;
  b.querySelectorAll(".scard[data-i]").forEach(c => {
    const i = +c.dataset.i, l = n.lines[i];
    c.onclick = () => selectLine(i);
    c.ondblclick = () => { setCenter("play"); playFrom(i); };
    if (isSpoken(l)) bindLineImgDrop(c, i); else if (l[0] === "@shot") bindDropTarget(c, `img/s_${l[1]}.jpg`);
  });
  b.querySelectorAll(".scard[data-kind]").forEach(c => c.onclick = () => select({ kind: c.dataset.kind }));
  b.querySelectorAll("[data-fix]").forEach(x => { x.onclick = e => { e.stopPropagation(); const k = +x.dataset.fix; selectLine(k); openFixBox(k); }; x.ondblclick = e => e.stopPropagation(); });
  const dm = $("bDrawMissing"); if (dm) dm.onclick = () => drawMissing();
  const fa = $("bFixAll"); if (fa) fa.onclick = () => fixScene();
  const br = $("bReview"); if (br) br.onclick = () => openReview("scene", "all");
}

/* ---------- 给一句话配图 ---------- */
function pinImage(i, nid = cur) {        // 确保这一句有图名（没有就起一个），返回 "l/xxx"
  const l = P.N[nid].lines[i]; let im = limgOf(nid, i);
  if (!im || !(l[2] && l[2].img)) { im = im || newImgId(nid, i); const v = im; edit(() => { l[2] = { ...(l[2] || {}), img: v }; }); }
  return im;
}
function bindLineImgDrop(el, i) {
  el.addEventListener("dragover", e => { e.preventDefault(); el.classList.add("over"); });
  el.addEventListener("dragleave", () => el.classList.remove("over"));
  el.addEventListener("drop", e => {
    e.preventDefault(); e.stopPropagation(); el.classList.remove("over");
    const rel = e.dataTransfer.getData("text/x-studio-rel"); const src = rel ? absPath(rel) : e.dataTransfer.files[0] ? S.filePath(e.dataTransfer.files[0]) : null;
    if (src) setLineImage(i, src);
  });
}
async function setLineImage(i, srcAbs) { const im = pinImage(i); await replaceWith(limgRel(im), srcAbs); renderBoard(); }
async function pickLineImage(i) { try { const p = await S.pickAsset("image"); if (p && p[0]) setLineImage(i, p[0]); } catch (e) { toast(e.message, true); } }

/* ---------- 分镜表：每一句的画面要求 ---------- */
async function ensureShot(i, nid = cur, desc) {   // 分镜表里没有这一句就自动建一条（之后可以在右边改）
  const sb = SB(); if (!sb) throw new Error("没有分镜工作区");
  const l = P.N[nid].lines[i], im = pinImage(i, nid), id = shotId(im);
  if (sb.shots.find(x => x.id === id)) return id;
  const refs = [SPEAKER_REF[l[0]]].filter(Boolean);
  P.sb = await S.sbSaveShot(P.dir, { id, node: nid, line: i, shot: "近景", in_frame: l[0] || "", speaker_in_frame: "是", location: "", desc: desc || `${l[0] || "旁白"}说：「${l[1]}」时的画面`, layout: "", refs, note: "剪辑台新建，请补充画面描述和构图" });
  return id;
}
function boardProps(id, i) {
  const l = P.N[id].lines[i], im = limgOf(id, i), ok = im && has(limgRel(im)), sb = SB(), shot = shotOf(im), st = sbState(im), [tc, tt] = statusTag(im);
  const last = st ? (st.refine && st.refine.length ? st.refine[st.refine.length - 1] : (st.tries || []).filter(t => t.file).slice(-1)[0]) : null;
  let h = `<div class="sec"><label>分镜画面 <span class="tag ${tc}" style="border-radius:3px;padding:0 6px;margin-left:6px">${tt}</span></label>
    <div class="media" data-limgdrop="${i}">${ok ? `<img src="${fileUrl(limgRel(im))}" alt="">` : `<div class="drop">这一句还没有分镜图，播放时沿用场景图<br>把图片拖到这里，或用下面的按钮</div>`}
    <div class="row">${ok ? `<span class="chip">${esc(limgRel(im))}</span>` : ""}<button class="ghost" data-limgpick="${i}">${ok ? "换图…" : "选择图片…"}</button>${ok ? `<button class="ghost" data-reveal="${esc(limgRel(im))}">在文件夹中显示</button>` : ""}</div></div>`;
  if (sb && ok) h += `<button class="pri fbopen" id="sbBox" title="在图上框出要改的地方，写一句怎么改（快捷键 Ctrl+Shift+F）">✎ 审图 · 框选修图…</button>`;
  if (sb) h += `<div class="aibtns"><button id="sbEdit" ${ok ? "" : "disabled"} title="写一句修改意见，AI 在这张图上只改那里">AI 按意见修改…</button><button id="sbAuto" title="AI 逐项检查，局部问题就地修改，结构问题重画">AI 检查并自动修</button>
      <button id="sbSketch" title="用鼠标画简单的构图（可以让 AI 整理成 SVG），存成构图图，出图时一起参考">✎ 手绘构图…</button><button id="sbRedraw" title="按分镜表要求整张重画（最多 3 次，挑通过的那张）">重画这一张</button><button class="ghost" id="sbClear" ${l[2] && l[2].img ? "" : "disabled"} title="这一句不单独配图，沿用场景图（图片文件保留）">不用分镜图</button>
      ${ok && st && st.status !== "pass" && st.status !== "manual" ? `<button class="ghost" id="sbApprove" title="质检判没通过，但你看过觉得可以：直接标成人工确认">这张没问题，标记人工确认</button>` : ""}</div>`;
  else h += `<div class="hint" style="margin-top:6px">没找到分镜工作区（游戏文件夹旁边的 storyboard\\shotlist.json），AI 按钮不可用</div>`;
  h += `</div>`;
  if (last && last.issues && last.issues.length) h += `<div class="sec"><label>上次质检发现的问题（${last.score ?? "-"}/10）</label><ul class="qc">${last.issues.map(x => `<li>${esc(x)}</li>`).join("")}</ul></div>`;
  if (sb) {
    if (shot) h += `<div class="sec"><label>分镜要求（出图和质检都按这个来）</label>
      <div class="trimrow" style="gap:6px"><span class="dim">景别</span><input data-sf="shot" value="${esc(shot.shot || "")}" style="flex:1"><span class="dim">画面里</span><input data-sf="in_frame" value="${esc(shot.in_frame || "")}" style="flex:2"></div>
      <label style="margin-top:8px">构图（按画面方向写：谁在左、谁在右、机位）</label><textarea data-sf="layout">${esc(shot.layout || "")}</textarea>
      <label style="margin-top:8px">画面描述</label><textarea data-sf="desc">${esc(shot.desc || "")}</textarea>
      <label style="margin-top:8px">参考图（最多 5 张）</label><div class="reflist">${sb.refs.map(r => `<label class="${(shot.refs || []).includes(r) ? "on" : ""}"><input type="checkbox" data-ref="${esc(r)}" ${(shot.refs || []).includes(r) ? "checked" : ""}><img src="${fileUrl("../" + r)}" alt=""><span>${esc(r.split("/").pop().replace(/\.\w+$/, ""))}</span></label>`).join("")}</div></div>`;
    else h += `<div class="sec"><label>分镜要求</label><div class="hint">分镜表里还没有这一句。</div><div class="row"><button class="ghost" id="sbAddShot">加进分镜表</button></div></div>`;
  }
  return h;
}
function bindBoardProps(id, n) {
  if (mode !== "board" || !sel || sel.kind !== "line") return;
  const i = sel.i, l = n.lines[i]; if (!isSpoken(l)) return;
  const box = $("props"), on = (x, fn) => { const e = $(x); if (e) e.onclick = fn; };
  box.querySelectorAll("[data-limgdrop]").forEach(el => bindLineImgDrop(el, i));
  box.querySelectorAll("[data-limgpick]").forEach(b => b.onclick = () => pickLineImage(i));
  on("sbClear", () => edit(() => { l[2] = { img: "" }; }));
  on("sbAddShot", async () => { try { await ensureShot(i); toast("已加进分镜表，请补充构图和画面描述"); renderProps(); } catch (e) { toast(e.message, true); } });
  on("sbAuto", async () => { try { const sid = await ensureShot(i); runTool("refine.py", [sid], `AI 检查并自动修 · ${sid}`); } catch (e) { toast(e.message, true); } });
  on("sbBox", () => openFixBox(i));
  on("sbSketch", async () => { try { const sid = await ensureShot(i); openSketch(sid, "comp"); } catch (e) { toast(e.message, true); } });
  on("sbApprove", () => { const sid = shotId(limgOf(id, i)); runTool("fix_box.py", ["approve", sid], `标记人工确认 · ${sid}`); });
  on("sbRedraw", async () => { try { const sid = await ensureShot(i); runTool("batch.py", [sid], `重画 · ${sid}`); } catch (e) { toast(e.message, true); } });
  on("sbEdit", async () => {
    const r = await askText("AI 按意见修改", "写清楚要改哪里，例如：去掉车窗外的楼房，换成雪夜松林；把司机挪到画面右侧", "质检没通过也换进游戏（你看过觉得可以时勾选）");
    if (!r || !r.text) return;
    try { const sid = await ensureShot(i); runTool("refine.py", [sid, r.text, ...(r.force ? ["--force"] : [])], `AI 按意见修改 · ${sid}`); } catch (e) { toast(e.message, true); }
  });
  const im = limgOf(id, i), shot = shotOf(im);
  if (shot) {
    box.querySelectorAll("[data-sf]").forEach(x => x.onchange = async () => { try { P.sb = await S.sbSaveShot(P.dir, { id: shot.id, [x.dataset.sf]: x.value.trim() }); toast("已保存到分镜表"); } catch (e) { toast(e.message, true); } });
    box.querySelectorAll(".reflist img").forEach(im => { im.title = "单击勾选，双击放大"; im.onclick = e => { e.preventDefault(); const cb = im.closest("label").querySelector("input"); delayClick(() => cb.click()); }; });
    box.querySelectorAll("[data-ref]").forEach(x => x.onchange = async () => {
      let refs = [...box.querySelectorAll("[data-ref]:checked")].map(c => c.dataset.ref);
      if (refs.length > 5) { x.checked = false; return toast("参考图最多 5 张（出图模型一次能带的上限）", true); }
      try { P.sb = await S.sbSaveShot(P.dir, { id: shot.id, refs }); x.parentElement.classList.toggle("on", x.checked); } catch (e) { toast(e.message, true); }
    });
  }
}
// 不用浏览器自带的 alert / confirm / prompt：Electron 在 Windows 上弹过这类框之后，输入框常常再也打不了字（要切到别的窗口再切回来才恢复）；
// prompt 在 Electron 里根本不支持。确认用 S.confirm（主进程的对话框），输入用下面这个。
function askLine(title, val = "") {
  return new Promise(res => {
    const m = document.createElement("div"); m.className = "modal";
    m.innerHTML = `<div class="mbox" style="width:min(460px,92vw)"><h3>${esc(title)}</h3><input id="alT" value="${esc(val)}"><div class="row" style="justify-content:flex-end;margin-top:12px"><button class="ghost" id="alC">取消</button><button class="pri" id="alO">确定</button></div></div>`;
    document.body.appendChild(m); const t = m.querySelector("#alT"); t.focus(); t.select();
    const done = v => { m.remove(); res(v); };
    m.querySelector("#alC").onclick = () => done(null); m.querySelector("#alO").onclick = () => done(t.value.trim());
    t.onkeydown = e => { if (e.key === "Enter") done(t.value.trim()); else if (e.key === "Escape") { e.stopPropagation(); done(null); } };
  });
}
function askText(title, ph, checkLabel) {
  return new Promise(res => {
    const m = document.createElement("div"); m.className = "modal";
    m.innerHTML = `<div class="mbox" style="width:min(560px,92vw)"><h3>${esc(title)}</h3><textarea id="atT" style="min-height:90px" placeholder="${esc(ph)}"></textarea>
      ${checkLabel ? `<label style="display:flex;gap:6px;align-items:center;margin-top:8px"><input type="checkbox" id="atF" style="width:auto">${esc(checkLabel)}</label>` : ""}
      <div class="row" style="justify-content:flex-end;margin-top:12px"><button class="ghost" id="atC">取消</button><button class="pri" id="atO">开始</button></div></div>`;
    document.body.appendChild(m); m.querySelector("#atT").focus();
    const done = v => { m.remove(); res(v); };
    m.querySelector("#atC").onclick = () => done(null);
    m.querySelector("#atO").onclick = () => done({ text: m.querySelector("#atT").value.trim(), force: !!(m.querySelector("#atF") || {}).checked });
  });
}
async function drawMissing() {
  const n = P.N[cur], ids = [];
  try { for (let i = 0; i < n.lines.length; i++) { const l = n.lines[i]; if (!isSpoken(l)) continue; const im = limgOf(cur, i); if (im && has(limgRel(im))) continue; ids.push(await ensureShot(i)); } }
  catch (e) { return toast(e.message, true); }
  if (!ids.length) return toast("这一场每句都有图了");
  runTool("batch.py", ids, `给 ${sceneName(cur)} 出图 · ${ids.length} 张`);
}
function fixScene() {
  const n = P.N[cur], ids = n.lines.map((l, i) => isSpoken(l) ? limgOf(cur, i) : null).filter(im => im && has(limgRel(im)) && shotOf(im) && (sbState(im) || {}).status !== "pass").map(shotId);
  if (!ids.length) return toast("这一场的分镜图都通过质检了（或者还没有图，先点「给缺图的句子出图」）");
  runTool("refine.py", ids, `检查并自动修 · ${sceneName(cur)} · ${ids.length} 张`);
}

/* ---------- 审图 · 框选修图：框出要改的地方，写一句怎么改，只改框里（调用 storyboard\fix_box.py） ---------- */
let fixUI = null;
const b64 = s => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
/* ---------- @ 点名参考图：修图意见里输入 @，从参考图库里选一张，修改时把它一起发给 AI ---------- */
const mentionPool = () => REFS().filter(r => r.exists).map(r => ({ id: r.id, name: r.name || r.id, kind: r.kind, path: refRel(r.id) }));
function mentionedRefs(text) {               // 文字里 @ 了哪些参考图（按名称或 id，长的优先匹配）
  const out = []; let t = String(text || "");
  const keys = mentionPool().flatMap(r => [[r.name, r], [r.id, r]]).sort((x, y) => y[0].length - x[0].length);
  for (const [key, r] of keys) if (t.includes("@" + key)) { if (!out.some(x => x.id === r.id)) out.push(r); t = t.split("@" + key).join(""); }
  return out;
}
function attachMention(ta) {
  let box = null, start = -1, sel = 0, list = [];
  const close = () => { if (box) box.remove(); box = null; start = -1; };
  const pick = r => {
    const v = ta.value, end = ta.selectionStart; ta.value = v.slice(0, start) + "@" + r.name + " " + v.slice(end);
    const c = start + r.name.length + 2; close(); ta.focus(); ta.setSelectionRange(c, c); ta.dispatchEvent(new Event("input"));
  };
  const render = () => {
    if (!list.length || !ta.isConnected) return close();
    if (!box) { box = document.createElement("div"); box.className = "mention"; document.body.appendChild(box); }
    box.innerHTML = list.map((r, k) => `<button data-k="${k}" class="${k === sel ? "on" : ""}"><img src="${fileUrl("../" + r.path)}" alt=""><span>${esc(r.name)}</span><small>${KIND_CN[r.kind] || ""}</small></button>`).join("") + '<div class="mhint">↑↓ 选择 · Enter 插入 · Esc 取消</div>';
    const rc = ta.getBoundingClientRect(), w = Math.max(rc.width, 260);
    Object.assign(box.style, { left: Math.min(rc.left, innerWidth - w - 8) + "px", width: w + "px" });
    box.style.top = (rc.bottom + 4 + box.offsetHeight > innerHeight - 8 ? Math.max(8, rc.top - 4 - box.offsetHeight) : rc.bottom + 4) + "px";
    box.querySelectorAll("button").forEach(b => b.onmousedown = e => { e.preventDefault(); pick(list[+b.dataset.k]); });
  };
  ta.addEventListener("input", () => {
    const c = ta.selectionStart, m = ta.value.slice(0, c).match(/@([^\s@，。；,;：:]*)$/);
    if (!m) return close();
    start = c - m[0].length; const q = m[1].toLowerCase();
    list = mentionPool().filter(r => !q || r.name.toLowerCase().includes(q) || r.id.toLowerCase().includes(q)).slice(0, 8); sel = 0; render();
  });
  ta.addEventListener("keydown", e => {
    if (!box) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); sel = (sel + (e.key === "ArrowDown" ? 1 : -1) + list.length) % list.length; render(); }
    else if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pick(list[sel]); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
  });
  ta.addEventListener("blur", () => setTimeout(close, 150));
  // 输入框被重新渲染掉（比如框选了新的框）时 blur 不一定触发，弹出的 @ 列表会一直浮在右侧栏上，挡住下面的输入框、点了也进不去：发现输入框没了就关掉
  const watch = setInterval(() => { if (!ta.isConnected) { close(); clearInterval(watch); } }, 500);
}

function openFixBox(i, nid = cur, imOv) {
  const im = imOv || limgOf(nid, i); if (!im || !has(limgRel(im))) return toast("这一句还没有分镜图", true);
  const sid = shotId(im), l = P.N[nid].lines[i], shot = shotOf(im), st = sbState(im);
  const last = st ? (st.refine && st.refine.length ? st.refine[st.refine.length - 1] : (st.tries || []).filter(t => t.file).slice(-1)[0]) : null;
  const [tc, tt] = statusTag(im);
  const m = document.createElement("div"); m.className = "modal fbx";
  m.innerHTML = `<div class="fbbox" role="dialog" aria-label="审图 · 框选修图">
    <div class="fbhead"><b>审图 · 框选修图</b><span class="chip">${esc(sid)}</span><span class="tag ${tc}">${tt}</span>
      <span class="dim fbline">${esc(l[0] || "旁白")}：${esc(l[1])}</span><span class="grow"></span>
      <span class="fbseg" id="fbSeg" hidden><button data-v="old">修改前</button><button data-v="new" class="on">修改后</button><button data-v="diff" hidden title="和裁切图相比被 AI 改掉的地方：没变的压暗，变了的红线圈出">变化处</button></span>
      <button class="icon" id="fbX" title="关闭（Esc）">✕</button></div>
    <div class="fbwork">
      <div class="fbstage" id="fbStage"><div class="fbwrap" id="fbWrap"><img id="fbImg" alt="" draggable="false" data-nozoom></div></div>
      <div class="fbside">
        ${last && last.issues && last.issues.length ? `<div class="fbqc"><label>质检发现的问题（${last.score ?? "-"}/10）</label><ul class="qc">${last.issues.map(x => `<li>${esc(x)}</li>`).join("")}</ul></div>` : ""}
        ${shot ? `<div class="fbreq"><label>分镜要求</label><div class="dim">${esc(shot.shot || "")} · ${esc(shot.in_frame || "")}</div><div class="dim">${esc(shot.layout || shot.desc || "")}</div></div>` : ""}
        <div class="fbtool" id="fbTool"><span class="fbseg"><button data-v="rect" class="on" title="拖出矩形框（R）">▭ 矩形框</button><button data-v="lasso" title="按住鼠标沿着轮廓画一圈，松开自动闭合（L）">套索 · 自由选区</button></span></div>
        <div class="hint" id="fbHint"></div>
        <div id="fbItems" class="fbitems"></div>
        <div id="fbRefs" class="fbrefs"></div>
        <div class="fbmode" id="fbMode">
          <label><input type="radio" name="fbm" value="patch" checked><span><b>只改框里，框外不动</b><small>换颜色、盖掉字、换花纹、去掉多余的东西……只把框里贴回原图，框外一个像素不变</small></span></label>
          <label><input type="radio" name="fbm" value="whole"><span><b>要加东西或改形状</b><small>箱子里加金子、给人戴上帽子……整张交给 AI，衔接更自然，框外可能有细微变化</small></span></label>
          <label><input type="radio" name="fbm" value="crop"><span><b>裁切后 AI 重画（拉近、改景别）</b><small>拖一个 16:9 的框选取景范围，AI 照着重画成高清，内容不变；会标出被改掉的地方</small></span></label>
        </div>
        <button class="pri" id="fbGo" disabled>修改框里的内容</button>
        <div id="fbAfter" class="fbcol" hidden>
          <button class="pri" id="fbOk">采用这张，换进游戏</button>
          <button class="ghost" id="fbMore">在这张基础上继续改</button>
          <button class="ghost" id="fbDrop">不要，回到修改前</button>
        </div>
        <div class="grow"></div>
        <button class="ghost" id="fbApprove" ${st && (st.status === "pass" || st.status === "manual") ? "disabled" : ""} title="不改图，直接把这张标成人工确认（质检判没通过、但你看过觉得可以时用）">这张没问题，标记人工确认</button>
        <div id="fbMsg" class="fbmsg"></div>
      </div>
    </div></div>`;
  document.body.appendChild(m);
  const U = fixUI = { tool: "rect", sid, i, nid, im, m, src: "", srcUrl: fileUrl(limgRel(im)), cand: null, boxes: [], busy: false, log: "", view: "new" };
  const q = s => m.querySelector(s), img = q("#fbImg"), wrap = q("#fbWrap");
  const show = url => { img.src = url; };
  const modeOf = () => (q("input[name=fbm]:checked") || {}).value || "patch";
  // 每个框一种颜色（和 fix_box.py 的 PALETTE 顺序一致）：好几处一起改时，发给 AI 的位置图里也用这些颜色和编号对上各自的意见
  const BOXC = [["红", "#ff0000"], ["蓝", "#005aff"], ["绿", "#00c83c"], ["黄", "#ffd200"], ["紫", "#be00ff"], ["青", "#00d2dc"]], boxc = k => BOXC[k % BOXC.length];
  const HINT = { patch: "在图上按住鼠标拖出方框（或用套索沿着轮廓圈出来），再写一句怎么改；要去掉东西，点框下面的「把框里的东西去掉」。可以框好几处，每个框自动换一种颜色，各写各的意见，点一次「开始修改」一起改（离得近的几处一次交给 AI，远的分开）。画好的框可以拖动、拖右下角改大小。然后在下面选修改方式。",
    whole: "在图上按住鼠标拖出方框，框住要加东西或改形状的地方，再写一句怎么改。可以框好几处，每个框一种颜色，一次一起改。",
    crop: "在图上拖出新的取景范围（自动保持 16:9，只能一个框）。按住框可以拖动位置，拖右下角的小方块改大小，方向键微调；在框外重新拖会替换。框外压暗的部分会被裁掉，留下的部分由 AI 重画成高清。补充要求可以不写。" };
  show(U.srcUrl);
  function draw() {
    wrap.querySelectorAll(".fbr").forEach(e => e.remove());
    document.querySelectorAll(".mention").forEach(x => x.remove());   // 右侧栏要重画，旧的 @ 列表先收掉
    const crop = modeOf() === "crop"; wrap.classList.toggle("cropping", crop && !U.cand); q("#fbHint").textContent = HINT[modeOf()];
    if (!U.cand) U.boxes.forEach((b, k) => { const d = document.createElement("div"); d.className = "fbr fbm" + (crop ? " crop" : "") + (b.lp ? " lasso" : "") + (U.sel === k ? " sel" : ""); d.dataset.k = k; if (!crop) { d.style.setProperty("--bc", boxc(k)[1]); if ([3, 5].includes(k % BOXC.length)) d.style.setProperty("--bt", "#000"); } d.title = U.busy ? "" : "按住拖动可以移动；拖右下角的小方块改大小；选中后可以用方向键微调（Shift 加快）"; Object.assign(d.style, { left: b.fx * 100 + "%", top: b.fy * 100 + "%", width: b.fw * 100 + "%", height: b.fh * 100 + "%" }); d.innerHTML = `${b.lp ? `<svg viewBox="0 0 1 1" preserveAspectRatio="none"><polygon points="${b.lp.map(p => p.join(",")).join(" ")}"/></svg>` : ""}<b>${k + 1}</b>${U.busy ? "" : '<i class="fbh"></i>'}`; wrap.appendChild(d); });
    q("#fbTool").hidden = crop || !!U.cand; q("#fbTool").querySelectorAll("button").forEach(x => x.classList.toggle("on", x.dataset.v === U.tool));
    const it = q("#fbItems"); it.innerHTML = "";
    U.boxes.forEach((b, k) => {
      const d = document.createElement("div"); d.className = "fbitem"; if (!crop) d.style.setProperty("--bc", boxc(k)[1]);
      d.innerHTML = `<div class="fbih"><span>${crop ? `取景范围（拉近 ${(1 / b.fw).toFixed(1)} 倍）` : `<i class="fbdot"></i>${boxc(k)[0]}色${b.lp ? "选区" : "框"} ${k + 1}`}</span><button class="icon fbdelbox" title="删掉这个框">✕</button></div><textarea placeholder="${crop ? "可以不写。比如：女人的表情保持不变，手套上的毛要清楚" : "比如：把钞票换成 @第四套人民币 的样子，灰蓝色，不要粉红色"}（输入 @ 点名参考图）" ${U.cand || U.busy ? "disabled" : ""}></textarea>`;
      if (!crop && !U.cand) { const qk = document.createElement("div"); qk.className = "fbquick"; qk.innerHTML = '<span class="dim">常用：</span><button class="fbchip" title="填好修改意见，并切到「只改框里」（框外一个像素不变）">把框里的东西去掉</button>'; d.appendChild(qk); }
      const t = d.querySelector("textarea"); t.value = b.text; t.oninput = () => { b.text = t.value; upd(); }; attachMention(t);
      d.querySelector(".fbdelbox").onclick = () => { if (U.busy || U.cand) return; U.boxes.splice(k, 1); U.sel = null; draw(); };
      const er = d.querySelector(".fbchip"); if (er) er.onclick = () => {
        if (U.busy || U.cand) return;
        b.text = "去掉框里的东西，用周围的背景自然补上：光线、颜色、颗粒感、景深都和周围一致，看不出修过的痕迹"; t.value = b.text;
        if (modeOf() !== "patch") { q('input[name=fbm][value="patch"]').checked = true; msg("去掉东西用「只改框里」：只把框里贴回原图，框外一个像素不变，不会顺手改动别处"); }
        draw();
      };
      it.appendChild(d);
    });
    upd();
  }
  function fbRefs() {                        // 会一起发给 AI 的参考图：@ 点名的在前，再加分镜表里这个镜头的参考图（最多 6 张，和 fix_box.py 一致）
    const named = []; U.boxes.forEach(b => mentionedRefs(b.text).forEach(r => { if (!named.some(x => x.id === r.id)) named.push(r); }));
    const own = ((shot && shot.refs) || []).filter(p => !named.some(x => x.path === p)).map(p => ({ path: p, name: (refById(p.split("/").pop().replace(/\.\w+$/, "")) || {}).name || p.split("/").pop().replace(/\.\w+$/, "") }));
    return { named, all: [...named.map(r => ({ ...r, at: true })), ...own].slice(0, 6) };
  }
  function upd() {
    const crop = modeOf() === "crop";
    const fr = fbRefs(), el = q("#fbRefs");
    el.innerHTML = fr.all.length ? `<label>会一起发给 AI 的参考图（在修改意见里输入 @ 可以点名更多）</label><div class="fbrefl">${fr.all.map(r => `<span class="fbref${r.at ? " at" : ""}" title="${r.at ? "修改意见里 @ 点名的" : "分镜表里这个镜头的参考图"}"><img src="${fileUrl("../" + r.path)}" data-zoom="参考图 · ${esc(r.name)}" alt=""><i>${r.at ? "@" : ""}${esc(r.name)}</i></span>`).join("")}</div>` : "";
    q("#fbGo").textContent = crop ? "裁切并让 AI 重画（约 $0.14）" : "修改框里的内容";
    q("#fbGo").disabled = !(U.boxes.length && (crop || U.boxes.every(b => b.text.trim())) && !U.cand && !U.busy); q("#fbGo").hidden = q("#fbMode").hidden = !!U.cand; q("#fbMode").querySelectorAll("input").forEach(x => x.disabled = U.busy); }
  let dg = null, mv = null;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const place = (k, b) => { const el = wrap.querySelector(`.fbr[data-k="${k}"]`); if (el) Object.assign(el.style, { left: b.fx * 100 + "%", top: b.fy * 100 + "%", width: b.fw * 100 + "%", height: b.fh * 100 + "%" }); };
  function moveBox(k, b0, dx, dy, resize) {  // 移动或改大小；裁切框保持 16:9（比例上宽高相等），最小 15%
    const b = U.boxes[k], crop = modeOf() === "crop";
    if (resize) {
      if (crop) { const s = clamp(b0.fw + (Math.abs(dx) > Math.abs(dy) ? dx : dy), 0.15, Math.min(1 - b0.fx, 1 - b0.fy)); b.fw = b.fh = s; }
      else { b.fw = clamp(b0.fw + dx, 0.01, 1 - b0.fx); b.fh = clamp(b0.fh + dy, 0.01, 1 - b0.fy); }
    } else { b.fx = clamp(b0.fx + dx, 0, 1 - b0.fw); b.fy = clamp(b0.fy + dy, 0, 1 - b0.fh); }
    place(k, b);
  }
  wrap.addEventListener("pointerdown", e => {
    if (U.busy || U.cand || e.button !== 0) return;
    const hit = e.target.closest && e.target.closest(".fbr[data-k]");
    if (hit) {                                 // 点在已有的框上：拖动它，不新画一个
      const k = +hit.dataset.k; U.sel = k; wrap.querySelectorAll(".fbr[data-k]").forEach(x => x.classList.toggle("sel", +x.dataset.k === k));
      mv = { k, r: img.getBoundingClientRect(), x0: e.clientX, y0: e.clientY, b0: { ...U.boxes[k] }, resize: !!e.target.closest(".fbh") };
      wrap.setPointerCapture(e.pointerId); e.preventDefault(); return;
    }
    const r = img.getBoundingClientRect();
    if (U.tool === "lasso" && modeOf() !== "crop") {   // 套索：按住沿轮廓画，松开自动闭合
      const el = document.createElement("div"); el.className = "fblive"; el.innerHTML = '<svg viewBox="0 0 1 1" preserveAspectRatio="none"><polyline points=""/></svg>'; wrap.appendChild(el);
      dg = { lasso: true, r, el, pts: [[(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height]] }; wrap.setPointerCapture(e.pointerId); return;
    }
    dg = { x: e.clientX - r.left, y: e.clientY - r.top, r, el: document.createElement("div") };
    dg.el.className = "fbr live" + (modeOf() === "crop" ? " crop" : ""); wrap.appendChild(dg.el); wrap.setPointerCapture(e.pointerId);
  });
  wrap.addEventListener("pointermove", e => {
    if (mv) { moveBox(mv.k, mv.b0, (e.clientX - mv.x0) / mv.r.width, (e.clientY - mv.y0) / mv.r.height, mv.resize); return; }
    if (dg && dg.lasso) {
      const r = dg.r, p = [Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), Math.max(0, Math.min(1, (e.clientY - r.top) / r.height))], l = dg.pts[dg.pts.length - 1];
      if (Math.hypot((p[0] - l[0]) * r.width, (p[1] - l[1]) * r.height) > 3) { dg.pts.push(p); dg.el.querySelector("polyline").setAttribute("points", dg.pts.map(q => q.join(",")).join(" ")); }
      return;
    }
    if (!dg) return; const r = dg.r, x = Math.max(0, Math.min(e.clientX - r.left, r.width)), y = Math.max(0, Math.min(e.clientY - r.top, r.height));
    dg.b = { fx: Math.min(x, dg.x) / r.width, fy: Math.min(y, dg.y) / r.height, fw: Math.abs(x - dg.x) / r.width, fh: Math.abs(y - dg.y) / r.height };
    if (modeOf() === "crop") {   // 画面本身是 16:9，比例上宽高相等就是 16:9；往拖动方向延伸，不超出画面
      const sx = x >= dg.x ? 1 : -1, sy = y >= dg.y ? 1 : -1, ox = dg.x / r.width, oy = dg.y / r.height;
      const lim = Math.min(sx > 0 ? 1 - ox : ox, sy > 0 ? 1 - oy : oy), s = Math.min(Math.max(dg.b.fw, dg.b.fh), lim);
      dg.b = { fx: sx > 0 ? ox : ox - s, fy: sy > 0 ? oy : oy - s, fw: s, fh: s };
    }
    Object.assign(dg.el.style, { left: dg.b.fx * 100 + "%", top: dg.b.fy * 100 + "%", width: dg.b.fw * 100 + "%", height: dg.b.fh * 100 + "%" });
  });
  wrap.addEventListener("pointercancel", () => { if (dg) { dg.el.remove(); dg = null; } if (mv) { mv = null; draw(); } });   // 被系统打断（触控板手势、切窗口）时收掉画了一半的框
  wrap.addEventListener("pointerup", () => {
    if (mv) { mv = null; draw(); return; }
    if (dg && dg.lasso) {
      const d = dg; dg = null; d.el.remove();
      const xs = d.pts.map(p => p[0]), ys = d.pts.map(p => p[1]), fx = Math.min(...xs), fy = Math.min(...ys), fw = Math.max(...xs) - fx, fh = Math.max(...ys) - fy;
      if (d.pts.length < 4 || fw * img.clientWidth < 10 || fh * img.clientHeight < 10) return msg("圈得太小了，按住鼠标沿着轮廓画一圈", true);
      const step = Math.max(1, Math.floor(d.pts.length / 120)), pts = d.pts.filter((_, j) => j % step === 0);   // 点太多就抽稀
      U.boxes.push({ fx, fy, fw, fh, lp: pts.map(([x, y]) => [+((x - fx) / fw).toFixed(4), +((y - fy) / fh).toFixed(4)]), text: "" });
      U.sel = U.boxes.length - 1; msg(""); draw(); const ts = q("#fbItems").querySelectorAll("textarea"); ts[ts.length - 1].focus(); return;
    }
    if (!dg) return; const b = dg.b; dg.el.remove(); dg = null;
    if (b && modeOf() === "crop" && b.fw < 0.15) { msg("取景框太小了（拉近超过 6 倍画质撑不住），请拖大一点", true); return; }
    if (b && b.fw * img.clientWidth > 8 && b.fh * img.clientHeight > 8) { if (modeOf() === "crop") U.boxes = []; U.boxes.push({ ...b, text: "" }); U.sel = U.boxes.length - 1; draw(); const ts = q("#fbItems").querySelectorAll("textarea"); ts[ts.length - 1].focus(); }
  });
  const msg = (t, err) => { const e = q("#fbMsg"); e.textContent = t; e.classList.toggle("err", !!err); };
  q("#fbTool").querySelectorAll("button").forEach(b => b.onclick = () => { U.tool = b.dataset.v; draw(); });
  q("#fbMode").querySelectorAll("input").forEach(x => x.onchange = () => {
    if (modeOf() === "crop" && U.boxes.length) {   // 切到裁切：只留最后一个框，改成 16:9
      const b = U.boxes[U.boxes.length - 1], s = Math.max(0.15, Math.min(1, Math.max(b.fw, b.fh)));
      U.tool = "rect"; U.boxes = [{ fx: Math.min(Math.max(0, b.fx + b.fw / 2 - s / 2), 1 - s), fy: Math.min(Math.max(0, b.fy + b.fh / 2 - s / 2), 1 - s), fw: s, fh: s, text: "" }];
    }
    msg(""); draw();
  });
  const setView = v => { U.view = v; show(v === "old" ? (U.oldUrl || U.srcUrl) : v === "diff" ? U.diffUrl : U.candUrl); q("#fbSeg").querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset.v === v)); };
  q("#fbSeg").querySelectorAll("button").forEach(b => b.onclick = () => setView(b.dataset.v));
  U.close = async () => { if (U.closing) return; if (U.busy) { U.closing = true; const r = await S.confirm("修改还在进行中。关掉窗口后会继续在后台跑完，好了会弹出提示，可以一键打开对比、采用。确定关闭？", ["关闭（后台继续）", "不关"]).catch(() => 1); U.closing = false; if (r !== 0 || !m.isConnected) return; } m.remove(); document.removeEventListener("keydown", U.key); if (U.busy) U.detached = true; if (fixUI === U) fixUI = null; };
  U.key = e => {
    if (e.target.matches("textarea,input")) return;
    if (e.key === "Escape") return U.close();
    if (!e.ctrlKey && !e.metaKey && !U.busy && !U.cand && modeOf() !== "crop" && /^[rl]$/i.test(e.key)) { U.tool = e.key.toLowerCase() === "l" ? "lasso" : "rect"; draw(); return; }
    const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (d && !U.busy && !U.cand && U.boxes[U.sel]) { e.preventDefault(); const st = e.shiftKey ? 0.05 : 0.005, b0 = { ...U.boxes[U.sel] }; moveBox(U.sel, b0, d[0] * st, d[1] * st, false); }
  };
  document.addEventListener("keydown", U.key);
  q("#fbX").onclick = U.close;
  q("#fbGo").onclick = async () => {
    const boxes = U.boxes.map(b => ({ fx: +b.fx.toFixed(5), fy: +b.fy.toFixed(5), fw: +b.fw.toFixed(5), fh: +b.fh.toFixed(5), text: b.text.trim(), ...(b.lp && modeOf() !== "crop" ? { poly: b.lp.map(([x, y]) => [+(b.fx + x * b.fw).toFixed(5), +(b.fy + y * b.fh).toFixed(5)]) } : {}) }));
    const mode = (q("input[name=fbm]:checked") || {}).value || "patch";
    const refs = fbRefs().named.map(r => ({ path: r.path, name: r.name }));
    U.busy = true; U.log = ""; U.task = "edit"; U.mode = mode; draw();
    msg(mode === "crop" ? "AI 正在按裁切范围重画高清版，大约 30～90 秒…" : mode === "whole" ? `整张交给 AI 修改 ${boxes.length} 处，大约 30～60 秒…` : `AI 正在修改 ${boxes.length} 处，每处大约 30～60 秒…`);
    if (!await runTool("fix_box.py", ["edit", sid, b64(JSON.stringify({ src: U.src, mode, boxes, refs }))], `框选修图 · ${sid}`, { kind: "fix", U })) { U.busy = false; draw(); msg("没能启动修改任务", true); }
  };
  q("#fbOk").onclick = async () => { U.busy = true; U.task = "accept"; msg("正在换进游戏…"); if (!await runTool("fix_box.py", ["accept", sid, U.cand], `采用修改 · ${sid}`, { kind: "fix", U })) U.busy = false; };
  const resetCand = () => { U.oldUrl = U.diffUrl = null; q('#fbSeg button[data-v="diff"]').hidden = true; };
  q("#fbMore").onclick = () => { resetCand(); U.src = U.cand; U.srcUrl = U.candUrl; U.cand = null; U.boxes = []; q("#fbAfter").hidden = true; q("#fbSeg").hidden = true; show(U.srcUrl); draw(); msg("在修改后的图上继续框选（还没换进游戏）"); };
  q("#fbDrop").onclick = () => { resetCand(); U.cand = null; q("#fbAfter").hidden = true; q("#fbSeg").hidden = true; show(U.srcUrl); draw(); msg(""); };
  q("#fbApprove").onclick = async () => { U.busy = true; U.task = "approve"; msg("正在标记…"); if (!await runTool("fix_box.py", ["approve", sid], `标记人工确认 · ${sid}`, { kind: "fix", U })) U.busy = false; };
  U.msg = msg; U.draw = draw; U.show = show; U.q = q; U.setView = setView;
  draw();
}
function reopenFix(old) {                    // 重新打开修图窗口，直接显示后台修好的结果
  if (fixUI) return toast("先关掉正在用的修图窗口", true);
  openFixBox(old.i, old.nid, old.im); const U = fixUI; if (!U || U.sid !== old.sid) return;
  Object.assign(U, { src: old.src, srcUrl: old.srcUrl, mode: old.mode, log: old.log, task: "edit", busy: false });
  const r = U.q(`input[name=fbm][value="${old.mode}"]`); if (r) r.checked = true;
  fixDone(0);
}
function fixLog(t, U = fixUI) {
  if (!U) return; U.log += t;
  const lines = U.log.split(/\r?\n/).filter(Boolean), lastL = lines[lines.length - 1] || "";
  if (!U.detached && U.task === "edit" && !/^(RESULT|ERROR|INFO):/.test(lastL)) U.msg("AI 正在修改…\n" + lastL.slice(0, 120));
}
function fixDone(code, U = fixUI) {
  if (!U) return; const res = (U.log.match(/RESULT:(\S+)/) || [])[1], err = (U.log.match(/ERROR:(.+)/) || [])[1];
  if (U.detached) {                             // 修图窗口已经关了：结果记成候选，提示里可以一键打开对比、采用
    if (fixUI === U) fixUI = null;
    if (!res || U.task !== "edit") return toast(res ? `${U.sid} 已处理` : `框选修图结束：${err || "看一下日志"}`, !res);
    return toastAct(`${U.sid} 修好了（还没换进游戏）。也可以在审阅页这张图的「其他候选」里找到`, "打开对比、采用", () => reopenFix(U));
  }
  if (U.task === "edit") {
    if (code !== 0 || !res) { U.draw(); U.msg("× " + (err || "修改失败，看一下右下角的日志"), true); return; }
    const crop = (U.log.match(/CROP:(\S+)/) || [])[1], diff = (U.log.match(/DIFF:(\S+)/) || [])[1];
    U.cand = res; U.candUrl = fileUrl("../" + res); U.oldUrl = crop ? fileUrl("../" + crop) : null; U.diffUrl = diff ? fileUrl("../" + diff) : null;
    U.q('#fbSeg button[data-v="diff"]').hidden = !diff;
    U.q("#fbAfter").hidden = false; U.q("#fbSeg").hidden = false; U.setView("new"); U.draw();
    const info = [...U.log.matchAll(/INFO:(.+)/g)].map(x => x[1]).join("\n");
    U.msg(U.mode === "crop" ? "重画好了。「修改前」是直接放大的裁切图，「修改后」是 AI 重画的高清版，「变化处」标出 AI 改掉的地方（重点看脸、手、文字道具）。满意就采用。\n" + info
      : "改好了。用上面的「修改前 / 修改后」切换对比，满意就采用。" + (U.mode === "whole" ? "\n" + (info || "整张由 AI 重新输出，请留意框外有没有被改动。") : ""));
  } else if (U.task === "accept" || U.task === "approve") {
    if (code !== 0) { U.msg("× " + (err || "没成功，看一下日志"), true); return; }
    toast(U.task === "accept" ? `已换进游戏：${U.sid}（原图还留在 storyboard\\out 里）` : `${U.sid} 已标记为人工确认`);
    U.busy = false; U.close();
  }
}

/* ---------- 放大查看（双击图片） ---------- */
let thumbClickT = null;                         // 能单击增减的缩略图：单击稍等一下，确认不是双击
function delayClick(fn) { clearTimeout(thumbClickT); thumbClickT = setTimeout(() => { thumbClickT = null; fn(); }, 260); }
function zoomCap(x) {
  if (x.dataset.zoom) return x.dataset.zoom;
  const box = x.closest("button,label,figure"), t = box && box.querySelector("span,figcaption");
  return (t && t.textContent) || x.alt || "";
}
document.addEventListener("dblclick", e => {    // 剪辑台里任何一张图，双击都能放大（同一张卡片里的图可以 ← → 翻看）
  const im = e.target && e.target.closest && e.target.closest("img");
  if (!im || !im.src || im.closest(".lbx, .lib, .timeline") || "nozoom" in im.dataset) return;   // 素材库、时间线保留原来的双击（预览 / 从这句开始播）
  e.preventDefault(); clearTimeout(thumbClickT); thumbClickT = null;
  const scope = im.closest(".rvcard, .mbox, .scard, .media, .sec, #props") || document.body;
  const imgs = [...scope.querySelectorAll("img")].filter(x => x.src && !("nozoom" in x.dataset) && x.offsetParent !== null && x.naturalWidth);
  if (!imgs.includes(im)) imgs.unshift(im);
  openLightbox(imgs.map(x => ({ src: x.src, cap: zoomCap(x) })), imgs.indexOf(im));
});
/* ---------- 图片右键菜单：复制图片 / 复制路径 / 在文件夹中显示 / 另存为 ---------- */
async function copyImg(src) { try { await S.copyImage(src); toast("图片已复制，可以直接粘贴到微信、文档或修图软件里"); } catch (e) { toast(e.message, true); } }
function imgMenu(e, src, reviewTarget) {
  e.preventDefault(); e.stopPropagation();
  document.querySelectorAll(".ctxmenu").forEach(x => x.remove());
  const m = document.createElement("div"); m.className = "ctxmenu";
  const items = [["复制图片", "Ctrl+C", () => copyImg(src)],
    ["复制文件路径", "", async () => { try { await S.copyText(await S.imgPath(src)); toast("路径已复制"); } catch (err) { toast(err.message, true); } }],
    null,
    ["在文件夹中显示", "", async () => { try { await S.reveal(await S.imgPath(src)); } catch (err) { toast(err.message, true); } }],
    ["另存为…", "", async () => { try { const p = await S.saveImageAs(src); if (p) toast("已保存到 " + p); } catch (err) { toast(err.message, true); } }]];
  if (reviewTarget) items.unshift(["审阅意见…", "", () => scriptReviewOpinion(reviewTarget)], null);
  const reviewId = mediaReviewImageId(src);
  if (reviewId) items.unshift(["去「② 图片」审阅", "", () => { document.querySelectorAll(".lbx .lbx-x").forEach(x => x.click()); jumpToMediaReview("img", reviewId); }], null);
  m.innerHTML = items.map((it, i) => it ? `<button data-i="${i}"><span>${it[0]}</span><kbd>${it[1]}</kbd></button>` : "<hr>").join("");
  document.body.appendChild(m);
  const w = m.offsetWidth, h = m.offsetHeight;
  m.style.left = Math.min(e.clientX, innerWidth - w - 6) + "px"; m.style.top = Math.min(e.clientY, innerHeight - h - 6) + "px";
  const close = () => { m.remove(); removeEventListener("keydown", key, true); removeEventListener("mousedown", out, true); };
  const key = ev => { if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); close(); } };   // 只关菜单，不关放大窗口
  const out = ev => { if (!m.contains(ev.target)) close(); };
  addEventListener("keydown", key, true); setTimeout(() => addEventListener("mousedown", out, true), 0);
  m.querySelectorAll("button").forEach(b => b.onclick = () => { const it = items[+b.dataset.i]; close(); it[2](); });
}
// 兜底：点了输入框，窗口却没有键盘焦点（Windows 上弹过系统对话框后偶尔这样，表现为框选后写不了修改意见），让主进程把焦点还回来
document.addEventListener("mousedown", e => {
  const t = e.target; if (!(t && t.matches && t.matches("textarea,input:not([type=checkbox]):not([type=radio]),[contenteditable]"))) return;
  if (!document.hasFocus()) S.refocus().then(() => setTimeout(() => t.focus(), 30)).catch(() => {});
}, true);
document.addEventListener("contextmenu", e => {   // 剪辑台里任何一张图都能右键复制
  const im = e.target && e.target.closest && e.target.closest("img");
  if (im && im.src) imgMenu(e, im.src);
});
function openLightbox(list, idx = 0) {
  if (!list.length) return;
  const m = document.createElement("div"); m.className = "modal lbx";
  m.innerHTML = `<button class="icon lbx-x" title="关闭（Esc）">✕</button><span class="lbx-hint">右键：复制图片 / 另存为 · Ctrl+C 复制</span>${list.length > 1 ? '<button class="icon lbx-p" title="上一张（←）">‹</button><button class="icon lbx-n" title="下一张（→）">›</button>' : ""}<figure><img alt=""><figcaption></figcaption></figure>`;
  document.body.appendChild(m);
  let k = idx;
  const show = () => { m.querySelector("img").src = list[k].src; m.querySelector("figcaption").textContent = list[k].cap + (list.length > 1 ? `　${k + 1} / ${list.length}` : ""); };
  const close = () => { m.remove(); document.removeEventListener("keydown", key, true); };
  const step = d => { k = (k + d + list.length) % list.length; show(); };
  const key = e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") copyImg(list[k].src);
    else if (e.key === "Escape") close(); else if (e.key === "ArrowLeft" && list.length > 1) step(-1); else if (e.key === "ArrowRight" && list.length > 1) step(1); else return;
    e.preventDefault(); e.stopPropagation();
  };
  document.addEventListener("keydown", key, true);
  m.onclick = e => { if (e.target === m || e.target.tagName === "FIGURE") close(); };
  m.querySelector(".lbx-x").onclick = close;
  if (list.length > 1) { m.querySelector(".lbx-p").onclick = e => { e.stopPropagation(); step(-1); }; m.querySelector(".lbx-n").onclick = e => { e.stopPropagation(); step(1); }; }
  show();
}

/* ---------- 参考图：登记表、审阅、新增（moban_art\refs\refs.json，生成调用 storyboard\ref_tool.py） ---------- */
const REFS = () => (P && P.refs && P.refs.refs) || [];
const refRel = id => `refs/${id}.png`;
const KIND_CN = { char: "人物", prop: "道具", bg: "场景" };
// 提示词里常出现、最好有参考图的东西（参考图库里没有时提醒新增），带上预填的描述模板
const REF_NEEDS = [
  { words: ["钞票", "人民币", "纸币"], id: "prop_rmb", name: "第四套人民币", kind: "prop", desc: "1998 年流通的第四套人民币旧版纸币：100 元、50 元、10 元各一张，折过、有点旧，摊开平放，正面朝上；颜色偏暗沉（蓝黑、灰绿等），绝对不是粉红色的百元钞（粉红色的第五套 1999 年才发行）。票面上的字和数字不用画清楚。" },
  { words: ["BP机", "寻呼机", "呼机"], id: "prop_pager", name: "BP机", kind: "prop", desc: "1998 年的黑色数字寻呼机（BP机）：比火柴盒稍大，顶部一块窄长的绿色背光液晶小屏，屏幕亮着但不显示任何字，侧面有按键，背面带金属腰夹。正面和背面各一个角度。", inputs: ["char_woman"] },
  { words: ["保险单"], id: "prop_policy", name: "财产保险单", kind: "prop", desc: "1998 年的纸质财产保险单：一张浅黄色的纸，顶部一行红色抬头（只画成红色色块，不要可读的字），右下角一个红色圆形公章，中间几行细线表格。折过两道。" },
  { words: ["信封"], id: "prop_envelope", name: "白信封", kind: "prop", desc: "普通的白色信封，没写字，有折痕，略鼓，开口处露出折起来的浅黄色纸的一角。" },
  { words: ["收音机"], id: "prop_radio", name: "车载收音机", kind: "prop", desc: "90 年代国产小轿车上的老式车载收音机，黑色面板，一块小的绿色背光屏亮着，两个旋钮，嵌在仪表台中控位置。屏幕上不要字。", inputs: ["bg_interior"] },
  { words: ["警车"], id: "prop_policecar", name: "警车", kind: "prop", desc: "1998 年东北县城派出所的警车：老式国产车，车顶一排红蓝警灯亮着，雪夜。车身上不要任何文字。（具体车型、涂装请按你们的考据改这里）" },
  { words: ["手电"], id: "prop_flashlight", name: "手电筒", kind: "prop", desc: "90 年代的老式金属长柄手电筒，黑色，亮着，光束是偏黄的白光。", inputs: ["char_police"] },
  { words: ["金条", "金光", "金饰", "首饰"], id: "prop_gold", name: "箱子里的金货", kind: "prop", desc: "打开的黑皮箱里装满金店的货：金条、金项链、金镯子，在手电光下反光，没有任何文字或标签。", inputs: ["prop_case"] },
];
const refById = id => REFS().find(r => r.id === id);
function mentions(T, w) {                     // 提到了 w，而且不是「没有 w / 不要 w」
  if (!w) return false; let i = T.indexOf(w);
  while (i >= 0) { if (!/(没有|不要|不能|不许|别|无|看不到|不出现)$/.test(T.slice(Math.max(0, i - 4), i))) return true; i = T.indexOf(w, i + 1); }
  return false;
}
function refState(it) {
  const r = it.ref; if (!r.exists) return "missing";
  const v = ((SB() || {}).review || {})["ref:" + r.id];
  return v && v.mtime === r.mtime ? (v.ok ? "ok" : "bad") : "todo";
}
function refUse(r) {                          // 用到它的镜头 / 提示词里提到它但没附上的镜头
  const sb = SB(); if (!sb) return { used: [], missing: [] };
  const rel = refRel(r.id), used = [], missing = [];
  for (const s of sb.shots) {
    if ((s.refs || []).includes(rel)) used.push(s.id);
    else if ((r.keywords || []).some(k => mentions((s.in_frame || "") + "；" + (s.layout || "") + "；" + (s.desc || ""), k))) missing.push(s.id);
  }
  return { used, missing };
}
function refBible(r) {                        // 统一设定里关于它的写法（方便对照）
  const b = (SB() || {}).bible || {}, out = [];
  for (const [k, v] of Object.entries(b)) {
    const parts = String(v).split(/[。；]/).filter(s => s && ((r.keywords || []).some(w => w && s.includes(w)) || s.includes(r.name)));
    parts.forEach(s => out.push(`${k}：${s.trim()}`));
  }
  if (r.id === "prop_taxi" && b["出租车"]) out.unshift(`出租车：${b["出租车"]}`);
  return [...new Set(out)].slice(0, 5);
}
function refCard(it, k) {
  const r = it.ref, st = refState(it), u = refUse(r), bl = refBible(r);
  const stag = { ok: '<span class="tag pass">参考图 ✓ 已审</span>', todo: '<span class="tag none">参考图待审</span>', bad: '<span class="tag rvbad">有问题</span>', missing: '<span class="tag fb">还没有图</span>' }[st];
  const others = REFS().filter(x => x.id !== r.id && x.exists);
  return `<article class="rvcard pv st-${st === "missing" ? "missing" : st}" data-k="${k}">
    <div class="pvleft">
      <div class="rvimg">${r.exists ? `<img class="rvmain" src="${fileUrl("../" + refRel(r.id))}" data-zoom="参考图 · ${esc(r.name)}" loading="lazy" alt="">` : `<div class="rvmiss">还没有图<br><small>写好描述后点「用 AI 生成」，或者「换成本地图片」</small></div>`}</div>
      <div class="rvsec"><label>生成时一起参考（单击增减，双击放大，最多 4 张；比如 BP机 参考女人的设定图）</label><div class="pvrefs">${others.map(x => `<button class="pvref${(r.inputs || []).includes(x.id) ? " on" : ""}" data-input="${x.id}" title="${esc(x.name)}：单击增减，双击放大"><img src="${fileUrl("../" + refRel(x.id))}" data-zoom="参考图 · ${esc(x.name)}" loading="lazy" alt=""><span>${esc(x.name)}</span></button>`).join("")}</div></div>
    </div>
    <div class="rvinfo">
      <div class="rvwhere"><span class="dim">${KIND_CN[r.kind] || ""}参考图</span><span class="chip">${esc(r.id)}</span></div>
      <div class="rvline"><b>${esc(r.name)}</b></div>
      <div class="rvtags">${stag}<span class="tag none">${u.used.length} 个镜头在用</span>${u.missing.length ? `<span class="tag best">${u.missing.length} 个镜头提到了但没附</span>` : ""}</div>
      ${bl.length ? `<div class="rvsec"><label>统一设定里的写法（对照看图对不对）</label>${bl.map(s => `<div class="dim">${esc(s)}</div>`).join("")}</div>` : ""}
      ${u.missing.length ? `<div class="rvsec"><label>提示词里提到它、却没附这张参考图的镜头</label><div class="dim">${u.missing.map(esc).join("、")}</div><div class="row"><button class="ghost" data-a="attachAll">全部附上</button></div></div>` : ""}
      <div class="pvfields">
        <div class="pvrow"><label>名称<input data-rf="name" value="${esc(r.name)}"></label><label>类型<select data-rf="kind">${Object.entries(KIND_CN).map(([v, t]) => `<option value="${v}" ${r.kind === v ? "selected" : ""}>${t}</option>`).join("")}</select></label></div>
        <label>关键词（提示词里出现这些词时应该附上它，用逗号分开）<input data-rf="keywords" value="${esc((r.keywords || []).join("，"))}"></label>
        <label>描述（AI 生成时用）<textarea data-rf="desc" rows="6">${esc(r.desc || "")}</textarea></label>
      </div>
      <div class="rvact"><button class="pri" data-a="rok" ${r.exists ? "" : "disabled"}>✓ 参考图没问题<kbd>A</kbd></button><button class="ghost" data-a="regen">↻ ${r.exists ? "按描述重新生成" : "用 AI 生成"}<kbd>R</kbd></button><button class="ghost" data-a="rimport">换成本地图片…</button><button class="ghost" data-a="rused" ${u.used.length ? "" : "disabled"}>看用到它的镜头</button></div>
      ${r.exists ? '<div class="hint">重新生成或换图后，原图会挪到 refs\\_old\\，不会丢；用到它的镜头要重画才会用上新图。</div>' : ""}
    </div></article>`;
}
function bindRefCard(card, k) {
  const it = RV.items[k], r = it.ref;
  const im = card.querySelector(".rvmain"); if (im) im.title = "双击放大";
  card.querySelectorAll("[data-rf]").forEach(x => x.onchange = async () => {
    let v = x.value.trim(); if (x.dataset.rf === "keywords") v = v.split(/[，,、\s]+/).filter(Boolean);
    try { P.refs = await S.refsSave(P.dir, { id: r.id, [x.dataset.rf]: v }); toast("已保存到参考图登记表"); rvUpdateCard(k); } catch (e) { toast(e.message, true); }
  });
  card.querySelectorAll("[data-input]").forEach(b => b.onclick = () => delayClick(async () => {
    let ins = [...(r.inputs || [])]; const id = b.dataset.input;
    ins = ins.includes(id) ? ins.filter(x => x !== id) : [...ins, id];
    if (ins.length > 4) return toast("生成时最多一起参考 4 张", true);
    try { P.refs = await S.refsSave(P.dir, { id: r.id, inputs: ins }); rvUpdateCard(k); } catch (e) { toast(e.message, true); }
  }));
}
async function attachRef(shotIds, rid) {      // 把参考图附到这些镜头上（超过 5 张的跳过）
  let n = 0, skip = [];
  for (const sid of shotIds) {
    const s = SB().shots.find(x => x.id === sid); if (!s) continue; const refs = [...(s.refs || [])];
    if (refs.includes(refRel(rid))) continue; if (refs.length >= 5) { skip.push(sid); continue; }
    P.sb = await S.sbSaveShot(P.dir, { id: sid, refs: [...refs, refRel(rid)] }); n++;
  }
  toast(`已附到 ${n} 个镜头` + (skip.length ? `；${skip.join("、")} 已经有 5 张参考图，没附上` : ""), !!skip.length);
}
async function importRef(rid) {
  try { const p = await S.pickAsset("image"); if (!p || !p[0]) return false; P.refs = await S.refsImport(P.dir, rid, p[0]); await refreshFiles(); toast("已换成本地图片（原图在 refs\\_old）"); return true; }
  catch (e) { toast(e.message, true); return false; }
}
function openNewRef(pre = {}, shot = null) {
  const t = REF_NEEDS.find(x => pre.kw && x.words.some(w => pre.kw.includes(w) || w.includes(pre.kw))) || {};
  let id = pre.id || t.id || "prop_new"; while (refById(id) && !pre.id) id = id.replace(/\d*$/, m => String((+m || 1) + 1));
  const ins = new Set(t.inputs || []);
  const m = document.createElement("div"); m.className = "modal";
  m.innerHTML = `<div class="mbox nrbox"><h3>新增参考图</h3>
    <div class="pvfields">
      <div class="pvrow"><label>名称<input id="nrName" value="${esc(pre.name || t.name || pre.kw || "")}"></label><label>类型<select id="nrKind">${Object.entries(KIND_CN).map(([v, tt]) => `<option value="${v}" ${(t.kind || "prop") === v ? "selected" : ""}>${tt}</option>`).join("")}</select></label></div>
      <label>文件名（小写英文、数字、下划线，存成 refs\\<文件名>.png）<input id="nrId" value="${esc(id)}"></label>
      <label>关键词（提示词里出现这些词时应该附上它，用逗号分开）<input id="nrKw" value="${esc((t.words || (pre.kw ? [pre.kw] : [])).join("，"))}"></label>
      <label>描述（AI 生成时用；写清楚年代、样子、颜色，不要文字）<textarea id="nrDesc" rows="5">${esc(t.desc || "")}</textarea></label>
      <label>生成时一起参考（可选，单击增减，双击放大，最多 4 张）</label><div class="pvrefs">${REFS().filter(x => x.exists).map(x => `<button class="pvref${ins.has(x.id) ? " on" : ""}" data-in="${x.id}" title="${esc(x.name)}：单击增减，双击放大"><img src="${fileUrl("../" + refRel(x.id))}" data-zoom="参考图 · ${esc(x.name)}" alt=""><span>${esc(x.name)}</span></button>`).join("")}</div>
      ${shot ? `<label class="nrchk"><input type="checkbox" id="nrAttach" checked> 同时附到 ${esc(shot.id)} 的参考图里</label>` : ""}
    </div>
    <div class="row" style="justify-content:flex-end;margin-top:12px;gap:8px"><button class="ghost" id="nrC">取消</button><button class="ghost" id="nrImp">保存，并选本地图片…</button><button class="pri" id="nrGen">保存，并用 AI 生成</button></div></div>`;
  document.body.appendChild(m);
  const q = s => m.querySelector(s);
  m.querySelectorAll("[data-in]").forEach(b => b.onclick = () => delayClick(() => { const v = b.dataset.in; if (ins.has(v)) ins.delete(v); else { if (ins.size >= 4) return toast("最多 4 张", true); ins.add(v); } b.classList.toggle("on", ins.has(v)); }));
  const close = () => m.remove();
  q("#nrC").onclick = close;
  const save = async () => {
    const e = { id: q("#nrId").value.trim(), name: q("#nrName").value.trim(), kind: q("#nrKind").value, keywords: q("#nrKw").value.split(/[，,、\s]+/).filter(Boolean), desc: q("#nrDesc").value.trim(), inputs: [...ins] };
    if (!e.name) { toast("写一下名称", true); return null; }
    if (refById(e.id)) { toast(`已经有 ${e.id} 了，换一个文件名`, true); return null; }
    try { P.refs = await S.refsSave(P.dir, e); } catch (err) { toast(err.message, true); return null; }
    if (shot && q("#nrAttach") && q("#nrAttach").checked) await attachRef([shot.id], e.id);
    return e;
  };
  q("#nrGen").onclick = async () => { if (!q("#nrDesc").value.trim()) return toast("AI 生成要先写描述", true); const e = await save(); if (!e) return; close(); if (RV) { RV.kind = "ref"; rvBuild(); } runTool("ref_tool.py", ["gen", e.id], `生成参考图 · ${e.name}`); };
  q("#nrImp").onclick = async () => { const e = await save(); if (!e) return; close(); await importRef(e.id); if (RV) rvRefresh(); };
  setTimeout(() => q("#nrName").focus(), 0);
}

/* ---------- 提示词审阅：出图前先看「实际发给模型的提示词」，自动挑矛盾 ---------- */
/* 拼法必须和 storyboard\batch.py 里的 prompt() 保持一致（改了那边要同步改这里） */
// 和 batch.py 的 PRESENCE 一致：只说「画面里只有这些人」，模型会把本来在场的人删掉（车在开，驾驶座却空着）
const PRESENCE = "【在场的其他人】「画面里」写的是这个镜头的主角。按座位设定本来就在场的其他人，如果他们的位置落在画面里，要画出来（可以只露出手、肩膀、后脑或虚化的背影），不要让本该有人的座位空着；车在行驶时，驾驶座上一定有司机，双手握着方向盘。除此之外不要出现其他人。";
function promptText(shot) {
  const sb = SB(), rules = Object.entries(sb.bible || {}).map(([k, v]) => `${k}：${v}`).join("；");
  let p = `为一部互动电影游戏画一张分镜剧照（16:9 横幅）。\n【构图，以画面方向为准，必须做到】${shot.layout || ""}\n【画面内容】${shot.desc || ""}\n【景别】${shot.shot || ""}。【画面里的主角】${shot.in_frame || ""}。【场景】${shot.location || ""}\n${PRESENCE}\n【统一设定】${rules}\n人物长相、发型、服装、道具必须和对应参考图一致；不要照抄参考图的灰色背景和排版；画面里不要任何文字、字幕或水印。`;
  if (shot.sketch && shot.sketch.length) p += "\n【构图草图】已附构图草图和俯视位置图：人物的左右位置、朝向、机位、车头方向必须和草图一致；草图只是示意，不要画出草图里的色块、简笔人形、箭头和文字。";
  return p;
}
function promptKey(shot) {                    // 只取这个镜头自己的内容（固定成 2026-10 的写法），改通用模板不会让已审的全部回到待审
  const rules = Object.entries((SB() || {}).bible || {}).map(([k, v]) => `${k}：${v}`).join("；");
  let p = `为一部互动电影游戏画一张分镜剧照（16:9 横幅）。\n【构图，以画面方向为准，必须做到】${shot.layout || ""}\n【画面内容】${shot.desc || ""}\n【景别】${shot.shot || ""}。【画面里只有这些人】${shot.in_frame || ""}，不要出现其他人。【场景】${shot.location || ""}\n【统一设定】${rules}\n人物长相、发型、服装、道具必须和对应参考图一致；不要照抄参考图的灰色背景和排版；画面里不要任何文字、字幕或水印。`;
  if (shot.sketch && shot.sketch.length) p += "\n【构图草图】已附构图草图和俯视位置图：人物的左右位置、朝向、机位、车头方向必须和草图一致；草图只是示意，不要画出草图里的色块、简笔人形、箭头和文字。";
  return p;
}
function promptHash(shot) {                  // 提示词、参考图、构图图任何一样变了，就回到「待审」
  const s = promptKey(shot) + "|" + (shot.refs || []).join(",") + "|" + (shot.sketch || []).join(","); let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h >>> 0;
}
const PEOPLE = { "司机": "char_driver", "女人": "char_woman", "大军": "char_dajun", "民警": "char_police" };
function lintShot(shot, line) {
  const out = [], L = shot.layout || "", D = shot.desc || "", F = shot.in_frame || "", N = shot.note || "", LD = L + "；" + D, refs = (shot.refs || []).map(r => r.split("/").pop());
  const bible = JSON.stringify((SB() || {}).bible || {});
  const add = (lv, t) => out.push({ lv, t });
  if (!L.trim()) add("warn", "没写构图：谁在画面左、谁在右、机位在哪，模型只能自己猜");
  // 构图 / 画面描述里出现的人，「画面里」却没有（机位、视线方向里提到的不算；只露手、背影这类局部单独提醒）
  for (const name of Object.keys(PEOPLE)) {
    if (F.includes(name)) continue;
    const re = new RegExp(name, "g"); let m, full = false, part = "";
    while ((m = re.exec(LD))) {
      const before = LD.slice(Math.max(0, m.index - 4), m.index), after = LD.slice(m.index + name.length, m.index + name.length + 6);
      if (/外的$/.test(before)) { part = part || "窗外的" + name; continue; }
      if (/(看向|瞪向|指向|指着|盯着|瞟着|瞟向|朝着|冲着|对着|递向|不看|看着|向|从|冲|对|朝|给|跟)$/.test(before) || /^(的位置|的方向|方向|那边|座位|座椅|的座位|一侧|那一侧)/.test(after)) continue;
      const pm = after.match(/^(戴手套的手|的手|的胳膊|胳膊|的肩膀|肩膀|的肩|腰间|的背影|背影|的后脑|后脑)/);
      if (pm) { part = part || name + pm[1].replace(/^的/, "的"); continue; }
      full = true; break;
    }
    if (full) add("bad", `构图或画面描述里出现了「${name}」，但「画面里」没有写${name}。质检会判多出一个人；要么在「画面里」写上（比如只露背影），要么从描述里去掉`);
    else if (part) add("warn", `描述里提到「${part}」，但「画面里」没写${name}；建议写明露哪一部分（比如：画面边缘露出${name}的手，看不到脸），否则质检可能判多出一个人`);
  }
  if (/从后座往前|从后排[^；。]{0,14}往前/.test(L) && !F.includes("司机")) add("bad", "从后座往前拍，司机就坐在画面左侧，一定会入画；「画面里」要写上司机（比如：画面左边缘露出司机的肩膀和后脑）");
  // 人和物的关系：车在开，司机一定在驾驶座、手握方向盘；机位在驾驶座一侧时模型常把镜头往后拉，画出空驾驶座和没人握的方向盘
  if (/行驶/.test(shot.location || "") && !F.includes("司机") && (/(从司机座位|从驾驶座|驾驶座方向|方向盘)/.test(LD) || /(从后排左|从后座左|从左后)/.test(L)))
    add("warn", "车在行驶，司机一定在驾驶座上、手握方向盘。机位在驾驶座一侧时，模型常把镜头往后拉，画出空着的驾驶座和没人握的方向盘：要么在构图里写明「司机的视角，看不到方向盘」，要么在「画面里」写上「画面左下角露出司机握方向盘的手」");
  if (/(从后座往前|从车内往前|从驾驶座[^；。]{0,6}往前|从后排[^；。]{0,14}往前)/.test(L) && /(方向盘|司机)[^；，。]{0,6}画面右/.test(L)) add("bad", "左舵车：从车里往前看，司机和方向盘应该在画面左侧");
  if (/(从车头前方|从挡风玻璃外|隔着挡风玻璃往车里)/.test(L) && /(方向盘|司机)[^；，。]{0,6}画面左/.test(L)) add("bad", "左舵车：从车头前方往里看，司机和方向盘应该在画面右侧");
  if (/(朝车尾|往后拍|朝后拍|朝左后方|朝右后方)/.test(L) && bible.includes("红穗子") && !/(看不到|没有)[^；。]{0,8}(后视镜|红穗子)/.test(LD)) add("warn", "机位朝后，但统一设定里有「挡风玻璃下挂红穗子」，模型常会把它画进来；建议在构图里写明「看不到后视镜和红穗子」");
  if (/后备箱/.test(LD)) add("warn", "参考图里的夏利是五门两厢车（掀背），没有凸出的后备箱；写「后备箱」容易画成三厢轿车");
  if (/(远离|那边|这边|旁边)/.test(L)) add("info", "构图里有「远离 / 那边 / 旁边」这类方向词，模型容易理解偏；建议写成画面左 / 右、前排 / 后排");
  if (/(抬头|字样|写着)/.test(D) && /(清楚|清晰|看得清)/.test(D)) add("warn", "要求画面上的字清楚，和统一的「画面里不要任何文字」冲突");
  if (line && /指甲/.test(line[1] || "") && /手套/.test(LD + F) && !/(摘|光着|没戴)/.test(LD + F)) add("bad", "台词说的是指甲（缝），手应该是光着的，提示词里却写戴着手套");
  if (N && /(左舵|座位|必须|第四套|不要|左后|右后|朝向|画面左|画面右|不能)/.test(N)) add("warn", `备注不会发给模型，但这条备注里像是有画面要求：「${N}」；需要的话挪到构图或画面描述里`);
  // 参考图
  if (refs.length > 5) add("bad", `参考图 ${refs.length} 张，模型最多带 5 张`);
  for (const [name, ref] of Object.entries(PEOPLE)) if (F.includes(name) && !/(只露|看不清|背影|后脑|虚化|画外|手|胳膊|倒影|影子)/.test(F.split(/[；，]/).find(s => s.includes(name)) || "") && !refs.some(r => r.startsWith(ref))) add("warn", `「画面里」有${name}，但参考图里没有 ${ref}`);
  const T = F + "；" + LD;
  for (const r of REFS()) {                   // 登记表里有这张参考图，但没附上
    if (r.kind === "char" || refs.some(x => x.startsWith(r.id + "."))) continue;
    if (r.id === "prop_taxi" && /^车内/.test(shot.location || "")) continue;
    const kw = (r.keywords || []).find(w => mentions(T, w));
    if (kw) out.push({ lv: "warn", t: `提到「${kw}」，但没附参考图「${r.name}」`, addref: r.id });
  }
  for (const n of REF_NEEDS) {                // 参考图库里根本没有
    const w = n.words.find(x => mentions(T, x)); if (!w) continue;
    if (REFS().some(r => (r.keywords || []).some(k => n.words.includes(k)) || r.id === n.id)) continue;
    out.push({ lv: "warn", t: `提到「${w}」，参考图库里还没有它，模型只能凭空画（容易画错年代、样子）`, newref: w });
  }
  return out;
}
// 不是分镜流水线出的图（场景图、特写镜头）也有「提示词」：场景图 = 这一场的 img（画面提示词）；视频镜头 = 视频分镜表里的提示词；定格特写 = 剧本里的 stills 描述
function xPrompt(it) {
  if (it.x === "scene") return { text: P.N[it.nid].img || "", kind: "scene", label: "场景图的画面提示词（也是剧本里这一场的「环境」）" };
  const v = vsShot(it.sid); if (v) return { text: v.prompt || v.describe || "", kind: "video", id: v.id, label: "视频分镜表里的提示词（这张图是视频的首帧）" };
  return { text: stillDesc(it.sid), kind: "still", label: "定格特写的画面描述（存在剧本里）" };
}
const xpHash = it => hashStr(xPrompt(it).text);
function promptState(it) {
  if (it.x === "scene" || it.x === "shot") { const r = ((SB() || {}).review || {})["prompt:" + it.sid]; return r && r.mtime === xpHash(it) ? (r.ok ? "ok" : "bad") : "todo"; }
  if (!it.im) return "noshot"; const shot = shotOf(it.im); if (!shot) return "noshot";
  const r = ((SB() || {}).review || {})["prompt:" + shot.id];
  return r && r.mtime === promptHash(shot) ? (r.ok ? "ok" : "bad") : "todo";
}
function xpCard(it, k) {
  const st = promptState(it), xp = xPrompt(it);
  const stag = { ok: '<span class="tag pass">提示词 ✓ 已审</span>', todo: '<span class="tag none">提示词待审</span>', bad: '<span class="tag rvbad">提示词有问题</span>' }[st];
  const box = xp.kind === "video" ? `<div class="pvtext">${esc(xp.text) || '<span class="dim">（空）</span>'}</div><div class="row"><button class="ghost" data-a="xpvid">去「视频提示词」改</button></div>`
    : `<textarea data-xp rows="4" placeholder="${xp.kind === "scene" ? "这一场在哪、什么时间、天气光线、气氛" : "这张图画的是什么：谁、在哪、在做什么、镜头多近"}">${esc(xp.text)}</textarea>`;
  return `<article class="rvcard pv st-${st}" data-k="${k}">
    <div class="pvleft"><div class="pvfigs">${it.ok ? `<figure class="pvfig" title="双击放大"><img src="${fileUrl(limgRel(it.im))}" data-zoom="${esc(`${sceneName(it.nid)} · ${it.sid}`)}" loading="lazy" alt=""><figcaption>现在的图</figcaption></figure>` : '<div class="rvmiss">没有图</div>'}</div></div>
    <div class="rvinfo">
      <div class="rvwhere"><span class="dim">${esc(sceneName(it.nid))} · ${rvWhere(it)}</span><span class="chip">${esc(it.sid)}</span><span class="tag none">${X_LABEL[it.x]}</span></div>
      <div class="rvline">${rvLineHtml(it).replace(/<div class="dim" style="margin-top:4px">[\s\S]*$/, "")}</div>
      <div class="rvtags">${stag}</div>
      <div class="rvsec"><label>${xp.label}</label>${box}</div>
      <div class="dim" style="font-size:12px">这张图不是分镜流水线出的，改了提示词不会自动重画；图要改，去「图片」审阅里修图或换成本地图片。${xp.kind === "scene" ? "改动和剧本是同一份，Ctrl+S 保存。" : ""}</div>
      <div class="rvact"><button class="pri" data-a="pok">✓ 提示词没问题<kbd>A</kbd></button></div>
    </div></article>`;
}
function pvCard(it, k) {
  if (it.x === "scene" || it.x === "shot") return xpCard(it, k);
  const st = promptState(it), shot = it.im ? shotOf(it.im) : null, sb = SB();
  if (!shot) return `<article class="rvcard st-missing" data-k="${k}"><div class="rvimg"><div class="rvmiss">分镜表里还没有这一句</div></div>
    <div class="rvinfo"><div class="rvwhere"><span class="dim">${esc(sceneName(it.nid))} · 第 ${it.i + 1} 句</span></div><div class="rvline"><b>${esc(it.l[0] || "旁白")}</b>：${esc(it.l[1])}</div>
    <div class="rvact"><button class="ghost" data-a="goto">去故事板加进分镜表</button></div></div></article>`;
  const lint = lintShot(shot, it.l), refs = shot.refs || [], sk = shot.sketch || [];
  const pic = (src, cap) => `<figure class="pvfig" title="双击放大"><img src="${src}" data-zoom="${esc(cap)}" loading="lazy" alt=""><figcaption>${cap}</figcaption></figure>`;
  const figs = [it.ok ? pic(fileUrl(limgRel(it.im)), "现在的成图") : "", ...sk.map(r => pic(fileUrl("../" + r), r.endsWith("_map.png") ? "俯视位置图" : "构图图"))].filter(Boolean);
  const stag = { ok: '<span class="tag pass">提示词 ✓ 已审</span>', todo: '<span class="tag none">提示词待审</span>', bad: '<span class="tag rvbad">提示词有问题</span>' }[st];
  const nBad = lint.filter(x => x.lv === "bad").length, nWarn = lint.filter(x => x.lv === "warn").length;
  return `<article class="rvcard pv st-${st}" data-k="${k}">
    <div class="pvleft">
      <div class="pvfigs">${figs.join("") || '<div class="rvmiss">没有成图，也没有构图图</div>'}</div>
      <div class="row pvsk"><button class="ghost" data-a="sketch" title="用鼠标画画面构图，可以让 AI 整理成 SVG，存成构图图">✎ 手绘构图</button><button class="ghost" data-a="sketchmap" title="从上往下看：车、座位、每个人在哪、机位和拍摄方向">✎ 手绘俯视位置图</button></div>
      <div class="rvsec"><label>参考图（${refs.length} / 5，单击增减，双击放大）</label><div class="pvrefs">${[...new Set([...REFS().filter(x => x.exists).map(x => refRel(x.id)), ...refs])].map(r => `<button class="pvref${refs.includes(r) ? " on" : ""}" data-ref="${esc(r)}" title="${esc(r.split("/").pop())}：单击增减，双击放大"><img src="${fileUrl("../" + r)}" data-zoom="参考图 · ${esc(r.split("/").pop().replace(/\.\w+$/, ""))}" loading="lazy" alt=""><span>${esc((refById(r.split("/").pop().replace(/\.\w+$/, "")) || {}).name || r.split("/").pop().replace(/\.\w+$/, ""))}</span></button>`).join("")}<button class="pvref pvadd" data-newref="" title="新增一张参考图">＋<span>新增</span></button></div></div>
      <details class="pvfull"><summary>实际发给模型的完整提示词</summary><pre>${esc(promptText(shot))}</pre><div class="dim">附图：${refs.map(r => esc(r.split("/").pop())).join("、") || "无"}${sk.length ? "；构图图 " + sk.length + " 张" : ""}</div></details>
    </div>
    <div class="rvinfo">
      <div class="rvwhere"><span class="dim">${esc(sceneName(it.nid))} · 第 ${it.i + 1} 句</span><span class="chip">${esc(shot.id)}</span></div>
      <div class="rvline">${rvLineHtml(it)}</div>
      <div class="rvtags">${stag}${nBad ? `<span class="tag rvbad">${nBad} 处矛盾</span>` : ""}${nWarn ? `<span class="tag best">${nWarn} 处提醒</span>` : ""}${!lint.length ? '<span class="tag pass">自动检查没发现问题</span>' : ""}${contTag(it, "prompt")}${upTag(it, "prompt")}</div>
      ${upHtml(it, "prompt")}
      ${lint.length ? `<ul class="pvlint">${lint.map(x => `<li class="${x.lv}">${esc(x.t)}${x.addref ? ` <button class="pvfix" data-addref="${x.addref}">附上</button>` : ""}${x.newref ? ` <button class="pvfix" data-newref="${esc(x.newref)}">＋ 新增参考图</button>` : ""}</li>`).join("")}</ul>` : ""}
      <div class="pvfields">
        <div class="pvrow"><label>景别<input data-sf="shot" value="${esc(shot.shot || "")}"></label><label>场景<input data-sf="location" value="${esc(shot.location || "")}"></label></div>
        <label>画面里只有这些人<input data-sf="in_frame" value="${esc(shot.in_frame || "")}"></label>
        <label>构图（按画面方向写：谁在左、谁在右、机位）<textarea data-sf="layout" rows="4">${esc(shot.layout || "")}</textarea></label>
        <label>画面描述<textarea data-sf="desc" rows="3">${esc(shot.desc || "")}</textarea></label>
        <label>备注 <span class="pvnosend">不会发给模型</span><input data-sf="note" value="${esc(shot.note || "")}"></label>
      </div>
      ${contStrip(it, "prompt")}
      <div class="rvact"><button class="pri" data-a="pok">✓ 提示词没问题<kbd>A</kbd></button><button class="ghost" data-a="redraw">↻ 按这条${it.ok ? "重画" : "出图"}<kbd>R</kbd></button></div>
    </div></article>`;
}
function bindPvCard(card, k) {
  const it = RV.items[k];
  if (it.x === "scene" || it.x === "shot") {
    const t = card.querySelector("[data-xp]"); if (t) t.onchange = () => { if (!card.isConnected) return; const v = t.value.trim(), xp = xPrompt(it); if (v === xp.text) return;
      edit(() => { if (xp.kind === "scene") { const n = P.N[it.nid]; if (v) n.img = v; else delete n.img; }
        else { Object.values(P.N).forEach(m => { if (m.stills) { delete m.stills[it.sid]; if (!Object.keys(m.stills).length) delete m.stills; } }); if (v) { const n = P.N[it.nid]; (n.stills = n.stills || {})[it.sid] = v; } } });
      rvUpdateCard(k); rvCounts(); };
    return;
  }
  const shot = it.im ? shotOf(it.im) : null; if (!shot) return;
  card.querySelectorAll("[data-sf]").forEach(x => x.onchange = async () => {
    try { P.sb = await S.sbSaveShot(P.dir, { id: shot.id, [x.dataset.sf]: x.value.trim() }); toast("已保存到分镜表"); rvUpdateCard(k); rvCounts(); } catch (e) { toast(e.message, true); }
  });
  card.querySelectorAll("[data-addref]").forEach(b => b.onclick = async () => { await attachRef([shot.id], b.dataset.addref); rvUpdateCard(k); rvCounts(); });
  card.querySelectorAll("[data-newref]").forEach(b => b.onclick = () => openNewRef({ kw: b.dataset.newref }, shot));
  card.querySelectorAll("[data-ref]").forEach(b => { b.onclick = () => delayClick(() => toggleRef(b)); });
  const toggleRef = async b => {
    let refs = [...(shot.refs || [])]; const r = b.dataset.ref;
    refs = refs.includes(r) ? refs.filter(x => x !== r) : [...refs, r];
    if (refs.length > 5) return toast("参考图最多 5 张（出图模型一次能带的上限）", true);
    try { P.sb = await S.sbSaveShot(P.dir, { id: shot.id, refs }); rvUpdateCard(k); rvCounts(); } catch (e) { toast(e.message, true); }
  };
  const det = card.querySelector(".pvfull"); if (det) { det.open = !!RV.fullOpen; det.ontoggle = () => { RV.fullOpen = det.open; }; }
}
async function confirmPrompts(ids) {         // 出图前：还没审过的提示词提醒一下
  if (!SB()) return true;
  const rv = SB().review || {}, todo = ids.filter(id => { const s = SB().shots.find(x => x.id === id); return s && !((r => r && r.ok && r.mtime === promptHash(s))(rv["prompt:" + id])); });
  if (!todo.length) return true;
  const bad = todo.filter(id => lintShot(SB().shots.find(x => x.id === id), null).some(x => x.lv === "bad"));
  const r = await S.confirm(`有 ${todo.length} 条提示词还没审过${bad.length ? `，其中 ${bad.length} 条自动检查发现了矛盾（${bad.slice(0, 4).join("、")}${bad.length > 4 ? "…" : ""}）` : ""}。\n提示词有问题，出图多半也是错的。`, ["先去审提示词", "照样出图", "取消"]);
  if (r === 0) { openReview(RV ? RV.scope : "all", "todo", "prompt"); return false; }
  return r === 1;
}

/* ---------- 审阅：一张张往下刷，看图、对照要求，通过 / 标问题 / 修图 / 重画 ---------- */
let RV = null;
function reviewOf(sid, im) {                 // 人工审阅结果；图换过（修改时间变了）就当没审过
  const sb = SB(); if (!sb || !sid) return null;
  const r = (sb.review || {})[sid], f = P.files[limgRel(im)], st = (sb.state.shots || {})[sid];
  if (r && f && r.mtime === f.mtime) return r;
  if (r && r.mtime === 0) return null;                                   // 人手动「改回待审」过
  if (st && st.status === "manual") return { ok: true, note: "" };   // 在修图窗口里采用 / 标记过
  return null;
}
// @shot 镜头在游戏里显示哪几张图（和 moban_game/index.html 里的 specials / LEAD 一致：pager、policy 先播引子视频再定格到特写）
const SHOT_IMGS = { gold: ["s_gold"], policy: ["s_envelope", "s_policy_close"], pager: ["s_pager", "s_pager_close"] };
const shotImgs = id => SHOT_IMGS[id] || ["s_" + id];
function reviewItems(scope) {
  // 不只是逐句分镜图：场景图（没有逐句图的台词都显示它、结局画面）、@shot 特写镜头的图、字幕卡（@cap）上的图，同样会出现在游戏里，也要人审
  const out = [], seen = new Set();
  (scope === "scene" ? [cur] : flatOrder()).forEach(nid => {
    if (has(`img/${nid}.jpg`) && !seen.has(nid)) { seen.add(nid); out.push({ nid, i: -1, l: ["@scene", sceneName(nid)], im: nid, ok: true, sid: nid, x: "scene" }); }
    P.N[nid].lines.forEach((l, i) => {
      const tag = String(l[0] || "");
      if (tag === "@shot") {
        shotImgs(l[1]).forEach(im => { if (seen.has(im)) return; seen.add(im); out.push({ nid, i, l, im, ok: has(limgRel(im)), sid: im, x: "shot" }); });
        return;
      }
      if (tag === "@cap") { const im = limgOf(nid, i); if (im && (has(limgRel(im)) || shotOf(im))) out.push({ nid, i, l, im, ok: has(limgRel(im)), sid: shotId(im), x: "cap" }); return; }
      if (!isSpoken(l)) return; const im = limgOf(nid, i), ok = !!(im && has(limgRel(im)));
      out.push({ nid, i, l, im, ok, sid: im ? shotId(im) : null });
    });
  });
  return out;
}
const X_LABEL = { scene: "场景图", shot: "特写镜头", cap: "字幕卡" };
// 定格特写图（没有视频分镜表条目的 s_*）的画面描述：存在剧本里那一场的 stills 字段（游戏不读它），同一张图在别的场景也能找到
function stillDesc(img) { for (const n of Object.values(P.N)) if (n.stills && n.stills[img]) return n.stills[img]; return ""; }
// 游戏（moban_game/index.html 的 showCap / showLine）实际不会显示的图：字幕卡只显示文字；「BP机」那句不换图，只弹证物文字
function notShown(it) {
  if (!it.im) return "";
  if (it.x === "cap") return "游戏里字幕卡只显示文字、不换画面，这张图现在不会出现";
  if (!it.x && it.l && it.l[0] === "BP机") return "游戏里「BP机」这句不换画面（只弹出证物文字），这张图现在不会出现";
  return "";
}
function rvLineHtml(it) {                  // 审阅卡片上「这是哪一句 / 哪张图」
  if (it.x === "scene") return `<b>${P.N[it.nid].end ? "结局画面" : "场景图"}</b>：<span class="dim">这一场没有逐句图的台词都显示这张，也是场景视频的底图</span>`;
  if (it.x === "shot") { const v = vsShot(it.sid), d = v ? (v.describe || v.prompt || "") : stillDesc(it.sid);
    return `<b>特写镜头</b>：@shot ${esc(it.l[1])}　<span class="dim">${has(`vid/${it.sid}.mp4`) ? `播放 vid/${esc(it.sid)}.mp4 时的首帧` : "游戏里定格显示这张图"}</span>${d ? `<div class="dim" style="margin-top:4px">画面：${esc(d)}</div>` : '<div class="dim" style="margin-top:4px">还没有画面描述（在剧本审阅里补）</div>'}`; }
  if (it.x === "cap") return `<b>字幕卡</b>：${esc(it.l[1] || "")}`;
  return `<b>${esc(it.l[0] || "旁白")}</b>：${esc(it.l[1])}`;
}
const rvWhere = it => it.x === "scene" ? "场景开头" : `第 ${it.i + 1} 句`;
const rvState = it => !it.ok ? "missing" : (r => r ? (r.ok ? "ok" : "bad") : "todo")(reviewOf(it.sid, it.im));
const pendingCount = () => SB() ? reviewItems("all").filter(it => rvState(it) === "todo").length : 0;
const candQc = c => c.pass == null ? "人工修图，未质检" : `${c.pass ? "通过" : "没通过"} ${c.score ?? "-"}/10`;
function rvCodexRevision(it) {
  return !!it.sid && !!SB()?.state?.shots?.[it.sid]?.refine?.some(r => r.file && r.dir?.startsWith('codex_script_review_'));
}
function rvCands(sid) {
  const st = ((SB() || {}).state || { shots: {} }).shots[sid]; if (!st) return [];
  const c = [], seen = new Set();
  (st.tries || []).forEach(t => t.file && c.push({ file: t.file, dir: "batch", label: `第${t.n}次`, pass: t.pass, score: t.score, issues: t.issues || [] }));
  (st.refine || []).forEach((t, k) => t.file && c.push({ file: t.file, dir: t.dir || "refine", label: `${t.how || "修改"}${k + 1}`, pass: t.pass, score: t.score, issues: t.issues || [] }));
  (st.fixes || []).forEach((t, k) => t.file && c.push({ file: t.file, dir: "fix", label: `${t.how || "修图"}${k + 1}`, pass: null, score: null, issues: t.note ? ["修改意见：" + t.note] : [] }));
  return c.filter(x => !seen.has(x.file) && seen.add(x.file)).map(x => ({ ...x, cur: x.file === st.final }));
}
/* ---------- ③ 视频提示词审阅（autofix\video_shots.json）：第一次生成前人必须审过（方案 C），自动重拍时 AI 改写的提示词照常放行但会标出来 ---------- */
const VS = () => P && P.vs && !P.vs.error ? P.vs : null;
const vsShot = id => (VS() ? VS().shots.find(s => s.id === id) : null);
const vpHash = s => hashStr(["prompt", "mode", "key", "last", "mid"].map(k => String(s[k] || "")).join("|"));   // 和 video_shots.py 的 vp_hash 一致
/* ---------- 剧本 → 提示词 → 图片 → 视频 的绑定：剧本里每一场、每个动作镜头都要有视频位 ---------- */
const shotVid = name => (({ pager: "s_pager", policy: "s_envelope" })[name] || "s_" + name);   // @shot 播的是哪条视频（和游戏的 LEAD 一致）
const LINE_OFF = new Set(["收音机", "旁白", "BP机", "画外音", ""]);   // 这些「说话的」不在画面里（和 durations.py 的 OFFSCREEN 一致）
const vRel = s => s.video || `vid/${s.id}.mp4`;
const vDraftRel = s => "vid_draft/" + vRel(s).split("/").slice(1).join("/");   // 游戏草稿模式播的文件
const vDraftOf = s => ((VS() || {}).drafts || {})[s.id] || {};
function scriptVids() {                          // 按播放顺序：[{ id, kind, nid, i, name }]
  const out = [], seen = new Set();
  flatOrder().forEach(nid => { if (!seen.has(nid)) { seen.add(nid); out.push({ id: nid, kind: "scene", nid, i: -1 }); }
    P.N[nid].lines.forEach((l, i) => {
      if (l[0] !== "@shot") { const tag = String(l[0] || ""); if (tag.startsWith("@") || tag === "BP机") return;   // 台词页：这一句有自己的分镜图就有一个视频位（游戏里配音期间播，没有视频就定格）
        const im = limgOf(nid, i), id = im && shotId(im); if (!id || seen.has(id)) return; seen.add(id); out.push({ id, kind: "line", nid, i, im }); return; }
      const id = shotVid(l[1]); if (seen.has(id)) return; seen.add(id); out.push({ id, kind: "shot", nid, i, name: l[1] }); }); });
  return out;
}
async function ensureVsSlots() {                 // 视频分镜表里缺的就补一条占位：不会自动生成、不花钱；第一次生成前照样要人审提示词
  if (!VS() || !S.vsAdd) return 0;
  const have = new Set(VS().shots.map(x => x.id)), add = [];
  for (const v of scriptVids()) {
    if (have.has(v.id)) continue;
    if (v.kind === "line") {                     // 台词页：首帧就是这一句的分镜图，视频放 vid/l/
      const l = P.N[v.nid].lines[v.i], who0 = String(l[0] || ""), who = who0 === "你" ? "司机" : who0, sh = shotOf(v.im), off = LINE_OFF.has(who0) || (sh && sh.speaker_in_frame === "否");   // 剧本里的「你」就是玩家扮演的出租车司机
      const desc = (sh && (sh.desc || sh.layout)) || stillDesc(v.id) || "";
      const silent = /^[…。.\s]*$/.test(String(l[1]));
      const text = desc + (off ? `，画面里的人不张嘴（「${l[1]}」是${who || "画外音"}的声音）` : silent ? `，${who}欲言又止，嘴唇动了动没有出声` : `，${who}张嘴说「${l[1]}」`);
      add.push({ id: v.id, kind: "line", keyframe: limgRel(v.im), key: "", last: "", mid: "", mode: "", model: "", refs: [], gen_refs: [], cost: 2, duration: 6,
        speakers: off || silent ? [] : [who], need_mouth: !off && !silent, describe: desc, prompt: text, prompt_from: "剪辑台按剧本自动占位（台词页：分镜描述 + 这句台词，请用「AI 重写」改成视频提示词）",
        auto: false, video: `vid/${v.im}.mp4`, qc_refs: [], placeholder: true });
      continue;
    }
    const text = v.kind === "scene" ? (P.N[v.id].img || "") : stillDesc(v.id) || stillDesc("s_" + v.name);
    add.push({ id: v.id, kind: v.kind, keyframe: `img/${v.id}.jpg`, key: "", last: "", mid: "", mode: "", model: "", refs: [], gen_refs: [], cost: 2, duration: 6,
      speakers: [], need_mouth: false, describe: text, prompt: text, prompt_from: "剪辑台按剧本自动占位（从环境 / 画面描述抄来，请改成视频提示词）",
      auto: false, video: `vid/${v.id}.mp4`, qc_refs: [], placeholder: true, novideo: v.kind === "shot" && v.name === "gold" });   // gold 在游戏里只定格显示，不播视频
  }
  if (!add.length) return 0;
  try { P.vs = await S.vsAdd(P.dir, add); toast(`按剧本补了 ${add.length} 个视频位：${add.map(x => x.id).join("、")}（只是占位，不会自动生成）`); } catch (e) { toast(e.message, true); return 0; }
  return add.length;
}
function orphans() {                             // 分镜表 / 视频分镜表里有、剧本里已经找不到的
  const sb = SB(), lineIds = new Set(), out = [];
  Object.keys(P.N).forEach(nid => P.N[nid].lines.forEach((l, i) => { const im = limgOf(nid, i); if (im) lineIds.add(shotId(im)); }));
  (sb ? sb.shots : []).forEach(x => { if (!lineIds.has(x.id)) out.push({ kind: "shot", id: x.id, t: x.desc || x.layout || "" }); });
  const vids = new Set(scriptVids().map(v => v.id));
  (VS() ? VS().shots : []).forEach(x => { if (!vids.has(x.id)) out.push({ kind: "video", id: x.id, t: x.describe || x.prompt || "" }); });
  return out;
}
function orphanBar(kind) {
  const list = orphans().filter(o => o.kind === (kind === "video" ? "video" : "shot")); if (!list.length) return "";
  return `<div class="rvorph"><b>剧本里已经找不到的${kind === "video" ? "视频位" : "分镜"}（${list.length}）</b><span class="dim">——对应的台词或镜头被删了 / 改名了。确认不要了再删；要留着就在剧本里加回对应的一行。</span>
    <ul>${list.map(o => `<li><span class="chip">${esc(o.id)}</span> <span class="dim">${esc(o.t.slice(0, 60))}</span> <button class="ghost" data-orphdel="${esc(o.kind)}:${esc(o.id)}">删掉这条</button></li>`).join("")}</ul></div>`;
}
// 剧本审阅右侧的对照表：这一场每一行的提示词 / 图片 / 视频各到了哪一步，点一格跳过去
const BT = { ok: ["ok", "✓"], todo: ["todo", "待审"], bad: ["bad", "✗"], missing: ["miss", "缺"], noshot: ["miss", "缺"], skip: ["na", "不做"], na: ["na", "—"], hidden: ["bad", "不显示"] };
const btWorst = arr => ["noshot", "missing", "bad", "hidden", "todo", "ok", "skip", "na"].find(x => arr.includes(x)) || "na";
function bindTable(nid) {
  const n = P.N[nid], rows = [];
  const vcell = id => { const v = vsShot(id); return v ? vpState({ vid: id }) : "missing"; };
  const cell = (st, go, tip) => { const [c, t] = BT[st] || BT.na; return `<td><button class="bt ${c}" ${go && st !== "na" ? `data-go="${esc(go)}"` : "disabled"} title="${esc(tip || "")}">${t}</button></td>`; };
  const sc = { x: "scene", nid, i: -1, l: ["@scene"], im: nid, ok: has(`img/${nid}.jpg`), sid: nid };
  rows.push(`<tr><th title="环境 / 场景图 / 场景视频">环境</th>${cell(promptState(sc), "prompt:" + nid, "场景图的画面提示词")}${cell(sc.ok ? rvState(sc) : "missing", "img:" + nid, "场景图")}${cell(vcell(nid), "video:" + nid, "场景视频")}</tr>`);
  n.lines.forEach((l, i) => {
    const tag = String(l[0] || ""), lab = `${i + 1} ${tag === "@shot" ? "动作" : tag === "@cap" ? "字幕卡" : (tag || "旁白")}`, tip = String(l[1] || "");
    if (tag === "@shot") {
      const its = shotImgs(l[1]).map(im => ({ x: "shot", nid, i, l, im, ok: has(limgRel(im)), sid: im })), vid = shotVid(l[1]);
      rows.push(`<tr><th title="${esc(tip)}">${esc(lab)}</th>${cell(btWorst(its.map(promptState)), "prompt:" + its[0].sid, "画面描述 / 提示词")}${cell(btWorst(its.map(rvState)), "img:" + its[0].sid, "首帧 / 定格图")}${cell(vcell(vid), "video:" + vid, "视频")}</tr>`);
    } else if (tag === "@cap") {
      const im = limgOf(nid, i); if (!im) { rows.push(`<tr class="dim"><th title="${esc(tip)}">${esc(lab)}</th>${cell("na")}${cell("na")}${cell("na")}</tr>`); return; }
      const it = { x: "cap", nid, i, l, im, ok: has(limgRel(im)), sid: shotId(im) };
      rows.push(`<tr><th title="${esc(tip)}">${esc(lab)}</th>${cell(shotOf(im) ? promptState(it) : "na", "prompt:" + it.sid)}${cell(it.ok ? "hidden" : "na", "img:" + it.sid, "游戏里字幕卡不换画面")}${cell("na")}</tr>`);
    } else if (!tag.startsWith("@")) {
      const im = limgOf(nid, i), it = { nid, i, l, im, ok: !!(im && has(limgRel(im))), sid: im ? shotId(im) : null };
      const ps = im ? promptState(it) : "noshot", is = !im ? "missing" : rvState(it);
      rows.push(`<tr><th title="${esc(tip)}">${esc(lab)}</th>${cell(ps, it.sid ? "prompt:" + it.sid : "", ps === "noshot" ? "还没有分镜：在左边这一句下面写画面描述" : "")}${cell(tag === "BP机" && it.ok ? "hidden" : is, it.sid ? "img:" + it.sid : "", tag === "BP机" ? "游戏里 BP机 这句不换画面" : "")}${im && tag !== "BP机" ? cell(vcell(it.sid), "video:" + it.sid, "台词页视频（配音期间播；没有就定格这张图）") : cell("na")}</tr>`);
    }
  });
  return `<table class="bt-t"><thead><tr><th></th><th>提示词</th><th>图片</th><th>视频</th></tr></thead><tbody>${rows.join("")}</tbody></table>`;
}
function vsItems(scope) {
  if (!VS()) return [];
  const order = scriptVids().map(v => v.id), pos = id => { const j = order.indexOf(id); return j < 0 ? 1e9 : j; };
  let ids = VS().shots.map(s => s.id).sort((a, b) => pos(a) - pos(b));
  if (scope === "scene") { const own = scriptVids().filter(v => v.nid === cur).map(v => v.id); ids = ids.filter(id => own.includes(id)); }
  return ids.map(vid => ({ vid }));
}
function vpState(it) {
  const s = vsShot(it.vid); if (!s) return "todo"; if (s.novideo) return "skip";
  const r = ((SB() || {}).review || {})["vprompt:" + s.id];
  return r && r.mtime === vpHash(s) ? (r.ok ? "ok" : "bad") : "todo";
}
const vRefCount = s => s.mode === "h3" && ((s._refs || []).length + (s._gen || []).length) ? 1 + (s._refs || []).filter(r => r.ok).length + (s._gen || []).filter(r => r.ok).length : 0;
function vModeText(s) {
  if (s.mode === "h3") { const n = vRefCount(s); return n ? `MiniMax H3 参考模式（${n} 张参考图，最多 9 张；首帧只当构图参考，车头朝向可能被改）` : `MiniMax H3 帧模式（首帧${s.mid ? " + 中间帧" : ""}${s.last ? " + 尾帧" : ""}，构图锁定）`; }
  return s.last ? "海螺 首尾帧模式（画面从首帧走到尾帧）" : "海螺 2.3 首帧模式（构图锁定）";
}
function vSent(s) {                           // 实际发给视频模型的文字（和 autofix.py 的拼法一致）
  const suf = (VS() && VS().suffix) || "";
  if (s.mode === "h3" && vRefCount(s)) {
    const items = [["首帧", "本镜头的构图、机位和光线（视频要和它一致）"], ...(s._gen || []).filter(g => g.ok).map(g => [g.rel, g.label]), ...(s._refs || []).filter(r => r.ok).map(r => [r.rel, r.label])].slice(0, 9);
    return `${s.prompt || s.describe || ""}${suf}（${items.map((x, i) => `参考图${i + 1}：${x[1]}`).join("；")}。画面构图以参考图1为准，人物长相、服装、道具与对应参考图一致）`;
  }
  return (s.prompt || s.describe || "") + suf;
}
const V_SENS = ["血", "伤", "打斗", "殴打", "抢劫", "劫匪", "削", "枪", "刀", "尸", "杀", "死", "押解", "挣扎"];
function vLint(s) {
  const out = [], add = (lv, t) => out.push({ lv, t }), T = s.prompt || "", frame = !(s.mode === "h3" && vRefCount(s));
  if (!T.trim()) add("bad", "提示词是空的，会直接用质检标准去生成");
  else if (T === s.describe) add("info", "提示词直接沿用了质检标准，没单独写过。视频提示词最好写清楚：镜头怎么动、谁先做什么、谁在说话");
  if (!s._keym) add("bad", `首帧图不存在：${s._keyRel}`);
  if (s.last && !s._lastRel) add("warn", "写了尾帧但找不到");
  const frameReview=SB()?.review?.['vprompt:'+s.id];
  if(s.last&&s.last===s.keyframe_tail_review&&!(frameReview?.ok&&frameReview.mtime===vpHash(s)))add('warn','首帧已随②图片更新，尾帧仍是旧版，请复查尾帧与新首帧是否衔接。');
  const sens = V_SENS.filter(w => T.includes(w)); if (sens.length) add("warn", `有「${sens.join("、")}」，视频平台审核可能会拦；自动重拍时会被直接删掉，意思可能就变了，最好换个说法`);
  const spk = (typeof finSpeech === "function" ? finSpeech(s) : []).filter(x => !/^[…。.\s]*$/.test(String(x.text)) && !LINE_OFF.has(String(x.who)));
  if (T && spk.length) { const miss = spk.filter(x => !T.includes(String(x.text).replace(/（[^）]*）/g, "").replace(/[「」]/g, "").slice(0, 5))); if (miss.length) add("warn", `游戏里这段视频播放时会响起台词，提示词里却没写原文：${miss.map(x => `${x.who === "你" ? "司机" : x.who}「${String(x.text).slice(0, 18)}${String(x.text).length > 18 ? "…" : ""}」`).join("、")}——嘴型对不上。点「✎ AI 重写」会按台词时间表写进去`); }
  if (T && !spk.length && s.kind !== "line" && /(张嘴|嘴唇一开一合|开口说|张嘴说话|大喊|喊道)/.test(T)) add("warn", "游戏里这段视频播放时没有任何台词配音，提示词却让人张嘴说话：画面里嘴在动、却没有声音。点「✎ AI 重写」会改成不说话");
  if (s.need_mouth && T && !/(张嘴|说话|嘴唇|开口|喊|问|回答|辩解|回话|对话)/.test(T)) add("warn", `这一镜要对口型（说话的人：${(s.speakers || []).join("、") || "未写"}），提示词里没写谁在张嘴说话`);
  if (!s.need_mouth && /(嘴唇[^，。；]{0,4}(开|合)|张嘴(说|回|问|喊))/.test(T)) add("info", "这一镜标的是不用张嘴，提示词却要求张嘴说话");
  const n = T.split(/[，。；;,]/).filter(x => x.trim().length > 1).length; if (n > 9) add("warn", `描述太多（${n} 句），${s.duration || 6} 秒视频做不完，容易乱或者停在尾帧不动`);
  if (frame && /(镜头[^，。；]{0,4}(绕|环绕|转到|切到|切换)|360|大幅(摇|移|推|拉)|甩镜|拉远到|俯冲)/.test(T)) add("warn", "帧模式会锁住首帧构图，大幅运镜容易变形；要换机位，应该换一张首帧");
  if (/后备箱/.test(T)) add("warn", "夏利是五门两厢车（掀背），没有凸出的后备箱；写「后备箱」容易画成三厢轿车");
  if (/(司机|方向盘)[^，。；]{0,6}画面右/.test(T) && !/(挡风玻璃外|车头前|从车前|从挡风玻璃)/.test(T)) add("warn", "左舵车：从车里往前看，司机和方向盘应该在画面左侧；只有从车头前往里看才在右侧");
  if (/(钞票|人民币|百元|一叠钱|递钱|塞钱)/.test(T) && !/第四套/.test(T)) add("info", "提到钱，最好写明「第四套人民币」（1998 年），不然容易出现红色百元钞");
  if (vRefCount(s) > 9) add("bad", `参考图 ${vRefCount(s)} 张，H3 最多 9 张（含首帧）`);
  (s._refs || []).concat(s._gen || []).filter(r => !r.ok).forEach(r => add("warn", `参考图不存在：${r.label}（${r.rel.replace(/^\.\.\//, "")}）`));
  return out;
}
function vUp(s) {                             // 审过之后首帧图换过
  const r = ((SB() || {}).review || {})["vprompt:" + s.id];
  const out = r && r.ok && r.keym && s._keym && r.keym !== s._keym ? [{ t: "首帧图换过，提示词要按新的首帧复查（人物位置、动作起点可能变了）" }] : [];
  const kf = P.files[finalPosterRel(s)] || {mtime:s._keym||0}, vf = P.files[vRel(s)];   // 视频是在首帧图换掉之前做的
  if (kf && vf && vf.mtime < kf.mtime) out.push({ t: "游戏里现在的视频比首帧图旧（首帧换过），画面对不上，要按新首帧重做" });
  return out;
}
// ③ 草稿卡片左边：一张大的主视图 + 下面一排小方块（首帧、中间帧、尾帧、AI 尾帧、草稿视频），点小方块切换主视图；记住每条选的是哪个
function vMedia(s) {
  const dr = vDraftOf(s), drel = vDraftRel(s), out = [];
  if (s._keym) out.push({ t: "img", url: fileUrl(s._keyRel), cap: "首帧", short: "首帧" });
  if (s._midRel) out.push({ t: "img", url: fileUrl(s._midRel), cap: "中间帧", short: "中间帧" });
  if (s._lastRel && !(dr.end && s.last === dr.end.file)) out.push({ t: "img", url: fileUrl(s._lastRel), cap: "尾帧", short: "尾帧" });
  if (dr.end) out.push({ t: "img", url: fileUrl("../autofix/" + dr.end.file).replace(/\?t=.*$/, "?t=" + encodeURIComponent(dr.end.at)), cap: "AI 画的尾帧" + (s.last === dr.end.file ? "（已用作正式尾帧）" : ""), short: "AI 尾帧" });
  if (has(drel)) { const kind = ({ ltx: "本地模型", b25d: "2.5D 预演", code: "代码" })[dr.current] || "代码"; out.push({ t: "video", url: fileUrl(drel), cap: `草稿视频（${kind}${dr[dr.current] ? " · " + dr[dr.current].at : ""}）`, short: "草稿视频" }); }
  return out;
}
function vSel(s, media) { const v = ((RV && RV.vsel) || {})[s.id]; return v != null && v < media.length ? v : 0; }
function vMainHtml(m, s) {
  if (!m) return "";
  return `${m.t === "video" ? `<video src="${m.url}" controls preload="metadata"></video>` : `<img src="${m.url}" data-zoom="${esc(m.cap + " · " + s.id)}" alt="">`}<span class="vcap">${esc(m.cap)}</span>`;
}
// 生成视频时选模型（和 autofix.py 的 ENGINES 一致；价格按 MiniMax 开放平台定价：海螺按条，H3 按秒）
const ENGINES = {
  hailuo: { label: "海螺 2.3 · 768P", kind: "hailuo", clip: { 6: 2.0, 10: 4.0 }, note: "现在大部分镜头用的；只有 6 / 10 秒" },
  hailuo_fast: { label: "海螺 2.3 Fast · 768P", kind: "hailuo", clip: { 6: 1.35, 10: 2.25 }, note: "便宜三成，速度快，画质略低" },
  h3: { label: "H3 · 768P", kind: "h3", sec: .50, note: "4～10 秒按需要的长度生成；首帧锁构图（帧模式）" },
  h3_lite: { label: "H3-Lite · 768P", kind: "h3", sec: .26, note: "H3 的便宜版，先测画质" },
  hailuo02_512: { label: "海螺 02 · 512P（低清草稿）", kind: "hailuo", clip: { 6: .6, 10: 1.0 }, note: "看动作和嘴型走向用，不进游戏" },
  h3_lite480: { label: "H3-Lite · 480P（低清草稿）", kind: "h3", sec: .16, note: "看动作和嘴型走向用，不进游戏" },
};
function engineDur(e, s) { const need = +(s.duration_need || s.duration || 6); return ENGINES[e].kind === "hailuo" ? (+(s.duration || 6) >= 8 ? 10 : 6) : Math.min(10, Math.max(4, Math.ceil(need))); }
function engineCost(e, d) { const E = ENGINES[e]; return E.kind === "hailuo" ? E.clip[d >= 8 ? 10 : 6] : +(E.sec * d).toFixed(2); }
function pickEngine(s) {
  return new Promise(res => {
    const af = ((VS() || {}).state || {})[s.id], hasTries = !!(af && (af.tries || []).length), def = (() => { try { return localStorage.getItem("studio_engine") || ""; } catch { return ""; } })() || (s.mode === "h3" ? "h3" : "hailuo");
    const m = document.createElement("div"); m.className = "modal";
    m.innerHTML = `<div class="mbox eng-box"><h3>生成 ${esc(s.id)} 的视频</h3><div class="dim">需要的时长约 ${(+(s.duration_need || s.duration || 6)).toFixed(1)} 秒 · ${esc(s.duration_why || "")}</div>
      <div class="eng-list">${Object.entries(ENGINES).map(([k, E]) => { const d = engineDur(k, s), c = engineCost(k, d); return `<label class="eng${k === def ? " on" : ""}"><input type="radio" name="eng" value="${k}" ${k === def ? "checked" : ""}><b>${esc(E.label)}</b><span class="eng-p">${d} 秒 · ¥${c}</span><span class="dim">${esc(E.note)}</span></label>`; }).join("")}</div>
      <label class="eng-more"><input type="checkbox" id="engMore" ${hasTries ? "checked" : ""}> 多生成一版：保留以前的版本，只生成一次，不自动换进游戏（到「④ 成片」里和别的版本对比、选用）</label>
      <div class="dim" id="engNote"></div>
      <div class="row" style="justify-content:flex-end;margin-top:12px"><button class="ghost" id="engC">取消</button><button class="pri" id="engO">开始生成</button></div></div>`;
    document.body.appendChild(m);
    const note = () => { const e = m.querySelector('input[name="eng"]:checked').value, more = m.querySelector("#engMore").checked, c = engineCost(e, engineDur(e, s));
      m.querySelectorAll(".eng").forEach(x => x.classList.toggle("on", x.querySelector("input").checked));
      m.querySelector("#engNote").textContent = more ? `只生成一次，约 ¥${c}；生成后 AI 质检打分，结果在「④ 成片」。` : `质检不通过会用 AI 改写的提示词自动重拍，最多再拍 2 次（最多约 ¥${+(c * 3).toFixed(2)}）；通过就自动换进游戏。需要 MINIMAX_API_KEY 和 GEMINI_API_KEY，每条几分钟。`; };
    m.querySelectorAll("input").forEach(x => x.onchange = note); note();
    const done = v => { m.remove(); res(v); };
    m.querySelector("#engC").onclick = () => done(null); m.onclick = e => { if (e.target === m) done(null); };
    m.querySelector("#engO").onclick = () => { const e = m.querySelector('input[name="eng"]:checked').value; try { localStorage.setItem("studio_engine", e); } catch {} done({ engine: e, more: m.querySelector("#engMore").checked }); };
  });
}
function vCard(it, k) {
  const s = vsShot(it.vid); if (!s) return `<article class="rvcard" data-k="${k}"><div class="rvmiss">视频分镜表里没有 ${esc(it.vid)}</div></article>`;
  const st = vpState(it), lint = vLint(s), up = vUp(s), af = ((VS() || {}).state || {})[s.id], tries = (af && af.tries) || [];
  const dr = vDraftOf(s), drel = vDraftRel(s);
  const media = vMedia(s), mi = vSel(s, media);
  const dstale = dr[dr.current] && dr[dr.current].prompt !== undefined && dr[dr.current].prompt !== (s.prompt || "");
  const refs = [...(s._gen || []), ...(s._refs || [])];
  const stag = { ok: '<span class="tag pass">视频提示词 ✓ 已审</span>', todo: '<span class="tag none">视频提示词待审</span>', bad: '<span class="tag rvbad">视频提示词有问题</span>' }[st];
  const nBad = lint.filter(x => x.lv === "bad").length, nWarn = lint.filter(x => x.lv === "warn").length;
  const lv = s.kind === "line" ? scriptVids().find(v => v.id === s.id) : null;
  const where = P.N[s.id] ? `${sceneName(s.id)}（场景视频）` : lv ? `${sceneName(lv.nid)} · 第 ${lv.i + 1} 句台词页（${P.N[lv.nid].lines[lv.i][0] || "旁白"}：${String(P.N[lv.nid].lines[lv.i][1]).slice(0, 24)}）` : s.kind === "line" ? `台词页 ${s.id}` : `插入镜头 ${s.id}`;
  const afTag = af ? ({ installed: '<span class="tag pass">已换进游戏</span>', needs_lipsync: '<span class="tag best">等口型同步</span>', human: '<span class="tag rvbad">重拍后仍不通过，待人看</span>', budget: '<span class="tag fb">预算到顶</span>', await_review: '<span class="tag none">等提示词审过才生成</span>', manual: '<span class="tag pass">人工选定</span>' }[af.status] || "") : "";
  return `<article class="rvcard pv vp st-${st}" data-k="${k}">
    <div class="pvleft">
      ${media.length ? `<div class="vview"><div class="vmain" data-vmain>${vMainHtml(media[mi], s)}</div>
        ${media.length > 1 ? `<div class="vthumbs">${media.map((m, j) => `<button class="vth${j === mi ? " on" : ""}" data-vm="${j}" title="${esc(m.cap)}">${m.t === "video" ? `<video src="${m.url}" muted preload="metadata"></video><i class="vplay">▶</i>` : `<img src="${m.url}" loading="lazy" alt="">`}<span>${esc(m.short)}</span></button>`).join("")}</div>` : ""}</div>`
        : '<div class="rvmiss">首帧图不存在</div>'}
      ${refs.length ? `<div class="rvsec"><label>参考图（${s.mode === "h3" ? "H3 参考模式会一起发" : "现在的生成方式不用参考图"}）</label><div class="pvrefs">${refs.map(r => `<span class="pvref on${r.ok ? "" : " miss"}" title="${esc(r.label)}">${r.ok ? `<img src="${fileUrl(r.rel)}" data-zoom="参考图 · ${esc(r.label)}" loading="lazy" alt="">` : "<i>缺图</i>"}<span>${esc(r.label)}</span></span>`).join("")}</div></div>` : ""}
      <details class="pvfull"><summary>实际发给视频模型的文字</summary><pre>${esc(vSent(s))}</pre></details>
      ${tries.length || has(vRel(s)) ? `<div class="rvsec vgone"><label>生成结果</label><div class="dim">${tries.length ? `生成过 ${tries.length} 次，最近一次：第 ${tries[tries.length - 1].n} 次 ${tries[tries.length - 1].pass ? "通过" : tries[tries.length - 1].error ? "出错" : `不通过 ${tries[tries.length - 1].score ?? "-"}/10`}` : "游戏里已经有视频"}。看结果、挑版本、配声音在「④ 成片」。</div></div>` : ""}
    </div>
    <div class="rvinfo">
      <div class="rvwhere"><span class="dim">${esc(where)}</span><span class="chip">${esc(s.id)}</span>${s.placeholder ? '<span class="tag best" title="剪辑台按剧本自动补的，提示词是从环境 / 画面描述抄来的">占位</span>' : ""}${s.novideo ? '<span class="tag none">不做视频</span>' : ""}${!scriptVids().some(v => v.id === s.id) ? '<span class="tag rvbad">剧本里没有了</span>' : ""}</div>
      <div class="rvtags">${stag}${afTag}${s.need_mouth ? `<span class="tag none" title="${esc((s.speakers || []).join("、"))}">要对口型</span>` : ""}${nBad ? `<span class="tag rvbad">${nBad} 处问题</span>` : ""}${nWarn ? `<span class="tag best">${nWarn} 处提醒</span>` : ""}${!lint.length ? '<span class="tag pass">自动检查没发现问题</span>' : ""}${up.length ? '<span class="tag best">↑ 上游改过</span>' : ""}</div>
      ${up.length ? `<div class="rvsec upbox"><ul class="pvlint">${up.map(f => `<li class="warn">${esc(f.t)}</li>`).join("")}</ul></div>` : ""}
      ${(fr => fr && !fr.ok && fr.note ? `<div class="rvsec upbox"><ul class="pvlint"><li class="warn">「④ 成片」里标了有问题：${esc(fr.note)}——改提示词后重新生成</li></ul></div>` : "")(((SB() || {}).review || {})["final:" + s.id])}
      ${lint.length ? `<ul class="pvlint">${lint.map(x => `<li class="${x.lv}">${esc(x.t)}</li>`).join("")}</ul>` : ""}
      <div class="pvfields">
        <div class="dim vmode">${esc(vModeText(s))} · ${s.duration || 6} 秒 · 每条约 ¥${s.cost || 2}<br>提示词来自：${esc(s.prompt_from || "—")}</div>
        <label>视频提示词（镜头怎么动、谁先做什么、谁在说话）<textarea data-vf="prompt" rows="7">${esc(s.prompt || "")}</textarea></label>
        <label>质检标准（生成后 AI 按这个检查）<textarea data-vf="describe" rows="4">${esc(s.describe || "")}</textarea></label>
        <label class="vauto"><input type="checkbox" data-vf="auto" ${s.auto ? "checked" : ""}> 批量跑时默认要做（autofix 不写镜头名时做这些）</label>
        <div class="vdur"><label>时长 <input type="number" data-vf="duration" min="3" max="10" step="1" value="${s.duration || 6}"> 秒</label>${s.duration_locked ? '<span class="tag none" title="手改过，按剧本算时长时不会动它">手改</span>' : ""}<span class="dim">${esc(s.duration_why || "还没按剧本算过时长（视频审阅顶部「⏱ 按剧本算时长」）")}</span></div>
        <label class="vauto"><input type="checkbox" data-vf="novideo" ${s.novideo ? "checked" : ""}> 不做视频（游戏里只用定格图；勾上后不算待审）</label>
      </div>
      <div class="rvact vdraftbar"><span class="dim">草稿：</span><button class="ghost" data-a="vdcode" title="免费，几秒：首帧 + 按提示词做镜头运动 + 动作提示条 + 有尾帧就淡入 + 有手绘轨迹就画出来；台词页带配音。预览选「草稿」在游戏里看">🎞 出草稿（免费）</button><button class="ghost" data-a="vdend" title="让 Gemini 按提示词画这段视频最后一刻的样子（约 $0.14），画完自动重出代码草稿（后半段淡入尾帧）">🖼 AI 画尾帧</button>${dr.end && s.last !== dr.end.file ? '<button class="ghost" data-a="vduse" title="正式生成时把这张当尾帧（首尾帧模式），动作的终点会锁得更准">用作正式尾帧</button>' : ""}${dr.end && s.last === dr.end.file ? '<button class="ghost" data-a="vdunuse" title="正式生成时不用尾帧">不用尾帧</button>' : ""}<button class="ghost" data-a="vd25" title="2.5D 预演（免费，要装 Blender）：首帧估深度变成立体场景，人 / 车抠成卡片在地上走，镜头、光照、颜色、雪按参数来；有手绘动作就加灰模手臂。参数在 motion_ref\\scenes\\${esc(s.id)}.json（第一次自动生成）">🧊 2.5D 预演</button><button class="ghost" data-a="vd25e" title="打开这条的 2.5D 参数文件（镜头运动、光照颜色、雪、要抠出来走动的人 / 车），改完再点「2.5D 预演」">参数</button><button class="ghost" data-a="vdlocal" title="用电脑上的开源视频模型（LTX-Video）出会动的草稿，不花 API 钱；要 NVIDIA 显卡，第一次要装 install_local_video.bat">🖥 本地模型草稿</button>${dstale ? '<span class="tag best" title="草稿是按旧提示词出的">提示词改过，草稿要重出</span>' : ""}</div>
      <div class="rvact"><button class="ghost" data-a="vsketch" title="在首帧上用鼠标录动作路线（按住拖动，边拖边计时），AI 整理后用代码生成参考视频">✎ 手绘动作</button><button class="ghost" data-a="vwrite" title="让 Gemini 看这张首帧图和剧本，重写这一条的视频提示词和质检标准（约 $0.01）；原来的存进 prompt_prev">✎ AI 重写</button><button class="pri" data-a="vok">✓ 视频提示词没问题<kbd>A</kbd></button><button class="ghost" data-a="vgen" title="交给视频模型生成，质检不通过会自动用 AI 改写的提示词重拍（最多 2 次）">▶ 生成视频（选模型）<kbd>R</kbd></button>${P.N[s.id] ? '<button class="ghost" data-a="goto">去故事板</button>' : ""}</div>
    </div></article>`;
}
function bindVCard(card, k) {
  const it = RV.items[k], s = vsShot(it.vid); if (!s) return;
  const media = vMedia(s), main = card.querySelector("[data-vmain]");
  card.querySelectorAll("[data-vm]").forEach(b => b.onclick = e => { e.stopPropagation(); const j = +b.dataset.vm; if (!media[j] || !main) return;
    RV.vsel = RV.vsel || {}; RV.vsel[s.id] = j; main.querySelectorAll("video").forEach(v => v.pause()); main.innerHTML = vMainHtml(media[j], s);
    card.querySelectorAll("[data-vm]").forEach(x => x.classList.toggle("on", x === b)); const v = main.querySelector("video"); if (v) v.play().catch(() => {}); });
  const save = async patch => { try { P.vs = await S.vsSave(P.dir, s.id, patch); toast("已保存到视频分镜表"); rvUpdateCard(k); rvCounts(); renderTop(); } catch (e) { toast(e.message, true); } };
  card.querySelectorAll("[data-vf]").forEach(x => x.onchange = () => save(x.dataset.vf === "duration" ? { duration: Math.round(Math.min(10, Math.max(3, +x.value || 6))), duration_locked: true } : { [x.dataset.vf]: x.type === "checkbox" ? x.checked : x.value.trim() }));
  const af = ((VS() || {}).state || {})[s.id], tries = (af && af.tries) || [];
  card.querySelectorAll("[data-vuse]").forEach(b => b.onclick = () => { const t = tries[+b.dataset.vuse]; if (t && t.prompt) save({ prompt: t.prompt, prompt_from: `第 ${t.n} 次生成用过的${t.ai_rewrite ? "（AI 改写）" : ""}` }); });
  const det = card.querySelector(".pvfull"); if (det) { det.open = !!RV.fullOpen; det.ontoggle = () => { RV.fullOpen = det.open; }; }
}

/* ---------- 剧本审阅：按剧本格式连着读、直接改、审阅状态、自动检查 ---------- */
const hashStr = s => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return h >>> 0; };
const lineText = l => `${l[0] || "旁白"}：${l[1] || ""}`;
const sceneKind = n => n.end ? "结局" : n.lock ? "谜题" : n.timer ? "限时选择" : (n.choices || []).length > 1 ? "分支" : "场景";
function sceneHash(nid) {                    // 剧本内容（台词、选项、结局文字…）任何一处改了，这一场就回到「待审」
  const n = P.N[nid];
  return hashStr(JSON.stringify([n.title || "", n.end || "", n.quote || "", n.epi || "", n.lines.map(l => [l[0], l[1]]), n.choices || [], n.lock || null, n.timer || 0, n.gainAt || {}]));
}
function scriptState(it) {
  const r = ((SB() || {}).review || {})["script:" + it.nid];
  return r && r.mtime === sceneHash(it.nid) ? (r.ok ? "ok" : "bad") : "todo";
}
const scriptItems = scope => (scope === "scene" ? [cur] : flatOrder()).filter(id => P.N[id]).map(nid => ({ nid, script: true }));
function storyGraph() {                       // 全局：从开头能走到哪些场景、哪些线索给出过 / 用到过、每场从哪来
  const ids = Object.keys(P.N), start = P.N.start ? "start" : flatOrder()[0];
  const reach = new Set([start]), q = [start];
  while (q.length) { const x = q.shift(); outs(P.N[x]).forEach(y => { if (P.N[y] && !reach.has(y)) { reach.add(y); q.push(y); } }); }
  const gained = new Set(ids.flatMap(id => P.N[id].gain || [])), used = new Set(), inc = {};
  ids.forEach(id => {
    const n = P.N[id];
    (n.choices || []).forEach(c => { if (c.if) used.add(c.if); (inc[c.to] = inc[c.to] || []).push({ from: id, t: `选「${c.t}」${c.if ? `（需要线索 ${P.CLUES[c.if] || c.if}）` : ""}` }); });
    if (n.lock) { (inc[n.lock.ok] = inc[n.lock.ok] || []).push({ from: id, t: "密码锁答对" }); (inc[n.lock.fail] = inc[n.lock.fail] || []).push({ from: id, t: "密码锁答错" }); }
  });
  return { start, reach, gained, used, inc };
}
function sceneChecks(nid, G) {
  const n = P.N[nid], out = [], add = (lv, t) => out.push({ lv, t }), cn = c => P.CLUES[c] || c;
  if (!G.reach.has(nid)) add("bad", n.end ? "这个结局从开头走不到：没有任何选项或密码锁通向它" : "这一场从开头走不到：没有任何选项或密码锁通向它");
  if (!n.end && !outs(n).length) add("bad", "死路：不是结局，也没有选项或密码锁通向下一场");
  const before = new Set([...cluesBefore(nid), ...(n.gain || [])]);
  (n.choices || []).forEach(c => {
    if (!P.N[c.to]) add("bad", `选项「${c.t}」指向不存在的场景 ${c.to}`);
    else if (c.to === nid) add("warn", `选项「${c.t}」指回本场`);
    if (c.if && !G.gained.has(c.if)) add("bad", `选项「${c.t}」需要线索「${cn(c.if)}」，但没有任何一场给出这条线索`);
    else if (c.if && !before.has(c.if)) add("bad", `选项「${c.t}」需要线索「${cn(c.if)}」，但走到这里的任何一条路上都拿不到它`);
  });
  if (n.lock) [["答对", n.lock.ok], ["答错", n.lock.fail]].forEach(([w, t]) => { if (!P.N[t]) add("bad", `密码锁${w}后去的场景 ${t} 不存在`); });
  const after = new Set([nid]), q2 = [nid]; while (q2.length) { const x = q2.shift(); outs(P.N[x]).forEach(y => { if (P.N[y] && !after.has(y)) { after.add(y); q2.push(y); } }); }
  const lockAfter = [...after].some(id => P.N[id].lock);   // 后面有密码锁：线索可能是给玩家推理用的，不算没用到
  (n.gain || []).forEach(c => { if (!P.CLUES[c]) add("warn", `给出的线索 ${c} 不在线索本里`); else if (!G.used.has(c) && !lockAfter) add("info", `线索「${cn(c)}」给出了，但后面既没有选项用到它，也没有需要推理的密码锁（只记进线索本）`); });
  const empty = [], noWho = [], noShot = [], noImg = [];
  n.lines.forEach((l, i) => {
    if (!isSpoken(l)) { if (l[0] === "@cap" && !String(l[1] || "").trim()) empty.push(i + 1); return; }
    if (!String(l[1] || "").trim() || l[1] === "（新台词）") empty.push(i + 1);
    if (!String(l[0] || "").trim()) noWho.push(i + 1);
    const im = limgOf(nid, i); if (!im) noShot.push(i + 1); else if (!has(limgRel(im))) noImg.push(i + 1);
  });
  if (empty.length) add("warn", `第 ${empty.join("、")} 句还是空的`);
  if (noWho.length) add("info", `第 ${noWho.join("、")} 句没写说话人（会当旁白）`);
  if (noShot.length) add("info", `第 ${noShot.join("、")} 句没有自己的分镜（播放时沿用上一张）`);
  if (noImg.length) add("info", `第 ${noImg.join("、")} 句的分镜还没出图`);
  return out;
}
function setLineText(nid, i, nt) {           // 改台词文字：配音对应表跟着改，并标「配音是旧的」
  const n = P.N[nid], l = n.lines[i], old = l[1]; if (old === nt) return false;
  if (l[0] !== "@cap") { const k = voKey(old); if (k) { delete P.VOT[cleanKey(old)]; P.VOT[cleanKey(nt)] = k; stale.add(nid + ":" + i); } }
  l[1] = nt; return true;
}
function scMove(nid, i, d) { const n = P.N[nid], j = i + d; if (j < 0 || j >= n.lines.length) return; [n.lines[i], n.lines[j]] = [n.lines[j], n.lines[i]]; shiftGain(n, i, j); moveStale(nid, i, j); }
function scDel(nid, i) {
  const n = P.N[nid]; n.lines.splice(i, 1);
  if (n.gainAt) for (const c in n.gainAt) { if (n.gainAt[c] === i) { delete n.gainAt[c]; n.gain = (n.gain || []).filter(x => x !== c); } else if (n.gainAt[c] > i) n.gainAt[c]--; }
  [...stale].filter(k => k.startsWith(nid + ":")).map(k => +k.split(":")[1]).sort((a, b) => a - b).forEach(x => { if (x === i) stale.delete(nid + ":" + x); else if (x > i) { stale.delete(nid + ":" + x); stale.add(nid + ":" + (x - 1)); } });
}
function scInsert(nid, at, line) {
  const n = P.N[nid]; n.lines.splice(at, 0, line); bump(n, at, 1);
  [...stale].filter(k => k.startsWith(nid + ":")).map(k => +k.split(":")[1]).sort((a, b) => b - a).forEach(x => { if (x >= at) { stale.delete(nid + ":" + x); stale.add(nid + ":" + (x + 1)); } });
}
function scriptCard(it, k) {
  const nid = it.nid, n = P.N[nid], st = scriptState(it), G = RV.G || (RV.G = storyGraph());
  const chk = sceneChecks(nid, G), r = ((SB() || {}).review || {})["script:" + nid];
  const clueAt = {}; Object.entries(n.gainAt || {}).forEach(([c, i]) => (clueAt[i] = clueAt[i] || []).push(c));
  const opts = sel => Object.keys(P.N).map(id => `<option value="${esc(id)}"${id === sel ? " selected" : ""}>${esc(sceneName(id))}（${esc(id)}）</option>`).join("");
  const down = scriptDownstream(nid);
  const rows = n.lines.map((l, i) => {
    const ops = `<span class="scops"><button class="icon" data-scup="${i}" title="上移">↑</button><button class="icon" data-scdown="${i}" title="下移">↓</button><button class="icon" data-scins="${i}" title="在下面插一句">＋</button><button class="icon" data-scdel="${i}" title="删除这一句">✕</button></span>`;
    const clue = (clueAt[i] || []).map(c => `<div class="scclue">◆ 获得线索：${esc(P.CLUES[c] || c)}</div>`).join("");
    if (l[0] === "@cap") { const cim = limgOf(nid, i), csh = cim ? shotOf(cim) : null;
      return `<div class="scl cap"><span class="scno">${i + 1}</span><span class="sccap">字幕卡</span><textarea class="sctext" data-sctxt="${i}" rows="1">${esc(l[1])}</textarea>${ops}</div>${csh && (csh.desc || csh.layout) ? `<div class="scdesc"><span>画面</span>${esc(csh.desc || csh.layout)} <button class="sclink" data-scpv="${esc(shotId(cim))}" title="去「提示词」审阅改这张图的画面描述">去改</button>${has(limgRel(cim)) ? ' <b style="color:var(--bad);font-weight:normal">（游戏里字幕卡不换画面，这张图现在不会出现）</b>' : ""}</div>` : ""}${clue}`; }
    if (l[0] === "@shot") {   // 插入镜头 = 动作描写：每张图一段画面描述（视频镜头读视频分镜表，定格特写读剧本里的 stills）
      const ims = shotImgs(l[1]).filter(x => has(limgRel(x)));
      const parts = (ims.length ? ims : ["s_" + l[1]]).map(x => { const v = vsShot(x);
        if (v) return `<div class="scstill"><textarea class="sctext" data-scshotdesc="${esc(v.id)}" rows="1" placeholder="这个动作镜头发生了什么：谁、在哪、在做什么">${esc(v.describe ?? v.prompt ?? "")}</textarea><div class="dim">${esc(x)} · 视频镜头 · <button class="sclink" data-scvid="${esc(v.id)}" title="去「视频提示词」审阅这条镜头的描述和提示词">去改描述</button></div></div>`;
        return `<div class="scstill"><textarea class="sctext" data-scstill="${esc(x)}" rows="1" placeholder="这张图画的是什么：谁、在哪、在做什么、镜头多近">${esc(stillDesc(x))}</textarea><div class="dim">${esc(x)} · ${has(`vid/${x}.mp4`) ? "视频镜头（视频分镜表里还没有这一条）" : "定格特写"}</div></div>`; }).join("");
      return `<div class="scl shot act" data-sc-review-line="${i}"><span class="scno">${i + 1}</span><span class="sccap">动作 · 镜头</span><div class="scactt">${parts}<div class="dim">@shot ${esc(l[1])}</div></div><span class="scimg">${ims.length ? ims.map(x => `<img data-sc-review-img="${esc(x)}" src="${fileUrl(limgRel(x))}" data-zoom="${esc(`${sceneName(nid)} · 第 ${i + 1} 句 · ${x}`)}" loading="lazy" alt="" title="${esc(x)}，双击放大">`).join("") : '<i title="还没有图：在「图片」审阅里换成本地图片；游戏里没有图时沿用场景图">未出图</i>'}${scriptVideoLinks(nid, i)}</span>${ops}</div>${clue}`;
    }
    if (String(l[0]).startsWith("@")) return `<div class="scl shot"><span class="scno">${i + 1}</span><span class="sccap">${esc(l[0])}</span><span class="dim">${esc(l[1])}</span>${ops}</div>${clue}`;
    const im = limgOf(nid, i), ok = im && has(limgRel(im)), sid = im ? shotId(im) : null, fl = sid ? upFlags(sid, "prompt") : [], sh = im ? shotOf(im) : null;
    const desc = `<div class="scdesc"><span>画面</span><textarea class="sctext scdtext" data-scdesc="${i}" rows="1" placeholder="${esc(sh && sh.layout ? "构图：" + sh.layout : "这句话说的时候画面里是什么：谁在哪、在做什么、镜头多近（写了就会在分镜表里建这一句，之后可以出图）")}">${esc(sh ? sh.desc || "" : "")}</textarea>${sh ? `<button class="sclink" data-scpv="${esc(sid)}" title="去「提示词」审阅看这一句的构图、景别、参考图">提示词</button>` : ""}</div>`;
    return `<div class="scl${fl.length ? " up" : ""}" data-sc-review-line="${i}"><span class="scno">${i + 1}</span><input class="scwho" data-scwho="${i}" value="${esc(l[0])}" placeholder="旁白"><textarea class="sctext" data-sctxt="${i}" rows="1">${esc(l[1])}</textarea>
      <span class="scimg">${ok ? `<img data-sc-review-img="${esc(im)}" src="${fileUrl(limgRel(im))}" data-zoom="${esc(`${sceneName(nid)} · 第 ${i + 1} 句 · ${sid}`)}" loading="lazy" alt="" title="${esc(sid)}，双击放大">` : `<i title="${im ? "分镜还没出图" : "没有自己的分镜，沿用上一张"}">${im ? "未出图" : "—"}</i>`}${scriptVideoLinks(nid, i)}</span>${ops}</div>${desc}${clue}${fl.length ? `<div class="scdown">↓ 台词改过，分镜 ${esc(sid)} 的提示词要复查</div>` : ""}`;
  }).join("");
  const choices = n.end ? "" : n.lock
    ? `<div class="scch lock">密码锁：${n.lock.answer ? n.lock.answer.length + " 位" : ""}${n.lock.tries ? " · " + n.lock.tries + " 次机会" : ""} · 答对 → ${esc(sceneName(n.lock.ok) || n.lock.ok)} · 答错 → ${esc(P.N[n.lock.fail] ? sceneName(n.lock.fail) : n.lock.fail)} <span class="dim">（在右侧属性面板里改）</span></div>`
    : `<div class="scchs"><div class="sclabel">${n.timer ? `限时 ${n.timer} 秒的选择（超时默认选第 ${(n.def || 0) + 1} 个）` : (n.choices || []).length === 1 ? "继续" : "选择"}</div>${(n.choices || []).map((c, j) => `<div class="scch"><span>◇</span><input data-scct="${j}" value="${esc(c.t)}"><span class="dim">→</span><select data-sccto="${j}">${opts(c.to)}</select><select data-sccif="${j}" title="需要的线索"><option value="">不需要线索</option>${Object.keys(P.CLUES).map(x => `<option value="${esc(x)}"${x === c.if ? " selected" : ""}>需要：${esc((P.CLUES[x] || x).slice(0, 14))}</option>`).join("")}</select><button class="icon" data-scgo="${esc(c.to)}" title="跳到那一场">↘</button><button class="icon" data-sccdel="${j}" title="删除这个选项">✕</button></div>`).join("")}<button class="ghost scadd" data-sccadd>＋ 选项</button></div>`;
  const ending = n.end ? `<div class="scend"><label>结局名<input data-scend value="${esc(n.end)}"></label><label>引言<textarea data-scquote rows="2">${esc(n.quote || "")}</textarea></label><label>尾声（每行一句）<textarea data-scepi rows="3">${esc((n.epi || []).join("\n"))}</textarea></label></div>` : "";
  const inc = nid === G.start ? '<span class="tag pass">开头</span>' : (G.inc[nid] || []).map(x => `<button class="sclink" data-scgo="${esc(x.from)}">${esc(sceneName(x.from))}</button> ${esc(x.t)}`).join("；") || '<span class="dim">没有任何地方通向这里</span>';
  const stag = { ok: '<span class="tag pass">剧本 ✓ 已审</span>', todo: '<span class="tag none">剧本待审</span>', bad: '<span class="tag rvbad">剧本有问题</span>' }[st];
  const nBad = chk.filter(x => x.lv === "bad").length, nWarn = chk.filter(x => x.lv === "warn").length;
  return `<article class="rvcard sc st-${st}" data-k="${k}">
    <div class="scmain">
      <div class="schead">${n.end ? `<b class="scend-t">结局 · ${esc(n.end)}</b>` : `<input class="sctitle" data-sctitle value="${esc(n.title || "")}" placeholder="${esc(nid)}">`}<span class="chip">${esc(nid)}</span><span class="tag none">${sceneKind(n)}</span></div>
      <div class="scfrom"><span class="sclabel">从哪来</span>${inc}</div>
      <div class="scenv"><span class="sclabel">环境</span><textarea data-scenv rows="2" placeholder="这一场在哪、什么时间、天气光线、气氛（也是场景图的画面提示词）">${esc(n.img || "")}</textarea><span class="scenv-media">${has(`img/${nid}.jpg`) ? `<img data-sc-review-img="${esc(nid)}" src="${fileUrl(`img/${nid}.jpg`)}" data-zoom="${esc(`${sceneName(nid)} · 场景图`)}" loading="lazy" alt="" title="场景图：这一场没有逐句图的台词都显示它，双击放大">` : ""}${scriptVideoLinks(nid, null)}</span></div>
      <div class="sclines">${rows || `<div class="dim">${n.end ? "结局没有台词（只有下面的结局文字）" : "这一场还没有台词"}</div>`}<div class="scaddrow"><button class="ghost scadd" data-scins="${n.lines.length - 1}">＋ 台词</button><button class="ghost scadd" data-sccap>＋ 字幕卡</button><button class="ghost scadd" data-scact title="加一段没有台词的动作或镜头（比如：女人把信封塞进座椅缝里）。游戏里播放它的视频或定格图">＋ 动作 · 镜头</button></div></div>
      ${choices}${ending}
    </div>
    <div class="rvinfo">
      <div class="rvwhere"><span class="dim">${esc(sceneName(nid))} · ${n.lines.filter(isSpoken).length} 句台词</span></div>
      <div class="rvtags">${stag}${nBad ? `<span class="tag rvbad">${nBad} 处问题</span>` : ""}${nWarn ? `<span class="tag best">${nWarn} 处提醒</span>` : ""}${!nBad && !nWarn ? '<span class="tag pass">自动检查没发现问题</span>' : ""}${down.length ? `<span class="tag best">下游 ${down.length} 处要复查</span>` : ""}</div>
      ${chk.length ? `<ul class="pvlint">${chk.map(x => `<li class="${x.lv}">${esc(x.t)}</li>`).join("")}</ul>` : ""}
      <div class="rvsec"><label>这一场的提示词 · 图片 · 视频（点一格跳过去；「缺」= 还没有）</label>${bindTable(nid)}</div>
      ${down.length ? `<div class="rvsec"><label>剧本改过，下游要复查</label><ul class="pvlint">${down.map(x => `<li class="warn">${esc(x.sid)}：${esc(x.t)}</li>`).join("")}</ul><div class="row"><button class="ghost" data-a="sdown">去提示词审阅看这几条</button></div></div>` : ""}
      ${!r ? auditReviewNote(((SB() || {}).review || {})[it.sid], (P.files[limgRel(it.im)] || {}).revision || (P.files[limgRel(it.im)] || {}).mtime) : ""}
      ${r && !r.ok && r.note ? `<div class="rvsec"><label>审阅意见</label><div class="rvnotev">${esc(r.note)}</div></div>` : ""}
      <div class="dim scnote">改动和时间线是同一份剧本：Ctrl+Z 撤销，Ctrl+S 保存。改了文字的台词，配音会标「是旧的」。</div>
      <div class="rvact"><button class="pri" data-a="sok">✓ 剧本没问题<kbd>A</kbd></button><button class="ghost" data-a="sbad">✗ 有问题<kbd>X</kbd></button><button class="ghost" data-a="goto">去故事板</button></div>
      <div class="rvnote" hidden><textarea placeholder="哪里不对？比如：这里大军的说法和前面矛盾">${esc(r && !r.ok ? r.note : "")}</textarea><div class="row"><button class="pri" data-a="snoteSave">记下</button></div></div>
    </div></article>`;
}
function bindScriptCard(card, k) {
  const it = RV.items[k], nid = it.nid, n = P.N[nid];
  bindScriptVideos(card, nid);
  const ed = fn => { edit(fn); RV.G = null; rvUpdateCard(k); rvCounts(); };
  const grow = t => { t.style.height = "auto"; t.style.height = t.scrollHeight + 2 + "px"; };
  card.querySelectorAll("textarea.sctext").forEach(t => { grow(t); t.addEventListener("input", () => grow(t)); });
  card.querySelectorAll("[data-sctxt]").forEach(x => x.onchange = () => { const i = +x.dataset.sctxt, v = x.value.trim(); if (v !== n.lines[i][1]) ed(() => setLineText(nid, i, v)); });
  card.querySelectorAll("[data-scwho]").forEach(x => x.onchange = () => ed(() => { n.lines[+x.dataset.scwho][0] = x.value.trim(); }));
  card.querySelectorAll("[data-scup]").forEach(b => b.onclick = () => ed(() => scMove(nid, +b.dataset.scup, -1)));
  card.querySelectorAll("[data-scdown]").forEach(b => b.onclick = () => ed(() => scMove(nid, +b.dataset.scdown, 1)));
  card.querySelectorAll("[data-scdel]").forEach(b => b.onclick = () => ed(() => scDel(nid, +b.dataset.scdel)));
  card.querySelectorAll("[data-scins]").forEach(b => b.onclick = () => { const i = +b.dataset.scins, prev = n.lines[i]; ed(() => scInsert(nid, i + 1, [prev && isSpoken(prev) ? prev[0] : "", "（新台词）"])); const t = RV.el.querySelector(`.rvcard[data-k="${k}"] [data-sctxt="${i + 1}"]`); if (t) { t.focus(); t.select(); } });
  const act = card.querySelector("[data-scact]"); if (act) act.onclick = async () => {   // 新的动作 · 镜头 = 一行 @shot：先写画面描述，图和视频之后补（图片审阅里换成本地图片，或做视频）
    const v = await askText("新的动作 · 镜头：画面里发生了什么？", "谁、在哪、在做什么、镜头多近。比如：特写，女人趁司机不注意，把白信封塞进座椅缝里");
    if (!v || !v.text) return;
    let j = 1, name; do { name = `${nid}_act${j++}`; } while ((P.SHOTS || []).includes(name) || has(`img/s_${name}.jpg`) || has(`vid/s_${name}.mp4`));
    ed(() => { scInsert(nid, n.lines.length, ["@shot", name]); (n.stills = n.stills || {})["s_" + name] = v.text; P.SHOTS = P.SHOTS || []; if (!P.SHOTS.includes(name)) P.SHOTS.push(name); });
    toast(`已加在这一场末尾（镜头名 ${name}），可以用 ↑↓ 挪到要的位置。图在「图片」审阅里换成本地图片，视频放 vid/s_${name}.mp4`);
    ensureVsSlots();   // 视频分镜表里同时占一个位
  };
  const cap = card.querySelector("[data-sccap]"); if (cap) cap.onclick = () => ed(() => scInsert(nid, n.lines.length, ["@cap", "时间 · 地点"]));
  card.querySelectorAll("[data-scdesc]").forEach(t => { grow(t); t.addEventListener("input", () => grow(t)); t.onchange = async () => {   // 每句的画面描述 = 分镜表这一句的 desc；这一句还没有分镜就新建一条
    const i = +t.dataset.scdesc, v = t.value.trim(), im = limgOf(nid, i), sh = im ? shotOf(im) : null;
    if (v === (sh ? sh.desc || "" : "")) return;
    try {
      if (sh) P.sb = await S.sbSaveShot(P.dir, { id: sh.id, desc: v });
      else if (v) { const id = await ensureShot(i, nid, v); toast(`已在分镜表里新建 ${id}，之后可以在「提示词」审阅补构图、出图`); }
      else return;
      if (sh) toast("画面描述已保存到分镜表（这一句的提示词回到待审）");
      rvUpdateCard(k); rvCounts(); renderTop();
    } catch (e) { toast(e.message, true); }
  }; });
  card.querySelectorAll("[data-scshotdesc]").forEach(t => t.onchange = async () => {
    const id = t.dataset.scshotdesc, shot = vsShot(id), value = t.value.trim();
    if (!shot || value === (shot.describe ?? shot.prompt ?? "")) return;
    t.disabled = true;
    try {
      P.vs = await S.vsSave(P.dir, id, { describe: value });
      P.sb = await S.sbReview(P.dir, "vprompt:" + id, null);
      toast("动作描述已保存，视频提示词回到待审；请在「③ 草稿」复查提示词");
      rvUpdateCard(k); rvCounts(); renderTop();
    } catch (e) { toast(e.message, true); }
    finally { t.disabled = false; }
  });
  card.querySelectorAll("[data-scstill]").forEach(t => t.onchange = () => { const img = t.dataset.scstill, v = t.value.trim();
    ed(() => { Object.values(P.N).forEach(m => { if (m.stills) { delete m.stills[img]; if (!Object.keys(m.stills).length) delete m.stills; } }); if (v) (n.stills = n.stills || {})[img] = v; }); });
  const env = card.querySelector("[data-scenv]"); if (env) { grow(env); env.addEventListener("input", () => grow(env)); env.onchange = () => ed(() => { const v = env.value.trim(); if (v) n.img = v; else delete n.img; }); }
  const jump = (kind, find) => { RV.kind = kind; RV.filter = "all"; rvBuild(); const kk = RV.items.findIndex(find); if (kk >= 0) rvFocus(kk); };
  card.querySelectorAll("[data-go]").forEach(b => b.onclick = e => { e.stopPropagation(); const [kind, id] = b.dataset.go.split(":");
    if (kind === "video") jump("video", x => x.vid === id); else jump(kind, x => x.sid === id); });
  card.querySelectorAll("[data-scvid]").forEach(b => b.onclick = e => { e.stopPropagation(); jump("video", x => x.vid === b.dataset.scvid); });
  card.querySelectorAll("[data-scpv]").forEach(b => b.onclick = e => { e.stopPropagation(); jump("prompt", x => x.sid === b.dataset.scpv); });
  const ti = card.querySelector("[data-sctitle]"); if (ti) ti.onchange = () => ed(() => { const v = ti.value.trim(); if (v) n.title = v; else delete n.title; });
  card.querySelectorAll("[data-scct]").forEach(x => x.onchange = () => ed(() => { n.choices[+x.dataset.scct].t = x.value.trim(); }));
  card.querySelectorAll("[data-sccto]").forEach(x => x.onchange = () => ed(() => { n.choices[+x.dataset.sccto].to = x.value; }));
  card.querySelectorAll("[data-sccif]").forEach(x => x.onchange = () => ed(() => { const c = n.choices[+x.dataset.sccif]; if (x.value) c.if = x.value; else delete c.if; }));
  card.querySelectorAll("[data-sccdel]").forEach(b => b.onclick = () => { if ((n.choices || []).length <= 1) return toast("至少要留一个选项", true); ed(() => n.choices.splice(+b.dataset.sccdel, 1)); });
  const add = card.querySelector("[data-sccadd]"); if (add) add.onclick = () => ed(() => { n.choices = n.choices || []; n.choices.push({ t: "新选项", to: nid }); });
  const e1 = card.querySelector("[data-scend]"); if (e1) e1.onchange = () => { const v = e1.value.trim(); if (v) ed(() => { n.end = v; }); };
  const e2 = card.querySelector("[data-scquote]"); if (e2) e2.onchange = () => ed(() => { n.quote = e2.value.trim(); });
  const e3 = card.querySelector("[data-scepi]"); if (e3) e3.onchange = () => ed(() => { n.epi = e3.value.split("\n").map(s => s.trim()).filter(Boolean); });
  card.querySelectorAll("[data-scgo]").forEach(b => b.onclick = () => {
    const to = b.dataset.scgo; let kk = RV.items.findIndex(x => x.nid === to);
    if (kk < 0) { RV.scope = "all"; RV.filter = "all"; rvBuild(); kk = RV.items.findIndex(x => x.nid === to); }
    if (kk >= 0) rvFocus(kk);
  });
}

/* ---------- 上游改了，提示下游复查：剧本 → 提示词 → 图片；参考图 → 图片 ---------- */
// review.json 里记「上游基准」：up:prompt:<镜头> = 提示词确认时的台词；up:img:<镜头> = 图片确认时的提示词指纹、参考图时间、图片时间
const upKey = (kind, sid) => `up:${kind}:${sid}`;
function shotLines() {                        // 镜头 → 它对应的台词（同一镜头只记第一次出现）
  const m = {};
  Object.keys(P.N).forEach(nid => P.N[nid].lines.forEach((l, i) => { if (!isSpoken(l)) return; const im = limgOf(nid, i); if (!im) return; const sid = shotId(im); if (!m[sid]) m[sid] = { nid, i, text: lineText(l) }; }));
  return m;
}
const shotRefM = shot => Math.max(0, ...(shot.refs || []).map(r => (refById(r.split("/").pop().replace(/\.\w+$/, "")) || {}).mtime || 0));
function upNow(sid, SL) {
  const sh = SB() && SB().shots.find(x => x.id === sid), f = P.files[limgRel("l/" + sid)];
  return { line: ((SL || shotLines())[sid] || {}).text || "", ph: sh ? promptHash(sh) : 0, refm: sh ? shotRefM(sh) : 0, imgm: f ? f.mtime : 0 };
}
function upFlags(sid, kind) {
  const sb = SB(); if (!sb || !sid) return [];
  const b = (sb.review || {})[upKey(kind, sid)]; if (!b) return [];
  const now = upNow(sid), out = [];
  if (kind === "prompt") { if (b.line !== undefined && b.line !== now.line) out.push({ what: "script", t: `台词改过：原来「${b.line}」，现在「${now.line}」` }); }
  else if (b.imgm && b.imgm === now.imgm) {   // 图没换过，上游却变了：这张图是按旧的画的
    if (b.ph && b.ph !== now.ph) out.push({ what: "prompt", t: "分镜提示词（或参考图选择、构图图）改过，这张图是按旧的画的" });
    if (b.refm && now.refm > b.refm) out.push({ what: "ref", t: "用到的参考图重新生成或换过" });
  }
  return out;
}
async function upAck(sids, kind) {            // 下游确认过了：把现在的上游记成新的基准
  if (!SB() || !sids.length) return;
  const SL = shotLines(), at = new Date().toISOString(), e = {};
  sids.forEach(sid => { const now = upNow(sid, SL); e[upKey(kind, sid)] = kind === "prompt" ? { line: now.line, at } : { ph: now.ph, refm: now.refm, imgm: now.imgm, at }; });
  try { P.sb = await S.sbReviewMany(P.dir, e); } catch (err) { toast(err.message, true); }
}
let upBusy = false;
async function ensureUpBase() {               // 还没有基准的镜头：把现在的状态记成基准（第一次打开时全部记一遍）
  const sb = SB(); if (!sb || upBusy) return; upBusy = true;
  try {
    const rv = sb.review || {}, SL = shotLines(), at = new Date().toISOString(), e = {};
    Object.keys(SL).forEach(sid => {
      const now = upNow(sid, SL);
      if (!rv[upKey("prompt", sid)]) e[upKey("prompt", sid)] = { line: now.line, at };
      if (!rv[upKey("img", sid)] && now.imgm) e[upKey("img", sid)] = { ph: now.ph, refm: now.refm, imgm: now.imgm, at };
      else if (rv[upKey("img", sid)] && !rv[upKey("img", sid)].imgm && now.imgm) e[upKey("img", sid)] = { ph: now.ph, refm: now.refm, imgm: now.imgm, at };
    });
    if (Object.keys(e).length) P.sb = await S.sbReviewMany(P.dir, e);
  } catch {} finally { upBusy = false; }
}
function scriptDownstream(nid) {              // 这一场里，台词改过、提示词还没复查的镜头
  const out = [];
  P.N[nid].lines.forEach((l, i) => { if (!isSpoken(l)) return; const im = limgOf(nid, i); if (!im) return; const sid = shotId(im); upFlags(sid, "prompt").forEach(f => out.push({ sid, t: f.t })); });
  return out;
}
function upHtml(it, kind) {                   // 提示词 / 图片卡片上的「上游改过」提示
  if (!it.im) return "";
  const sid = shotId(it.im), fl = upFlags(sid, kind), pre = kind === "img" ? upFlags(sid, "prompt") : [];
  if (!fl.length && !pre.length) return "";
  return `<div class="rvsec upbox"><label>↑ 上游改过，要复查</label><ul class="pvlint">${fl.map(f => `<li class="warn">${esc(f.t)}</li>`).join("")}${pre.map(f => `<li class="info">上游的提示词还在等复查：${esc(f.t)}</li>`).join("")}</ul>
    ${fl.length ? `<div class="row"><button class="ghost" data-a="upack" title="看过了，不用改：把现在的上游记成新的基准">已核对，不用改</button>${kind === "img" ? '<button class="ghost" data-a="redraw">按现在的提示词重画</button>' : ""}</div>` : ""}</div>`;
}
const upTag = (it, kind) => it.im && upFlags(shotId(it.im), kind).length ? '<span class="tag best">↑ 上游改过</span>' : "";

/* ---------- 手绘构图：用鼠标画简单的构图 → 直接用，或让 AI 整理成干净的 SVG → 存成构图图（storyboard\sketch），出图时一起参考 ---------- */
/* ---------- 手绘动作：在首帧上用鼠标录轨迹（按住拖动，边拖边计时），AI 整理后生成参考视频（autofix/motion_sketch.py） ---------- */
const MS_COLORS = ["#ff4646", "#3cc8ff", "#78ff78", "#ffd23c"], MS_DUR = 6;
const MS_CAM = [["static", "镜头不动"], ["auto", "让 AI 建议"], ["push_in", "推近"], ["pull_out", "拉远"], ["pan_left", "向左摇"], ["pan_right", "向右摇"], ["tilt_up", "上摇"], ["tilt_down", "下摇"]];
let msUI = null;
async function openMotionSketch(vid) {
  if (msUI) return;
  const kfRel = has(`img/${vid}.jpg`) ? `img/${vid}.jpg` : has(`img/l/${vid}.jpg`) ? `img/l/${vid}.jpg` : null;
  if (!kfRel) return toast(`找不到首帧图 img/${vid}.jpg`, true);
  const rawRel = `storyboard/sketch/${vid}_motion.json`;
  let saved = null; try { const t = await S.sketchRead(P.dir, rawRel); saved = t ? JSON.parse(t) : null; } catch {}
  const U = msUI = { vid, subs: saved && saved.subjects ? saved.subjects : [{ label: "", color: MS_COLORS[0], points: [] }], cam: (saved && saved.camera) || { move: "static", amount: 0.3 }, action: (saved && saved.action) || "", sel: 0, t: 0, rec: null, play: null, busy: false, dirty: false };
  const m = document.createElement("div"); m.className = "modal skx";
  m.innerHTML = `<div class="skbox msbox" role="dialog" aria-label="手绘动作">
    <div class="fbhead"><b>手绘动作</b><span class="chip">${esc(vid)}</span><span class="dim fbline">先选左边列表里的一个对象，在首帧上按住鼠标拖动：拖的路线和快慢就是它 6 秒里的动作（松手或到 6 秒停止）。</span><button class="icon" id="msX" title="关闭（Esc）">✕</button></div>
    <div class="skwork">
      <div class="skstage"><div class="skwrap mswrap" id="msWrap"><img id="msImg" src="${fileUrl(kfRel)}" alt="" draggable="false" data-nozoom><canvas id="msCv"></canvas><div class="mstime" id="msTime">0.0 / 6.0 秒</div></div></div>
      <div class="skside">
        <div><label>动作对象（每个对象一条路线）</label><div id="msSubs" class="mssubs"></div><button class="ghost" id="msAdd">＋ 再加一个对象</button></div>
        <div><label>镜头运动</label><div class="row"><select id="msCam">${MS_CAM.map(([v, n]) => `<option value="${v}">${n}</option>`).join("")}</select><input type="range" id="msAmt" min="0.05" max="1" step="0.05" title="幅度"></div></div>
        <div><label>一句话动作（可以不写，AI 会根据路线写）</label><textarea id="msAct" rows="2" placeholder="比如：女人放下合十的双手，伸手去握皮箱的把手"></textarea></div>
        <div class="row"><button class="ghost" id="msPlay">▶ 预览动作</button><button class="ghost" id="msSave">保存</button></div>
        <button class="pri" id="msAI" title="把路线修顺、精简成关键点；AI 认出每条路线是谁、写动作和视频提示词；再用代码生成参考视频（约 $0.01）">AI 整理并生成参考视频</button>
        <div id="msOut" class="msout" hidden><label>参考视频（代码生成，只用来看动作）</label><video id="msVid" controls muted loop></video><div id="msInfo" class="dim"></div></div>
        <div class="grow"></div><div id="msMsg" class="fbmsg"></div>
      </div>
    </div></div>`;
  document.body.appendChild(m);
  const q = s => m.querySelector(s), cv = q("#msCv"), img = q("#msImg"), ctx = cv.getContext("2d");
  const msg = (t, err) => { const e = q("#msMsg"); e.textContent = t; e.classList.toggle("err", !!err); };
  q("#msCam").value = U.cam.move; q("#msAmt").value = U.cam.amount; q("#msAct").value = U.action;
  const at = (pts, t) => { if (!pts.length) return null; if (t <= pts[0][2]) return pts[0]; for (let i = 1; i < pts.length; i++) if (pts[i][2] >= t) { const a = pts[i - 1], b = pts[i], f = (t - a[2]) / Math.max(1e-6, b[2] - a[2]); return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, t]; } return pts[pts.length - 1]; };
  function size() { cv.width = img.clientWidth * devicePixelRatio; cv.height = img.clientHeight * devicePixelRatio; cv.style.width = img.clientWidth + "px"; cv.style.height = img.clientHeight + "px"; draw(); }
  function draw() {
    const W = cv.width, H = cv.height, lw = Math.max(2, W / 320); ctx.clearRect(0, 0, W, H);
    U.subs.forEach((s, k) => {
      const p = s.points; if (!p.length) return;
      ctx.strokeStyle = s.color; ctx.lineWidth = k === U.sel ? lw * 1.6 : lw; ctx.lineJoin = ctx.lineCap = "round"; ctx.globalAlpha = .9;
      ctx.beginPath(); p.forEach(([x, y], i) => i ? ctx.lineTo(x * W, y * H) : ctx.moveTo(x * W, y * H)); ctx.stroke();
      ctx.fillStyle = s.color; ctx.beginPath(); ctx.arc(p[0][0] * W, p[0][1] * H, lw * 2.2, 0, 7); ctx.fill();
      const cur = (U.rec || U.play) ? at(p, U.t) : null;
      if (cur) { ctx.globalAlpha = 1; ctx.beginPath(); ctx.arc(cur[0] * W, cur[1] * H, W * .022, 0, 7); ctx.fill(); ctx.strokeStyle = "#fff"; ctx.lineWidth = lw; ctx.stroke(); }
      if (s.label) { ctx.globalAlpha = 1; ctx.font = `${Math.round(W / 50)}px "Microsoft YaHei", sans-serif`; ctx.lineWidth = 4; ctx.strokeStyle = "#000"; ctx.strokeText(s.label, p[0][0] * W + lw * 3, p[0][1] * H - lw * 3); ctx.fillText(s.label, p[0][0] * W + lw * 3, p[0][1] * H - lw * 3); }
    });
    ctx.globalAlpha = 1; q("#msTime").textContent = `${U.t.toFixed(1)} / ${MS_DUR.toFixed(1)} 秒`;
  }
  function subsUI() {
    q("#msSubs").innerHTML = U.subs.map((s, k) => `<div class="mssub${k === U.sel ? " on" : ""}" data-k="${k}"><i style="background:${s.color}"></i><input data-lab="${k}" value="${esc(s.label)}" placeholder="对象 ${k + 1}：比如 女人的右手"><span class="dim">${s.points.length ? (s.points[s.points.length - 1][2]).toFixed(1) + " 秒" : "未录"}</span><button class="icon" data-clr="${k}" title="清掉这条路线重录">↺</button>${U.subs.length > 1 ? `<button class="icon" data-del="${k}" title="删掉这个对象">✕</button>` : ""}</div>`).join("");
    q("#msSubs").querySelectorAll(".mssub").forEach(d => d.onclick = e => { if (e.target.closest("input,button")) return; U.sel = +d.dataset.k; subsUI(); draw(); });
    q("#msSubs").querySelectorAll("[data-lab]").forEach(x => { x.onfocus = () => { U.sel = +x.dataset.lab; }; x.oninput = () => { U.subs[+x.dataset.lab].label = x.value; U.dirty = true; draw(); }; });
    q("#msSubs").querySelectorAll("[data-clr]").forEach(b => b.onclick = () => { U.subs[+b.dataset.clr].points = []; U.dirty = true; subsUI(); draw(); });
    q("#msSubs").querySelectorAll("[data-del]").forEach(b => b.onclick = () => { U.subs.splice(+b.dataset.del, 1); U.sel = 0; U.dirty = true; subsUI(); draw(); });
  }
  const pos = e => { const r = cv.getBoundingClientRect(); return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))]; };
  cv.addEventListener("pointerdown", e => {
    if (U.busy || e.button !== 0) return; stopPlay(); const s = U.subs[U.sel]; if (!s) return;
    const [x, y] = pos(e); s.points = [[+x.toFixed(4), +y.toFixed(4), 0]]; U.rec = { t0: performance.now(), last: [x, y] }; U.t = 0; U.dirty = true; cv.setPointerCapture(e.pointerId);
    const tick = () => { if (!U.rec) return; U.t = Math.min(MS_DUR, (performance.now() - U.rec.t0) / 1000); if (U.t >= MS_DUR) return endRec(); draw(); requestAnimationFrame(tick); }; tick();
  });
  cv.addEventListener("pointermove", e => {
    if (!U.rec) return; const [x, y] = pos(e), t = (performance.now() - U.rec.t0) / 1000; if (t > MS_DUR) return endRec();
    const s = U.subs[U.sel], l = s.points[s.points.length - 1];
    if (Math.hypot(x - l[0], y - l[1]) > .002 || t - l[2] > .1) s.points.push([+x.toFixed(4), +y.toFixed(4), +t.toFixed(3)]);
  });
  function endRec() {
    if (!U.rec) return; const s = U.subs[U.sel], t = Math.min(MS_DUR, (performance.now() - U.rec.t0) / 1000), l = s.points[s.points.length - 1];
    if (t - l[2] > .05) s.points.push([l[0], l[1], +t.toFixed(3)]);      // 停着不动的那段时间也记下
    U.rec = null; if (s.points.length < 3) { s.points = []; msg("太短了：按住鼠标拖动一段再松手", true); } else msg(`录好了：${s.label || "对象 " + (U.sel + 1)}，${t.toFixed(1)} 秒`);
    subsUI(); draw();
  }
  cv.addEventListener("pointerup", endRec); cv.addEventListener("pointercancel", endRec);
  function stopPlay() { U.play = null; q("#msPlay").textContent = "▶ 预览动作"; }
  q("#msPlay").onclick = () => {
    if (U.play) { stopPlay(); draw(); return; }
    if (!U.subs.some(s => s.points.length)) return msg("还没录任何路线", true);
    U.play = { t0: performance.now() }; q("#msPlay").textContent = "■ 停止";
    const tick = () => { if (!U.play) return; U.t = ((performance.now() - U.play.t0) / 1000) % MS_DUR; draw(); requestAnimationFrame(tick); }; tick();
  };
  q("#msAdd").onclick = () => { if (U.subs.length >= 4) return msg("最多 4 个对象", true); U.subs.push({ label: "", color: MS_COLORS[U.subs.length % MS_COLORS.length], points: [] }); U.sel = U.subs.length - 1; subsUI(); draw(); };
  q("#msCam").onchange = () => { U.cam.move = q("#msCam").value; U.dirty = true; };
  q("#msAmt").oninput = () => { U.cam.amount = +q("#msAmt").value; U.dirty = true; };
  q("#msAct").oninput = () => { U.action = q("#msAct").value; U.dirty = true; };
  async function save() {
    const data = { vid, subjects: U.subs.filter(s => s.points.length >= 2), camera: U.cam, action: U.action.trim(), dur: MS_DUR, saved_at: new Date().toISOString() };
    if (!data.subjects.length) { msg("还没录任何路线", true); return false; }
    try { await S.sketchWrite(P.dir, rawRel, JSON.stringify(data, null, 1), false); U.dirty = false; msg("已保存（storyboard\\sketch\\" + vid + "_motion.json）"); return true; } catch (e) { msg(e.message, true); return false; }
  }
  q("#msSave").onclick = save;
  q("#msAI").onclick = async () => {
    if (U.busy) return; if (!await save()) return;
    U.busy = true; q("#msAI").disabled = true; msg("AI 整理中，然后生成参考视频（第一次要装 playwright 的话会失败，看右下角日志）…");
    if (!await runTool("motion_sketch.py", [vid], `手绘动作 · AI 整理 · ${vid}`, { kind: "sketch", U })) { U.busy = false; q("#msAI").disabled = false; msg("没能启动", true); }
  };
  U.done = async (code, log = "") => {
    U.busy = false; q("#msAI").disabled = false;
    const res = (log.match(/RESULT:(\S+)/) || [])[1], err = (log.match(/ERROR:(.+)/) || [])[1];
    if (code !== 0 || !res) return msg("× " + (err || "没成功，看一下右下角的日志"), true);
    const warn = log.split("\n").filter(l => l.includes("⚠")).map(l => l.trim()), pr = (log.match(/提示词：(.+)/) || [])[1];
    q("#msOut").hidden = false; q("#msVid").src = fileUrl("../" + res) + "&r=" + Date.now(); q("#msVid").play().catch(() => {});
    q("#msInfo").innerHTML = (pr ? `<div><b>AI 写的视频提示词：</b>${esc(pr)}</div>` : "") + warn.map(w => `<div style="color:var(--warn)">${esc(w)}</div>`).join("") + `<div>轨迹已写入 autofix\\test_motion\\${esc(vid)}\\motion.json，轨迹测试（test_motion.bat ${esc(vid)}）会用这条。</div>`;
    msg("参考视频生成好了");
  };
  const close = async () => {
    if (U.busy) return toast("AI 还在整理，等它完成", true);
    if (U.dirty && U.subs.some(s => s.points.length) && await S.confirm("录的路线还没保存，关掉会丢掉。确定关闭？", ["关闭，不保存", "取消"]) !== 0) return;
    stopPlay(); U.rec = null; m.remove(); removeEventListener("resize", size); document.removeEventListener("keydown", key, true); msUI = null;
  };
  const key = e => { if (e.target.matches && e.target.matches("input,textarea,select")) return; if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); } else if (e.key === " ") { e.preventDefault(); e.stopPropagation(); q("#msPlay").click(); } };
  document.addEventListener("keydown", key, true); q("#msX").onclick = close; addEventListener("resize", size);
  img.onload = size; if (img.complete) size(); subsUI();
  if (saved) msg("接着上次录的路线；拖动会重录选中的那个对象");
}
/* ---------- AI 视频提示词草稿：图片版预览，勾选后采用（write_vprompts.py --draft / --apply） ---------- */
function openVDraft() {
  const dr = VS() && VS().draft; if (!dr || !(dr.items || []).length) return toast("还没有草稿：先点「✎ AI 写视频提示词」", true);
  const pick = new Set(dr.items.map(it => it.id));
  const m = document.createElement("div"); m.className = "modal vdx";
  m.innerHTML = `<div class="vdbox" role="dialog" aria-label="视频提示词草稿">
    <div class="fbhead"><b>视频提示词草稿预览</b><span class="dim">${dr.items.length} 条 · ${esc(dr.created || "")} · 还没写进视频分镜表</span><span class="grow"></span>
      <button class="ghost" id="vdAll">全选</button><button class="ghost" id="vdNone">全不选</button><button class="pri" id="vdGo"></button><button class="icon" id="vdX" title="关闭（Esc）">✕</button></div>
    <div class="vdgrid">${dr.items.map(it => { const o = it.old || {}, pt = it.patch || {};
      return `<article class="vdc on" data-id="${esc(it.id)}"><label class="vdchk"><input type="checkbox" checked data-pick="${esc(it.id)}"> 采用</label>
        <img src="${fileUrl(it.keyframe)}" loading="lazy" alt="" data-zoom="${esc(it.id + " · 首帧")}">
        <div class="vdb"><h3>${esc(it.id)} <small>${esc(it.where || "")}</small></h3>
        <div class="vdd">时长 ${o.duration ?? "?"} 秒 → <b>${it.dur_new ?? "?"} 秒</b><span class="dim"> ${esc(it.dur_why || "")}</span></div>
        <div class="vdn">${esc(pt.prompt || "")}</div>
        <div class="vdq"><b>质检标准</b> ${esc(pt.describe || "")}</div><div class="vdq"><b>说话的人</b> ${esc((pt.speakers || []).join("、") || "没人说话")}</div>
        ${it.notes ? `<div class="vdw">⚠ ${esc(it.notes)}</div>` : ""}
        <details><summary>原来的提示词</summary><div class="vdo">${esc(o.prompt || "（空）")}</div></details></div></article>`; }).join("")}</div></div>`;
  document.body.appendChild(m);
  const q = s => m.querySelector(s);
  const upd = () => { q("#vdGo").textContent = `采用选中的 ${pick.size} 条`; q("#vdGo").disabled = !pick.size; m.querySelectorAll(".vdc").forEach(c => c.classList.toggle("on", pick.has(c.dataset.id))); };
  m.querySelectorAll("[data-pick]").forEach(x => x.onchange = () => { x.checked ? pick.add(x.dataset.pick) : pick.delete(x.dataset.pick); upd(); });
  q("#vdAll").onclick = () => { m.querySelectorAll("[data-pick]").forEach(x => { x.checked = true; pick.add(x.dataset.pick); }); upd(); };
  q("#vdNone").onclick = () => { m.querySelectorAll("[data-pick]").forEach(x => { x.checked = false; }); pick.clear(); upd(); };
  const close = () => { m.remove(); document.removeEventListener("keydown", key, true); };
  const key = e => { if (e.key === "Escape" && !document.querySelector(".lbx")) { e.preventDefault(); e.stopPropagation(); close(); } };
  document.addEventListener("keydown", key, true); q("#vdX").onclick = close;
  q("#vdGo").onclick = async () => {
    const ids = [...pick]; if (!ids.length) return;
    if (await runTool("write_vprompts.py", ["--apply", ...ids], `采用 AI 视频提示词 · ${ids.length} 条`)) { close(); toast(`正在写进视频分镜表：${ids.length} 条（时长会一起重算）。写完要逐条审过才会生成视频`); }
  };
  upd();
}
let skUI = null;
const SKW = 1280, SKH = 720, SK_COLORS = ["#222222", "#e5484d", "#2f6bd8", "#2f8f5b", "#e08a1e", "#8b5cf6"];
const SK_TOOLS = [["pen", "画笔", "P"], ["line", "直线", "L"], ["arrow", "箭头", "A"], ["rect", "方框", "R"], ["ellipse", "圆 / 椭圆", "E"], ["text", "文字", "T"], ["erase", "橡皮", "X"], ["move", "选中 · 移动", "V"]];
function skErase(shapes, p, R) {              // 橡皮：画笔线只擦掉碰到的那一段（断成几笔），其他图形碰到就整个擦掉
  const [px, py] = p, near = (x, y) => Math.hypot(x - px, y - py) < R;
  const segD = (a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy, t = L ? Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / L)) : 0; return Math.hypot(a[0] + t * dx - px, a[1] + t * dy - py); };
  const out = []; let changed = false;
  for (const s of shapes) {
    const r = R + (s.w || 0) / 2;
    if (s.t === "pen") {
      if (!s.p.some(q => near(q[0], q[1])) && !s.p.some((q, i) => i && segD(s.p[i - 1], q) < r)) { out.push(s); continue; }
      changed = true; let run = [];
      const dense = []; s.p.forEach((q, i) => { if (i) { const a0 = s.p[i - 1], n = Math.ceil(Math.hypot(q[0] - a0[0], q[1] - a0[1]) / 4); for (let k = 1; k < n; k++) dense.push([a0[0] + (q[0] - a0[0]) * k / n, a0[1] + (q[1] - a0[1]) * k / n]); } dense.push(q); });
      dense.forEach(q => { if (Math.hypot(q[0] - px, q[1] - py) < r) { if (run.length > 1) out.push({ ...s, p: run }); run = []; } else run.push(q); });
      if (run.length > 1) out.push({ ...s, p: run });
      continue;
    }
    let hit = false;
    if (s.t === "line" || s.t === "arrow") hit = segD(s.p[0], s.p[1]) < r;
    else if (s.t === "rect") { const x1 = Math.min(s.p[0][0], s.p[1][0]), x2 = Math.max(s.p[0][0], s.p[1][0]), y1 = Math.min(s.p[0][1], s.p[1][1]), y2 = Math.max(s.p[0][1], s.p[1][1]); const inside = px > x1 && px < x2 && py > y1 && py < y2; hit = (s.fill && inside) || [[x1, y1, x2, y1], [x2, y1, x2, y2], [x2, y2, x1, y2], [x1, y2, x1, y1]].some(([a, b, c, d]) => segD([a, b], [c, d]) < r); }
    else if (s.t === "ellipse") { const cx = (s.p[0][0] + s.p[1][0]) / 2, cy = (s.p[0][1] + s.p[1][1]) / 2, rx = Math.max(1, Math.abs(s.p[1][0] - s.p[0][0]) / 2), ry = Math.max(1, Math.abs(s.p[1][1] - s.p[0][1]) / 2), k = Math.hypot((px - cx) / rx, (py - cy) / ry); hit = (s.fill && k < 1) || Math.abs(k - 1) * Math.min(rx, ry) < r; }
    else if (s.t === "text") { const [x, y] = s.p[0], fs = s.size || 30; hit = px > x - R && px < x + String(s.text).length * fs + R && py > y - fs - R && py < y + R; }
    if (hit) changed = true; else out.push(s);
  }
  return changed ? out : null;
}
const skRel = (sid, kind) => `storyboard/sketch/${sid}${kind === "map" ? "_map" : ""}`;
const skDraft = (sid, kind) => `storyboard/sketch/_draft/${sid}_${kind}`;
function skShape(s, hit) {                    // 一个图形 → SVG；hit=true 时画一条看不见的粗线，方便点选
  const r = v => Math.round(v), col = hit ? "transparent" : s.c, w = hit ? Math.max(18, s.w + 12) : s.w;
  const st = `stroke="${col}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"`;
  const closed = s.t === "rect" || s.t === "ellipse" || s.t === "text";   // 封闭图形：点里面也能选中
  const fill = hit ? (closed ? "transparent" : "none") : (s.fill ? s.c + "40" : "none");
  const pe = hit ? ` pointer-events="${closed ? "all" : "stroke"}"` : "";
  if (s.t === "pen") return `<path d="M${s.p.map(q => r(q[0]) + " " + r(q[1])).join(" L")}" ${st} fill="none"${pe}/>`;
  if (s.t === "line" || s.t === "arrow") {
    const [[x1, y1], [x2, y2]] = s.p; let head = "";
    if (s.t === "arrow" && !hit) { const a = Math.atan2(y2 - y1, x2 - x1), L = 16 + s.w * 2.2, sp = 0.45; head = `<polygon points="${r(x2)},${r(y2)} ${r(x2 - L * Math.cos(a - sp))},${r(y2 - L * Math.sin(a - sp))} ${r(x2 - L * Math.cos(a + sp))},${r(y2 - L * Math.sin(a + sp))}" fill="${s.c}"/>`; }
    return `<line x1="${r(x1)}" y1="${r(y1)}" x2="${r(x2)}" y2="${r(y2)}" ${st}${pe}/>${head}`;
  }
  if (s.t === "rect") { const [[x1, y1], [x2, y2]] = s.p; return `<rect x="${r(Math.min(x1, x2))}" y="${r(Math.min(y1, y2))}" width="${r(Math.abs(x2 - x1))}" height="${r(Math.abs(y2 - y1))}" rx="4" ${st} fill="${fill}"${pe}/>`; }
  if (s.t === "ellipse") { const [[x1, y1], [x2, y2]] = s.p; return `<ellipse cx="${r((x1 + x2) / 2)}" cy="${r((y1 + y2) / 2)}" rx="${r(Math.abs(x2 - x1) / 2)}" ry="${r(Math.abs(y2 - y1) / 2)}" ${st} fill="${fill}"${pe}/>`; }
  if (s.t === "text") {
    const [[x, y]] = s.p, fs = s.size || 30;
    if (hit) return `<rect x="${r(x - 4)}" y="${r(y - fs)}" width="${r(String(s.text).length * fs + 8)}" height="${r(fs * 1.3)}" fill="transparent" pointer-events="all"/>`;
    return `<text x="${r(x)}" y="${r(y)}" font-size="${fs}" font-family="sans-serif" font-weight="600" fill="${s.c}">${esc(s.text)}</text>`;
  }
  return "";
}
const skSvg = shapes => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SKW} ${SKH}" width="${SKW}" height="${SKH}"><rect width="${SKW}" height="${SKH}" fill="#f4f4f1"/>${shapes.map(s => skShape(s)).join("")}</svg>`;
function skPng(svg) {                         // SVG 文本 → PNG（base64）：出图模型只能看图片
  return new Promise((ok, bad) => {
    const im = new Image();
    im.onload = () => { const c = document.createElement("canvas"); c.width = SKW; c.height = SKH; const g = c.getContext("2d"); g.fillStyle = "#f4f4f1"; g.fillRect(0, 0, SKW, SKH); g.drawImage(im, 0, 0, SKW, SKH); ok(c.toDataURL("image/png").split(",")[1]); };
    im.onerror = () => bad(new Error("这张 SVG 画不出来"));
    im.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  });
}
async function openSketch(sid, kind = "comp") {
  if (!SB()) return toast("没有分镜工作区", true);
  if (skUI) return;
  const shot = SB().shots.find(x => x.id === sid); if (!shot) return toast("分镜表里还没有 " + sid, true);
  const line = (shotLines()[sid] || {}).text || "";
  const m = document.createElement("div"); m.className = "modal skx";
  m.innerHTML = `<div class="skbox" role="dialog" aria-label="手绘构图">
    <div class="fbhead"><b>手绘构图</b><span class="chip">${esc(sid)}</span><span class="fbseg" id="skKind"><button data-v="comp">画面构图</button><button data-v="map">俯视位置图</button></span><span class="dim fbline">${esc(line)}</span><span class="grow"></span><button class="icon" id="skX" title="关闭（Esc）">✕</button></div>
    <div class="sktools" id="skTools">${SK_TOOLS.map(([t, n, k]) => `<button data-tool="${t}" title="${n}（${k}）">${n}</button>`).join("")}<span class="sksep"></span>${SK_COLORS.map(c => `<button class="skc" data-color="${c}" style="background:${c}" title="颜色：不同的人用不同颜色"></button>`).join("")}<span class="sksep"></span>
      <select id="skW" title="线条粗细"><option value="3">细</option><option value="6" selected>中</option><option value="10">粗</option></select><label class="skfill"><input type="checkbox" id="skFill">填充</label><span class="sksep"></span>
      <button id="skUndo" title="撤销（Ctrl+Z）">↶</button><button id="skRedo" title="重做（Ctrl+Y）">↷</button><button id="skDel" title="删除选中的（Delete）">删除</button><button id="skClear">清空</button><span class="sksep"></span>
      <label class="dim">底图 <select id="skBg"><option value="">空白</option><option value="img">现在的成图（淡）</option><option value="sk">现有的构图图（淡）</option></select></label></div>
    <div class="skwork">
      <div class="skstage"><div class="skwrap" id="skWrap"><svg id="skSvg" viewBox="0 0 ${SKW} ${SKH}"></svg><input id="skText" class="sktext" hidden placeholder="输入文字，回车确定"></div></div>
      <div class="skside">
        <div class="fbreq"><label>分镜要求</label><div class="dim">${esc(shot.shot || "")} · 画面里：${esc(shot.in_frame || "")}</div><div class="dim">${esc(shot.layout || "")}</div></div>
        <div class="hint" id="skHint"></div>
        <div class="skprev" id="skPrev" hidden><label>AI 整理后的 SVG（双击放大）</label><img id="skAiImg" alt="" data-zoom="AI 整理后的构图"><span class="fbseg" id="skPick"><button data-v="hand">用我手绘的</button><button data-v="ai" class="on">用 AI 整理的</button></span></div>
        <button class="ghost" id="skAI" title="把手绘稿和分镜要求交给 AI，整理成干净的 SVG（位置照手绘，不会挪动）">让 AI 整理成 SVG（约 $0.02）</button>
        <button class="pri" id="skUse">用作构图参考（出图时一起发给 AI）</button>
        <button class="ghost" id="skSave" title="只存草稿，下次打开接着画">只存草稿</button>
        <div class="grow"></div><div id="skMsg" class="fbmsg"></div>
      </div>
    </div></div>`;
  document.body.appendChild(m);
  const q = s => m.querySelector(s), svg = q("#skSvg"), wrap = q("#skWrap");
  const U = skUI = { sid, kind, shot, m, shapes: [], undo: [], redo: [], tool: "pen", color: SK_COLORS[0], sel: -1, aiSvg: null, pick: "ai", busy: false, dirty: false };
  const msg = (t, err) => { const e = q("#skMsg"); e.textContent = t; e.classList.toggle("err", !!err); };
  const HINT = { comp: "画镜头里看到的样子：谁在画面左、谁在右，多大，脸朝哪边，车窗、方向盘在哪。不同的人用不同颜色，可以写上名字。画得粗没关系，位置对就行。",
    map: "从正上方往下看：车头朝上，画出车、座位，每个人在哪；再画一个机位和拍摄方向（箭头或扇形）。" };
  HINT.comp += "橡皮（X）：画笔线只擦掉碰到的那一段，方框、圆、直线、文字碰到就整个擦掉；橡皮大小跟着「细 / 中 / 粗」。"; HINT.map += "橡皮（X）用法同上。";
  const snap = () => JSON.stringify(U.shapes);
  const push = () => { U.undo.push(snap()); if (U.undo.length > 100) U.undo.shift(); U.redo = []; U.dirty = true; };
  function bg() {
    const v = q("#skBg").value; if (!v) return "";
    const src = v === "img" ? (has(limgRel("l/" + sid)) ? fileUrl(limgRel("l/" + sid)) : "") : ((shot.sketch || []).find(r => U.kind === "map" ? r.endsWith("_map.png") : !r.endsWith("_map.png")) ? fileUrl("../" + (shot.sketch || []).find(r => U.kind === "map" ? r.endsWith("_map.png") : !r.endsWith("_map.png"))) : "");
    return src ? `<image href="${src}" x="0" y="0" width="${SKW}" height="${SKH}" opacity="0.35" preserveAspectRatio="xMidYMid slice" pointer-events="none"/>` : "";
  }
  function draw(live) {
    svg.innerHTML = `<rect width="${SKW}" height="${SKH}" fill="#f4f4f1"/>${bg()}${U.shapes.map((s, k) => `<g data-k="${k}"${k === U.sel ? ' class="sel"' : ""}>${skShape(s)}${U.tool === "move" ? skShape(s, true) : ""}</g>`).join("")}${live ? skShape(live) : ""}`;
    m.querySelectorAll("[data-tool]").forEach(b => b.classList.toggle("on", b.dataset.tool === U.tool));
    m.querySelectorAll("[data-color]").forEach(b => b.classList.toggle("on", b.dataset.color === U.color));
    m.querySelectorAll("#skKind button").forEach(b => b.classList.toggle("on", b.dataset.v === U.kind));
    q("#skHint").textContent = HINT[U.kind]; svg.style.cursor = U.tool === "move" ? "default" : U.tool === "text" ? "text" : U.tool === "erase" ? "none" : "crosshair";
    q("#skPrev").hidden = !U.aiSvg; q("#skAI").disabled = U.busy || !U.shapes.length; q("#skUse").disabled = U.busy || (!U.shapes.length && !U.aiSvg);
    m.querySelectorAll("#skPick button").forEach(b => b.classList.toggle("on", b.dataset.v === U.pick));
  }
  async function loadDraft() {
    U.shapes = []; U.undo = []; U.redo = []; U.aiSvg = null; U.sel = -1; U.dirty = false;
    try { const t = await S.sketchRead(P.dir, skDraft(sid, U.kind) + "_hand.json"); if (t) U.shapes = JSON.parse(t); } catch {}
    try { const t = await S.sketchRead(P.dir, skDraft(sid, U.kind) + "_ai.svg"); if (t) { U.aiSvg = t; q("#skAiImg").src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(t); } } catch {}
    msg(U.shapes.length ? "接着上次的草稿画" : ""); draw();
  }
  const pt = e => { const r = svg.getBoundingClientRect(); return [Math.max(0, Math.min(SKW, (e.clientX - r.left) / r.width * SKW)), Math.max(0, Math.min(SKH, (e.clientY - r.top) / r.height * SKH))]; };
  let dg = null;
  svg.addEventListener("pointerdown", e => {
    if (U.busy || e.button !== 0) return; const p = pt(e);
    if (U.tool === "text") { e.preventDefault(); return askText(p); }
    if (U.tool === "erase") { dg = { erase: true, pushed: false }; svg.setPointerCapture(e.pointerId); eraseAt(p); return; }
    if (U.tool === "move") {
      const g = e.target.closest && e.target.closest("g[data-k]"); U.sel = g ? +g.dataset.k : -1; draw();
      if (g) { dg = { move: true, p0: p, s0: JSON.parse(JSON.stringify(U.shapes[U.sel])), pushed: false }; svg.setPointerCapture(e.pointerId); }
      return;
    }
    dg = { s: { t: U.tool, c: U.color, w: +q("#skW").value, fill: q("#skFill").checked && (U.tool === "rect" || U.tool === "ellipse"), p: U.tool === "pen" ? [p] : [p, p] } };
    svg.setPointerCapture(e.pointerId);
  });
  const eraseR = () => ({ 3: 12, 6: 22, 10: 36 })[q("#skW").value] || 22;
  function eraseAt(p) {
    const res = skErase(U.shapes, p, eraseR());
    if (res) { if (!dg.pushed) { push(); dg.pushed = true; } U.shapes = res; U.sel = -1; draw(); }
    moveCur(p);
  }
  function moveCur(p) {                      // 橡皮的圆圈光标
    let c = svg.querySelector("#skCur");
    if (U.tool !== "erase") { if (c) c.remove(); return; }
    if (!c) { c = document.createElementNS("http://www.w3.org/2000/svg", "circle"); c.id = "skCur"; c.setAttribute("fill", "rgba(255,255,255,.35)"); c.setAttribute("stroke", "#555"); c.setAttribute("stroke-dasharray", "4 3"); c.setAttribute("pointer-events", "none"); svg.appendChild(c); }
    c.setAttribute("cx", p[0]); c.setAttribute("cy", p[1]); c.setAttribute("r", eraseR());
  }
  svg.addEventListener("pointerleave", () => { const c = svg.querySelector("#skCur"); if (c) c.remove(); });
  svg.addEventListener("pointermove", e => {
    if (U.tool === "erase") { const p = pt(e); if (dg && dg.erase) eraseAt(p); else moveCur(p); return; }
    if (!dg) return; const p = pt(e);
    if (dg.move) { if (!dg.pushed) { push(); dg.pushed = true; } const dx = p[0] - dg.p0[0], dy = p[1] - dg.p0[1]; U.shapes[U.sel].p = dg.s0.p.map(([x, y]) => [x + dx, y + dy]); draw(); return; }
    if (dg.s.t === "pen") { const l = dg.s.p[dg.s.p.length - 1]; if (Math.hypot(p[0] - l[0], p[1] - l[1]) > 3) dg.s.p.push(p); } else dg.s.p[1] = p;
    draw(dg.s);
  });
  svg.addEventListener("pointerup", () => {
    if (!dg) return; const d = dg; dg = null; if (d.move || d.erase) return;
    const s = d.s, big = s.t === "pen" ? s.p.length > 1 : Math.hypot(s.p[1][0] - s.p[0][0], s.p[1][1] - s.p[0][1]) > 6;
    if (big) { push(); U.shapes.push(s); } draw();
  });
  function askText(p) {
    const inp = q("#skText"), r = svg.getBoundingClientRect(), wr = wrap.getBoundingClientRect();
    Object.assign(inp.style, { left: (p[0] / SKW * r.width + r.left - wr.left) + "px", top: (p[1] / SKH * r.height + r.top - wr.top - 18) + "px" });
    inp.hidden = false; inp.value = ""; inp.focus(); setTimeout(() => inp.focus(), 0);
    let fin = false;
    const done = ok => { if (fin) return; fin = true; inp.onkeydown = inp.onblur = null; inp.hidden = true; const t = inp.value.trim(); if (ok && t) { push(); U.shapes.push({ t: "text", c: U.color, w: 1, size: 30, p: [[p[0], p[1] + 10]], text: t }); } draw(); };
    inp.onkeydown = ev => { ev.stopPropagation(); if (ev.key === "Enter") done(true); else if (ev.key === "Escape") done(false); };
    inp.onblur = () => done(true);
  }
  const undo = () => { if (!U.undo.length) return; U.redo.push(snap()); U.shapes = JSON.parse(U.undo.pop()); U.sel = -1; U.dirty = true; draw(); };
  const redo = () => { if (!U.redo.length) return; U.undo.push(snap()); U.shapes = JSON.parse(U.redo.pop()); U.sel = -1; U.dirty = true; draw(); };
  const del = () => { if (U.sel < 0) return; push(); U.shapes.splice(U.sel, 1); U.sel = -1; draw(); };
  m.querySelectorAll("[data-tool]").forEach(b => b.onclick = () => { U.tool = b.dataset.tool; U.sel = -1; draw(); });
  m.querySelectorAll("[data-color]").forEach(b => b.onclick = () => { U.color = b.dataset.color; if (U.sel >= 0) { push(); U.shapes[U.sel].c = U.color; } draw(); });
  q("#skUndo").onclick = undo; q("#skRedo").onclick = redo; q("#skDel").onclick = del;
  q("#skClear").onclick = () => { if (!U.shapes.length) return; push(); U.shapes = []; U.sel = -1; draw(); };
  q("#skBg").onchange = () => draw();
  m.querySelectorAll("#skPick button").forEach(b => b.onclick = () => { U.pick = b.dataset.v; draw(); });
  m.querySelectorAll("#skKind button").forEach(b => b.onclick = async () => {
    if (b.dataset.v === U.kind || U.busy) return;
    if (U.dirty && U.shapes.length) await saveDraft(true);
    U.kind = b.dataset.v; await loadDraft();
  });
  async function saveDraft(quiet) {
    await S.sketchWrite(P.dir, skDraft(sid, U.kind) + "_hand.json", JSON.stringify(U.shapes));
    await S.sketchWrite(P.dir, skDraft(sid, U.kind) + "_hand.svg", skSvg(U.shapes));
    U.dirty = false; if (!quiet) msg("草稿已保存（storyboard\\sketch\\_draft\\）");
  }
  q("#skSave").onclick = () => saveDraft().catch(e => msg(e.message, true));
  q("#skAI").onclick = async () => {
    try {
      await saveDraft(true);
      const rel = skDraft(sid, U.kind) + "_hand.png"; await S.sketchWrite(P.dir, rel, await skPng(skSvg(U.shapes)), true);
      U.busy = true; draw(); msg("AI 正在整理，大约 20～60 秒…");
      if (!await runTool("sketch_ai.py", [sid, U.kind, rel], `手绘构图 · AI 整理 · ${sid}`, { kind: "sketch", U })) { U.busy = false; draw(); msg("没能启动", true); }
    } catch (e) { U.busy = false; draw(); msg(e.message, true); }
  };
  q("#skUse").onclick = async () => {
    try {
      const svgText = U.aiSvg && U.pick === "ai" ? U.aiSvg : skSvg(U.shapes);
      const base = skRel(sid, U.kind), png = await skPng(svgText);
      await S.sketchWrite(P.dir, base + ".svg", svgText); await S.sketchWrite(P.dir, base + ".png", png, true);
      if (U.shapes.length) await saveDraft(true);
      const list = [...(shot.sketch || []).filter(r => r !== base + ".png")], comp = list.filter(r => !r.endsWith("_map.png")), map = list.filter(r => r.endsWith("_map.png"));
      const sketch = U.kind === "map" ? [...comp, base + ".png"] : [base + ".png", ...map];
      P.sb = await S.sbSaveShot(P.dir, { id: sid, sketch }); bust = Date.now();
      toast(`已存为${U.kind === "map" ? "俯视位置图" : "构图图"}：${base}.png，下次出图会一起参考（原来的在 sketch\\_old\\）`);
      close(true); if (RV) rvRefresh(); renderProps();
    } catch (e) { msg(e.message, true); }
  };
  const close = force => {
    if (!force && U.busy) return toast("AI 还在整理，等它完成", true);
    if (!force && U.dirty && U.shapes.length) { S.confirm("还没保存，关掉会丢掉这次画的内容。确定关闭？", ["关闭，不保存", "取消"]).then(r => { if (r === 0) close(true); }).catch(() => {}); return; }
    m.remove(); document.removeEventListener("keydown", key, true); skUI = null;
  };
  const key = e => {
    if (e.target.matches && e.target.matches("input,textarea,select")) return;
    const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
    if (mod && k === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (mod && k === "y") { e.preventDefault(); redo(); }
    else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); del(); }
    else if (e.key === "Escape") { e.preventDefault(); close(); }
    else if (!mod) { const t = SK_TOOLS.find(x => x[2].toLowerCase() === k); if (t) { U.tool = t[0]; U.sel = -1; draw(); } else return; }
    else return;
    e.stopPropagation();
  };
  document.addEventListener("keydown", key, true);
  q("#skX").onclick = () => close();
  U.done = async (code, log = "") => {
    U.busy = false;
    const res = (log.match(/RESULT:(\S+)/) || [])[1], err = (log.match(/ERROR:(.+)/) || [])[1];
    if (code !== 0 || !res) { draw(); return msg("× " + (err || "AI 整理失败，看一下日志"), true); }
    try { U.aiSvg = await S.sketchRead(P.dir, res); q("#skAiImg").src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(U.aiSvg); U.pick = "ai"; msg("整理好了。右边对照看位置有没有挪动，满意就「用作构图参考」；不满意可以接着改手绘再整理，或者用手绘的。"); }
    catch (e) { msg(e.message, true); }
    draw();
  };
  await loadDraft();
}

/* ---------- 前后镜头衔接：本场前后帧 + continuity.py 的检查结果（storyboard\out\continuity.json） ---------- */
const CONT_FP = ["shot", "in_frame", "location", "layout", "desc"];          // 和 continuity.py 的 FP_KEYS 一致
const contFp = s => CONT_FP.map(k => String((s && s[k]) || "")).join("|");
const sceneSeq = nid => P.N[nid].lines.map((l, i) => ({ l, i, im: limgOf(nid, i) })).filter(x => x.im && isSpoken(x.l));
function contNeighbors(nid, i) { const q = sceneSeq(nid), k = q.findIndex(x => x.i === i); return k < 0 ? {} : { prev: q[k - 1], next: q[k + 1] }; }
const contRec = (kind, nid) => ((((SB() || {}).cont || {})[kind === "prompt" ? "prompt" : "image"]) || {})[nid] || null;
function contFresh(kind, rec, sid) {         // 检查之后这个镜头（提示词 / 图）改过没有
  if (!rec || !(rec.sids || []).includes(sid)) return false;
  if (kind === "prompt") { const s = SB().shots.find(x => x.id === sid); return !!s && (rec.fp || {})[sid] === contFp(s); }
  const f = P.files[limgRel("l/" + sid)]; return !!f && (rec.mtime || {})[sid] === f.mtime;
}
function contPair(kind, nid, a, b) {
  const rec = contRec(kind, nid);
  if (!rec || !(rec.sids || []).includes(a) || !(rec.sids || []).includes(b)) return { st: "none", issues: [] };
  const issues = (rec.issues || []).filter(x => (x.a === a && x.b === b) || (x.a === b && x.b === a));
  if (!contFresh(kind, rec, a) || !contFresh(kind, rec, b)) return { st: "stale", issues };
  return { st: issues.some(x => x.level === "bad") ? "bad" : issues.length ? "warn" : "ok", issues };
}
function contWorst(it, kind) {               // 这一张和前后两张的衔接里最严重的情况
  if (!it.im) return "none";
  const { prev, next } = contNeighbors(it.nid, it.i), sid = shotId(it.im), sts = [];
  if (prev) sts.push(contPair(kind, it.nid, shotId(prev.im), sid).st);
  if (next) sts.push(contPair(kind, it.nid, sid, shotId(next.im)).st);
  return ["bad", "warn", "stale", "none", "ok"].find(s => sts.includes(s)) || "none";
}
function contTag(it, kind) {
  const w = contWorst(it, kind);
  return { bad: '<span class="tag rvbad">衔接 ✗ 接不上</span>', warn: '<span class="tag best">衔接 ⚠ 可能接不上</span>', ok: '<span class="tag pass">衔接 ✓</span>', stale: '<span class="tag none" title="检查之后改过，需要重新检查衔接">衔接 ? 改过待重查</span>' }[w] || "";
}
function contStrip(it, kind) {
  if (!it.im) return "";
  const { prev, next } = contNeighbors(it.nid, it.i); if (!prev && !next) return "";
  const cur = { im: it.im, i: it.i, l: it.l };
  const fig = (x, cls, cap) => { const ok = has(limgRel(x.im)); return `<figure class="cfig ${cls}">${ok ? `<img src="${fileUrl(limgRel(x.im))}" data-zoom="${esc(`${cap} · ${sceneName(it.nid)} · 第 ${x.i + 1} 句 · ${shotId(x.im)}`)}" loading="lazy" alt="">` : '<div class="cmiss">没有图</div>'}<figcaption>${cap} · 第 ${x.i + 1} 句 <b>${esc(x.l[0] || "旁白")}</b>：${esc(String(x.l[1] || "").slice(0, 16))}</figcaption></figure>`; };
  const link = (a, b) => { const p = contPair(kind, it.nid, shotId(a.im), shotId(b.im)); const t = { none: ["·", "这一对还没检查衔接"], stale: ["?", "检查之后改过，需要重新检查"], ok: ["✓", "衔接没问题"], warn: ["⚠", "可能接不上"], bad: ["✗", "接不上"] }[p.st]; return `<div class="clink c-${p.st}" title="${esc(t[1] + (p.issues.length ? "\n" + p.issues.map(x => x.what).join("\n") : ""))}">${t[0]}</div>`; };
  return `<div class="rvsec"><label>前后衔接（本场按播放顺序，双击放大可左右翻看）</label><div class="cstrip">${prev ? fig(prev, "", "上一张") + link(prev, cur) : ""}${fig(cur, "cur", "这一张")}${next ? link(cur, next) + fig(next, "", "下一张") : ""}</div>${contList(it, kind, prev, next)}</div>`;
}
function contList(it, kind, prev, next) {
  const rec = contRec(kind, it.nid), sid = shotId(it.im), what = kind === "prompt" ? "提示词" : "成图";
  const btn = `<button class="pvfix" data-a="cont" title="把本场相邻镜头的${what}一起交给 AI，查视线方位、人物位置、越轴、地点背景、光线、衣服道具是否接得上">${rec ? "重新检查" : "检查"}本场${what}衔接（约 $0.01）</button>`;
  if (!rec) return `<div class="cnote dim">本场${what}衔接还没检查过　${btn}</div>`;
  const ids = [prev, it, next].filter(Boolean).map(x => shotId(x.im));
  const stale = ids.some(s => !contFresh(kind, rec, s));
  const mine = (rec.issues || []).filter(x => x.a === sid || x.b === sid || (!x.a && !x.b));
  return `<div class="cnote dim">${esc(rec.at || "")} 检查过${stale ? ' <span class="tag fb">之后改过，结果可能过期</span>' : ""}${mine.length ? "" : "，这一张和前后接得上 ✓"}　${btn}</div>`
    + (mine.length ? `<ul class="pvlint">${mine.map(x => `<li class="${x.level}">${x.a && x.b ? `<b>${esc(x.a === sid ? "这一张 → 下一张" : "上一张 → 这一张")}</b>（${esc(x.a)} → ${esc(x.b)}）：` : "<b>本场</b>："}${esc(x.what)}${x.decide ? ' <span class="tag best">要人定</span>' : ""}${x.fix ? `<div class="cfix">建议：${esc(x.fix)}</div>` : ""}</li>`).join("")}</ul>` : "");
}
async function runCont(nodes) {
  if (!nodes.length) return toast("这里没有两个以上镜头的场景，不用检查衔接", true);
  const kind = RV && RV.kind === "prompt" ? "prompt" : "image";
  if (nodes.length > 1 && (await S.confirm(`检查 ${nodes.length} 个场景的${kind === "prompt" ? "提示词" : "成图"}衔接，大约 $${(nodes.length * (kind === "prompt" ? 0.01 : 0.02)).toFixed(2)}，每场 10～30 秒。`, ["开始检查", "取消"])) !== 0) return;
  runTool("continuity.py", [kind, ...nodes], `${kind === "prompt" ? "提示词" : "成图"}衔接检查 · ${nodes.length === 1 ? sceneName(nodes[0]) : nodes.length + " 个场景"}`);
}

function openReview(scope = "all", filter = "todo", kind) {
  pvCmd("pause");                                  // 打开审阅时预览里的游戏暂停（音乐、配音、视频一起停）
  if (!SB()) return toast("没找到分镜工作区（storyboard\\shotlist.json），审阅不可用", true);
  ensureVsSlots().then(n => { if (n && RV) { if (RV.kind === "video") rvBuild(); else rvRefresh(); } });
  const prevKind = RV && RV.kind; if (RV) { RV.io && RV.io.disconnect(); RV.el.remove(); document.removeEventListener("keydown", rvKey, true); }
  if (!kind && prevKind) kind = prevKind;
  const el = document.createElement("div"); el.className = "rv"; el.setAttribute("role", "dialog"); el.setAttribute("aria-label", "审阅分镜图");
  el.innerHTML = `<div class="rvhead"><span class="fbseg rvkind" id="rvKind"><button data-v="script">剧本 <i></i></button><button data-v="ref">⓪ 参考 <i></i></button><button data-v="prompt">① 提示词 <i></i></button><button data-v="img">② 图片 <i></i></button><button data-v="video" title="用分镜图生成视频之前：参考图、视频提示词、时长、草稿视频（代码草稿 / AI 尾帧 / 2.5D 预演），审过后生成">③ 草稿 <i></i></button><button data-v="final" title="最终选定放进游戏的视频：选哪一版、剪辑点、配音、音效 / 原声，连声音一起看">④ 成片 <i></i></button><button data-v="dialogue" title="按角色查看台词、试听对应音频">⑤ 台词 <i></i></button></span><span class="rvtools"><button class="ghost" id="rvToolsBtn" title="这一页的批量工具">🛠 工具 ▾</button><div class="rvmenu" id="rvMenu" hidden><button class="rvmi" id="rvNewRef" hidden>＋ 新增参考图</button><button class="rvmi" id="rvCont" title="把同一场相邻镜头放在一起，查连着播放时接不接得上（视线方位、人物位置、越轴、地点背景、光线、衣服道具）">检查衔接</button><button class="rvmi" id="rvVDur" title="按剧本算每条视频该多长：场景视频播到切走为止（字幕卡、台词配音的长度）、插入镜头按动作要多久，再对到模型支持的时长（海螺 6 / 10 秒，H3 4～10 秒）。手改过的不动">⏱ 按剧本算时长</button><button class="rvmi" id="rvVWrite" title="让 Gemini 看首帧图和剧本，把所有视频的提示词和时长重写一遍（标了「不做视频」的除外），先出草稿和图片版预览，勾选后才写进视频分镜表。每条约 $0.01">✎ AI 重写全部视频提示词</button><button class="rvmi" id="rvVDraft" title="AI 写好、还没采用的提示词：首帧 + 新旧提示词 + 时长，勾选后采用">📋 草稿预览</button><button class="rvmi" id="rvVCode" title="给所有要做的视频出代码草稿（免费，每条几秒；不做视频的、游戏里用不上的除外）。然后预览选「草稿」，在游戏里把整个剧情过一遍">🎞 全部出草稿（免费）</button><button class="rvmi" id="rvVGpu" title="检查这台电脑能不能跑本地视频模型（显卡、显存、PyTorch）">🖥 检查显卡</button></div></span>
      <span class="fbseg" id="rvScope"><button data-v="scene">本场</button><button data-v="all">全部场景</button></span>
      <span class="fbseg" id="rvFilter"><button data-v="todo">待审 <i></i></button><button data-v="bad">有问题 <i></i></button><button data-v="up" title="上游（剧本 / 提示词 / 参考图）改过、这里还没复查的">上游改过 <i></i></button><button data-v="ok" title="审过、标了没问题的（发现漏了可以在这里找到，改判有问题或改回待审）">已通过 <i></i></button><button data-v="all">全部 <i></i></button><button data-v="codex" hidden>Codex 剧本修正 <i></i></button></span>
      <span class="rvprog"><span class="prog"><i></i></span><span class="dim" id="rvProg"></span></span>
      <span class="grow"></span><span class="hint rvkeys" id="rvKeys"></span>
      <button class="icon" id="rvX" title="关闭（Esc）">✕</button></div>
    <div class="rvbody" id="rvBody"></div>`;
  document.body.appendChild(el);
  RV = { el, scope, filter, kind: kind || (RV && RV.kind) || (() => { try { return localStorage.getItem("studio_rvkind") || "img"; } catch { return "img"; } })(), k: 0, items: [] };
  el.querySelectorAll("#rvKind button").forEach(b => b.onclick = () => switchReviewFlow(b.dataset.v));
  el.querySelector("#rvX").onclick = closeReview;
  el.querySelector("#rvNewRef").onclick = () => openNewRef();
  el.querySelector("#rvVDur").onclick = () => runTool("durations.py", [], "按剧本算视频时长");
  el.querySelector("#rvVWrite").onclick = async () => {
    const n = VS() ? VS().shots.filter(x => !x.novideo).length : 0;
    if (await S.confirm(`让 Gemini 看首帧图和剧本，把 ${n} 条视频的提示词和时长全部重写一遍（标了「不做视频」的除外，约 $${(n * 0.01).toFixed(2)}）。先出草稿和图片版预览，不会马上改视频分镜表；你勾选后才采用。`, ["开始", "取消"]) !== 0) return;
    runTool("write_vprompts.py", ["--all", "--draft"], "AI 重写全部视频提示词（草稿）", { kind: "sketch", U: { done: (code, log) => { if (code === 0 && /RESULT:draft/.test(log)) setTimeout(() => { openVDraft(); }, 600); else toast("没写成，看一下右下角的日志", true); } } });
  };
  el.querySelector("#rvVDraft").onclick = openVDraft;
  el.querySelector("#rvVCode").onclick = () => runTool("draft_video.py", ["--all"], "全部出草稿（代码，免费）");
  el.querySelector("#rvVGpu").onclick = () => runTool("draft_video.py", ["--gpu"], "检查显卡");
  const tb = el.querySelector("#rvToolsBtn"), menu = el.querySelector("#rvMenu");
  tb.onclick = e => { e.stopPropagation(); menu.hidden = !menu.hidden; };
  menu.addEventListener("click", () => { menu.hidden = true; });          // 点了菜单里的一项就收起
  el.addEventListener("click", e => { if (!menu.hidden && !e.target.closest(".rvtools")) menu.hidden = true; });

  el.querySelector("#rvCont").onclick = () => runCont(RV.scope === "scene" ? [cur].filter(n => sceneSeq(n).length > 1) : flatOrder().filter(n => sceneSeq(n).length > 1));
  el.querySelectorAll("#rvScope button").forEach(b => b.onclick = () => { RV.scope = b.dataset.v; rvBuild(); });
  el.querySelectorAll("#rvFilter button").forEach(b => b.onclick = async () => {
    const view=RV,filter=b.dataset.v;
    if(filter==='codex'){
      try{await refreshReviewAssets()}catch(e){return toast(e.message,true)}
      if(RV!==view||RV.kind!=='img')return;RV.scope='all';
    }
    RV.filter=filter;rvBuild();
  });
  document.addEventListener("keydown", rvKey, true);
  const page=reviewReadPage(RV.kind);if(page){RV.scope=page.scope;RV.filter=page.filter}
  rvBuild();reviewRestorePage(page);ensureUpBase().then(() => RV && rvRefresh());
  let rememberTimer;el.querySelector('#rvBody').addEventListener('scroll',()=>{const view=RV,kind=RV?.kind;clearTimeout(rememberTimer);rememberTimer=setTimeout(()=>{if(RV===view&&RV?.kind===kind)reviewRememberPage()},180)});
}
function closeReview() { reviewRememberPage(); stopFinalLoading(); dialogueStop(); finStop(); if (!RV) return; setPausedUI(true); RV.io && RV.io.disconnect(); RV.el.remove(); RV = null; document.removeEventListener("keydown", rvKey, true); renderTop(); }
const rvSt = it => RV.kind === "final" ? finState(it) : RV.kind === "video" ? vpState(it) : RV.kind === "script" ? scriptState(it) : RV.kind === "ref" ? refState(it) : RV.kind === "prompt" ? promptState(it) : rvState(it);
const rvUp = it => RV.kind === "final" ? finUp(it) : RV.kind === "video" ? vUp(vsShot(it.vid) || {}).length > 0 : (RV.kind === "prompt" || RV.kind === "img") && !!it.im && upFlags(shotId(it.im), RV.kind).length > 0;
const refItems = () => [...REFS()].sort((x, y) => ["char", "prop", "bg"].indexOf(x.kind) - ["char", "prop", "bg"].indexOf(y.kind)).map(ref => ({ ref }));
const rvAll = () => RV.kind === "final" || RV.kind === "video" ? vsItems(RV.scope) : RV.kind === "script" ? scriptItems(RV.scope) : RV.kind === "ref" ? refItems() : RV.kind === "prompt" ? reviewItems(RV.scope).filter(it => it.x !== "cap" || shotOf(it.im)) : reviewItems(RV.scope);
function rvBuild() {
  RV.el.querySelector("#rvBody").dataset.reviewKind = RV.kind;
  stopFinalLoading();
  if (RV.kind === "dialogue") { dialogueBuild(); return; }
  if (RV.kind === "ref" && RV.refMode === "voice") { voiceRefsBuild(); return; }
  RV.el.querySelector("#rvFilter").hidden = false; RV.el.querySelector(".rvtools").hidden = false;
  // 按范围和筛选重新取一遍列表（审过的不会马上消失，换筛选时才更新）
  finStop(); RV.G = null; const all = rvAll();
  RV.el.querySelector("#rvScope").hidden = RV.kind === "ref"; RV.el.querySelector('#rvFilter button[data-v="up"]').hidden = !["prompt", "img", "video", "final"].includes(RV.kind);
  if (RV.filter === "up" && !["prompt", "img", "video", "final"].includes(RV.kind)) RV.filter = "todo"; RV.el.querySelector("#rvNewRef").hidden = RV.kind !== "ref"; RV.el.querySelector("#rvVWrite").hidden = RV.el.querySelector("#rvVDur").hidden = RV.el.querySelector("#rvVCode").hidden = RV.el.querySelector("#rvVGpu").hidden = RV.kind !== "video"; RV.el.querySelector("#rvVDraft").hidden = RV.kind !== "video" || !(VS() && VS().draft && (VS().draft.items || []).length); RV.el.querySelector("#rvCont").hidden = RV.kind === "ref" || RV.kind === "script" || RV.kind === "video" || RV.kind === "final";
  rvToolsSync();
  RV.el.querySelector('#rvFilter button[data-v="codex"]').hidden=RV.kind!=='img';
  if(RV.filter==='codex'&&RV.kind!=='img')RV.filter='all';
  RV.items = all.filter(it => RV.filter === "codex" ? rvCodexRevision(it) : RV.filter === "all" ? true : RV.filter === "up" ? rvUp(it) : (RV.kind === "ref" || RV.kind === "final") && RV.filter === "todo" ? ["todo", "missing"].includes(rvSt(it)) : rvSt(it) === RV.filter);
  RV.el.querySelector("#rvKeys").textContent = RV.kind === "final" ? "↑↓ 上一条 / 下一条 · A 成片没问题 · X 有问题 · 「▶ 连声音一起播」看配音和音效 · 剪辑点、音效改完 Ctrl+S 保存 · Esc 关闭" : RV.kind === "video" ? "↑↓ 上一条 / 下一条 · A 视频提示词没问题 · R 生成视频 · 改完点别处自动保存 · Esc 关闭" : RV.kind === "script" ? "↑↓ 上一场 / 下一场 · A 剧本没问题 · X 有问题 · 点文字直接改，点别处生效 · Ctrl+Z 撤销 · Ctrl+S 保存 · Esc 关闭" : RV.kind === "ref" ? "↑↓ 上一张 / 下一张 · A 参考图没问题 · R 按描述重新生成 · 双击放大 · Esc 关闭" : RV.kind === "prompt" ? "↑↓ 上一条 / 下一条 · A 提示词没问题 · R 按这条出图 · 改完字段点别处自动保存 · Esc 关闭" : "↑↓ 上一张 / 下一张 · A 通过 · X 有问题 · E 修图 · R 重画 · Esc 关闭";
  RV.k = 0; rvRender(); rvCounts(all);
}
function rvCounts(all) {
  if (RV.kind === "ref" && RV.refMode === "voice") { voiceRefsCounts(); return; }
  if (RV.kind === "dialogue") { dialogueCounts(); return; }
  all = all || rvAll();
  const n = s => all.filter(it => rvSt(it) === s).length, ok = n("ok");
  const withImg = RV.kind === "final" ? all.filter(it => finState(it) !== "skip").length : RV.kind === "video" || RV.kind === "script" ? all.length : RV.kind === "ref" ? all.filter(it => it.ref.exists).length : RV.kind === "prompt" ? all.filter(it => promptState(it) !== "noshot").length : all.filter(it => it.ok).length;
  const kb = RV.el.querySelectorAll("#rvKind button i"), li = reviewItems("all");
  kb[0].textContent = scriptItems("all").filter(it => scriptState(it) === "todo").length || ""; kb[1].textContent = REFS().length + voiceRefCount() || ""; kb[2].textContent = li.filter(it => promptState(it) === "todo").length || ""; kb[3].textContent = li.filter(it => rvState(it) === "todo").length || ""; kb[4].textContent = vsItems("all").filter(it => vpState(it) === "todo").length || ""; if (kb[5]) kb[5].textContent = vsItems("all").filter(it => ["todo", "missing"].includes(finState(it))).length || "";
  if (kb[6]) kb[6].textContent = dialogueItems("all").length || "";
  const f = RV.el.querySelectorAll("#rvFilter button i"); f[0].textContent = n("todo") + (RV.kind === "ref" || RV.kind === "final" ? n("missing") : 0); f[1].textContent = n("bad"); f[2].textContent = all.filter(rvUp).length || ""; f[3].textContent = n("ok") || ""; f[4].textContent = all.length; f[5].textContent = RV.kind === "img" ? all.filter(rvCodexRevision).length : "";
  RV.el.querySelectorAll("#rvKind button").forEach(b => b.classList.toggle("on", b.dataset.v === RV.kind));
  RV.el.querySelectorAll("#rvScope button").forEach(b => b.classList.toggle("on", b.dataset.v === RV.scope));
  RV.el.querySelectorAll("#rvFilter button").forEach(b => b.classList.toggle("on", b.dataset.v === RV.filter));
  RV.el.querySelector(".rvprog i").style.width = (withImg ? ok / withImg * 100 : 0) + "%";
  RV.el.querySelector("#rvProg").textContent = RV.kind === "final" ? `成片已确认 ${ok} / ${withImg} 条` + (n("missing") ? ` · ${n("missing")} 条还没有视频` : "") : RV.kind === "video" ? (VS() ? `已审 ${ok} / ${all.length} 条视频提示词` : "没找到视频分镜表（autofix\\video_shots.json）") : RV.kind === "script" ? `已审 ${ok} / ${all.length} 场` : RV.kind === "ref" ? `已审 ${ok} / ${withImg} 张参考图` + (all.length > withImg ? ` · ${all.length - withImg} 张还没有图` : "") : RV.kind === "prompt" ? `已审 ${ok} / ${withImg} 条` + (all.length > withImg ? ` · ${all.length - withImg} 句不在分镜表里` : "")
    : `已通过 ${ok} / ${withImg} 张` + (all.length > withImg ? ` · ${all.length - withImg} 句没有图` : "");
}

/* ---------- ④ 成片：最终放进游戏的视频。选哪一版、剪辑点、配音、音效 / 原声，连声音一起看 ---------- */
const finRel = s => vRel(s);
const finHash = s => { const f = P.files[finRel(s)] || {}; return hashStr(JSON.stringify([f.mtime || 0, f.size || 0, f.revision, P.TRIM[finRel(s)] || null, P.VAUD[finRel(s)] || null, s._keyrev || s._keym, finSpeech(s,false).map(x=>[x.text,x.rel,x.muted,x.t,P.files[x.rel],stale.has(x.nid+":"+x.i)])])); };
function finState(it) {
  const s = vsShot(it.vid); if (!s) return "todo"; if (s.novideo) return "skip"; if (!has(finRel(s))) return "missing";
  const r = ((SB() || {}).review || {})["final:" + s.id]; return r && r.mtime === finHash(s) ? (r.ok ? "ok" : "bad") : "todo";
}
const finUp = it => { const s = vsShot(it.vid); return !!s && vUp(s).some(x => /比首帧图旧/.test(x.t)); };
function voiceOffset(line) { const value=Number(line?.[2]?.vo_offset);return Number.isFinite(value)?Math.max(0,value):0; }
function setVoiceOffset(line, value) {
  const n=Number(value),offset=Number.isFinite(n)?Math.max(0,+n.toFixed(2)):0;
  line[2]={...(line[2]||{})};if(offset)line[2].vo_offset=offset;else delete line[2].vo_offset;
}
function moveFinVoice(rows, index, value) {
  const row=rows[index];if(!row)return;const offset=Math.max(0,+(Number(value)||0).toFixed(2)),delta=offset-(row.offset||0);
  row.baseT=row.baseT??row.t-(row.offset||0);row.offset=offset;row.t=+(row.baseT+offset).toFixed(2);
  rows.slice(index+1).forEach(next=>{next.baseT=(next.baseT??next.t-(next.offset||0))+delta;next.t=+(next.t+delta).toFixed(2)});
}
function finSpeech(s, probe = true) {                       // 这条视频播放时游戏里会响起的台词（和 durations.py 的 speech() 一样的算法）：[{t, who, text, rel, d}]
  const v = scriptVids().find(x => x.id === s.id); if (!v) return [];
  const one = (l, t) => { const k = voKey(l[1]), rel = k ? `vo/${k}.mp3` : null, ok = rel && has(rel), d = ok ? (probe ? dur(rel, 2) : (meta[rel] || 2)) + .65 : Math.max(1.9, String(l[1]).length * .24) + .4; return { t:t+voiceOffset(l), baseT:t, offset:voiceOffset(l), who: l[0] || "旁白", text: l[1], original:l[1], key:k, muted:!!l[2]?.mute, rel: ok ? rel : null, miss: !ok && !isSilent(l[1]), d }; };
  if (v.kind === "line") return [{...one(P.N[v.nid].lines[v.i], 0), nid:v.nid, i:v.i}];
  if (v.kind !== "scene") return [];
  const lines = P.N[v.nid].lines, own = (l, i) => !String(l[0]).startsWith("@") && l[0] !== "BP机" && !!limgOf(v.nid, i), out = []; let t = 0;
  if (lines.length && own(lines[0], 0)) return [];
  for (let i = 0; i < lines.length; i++) { const l = lines[i]; if (l[0] === "@shot" || own(l, i)) break;
    if (l[0] === "@cap") { t += 2.8; continue; } if (String(l[0]).startsWith("@")) continue; const x = one(l, t); out.push({...x,nid:v.nid,i}); t += x.d+x.offset; }
  return out;
}
function editAuditValid(r) {
  return !!r.videoRevision && has(r.video) && P.files[r.video]?.revision === r.videoRevision;
}
function applyEditAudit(r, cut) {
  if (!editAuditValid(r)) throw new Error("视频已变化，请重新复核");
  if (cut && (!Array.isArray(cut) || cut.length !== 2 || !cut.every(Number.isFinite) ||
      cut[0] < 0 || cut[1] > r.duration + .05 || cut[1] - cut[0] < .3)) throw new Error("剪辑范围无效");
  if (cut) P.TRIM[r.video] = [...cut];
  else delete P.TRIM[r.video];
}
function editAuditToolbar() {
  if (!RV) return;
  const host = RV.el.querySelector(".rvtools");
  let button = host.querySelector("[data-edit-audit]");
  if (!button) {
    button = document.createElement("button"); button.className = "ghost";
    button.dataset.editAudit = "1"; button.onclick = () => openEditAudit(); host.prepend(button);
  }
  const pending = Object.entries(SB()?.review || {}).filter(([k, r]) => k.startsWith("edit-audit:") && !r.reviewed).length;
  button.textContent = `AI 剪辑复核${pending ? `（${pending}）` : ""}`;
  button.hidden = RV.kind !== "final";
}
function openEditAudit(id) {
  const project = P, view = RV, modal = document.createElement("div");
  let selected = id ? "edit-audit:" + id : "", all = !!id, saving = false;
  modal.className = "modal"; document.body.appendChild(modal); finStop();
  const close = () => { if (!saving) { finStop(); modal.remove(); } };
  modal.onkeydown = e => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
  const draw = () => {
    finStop();
    const list = Object.entries(project.sb?.review || {}).filter(([key, r]) => key.startsWith("edit-audit:") && (all || !r.reviewed));
    const [key, r] = list.find(([k]) => k === selected) || list[0] || [];
    selected = key || "";
    const shot = r && vsShot(r.id), valid = r && editAuditValid(r) && !!shot;
    const current = r && (P.TRIM[r.video] || null);
    const range = cut => cut ? `${cut[0].toFixed(2)}–${cut[1].toFixed(2)} 秒` : `完整 ${r.duration.toFixed(2)} 秒`;
    modal.innerHTML = `<div class="mbox" style="width:min(900px,94vw);max-height:90vh;overflow:auto">
      <div class="row"><h3>AI 剪辑复核</h3><span class="grow"></span><button class="ghost" data-close>关闭</button></div>
      <div class="row"><select data-pick ${list.length ? "" : "disabled"}>${list.map(([k, x]) => `<option value="${esc(k)}" ${k === key ? "selected" : ""}>${esc(x.id)} · ${esc(x.text.slice(0, 28))}</option>`).join("")}</select><label><input type="checkbox" data-all ${all ? "checked" : ""}> 显示已确认</label></div>
      ${r ? `<p>${esc(r.reason)}</p><p class="dim">调整前：${range(r.before)}　AI 方案：${range(r.after)}　当前：${range(current)}</p>
      ${valid ? `<video src="${fileUrl(r.video)}" preload="metadata" playsinline style="width:100%;max-height:42vh"></video>
      <div class="row"><button class="ghost" data-listen="before">试听调整前</button><button class="ghost" data-listen="after">试听 AI 方案</button><button class="ghost" data-listen="current">试听当前</button><button class="ghost" data-stop>停止</button></div>
      <p class="dim">试听包含当前已选的原声和独立配音。下列操作保存后生效。</p>
      <div class="row"><button class="pri" data-save="current">确认当前剪辑</button><button class="ghost" data-save="after">采用 AI 方案</button><button class="ghost" data-save="before">恢复调整前</button><button class="ghost" data-edit>继续微调…</button></div><p class="dim" data-status></p>`
      : '<p class="dim">视频已更换，旧剪辑建议需要重新复核。</p>'}`
      : '<p class="dim">没有待确认的剪辑调整。勾选「显示已确认」可继续查看。</p>'}
    </div>`;
    const q = selector => modal.querySelector(selector);
    q("[data-close]").onclick = close;
    q("[data-all]").onchange = e => { all = e.target.checked; draw(); };
    q("[data-pick]").onchange = e => { selected = e.target.value; draw(); };
    if (!valid) return;
    const video = q("video");
    modal.querySelectorAll("[data-listen]").forEach(button => button.onclick = () => {
      const which = button.dataset.listen, cut = which === "current" ? current : r[which];
      const play = () => { if (modal.isConnected && video.isConnected) finMixOn(video, shot, cut, P.VAUD[r.video]); };
      if (video.readyState >= 1) play(); else video.onloadedmetadata = play;
    });
    q("[data-stop]").onclick = () => { video.onloadedmetadata = null; finStop(); };
    q("[data-edit]").onclick = () => {
      close(); jumpToMediaReview("final", r.id);
      const index = RV?.items.findIndex(it => it.vid === r.id);
      if (index >= 0) finEditor(shot, index);
    };
    modal.querySelectorAll("[data-save]").forEach(button => button.onclick = async () => {
      if (saving || P !== project) return;
      try {
        saving = true; modal.querySelectorAll("[data-save]").forEach(b => b.disabled = true);
        const which = button.dataset.save, cut = which === "current" ? (P.TRIM[r.video] || null) : r[which];
        edit(() => applyEditAudit(r, cut)); finStop();
        if (!await save() || P !== project) return;
        const result = await S.sbReviewMany(project.dir, { [key]: { ...r, reviewed:true, selectedCut:cut, selectedMode:which } });
        if (P !== project) return;
        project.sb = result;
        if (RV === view) rvBuild();
        draw();
      } catch (error) { const status = q("[data-status]"); if (status) status.textContent = error.message; }
      finally { saving = false; modal.querySelectorAll("[data-save]").forEach(b => b.disabled = false); }
    });
  };
  draw(); modal.tabIndex = -1; modal.focus();
}

function voiceAuditItem(r) {
  const line = P.N[r.nid]?.lines[r.i], key = line && voKey(line[1]), im = line && limgOf(r.nid, r.i);
  const source = P.VAUD[r.video]?.file || "";
  const valid = !!line && line[1] === r.text && r.video === `vid/${im}.mp4` && key && `vo/${key}.mp3` === r.vo &&
    !!r.videoRevision && P.files[r.video]?.revision === r.videoRevision &&
    !!r.voiceRevision && P.files[r.vo]?.revision === r.voiceRevision &&
    source === (r.originalFile || "") && (!source || P.files[source]?.revision === r.originalRevision) &&
    JSON.stringify(P.TRIM[r.video] || null) === JSON.stringify(r.trim || null);
  return { line, key, valid, hasOriginal: source ? has(source) : !!P.files[r.video]?.hasAudio };
}

function applyVoiceAudit(r, mode, offset) {
  const { line, key, valid, hasOriginal } = voiceAuditItem(r);
  if (!valid) throw new Error("视频、配音或剪辑点已变化，请重新复核");
  if (mode !== "ai" && !hasOriginal) throw new Error("此镜头没有可用的原声音轨");
  if (mode !== "original" && offset !== null &&
      (!Number.isFinite(offset) || offset < 0 || offset + r.voiceDuration > (r.trim?.[1] ?? r.videoDuration) - (r.trim?.[0] || 0) + .05)) {
    throw new Error("配音超出视频出点，请调整开口时间或剪辑点");
  }
  const settings = line[2] = { ...line[2] };
  if (mode === "original") settings.mute = true;
  else delete settings.mute;
  if (mode === "ai") (P.VAUD[r.video] ||= {}).muted = true;
  else if (P.VAUD[r.video]?.file) delete P.VAUD[r.video].muted;
  else delete P.VAUD[r.video];
  if (mode !== "original" && offset !== null) setVoiceOffset(line, offset);
  if (mode === "original" || offset !== null) {
    line[2].vo_bind = { video: r.video, voice: key, mode: mode === "original" ? "original" : "ai" };
  }
}

function voiceAuditToolbar() {
  const host = RV.el.querySelector(".rvtools");
  let button = host.querySelector("[data-voice-audit]");
  if (!button) {
    button = document.createElement("button"); button.className = "ghost";
    button.dataset.voiceAudit = "1"; button.onclick = () => openVoiceAudit(); host.prepend(button);
  }
  const pending = Object.entries(SB()?.review || {}).filter(([k, r]) => k.startsWith("voice-audit:") && !r.reviewed && r.pending).length;
  button.textContent = `AI 音轨复核${pending ? `（${pending}）` : ""}`;
  button.hidden = RV.kind !== "final";
}

function openVoiceAudit(shotId) {
  const project = P, view = RV, modal = document.createElement("div");
  const entries = () => Object.entries(project.sb?.review || {}).filter(([key]) => key.startsWith("voice-audit:"));
  const modes = { original: "保留原声", ai: "使用 AI 配音", both: "两轨保留" };
  let showAll = !!shotId, selected = shotId ? "voice-audit:" + shotId : "", saving = false;
  const close = () => { if (!saving) { finStop(); modal.remove(); } };
  modal.className = "modal"; document.body.appendChild(modal); finStop();
  modal.addEventListener("keydown", e => { if (e.key === "Escape") { e.stopPropagation(); close(); } });
  const draw = () => {
    finStop();
    const list = entries().filter(([, r]) => showAll || (r.pending && !r.reviewed));
    const [key, r] = list.find(([k]) => k === selected) || list[0] || [];
    selected = key || "";
    const item = r && voiceAuditItem(r);
    const s = r && vsShot(key.slice("voice-audit:".length));
    const active = !!(item?.valid && s);
    const raw = r ? project.VAUD[r.video] : null;
    const currentMode = r && (item.line?.[2]?.mute ? "original" : raw?.muted ? "ai" : "both");
    const suggested = r?.suggestion;
    const selection = item?.hasOriginal ? (!r.reviewed && modes[suggested] ? suggested : currentMode) : "ai";
    const offset = r?.reviewed ? (voiceOffset(item.line) || "") : r?.offset ?? (voiceOffset(item?.line) || "");
    modal.innerHTML = `<div class="mbox" style="width:min(900px,94vw);max-height:90vh;overflow:auto">
      <div class="row"><h3>AI 音轨复核</h3><span class="grow"></span><button class="ghost" data-close>关闭</button></div>
      <div class="row"><select data-pick ${list.length ? "" : "disabled"}>${list.map(([k, x]) => `<option value="${esc(k)}" ${k === key ? "selected" : ""}>${esc(k.slice("voice-audit:".length))} · ${esc(x.text.slice(0, 24))}</option>`).join("")}</select>
      <label><input type="checkbox" data-all ${showAll ? "checked" : ""}> 显示全部</label></div>
      ${r ? `<p>${esc(r.text)}</p><p class="dim">当前：${esc(modes[currentMode] || "待确认")} · Gemini 建议：${esc(modes[suggested] || "人工复听")}</p>
      <p class="dim">${esc(r.reason)}</p><p class="dim">Gemini 开口观察：${r.mouthStart == null ? "待定位" : esc(r.mouthStart) + " 秒（原视频时间）"}</p><details><summary>查看盲听转写</summary><p>原声：${esc(r.original || "未听到明确对白")}</p><p>AI 配音：${esc(r.independent || "未听到明确对白")}</p></details>
      ${active ? `<video src="${fileUrl(r.video)}" preload="metadata" style="width:100%;max-height:38vh" playsinline></video>
      <div class="row"><button class="ghost" data-listen="original" ${item.hasOriginal ? "" : "disabled"}>单听原声</button><button class="ghost" data-listen="ai">单听 AI 配音</button><button class="ghost" data-listen="chosen">试听选择</button><button class="ghost" data-stop>停止</button></div>
      <div class="row"><select data-mode>${Object.entries(modes).map(([mode, name]) => `<option value="${mode}" ${mode !== "ai" && !item.hasOriginal ? "disabled" : ""} ${mode === selection ? "selected" : ""}>${name}</option>`).join("")}</select>
      <label>配音开口 <input type="number" min="0" step=".01" data-offset value="${offset}" placeholder="待定位" style="width:84px"> 秒（从剪辑入点算）</label>
      <button class="pri" data-apply>保存选择</button></div><p class="dim" data-feedback></p>` : '<p class="dim">素材或剪辑点已变化，需要重新复核。</p>'}`
        : '<p class="dim">当前没有待复听条目。勾选「显示全部」可查看已有结果。</p>'}
    </div>`;
    const q = selector => modal.querySelector(selector);
    q("[data-close]").onclick = close;
    q("[data-all]").onchange = e => { showAll = e.target.checked; draw(); };
    q("[data-pick]").onchange = e => { selected = e.target.value; draw(); };
    if (!active) return;
    const video = q("video"), choice = q("[data-mode]"), input = q("[data-offset]");
    const getOffset = () => input.value === "" ? null : input.valueAsNumber;
    const listen = mode => {
      const rows = mode === "original" ? [] : [{rel:r.vo, muted:false, t:getOffset() ?? voiceOffset(item.line)}];
      const source = mode === "ai" ? { ...raw, muted:true } : { ...raw, muted:false };
      const play = () => { if (modal.isConnected && video.isConnected) finMixOn(video, s, r.trim, source, rows); };
      if (video.readyState >= 1) play(); else video.onloadedmetadata = play;
    };
    modal.querySelectorAll("[data-listen]").forEach(b => b.onclick = () => listen(b.dataset.listen === "chosen" ? choice.value : b.dataset.listen));
    q("[data-stop]").onclick = () => { video.onloadedmetadata = null; finStop(); };
    q("[data-apply]").onclick = async () => {
      if (saving || P !== project) return;
      try {
        saving = true; q("[data-apply]").disabled = true;
        const mode = choice.value, offset = getOffset();
        edit(() => applyVoiceAudit(r, mode, offset));
        finStop();
        if (!await save() || P !== project) return;
        const sb = await S.sbReviewMany(project.dir, { [key]: { ...r, reviewed:true, selectedMode:mode, selectedOffset:offset } });
        if (P !== project) return;
        project.sb = sb;
        if (RV === view) rvBuild();
        draw();
      } catch (error) { const status = q("[data-feedback]"); if (status) status.textContent = error.message; }
      finally { saving = false; const button = q("[data-apply]"); if (button) button.disabled = false; }
    };
  };
  draw(); modal.tabIndex = -1; modal.focus();
}

function finCands(s) {                        // 可以选作成片的版本：游戏里现在的、autofix 每次生成的（哪个模型、几秒、多少钱、质检分）、2.5D 预演、本地模型草稿
  const out = [], af = ((VS() || {}).state || {})[s.id], dr = vDraftOf(s);
  if (has(finRel(s))) out.push({ label: "项目本地视频（当前成片）", short: "当前成片", src: finRel(s), cur: true });
  ((af && af.tries) || []).forEach(t => t.video && out.push({ label: `第 ${t.n} 次生成 · ${t.engine_label || "海螺 2.3 · 768P"}${t.dur ? ` · ${t.dur} 秒` : ""}${t.cost ? ` · ¥${t.cost}` : ""}`, short: `#${t.n} ${(t.engine_label || "海螺").split(" · ")[0]}${t.dur ? " " + t.dur + "s" : ""}`,
    badge: t.pass ? "✓" : t.score != null ? `${t.score}/10` : t.error ? "出错" : "", ok: !!t.pass, src: `../autofix/${af.dir}/${t.video}`, tryN: t.n, prompt: t.prompt || "", issues: t.issues || [], ai: !!t.ai_rewrite, sheet: t.sheet ? `../autofix/${af.dir}/${t.sheet}` : "" }));
  out.push(...finalLocalCandidates(s));
  if (dr.b25d) out.push({ label: "2.5D 预演", short: "2.5D 预演", src: "../autofix/" + dr.b25d.file });
  if (dr.ltx) out.push({ label: "本地模型草稿", short: "本地模型", src: "../autofix/" + dr.ltx.file });
  return out;
}
const finSel = (s, cands) => { const v = ((RV && RV.fsel) || {})[s.id]; return v != null && v < cands.length ? v : 0; };
function finCandInfo(c, rel) {
  if (!c) return "";
  return `<div class="fninfo"><div class="fnt"><b>${esc(c.label)}</b>${c.cur ? '<span class="tag pass">在用</span>' : ""}${c.badge ? `<span class="tag ${c.ok ? "pass" : "rvbad"}">质检 ${esc(c.badge)}</span>` : ""}${c.ai ? '<span class="tag best">AI 改写的提示词</span>' : ""}</div>
    <div class="row">${c.cur ? "" : `<button class="pri" data-fa="use" title="复制到 ${esc(rel)}（原来的先备份）">用作成片</button>`}${c.prompt ? '<button class="ghost" data-fa="prompt" title="把这次用的提示词填回「③ 草稿」的视频提示词（之后要重新审）">把这次的提示词填回 ③</button>' : ""}</div>
    ${c.tryN ? `<details class="fntry"><summary>这次的提示词和质检${c.issues.length ? `（${c.issues.length} 个问题）` : ""}</summary><div class="vtp">${esc(c.prompt)}</div>${c.issues.length ? `<ul class="qc">${c.issues.map(i => `<li>[${esc(String(i.severity || ""))}] ${esc(String(i.type || ""))}：${esc(String(i.detail || ""))}</li>`).join("")}</ul>` : ""}${c.sheet ? `<img class="vsheet" src="${fileUrl(c.sheet)}" data-zoom="第 ${c.tryN} 次的抽帧" loading="lazy" alt="">` : ""}</details>` : ""}</div>`;
}
function auditReviewNote(r, fingerprint) {
  if (!r || !r.auditSource || r.auditFingerprint !== fingerprint) return "";
  return `<div class="rvsec"><span class="tag ${r.auditLabel === "不匹配" ? "rvbad" : "best"}">${esc(r.auditLabel)}</span><div class="rvnotev">${esc(r.note)}</div></div>`;
}
function finCard(it, k) {
  const s = vsShot(it.vid); if (!s) return `<article class="rvcard" data-k="${k}"><div class="rvmiss">视频分镜表里没有 ${esc(it.vid)}</div></article>`;
  const st = finState(it), rel = finRel(s), v = scriptVids().find(x => x.id === s.id), af = ((VS() || {}).state || {})[s.id];
  const where = !v ? `${s.id}（剧本里没有了）` : v.kind === "scene" ? `${sceneName(v.nid)}（场景视频）` : v.kind === "line" ? `${sceneName(v.nid)} · 第 ${v.i + 1} 句台词页` : `${sceneName(v.nid)} · 插入镜头 ${v.name}`;
  const tag = { ok: '<span class="tag pass">成片 ✓ 已确认</span>', bad: '<span class="tag rvbad">成片有问题</span>', todo: '<span class="tag none">成片待确认</span>', missing: '<span class="tag fb">还没有视频</span>', skip: '<span class="tag none">不做视频</span>' }[st];
  const sp = finSpeech(s, false), va = P.VAUD[rel], tr = P.TRIM[rel];
  const sfx = v && v.kind === "shot" && P.SHOT_SFX && P.SHOT_SFX[v.name] ? `sfx/${P.SHOT_SFX[v.name]}.mp3` : null;
  const bgm = v ? (P.BGM[v.nid] || (P.N[v.nid].end ? "sad" : "")) : "", amb = v ? P.AMB[v.nid] || "" : "";
  const up = vUp(s).filter(x => /比首帧图旧/.test(x.t)), cands = finCands(s), ci = finSel(s, cands), c = cands[ci], lip = s.need_mouth && af && af.status === "needs_lipsync";
  return `<article class="rvcard pv fin st-${st}" data-k="${k}">
    <div class="pvleft">
      ${c ? `<div class="vview"><div class="vmain"><video class="fnv" data-final-src="${fileUrl(c.src)}" poster="${fileUrl(finalPosterRel(s))}" preload="none" controls muted></video><span class="vcap">${esc(c.label)}</span></div>
        <div class="row fnbar"><button class="pri" data-fa="mix" title="视频（按剪辑点）+ 这段时间里的配音 + 音效 / 原声一起放，和游戏里听到的一样（音乐、环境声不算）">▶ 连声音一起播</button><button class="ghost" data-fa="stop">■ 停</button></div>
        ${cands.length ? `<div class="vthumbs">${cands.map((x, j) => `<button class="vth${j === ci ? " on" : ""}" data-fsel="${j}" title="${esc(x.label)}"><img src="${fileUrl(x.sheet || finalPosterRel(s))}" loading="lazy" alt="${esc(x.short)}">${x.cur ? '<i class="vbadge cur">在用</i>' : x.badge ? `<i class="vbadge ${x.ok ? "ok" : "bad"}">${esc(x.badge)}</i>` : ""}<span>${esc(x.short)}</span></button>`).join("")}</div>` : ""}
        ${finCandInfo(c, rel)}</div>`
        : `<div class="rvmiss">游戏里还没有这条视频（${esc(rel)}）<br><small>去「③ 草稿」选模型生成</small></div>`}
    </div>
    <div class="rvinfo">
      <div class="rvwhere"><span class="dim">${esc(where)}</span><span class="chip">${esc(s.id)}</span></div>
      <div class="rvtags">${tag}${lip ? '<span class="tag best">等口型同步</span>' : ""}${up.length ? '<span class="tag best">↑ 首帧换过</span>' : ""}${s.need_mouth ? `<span class="tag none">有人说话：${esc((s.speakers || []).join("、"))}</span>` : ""}</div>
      ${up.length ? `<div class="rvsec upbox"><ul class="pvlint">${up.map(f => `<li class="warn">${esc(f.t)}</li>`).join("")}</ul></div>` : ""}
      ${auditReviewNote(((SB() || {}).review || {})["final:" + s.id], finHash(s))}
      ${has(rel) ? `<div class="rvsec fnedit"><label>编辑（剪辑点 · 配音 · 音效）</label>
        <div class="fnsum"><span>剪辑：${tr ? `只播 ${tr[0]}–${tr[1]} 秒` : "完整播放"}</span><span>配音：${sp.length ? `${sp.length} 句${sp.some(x => x.miss) ? '<b class="bad"> · 有缺</b>' : ""}` : "无"}</span><span>音效：${va ? esc(va.file?.split("/").pop() || "视频自带原声") + ` · ${Math.round((va.vol ?? 1) * 100)}%` : "无"}</span></div>
        ${SB()?.review?.["voice-audit:" + s.id] ? `<button class="ghost" data-fa="voice-audit">AI 音轨复核${SB().review["voice-audit:" + s.id].pending && !SB().review["voice-audit:" + s.id].reviewed ? " · 待复听" : ""}</button>` : ""}
        ${SB()?.review?.["edit-audit:" + s.id] ? `<button class="ghost" data-fa="edit-audit">AI 剪辑复核${SB().review["edit-audit:" + s.id].reviewed ? "" : " · 待确认"}</button>` : ""}
        <button class="pri fnedbtn" data-fa="editor" title="打开编辑器：大画面 + 时间条（拖入点 / 出点）+ 配音轨 + 音效轨，连声音试听，改完保存进游戏">✂ 编辑…</button>
        ${sfx ? `<div class="dim">游戏播这个插入镜头时还会放：${esc(sfx)}${has(sfx) ? "" : ' <span class="tag rvbad">文件不存在</span>'}</div>` : ""}
        ${bgm || amb ? `<div class="dim">这一场的${bgm ? `音乐：${esc(bgm)}` : ""}${bgm && amb ? "，" : ""}${amb ? `环境声：${esc(amb)}` : ""}（在场景属性里改）</div>` : ""}
        ${s.need_mouth ? `<div class="dim">${lip ? "内容通过、只差口型：要精确对口型用 autofix\\lipsync.py 按配音同步。" : "画面里有人说话：在编辑器里连声音试听，看嘴型和配音对不对得上。"}</div>` : ""}</div>` : ""}
      ${st !== "missing" && st !== "skip" ? `<div class="rvact"><button class="pri" data-a="fok">✓ 成片没问题<kbd>A</kbd></button><button class="ghost" data-a="fbad">✗ 有问题<kbd>X</kbd></button></div>` : ""}
      ${localVideoBox(s)}
    </div></article>`;
}
let FINMIX = null;
function finStop() {
  const m=FINMIX;if(!m)return;FINMIX=null;
  (m.events||[]).forEach(([name,fn])=>m.v.removeEventListener(name,fn));
  m.auds.forEach(a=>a.pause());m.v.pause();
}
function finMixOn(v, s, trim, va, speech, position) {
  finStop(); if (!v) return; loadFinalVideo(v);
  const a=trim ? trim[0] : 0, b=trim ? trim[1] : Infinity;
  const M=FINMIX={v,auds:[],events:[],entries:[]};
  const add=(rel,start,vol=1)=>{if(!rel||!has(rel))return;const au=new Audio(fileUrl(rel));au.volume=Math.max(0,Math.min(1,vol));M.auds.push(au);M.entries.push({au,start});};
  const sp=speech||finSpeech(s);
  v.muted=!!(va?.file||va?.muted);
  v.volume=va?.vol ?? (sp.some(x=>x.rel&&!x.muted) ? .45 : 1);
  if(va?.file&&!va.muted)add(va.file,0,va.vol??1);
  sp.forEach(x=>{if(!x.muted)add(x.rel,a+x.t);});
  const sync=()=>{
    if(FINMIX!==M)return;
    if(v.currentTime>=b-.025){v.pause();return;}
    M.entries.forEach(({au,start})=>{
      const t=v.currentTime-start,active=t>=0&&(!Number.isFinite(au.duration)||t<au.duration);
      if(active){try{if(Math.abs(au.currentTime-t)>.18)au.currentTime=t;}catch{}
        if(!v.paused&&!v.seeking&&v.readyState>=3){if(au.paused)au.play().catch(()=>{});}else au.pause();
      }else au.pause();
    });
  };
  const pause=()=>M.auds.forEach(au=>au.pause());
  const bind=(name,fn)=>{v.addEventListener(name,fn);M.events.push([name,fn]);};
  ['timeupdate','playing','seeked','loadedmetadata'].forEach(name=>bind(name,sync));
  ['pause','waiting','seeking','ended'].forEach(name=>bind(name,pause));
  try{v.currentTime=position==null?a:Math.max(a,Math.min(position,b));}catch{}
  v.play().catch(()=>{});
}
function applyFinSpeech(rows) {
  rows.forEach(x=>{
    const line=P.N[x.nid]?.lines[x.i];
    if(!line||line[1]!==x.original)throw new Error("台词已变化，请重新打开成片编辑");
  });
  rows.forEach(x=>{
    const line=P.N[x.nid].lines[x.i];line[1]=x.text;setLineMuted(x.nid,x.i,!!x.muted);setVoiceOffset(line,x.offset||0);
    if(x.key)P.VOT[cleanKey(x.text)]=x.key;
    if(x.replaced)stale.delete(x.nid+":"+x.i);
    else if(x.text!==x.original)stale.add(x.nid+":"+x.i);
  });
}

const finMix = (card, s) => finMixOn(card.querySelector(".fnv"), s, P.TRIM[finRel(s)], P.VAUD[finRel(s)]);
function bindFinCard(card, k) {
  const it = RV.items[k], s = vsShot(it.vid); if (!s) return; const rel = finRel(s), cands = finCands(s), c = cands[finSel(s, cands)];
  bindLocalVideo(card, s, k); watchFinalMedia(card);
  card.querySelectorAll("[data-fsel]").forEach(b => b.onclick = e => { e.stopPropagation(); finStop(); RV.fsel = RV.fsel || {}; RV.fsel[s.id] = +b.dataset.fsel; rvUpdateCard(k); const v = RV.el.querySelector(`.rvcard[data-k="${k}"] .fnv`); if (v) { loadFinalVideo(v); v.play().catch(() => {}); } });
  card.querySelectorAll("[data-fa]").forEach(b => b.onclick = async e => { e.stopPropagation(); const a = b.dataset.fa;
    if (a === "mix") finMix(card, s); else if (a === "stop") finStop();
    else if (a === "editor") { finStop(); finEditor(s, k); }
    else if (a === "voice-audit") openVoiceAudit(s.id);
    else if (a === "edit-audit") openEditAudit(s.id);
    else if (a === "use" && c) { if (await S.confirm(`把「${c.label}」用作 ${s.id} 的成片？\n会复制到游戏的 ${rel}（原来的先备份）。`, ["用作成片", "取消"]) !== 0) return;
      try { await S.replace(P.dir, rel, P.dir + "/" + c.src); await refreshFiles(); RV.fsel = RV.fsel || {}; RV.fsel[s.id] = 0; reloadPreview(); rvUpdateCard(k); rvCounts(); toast(`已换成「${c.label}」，成片回到待确认`); } catch (e2) { toast(e2.message, true); } }
    else if (a === "prompt" && c && c.prompt) { try { P.vs = await S.vsSave(P.dir, s.id, { prompt: c.prompt, prompt_from: `第 ${c.tryN} 次生成用过的${c.ai ? "（AI 改写）" : ""}` }); toast("已填回「③ 草稿」的视频提示词，审过后可以重新生成"); } catch (e2) { toast(e2.message, true); } } });
  card.querySelectorAll(".vmain video, audio").forEach(m => m.addEventListener("click", e => e.stopPropagation()));
  card.querySelectorAll(".vth video").forEach(m => { m.style.pointerEvents = "none"; });   // 缩略图里的视频只当画面，点击交给外面的按钮
}
// ✂ 编辑器：像修图窗口一样单独打开。大画面 + 时间条（拖入点 / 出点、看配音在哪一秒进来）+ 音效轨（换文件、音量、分离原声），连声音试听，保存后写进游戏
function finEditor(s, k) {
  const rel = finRel(s); if (!has(rel)) return toast("游戏里还没有这条视频", true);
  const sp = finSpeech(s); let full = dur(rel, s.duration || 6), tr = P.TRIM[rel] ? [...P.TRIM[rel]] : [0, +full.toFixed(2)], va = P.VAUD[rel] ? { ...P.VAUD[rel] } : null, dirtyE = false;
  const m = document.createElement("div"); m.className = "modal fe";
  m.innerHTML = `<div class="mbox fe-box"><div class="fe-head"><h3>编辑成片 · ${esc(s.id)}</h3><span class="dim">${esc(rel)}</span><span class="grow"></span><button class="ghost" data-e="close">关闭</button></div>
    <div class="fe-main"><video class="fe-v" src="${fileUrl(rel)}" preload="auto" controls></video></div>
    <div class="fe-tl"><div class="fe-row"><span class="fe-lab">视频</span><div class="fe-track fe-vt"><div class="fe-sel"><i class="fe-h fe-hin" title="拖动设入点"></i><i class="fe-h fe-hout" title="拖动设出点"></i></div><div class="fe-ph"></div></div></div>
      <div class="fe-row"><span class="fe-lab">配音</span><div class="fe-track fe-vo"></div></div>
      <div class="fe-row"><span class="fe-lab">音效</span><div class="fe-track fe-fx"></div></div>
      <div class="fe-ruler"></div></div>
    <div class="fe-ctl">
      <div class="fe-grp"><b>剪辑</b><span>入点</span><input class="fe-in" type="number" step="0.1" min="0"><span>出点</span><input class="fe-out" type="number" step="0.1" min="0"><span class="dim fe-len"></span>
        <button class="ghost" data-e="setin">当前画面设为入点</button><button class="ghost" data-e="setout">当前画面设为出点</button><button class="ghost" data-e="full">恢复完整</button></div>
      <div class="fe-grp"><b>音效</b><span class="fe-fxname dim"></span><span>音量</span><input class="fe-vol" type="range" min="0" max="1" step="0.05"><span class="dim fe-volv"></span>
        <button class="ghost" data-e="pick">选音效文件…</button><button class="ghost" data-e="detach" title="视频本身有声音时，把它分离出来单独调音量">分离视频原声</button><button class="ghost danger" data-e="fxdel">去掉音效</button></div>
      <div class="fe-grp"><b>台词 · 配音</b><span class="dim">拖动蓝色配音块或设置延后时间；保存后与剧本和剪辑台联动。</span></div>
      <div class="fe-dialogue">${sp.map((x,j)=>`<div class="fe-line"><b>${esc(x.who==="你"?"司机":x.who)}</b><textarea data-fe-text="${j}" rows="2">${esc(x.text)}</textarea><label style="display:inline-flex;align-items:center;gap:4px">配音延后 <input data-fe-offset="${j}" type="number" min="0" step="0.1" style="width:76px" value="${x.offset||0}"> 秒</label><button class="ghost" data-fe-audio="${j}">选择 / 替换配音…</button><span class="dim" data-fe-file="${j}">${esc(x.rel||"缺配音")}</span></div>`).join("")||'<span class="dim">这段视频没有对应台词</span>'}</div>
    </div>
    <div class="dim fe-delay-note" style="font-size:12px"></div>
    <div class="fe-foot"><button class="pri" data-e="mix">▶ 连声音播放（入点 → 出点）</button><button class="ghost" data-e="stop">■ 停</button><span class="grow"></span><span class="dim fe-dirty"></span><button class="ghost" data-e="close">取消</button><button class="pri" data-e="save">保存进游戏</button></div></div>`;
  document.body.appendChild(m);
  const $e = q => m.querySelector(q), v = $e(".fe-v"), track = $e(".fe-vt"), selEl = $e(".fe-sel"), ph = $e(".fe-ph");
  m.querySelectorAll('[data-fe-text]').forEach(el=>el.oninput=()=>{sp[+el.dataset.feText].text=el.value;dirtyE=true;draw();});
  m.querySelectorAll('[data-fe-audio]').forEach(button=>button.onclick=async()=>{
    try{const paths=await S.pickAsset("audio");if(!paths?.[0])return;
      const x=sp[+button.dataset.feAudio], key="edit_"+crypto.randomUUID().replace(/-/g,""), target=`vo/${key}.mp3`;
      await S.replace(P.dir,target,paths[0]);await refreshFiles();
      const oldLength=x.d;
      x.key=key;x.rel=target;x.miss=false;x.replaced=true;x.d=dur(target,Math.max(1.6,x.text.length*.24))+.65;
      sp.slice(+button.dataset.feAudio+1).forEach(next=>{next.t+=x.d-oldLength;next.baseT+=x.d-oldLength;});
      dirtyE=true;$e(`[data-fe-file="${button.dataset.feAudio}"]`).textContent=target;finStop();draw();
    }catch(error){toast(error.message,true);}
  });
  const setOffset = (index,value) => {
    const row=sp[index];if(!row)return;const max=Math.max(0,full-tr[0]-(row.baseT||0)-.05);
    finStop();moveFinVoice(sp,index,Math.min(max,Math.max(0,Number(value)||0)));dirtyE=true;draw();
  };
  m.querySelectorAll('[data-fe-offset]').forEach(input=>input.onchange=()=>setOffset(+input.dataset.feOffset,input.value));
  let voiceDrag=null;
  $e('.fe-vo').onpointerdown=e=>{
    const block=e.target.closest('[data-fe-voice]');if(!block||e.button!==0)return;
    e.preventDefault();e.stopPropagation();finStop();const index=+block.dataset.feVoice;
    voiceDrag={index,x:e.clientX,offset:sp[index].offset||0,width:$e('.fe-vo').getBoundingClientRect().width};
    $e('.fe-vo').setPointerCapture(e.pointerId);
  };
  m.addEventListener('pointermove',e=>{if(voiceDrag&&voiceDrag.width>0)setOffset(voiceDrag.index,voiceDrag.offset+(e.clientX-voiceDrag.x)/voiceDrag.width*full)});
  m.addEventListener('pointerup',()=>{voiceDrag=null});m.addEventListener('pointercancel',()=>{voiceDrag=null});
  $e(".fe-vo").oncontextmenu=e=>{const row=e.target.closest('[data-fe-voice]');if(!row)return;const x=sp[+row.dataset.feVoice];reviewJumpMenu(e,x.muted?"取消静音（Unmute）":"静音（Mute）",()=>{finStop();x.muted=!x.muted;dirtyE=true;draw();});};
  $e(".fe-fx").oncontextmenu=e=>{if(!va)return;reviewJumpMenu(e,va.muted?"取消静音（Unmute）":"静音（Mute）",()=>{finStop();va.muted=!va.muted;dirtyE=true;draw();});};
  const X = t => Math.max(0, Math.min(100, t / full * 100));
  function draw() {
    selEl.style.left = X(tr[0]) + "%"; selEl.style.width = (X(tr[1]) - X(tr[0])) + "%";
    $e(".fe-in").value = tr[0]; $e(".fe-out").value = tr[1]; $e(".fe-len").textContent = `播 ${(tr[1] - tr[0]).toFixed(1)} 秒 · 原长 ${full.toFixed(1)} 秒`;
    $e(".fe-vo").innerHTML = sp.map(x => `<div data-fe-voice="${sp.indexOf(x)}" class="fe-blk vo${x.miss ? " miss" : ""}${x.muted?" is-muted":""}" style="cursor:grab;touch-action:none;left:${X(tr[0] + x.t)}%;width:${Math.max(1, X(tr[0] + x.t + Math.max(.4, x.d - .65)) - X(tr[0] + x.t))}%" title="${esc(x.who)}：${esc(x.text)}">${esc(x.who === "你" ? "司机" : x.who)}：${esc(String(x.text).slice(0, 14))}</div>`).join("");
    $e(".fe-fx").innerHTML = va ? `<div class="fe-blk fx${va.muted?" is-muted":""}" style="left:${X(tr[0])}%;width:${X(tr[1]) - X(tr[0])}%">${esc(va.file?.split("/").pop() || "视频自带原声")} · ${Math.round((va.vol ?? 1) * 100)}%</div>` : '<span class="dim" style="padding-left:6px;font-size:12px">没有音效</span>';
    $e(".fe-fxname").textContent = va ? (va.file || "视频自带原声") : "没有"; $e(".fe-vol").value = va ? (va.vol ?? 1) : 1; $e(".fe-vol").disabled = !va?.file; $e(".fe-volv").textContent = va ? Math.round((va.vol ?? 1) * 100) + "%" : "";
    $e('[data-e="fxdel"]').hidden = !va; $e('[data-e="detach"]').hidden = !!va?.file;
    $e(".fe-ruler").innerHTML = [...Array(Math.floor(full) + 1).keys()].map(t => `<i style="left:${X(t)}%">${t}s</i>`).join("");
    m.querySelectorAll('[data-fe-offset]').forEach(input=>input.value=sp[+input.dataset.feOffset].offset||0);
    $e('.fe-delay-note').textContent=sp.some(x=>tr[0]+x.t+Math.max(.4,x.d-.65)>tr[1]+.05)?'配音超出视频出点，试听会截断；请延长出点或减少延后时间。':'配音延后时间从原定开口位置计算；蓝色配音块可以左右拖动。';
    $e(".fe-dirty").textContent = dirtyE ? "有改动，还没保存" : "";
  }
  const setTr = (a, b) => { a = Math.max(0, +(+a).toFixed(2)); b = Math.min(full, +(+b).toFixed(2)); if (b < a + .3) return toast("出点要比入点晚至少 0.3 秒", true); finStop(); tr = [a, b]; dirtyE = true; draw(); };
  v.onplay = () => { if (!FINMIX || FINMIX.v !== v) finMixOn(v,s,tr,va,sp,v.currentTime); };
  v.onloadedmetadata = () => { if (v.duration && Math.abs(v.duration - full) > .05) { const wasFull = tr[1] >= full - .05; full = v.duration; if (wasFull) tr[1] = +full.toFixed(2); } try { v.currentTime = tr[0]; } catch {} draw(); };
  v.ontimeupdate = () => { ph.style.left = X(v.currentTime) + "%"; if (FINMIX && FINMIX.v === v && v.currentTime >= tr[1] - .04) v.pause(); };
  // 拖动入点 / 出点；点时间条跳到那一秒
  let drag = null;
  m.querySelectorAll(".fe-h").forEach(h => h.onpointerdown = e => { e.preventDefault(); e.stopPropagation(); finStop(); drag = h.classList.contains("fe-hin") ? "in" : "out"; h.setPointerCapture(e.pointerId); });
  m.addEventListener("pointermove", e => { if (!drag) return; const r = track.getBoundingClientRect(), t = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * full;
    if (drag === "in") tr[0] = +Math.min(t, tr[1] - .3).toFixed(2); else tr[1] = +Math.max(t, tr[0] + .3).toFixed(2); dirtyE = true; draw(); try { v.currentTime = drag === "in" ? tr[0] : tr[1]; } catch {} });
  m.addEventListener("pointerup", () => { drag = null; });
  track.onclick = e => { if (e.target.classList.contains("fe-h")) return; const r = track.getBoundingClientRect(); try { v.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * full; } catch {} };
  $e(".fe-in").onchange = () => setTr($e(".fe-in").value, tr[1]); $e(".fe-out").onchange = () => setTr(tr[0], $e(".fe-out").value);
  $e(".fe-vol").oninput = () => { if (!va) return; va.vol = +$e(".fe-vol").value; dirtyE = true; draw(); };
  const close = async () => { if (dirtyE && await S.confirm("有改动还没保存，确定关闭吗？", ["不保存，关闭", "回去保存"]) !== 0) return; finStop(); m.remove(); };
  m.querySelectorAll("[data-e]").forEach(b => b.onclick = async () => { const a = b.dataset.e;
    if (a === "close") return close();
    if (a === "setin") setTr(v.currentTime, tr[1]); else if (a === "setout") setTr(tr[0], v.currentTime); else if (a === "full") setTr(0, full);
    else if (a === "mix") finMixOn(v, s, tr, va, sp); else if (a === "stop") finStop();
    else if (a === "fxdel") { va = null; dirtyE = true; draw(); }
    else if (a === "pick") { try { const p = await S.pickAsset("audio"); if (!p || !p[0]) return; const ext = (p[0].match(/\.\w+$/) || [".mp3"])[0].toLowerCase(), out = `sfx/va_${s.id}${ext}`;
      await S.replace(P.dir, out, p[0]); await refreshFiles(); va = { file: out, vol: va ? va.vol ?? 1 : 1 }; dirtyE = true; draw(); toast(`音效已复制到 ${out}`); } catch (e2) { toast(e2.message, true); } }
    else if (a === "detach") { const before = P.VAUD[rel]; await detachAudio(rel); const got = P.VAUD[rel]; if (got && got !== before) { va = { ...got }; if (before) P.VAUD[rel] = before; else delete P.VAUD[rel]; dirtyE = true; draw(); } }
    else if (a === "save") { needEngine();
      try { edit(() => { applyFinSpeech(sp); if (tr[0] <= .05 && tr[1] >= full - .05) delete P.TRIM[rel]; else P.TRIM[rel] = [tr[0], tr[1]]; if (va) P.VAUD[rel] = va; else delete P.VAUD[rel]; });
        if(await save() === false)return; } catch (e2) { return toast("保存失败：" + e2.message, true); }
      dirtyE = false; finStop(); m.remove(); rvUpdateCard(k); rvCounts(); toast("已同步到剧本和剪辑台：视频剪辑、台词、配音和音效"); } });
  m.addEventListener("keydown", e => { if (e.key === "Escape") { e.stopPropagation(); close(); } if (e.key === " " && !e.target.matches("input,textarea,select")) { e.preventDefault(); v.paused ? finMixOn(v,s,tr,va,sp) : v.pause(); } });
  m.tabIndex = -1; m.focus(); draw();
}
async function finAct(a, k, it) {
  const s = vsShot(it.vid); if (!s) return;
  if (a === "fok") { if (!has(finRel(s))) return toast("还没有视频", true); try { P.sb = await S.sbReview(P.dir, "final:" + s.id, true, "", finHash(s)); rvUpdateCard(k); rvCounts(); renderTop(); } catch (e) { return toast(e.message, true); } rvFocus(k + 1); }
  else if (a === "fbad") { const old = ((SB() || {}).review || {})["final:" + s.id]; const r = await askText("成片哪里有问题？", old && !old.ok && old.note ? old.note : "比如：嘴型和配音对不上；第 3 秒手变形；音效太响"); if (!r || !r.text) return;
    try { P.sb = await S.sbReview(P.dir, "final:" + s.id, false, r.text, finHash(s)); rvUpdateCard(k); rvCounts(); renderTop(); } catch (e) { return toast(e.message, true); }
    if (await S.confirm(`记下了。要回「③ 草稿」改 ${s.id} 的提示词、重新生成吗？\n（问题会显示在 ③ 的卡片上；也可以先在这里换一个版本，或只调剪辑点 / 声音）`, ["去 ③ 改提示词", "留在这里"]) === 0) finAct("fdraft", k, it); }
  else if (a === "fdraft") { await switchReviewFlow("video",it); }
}
function rvCard(it, k) {
  const st = rvState(it), shot = it.im ? shotOf(it.im) : null, sst = it.im ? sbState(it.im) : null, [tc, tt] = statusTag(it.im), r = it.ok ? reviewOf(it.sid, it.im) : null;
  const last = sst ? (sst.refine && sst.refine.length ? sst.refine[sst.refine.length - 1] : (sst.tries || []).filter(t => t.file).slice(-1)[0]) : null;
  const cands = it.ok ? rvCands(it.sid) : [];
  const rtag = { ok: '<span class="tag pass">人工 ✓ 已通过</span>', bad: '<span class="tag rvbad">人工 ✗ 有问题</span>', todo: '<span class="tag none">待审</span>', missing: '<span class="tag fb">没有图</span>' }[st];
  return `<article class="rvcard st-${st}" data-k="${k}">
    <div class="rvimg">${it.ok ? `<img class="rvmain" src="${fileUrl(limgRel(it.im))}" loading="lazy" alt="">` : `<div class="rvmiss">${it.x ? `找不到 ${esc(limgRel(it.im))}` : "这一句还没有分镜图<br><small>播放时沿用场景图</small>"}</div>`}<div class="rvbanner" hidden></div></div>
    <div class="rvinfo">
      <div class="rvwhere"><span class="dim">${esc(sceneName(it.nid))} · ${rvWhere(it)}</span>${it.sid ? `<span class="chip">${esc(it.sid)}</span>` : ""}${it.x ? `<span class="tag none">${X_LABEL[it.x]}</span>` : ""}${notShown(it) ? '<span class="tag rvbad">游戏里不显示</span>' : ""}</div>
      <div class="rvline">${rvLineHtml(it)}</div>${notShown(it) ? `<div class="rvsec"><div class="cnote" style="color:var(--bad)">⚠ ${notShown(it)}</div></div>` : ""}
      <div class="rvtags">${it.ok && !(it.x && !sst) ? `<span class="tag ${tc}">${tt === "本地替换" ? "" : "AI "}${tt}</span>` : ""}${rtag}${it.x ? "" : contTag(it, "img") + upTag(it, "img")}</div>
      ${it.x ? (it.x !== "cap" ? '<div class="dim" style="font-size:12px">这张图不是分镜流水线出的（没有 AI 质检和候选），只能人审；有问题可以直接修图，采用后替换游戏里的这张（原图先备份）。</div>' : "") : upHtml(it, "img")}
      ${shot ? `<div class="rvsec"><label>分镜要求</label><div>${esc(shot.shot || "")}${shot.in_frame ? " · 画面里：" + esc(shot.in_frame) : ""}</div><div class="dim">${esc(shot.layout || shot.desc || "")}</div></div>` : ""}
      ${last && last.issues && last.issues.length && sst.status !== "pass" ? `<div class="rvsec"><label>AI 质检发现的问题（${last.score ?? "-"}/10）</label><ul class="qc">${last.issues.map(x => `<li>${esc(x)}</li>`).join("")}</ul></div>` : ""}
      ${it.x ? "" : contStrip(it, "img")}
      ${r && !r.ok && r.note ? `<div class="rvsec"><label>审阅意见</label><div class="rvnotev">${esc(r.note)}</div></div>` : ""}
      ${cands.some(c => !c.cur) ? `<div class="rvsec"><label>其他候选（单击在左边看，双击放大）</label><div class="rvcands">${cands.map((c, j) => `<button class="rvc${c.cur ? " cur" : ""}" data-cand="${j}" title="单击在左边大图里看，双击放大${c.issues.length ? "\n" + esc(c.issues.join("\n")) : ""}"><img src="${fileUrl("../storyboard/out/" + c.dir + "/" + c.file)}" data-zoom="候选 · ${esc(c.label)}（${candQc(c)}）" loading="lazy" alt=""><span>${esc(c.label)} ${c.pass == null ? "" : c.pass ? "✓" : (c.score ?? "")}${c.cur ? " · 在用" : ""}</span></button>`).join("")}</div></div>` : ""}
      ${it.ok ? `<div class="rvact"><button class="pri" data-a="ok">✓ 通过<kbd>A</kbd></button><button class="ghost" data-a="bad">✗ 有问题<kbd>X</kbd></button><button class="ghost" data-a="fix">✎ 修图<kbd>E</kbd></button><button class="ghost" data-a="local" title="用自己电脑上的图片替换（自动裁成 16:9、1280×720，原图先备份）">⇪ 换成本地图片</button><button class="ghost" data-a="redraw" ${shot ? "" : "disabled"}>↻ 重画<kbd>R</kbd></button></div>
      <div class="rvnote" hidden><textarea placeholder="哪里不对？比如：女人坐到了后座，应该在副驾驶">${esc(r && !r.ok ? r.note : "")}</textarea><div class="row"><button class="ghost" data-a="noteSave">只记下</button><button class="pri" data-a="noteAI" title="按这句意见让 AI 在整张图上修改，再质检">记下并让 AI 按意见修改</button></div></div>`
      : it.x === "shot" ? `<div class="rvact"><button class="ghost" data-a="local" title="用自己电脑上的图片（自动裁成 16:9、1280×720）">⇪ 用本地图片</button></div>` : `<div class="rvact"><button class="ghost" data-a="goto">去故事板给这一句出图</button></div>`}
    </div></article>`;
}
function rvRender() {
  regenQueueToolbar(); voiceAuditToolbar(); editAuditToolbar();
  stopFinalLoading();
  const body = RV.el.querySelector("#rvBody");
  body.innerHTML = (RV.kind === "ref" ? refHubBar() : "") + (RV.scope === "all" && (RV.kind === "prompt" || RV.kind === "video") ? orphanBar(RV.kind) : "") + (RV.items.length ? RV.items.map((it, k) => RV.kind === "final" ? finCard(it, k) : RV.kind === "video" ? vCard(it, k) : RV.kind === "script" ? scriptCard(it, k) : RV.kind === "ref" ? refCard(it, k) : RV.kind === "prompt" ? pvCard(it, k) : rvCard(it, k)).join("") + `<div class="rvend dim">${RV.filter === "todo" ? "这一批看完了 ✓" : "到底了"}</div>` : `<div class="rvempty">${(RV.kind === "final" ? { todo: "成片都确认过了 ✓", bad: "没有标了问题的成片", all: "这里没有视频镜头" } : RV.kind === "video" ? { todo: VS() ? "视频提示词都审过了 ✓" : "没找到视频分镜表（autofix\\video_shots.json）", bad: "没有标了问题的", all: VS() ? "这里没有视频镜头" : "没找到视频分镜表" } : RV.kind === "script" ? { todo: "剧本都审过了 ✓", bad: "没有标了问题的场景", up: "", all: "还没有场景" } : RV.kind === "ref" ? { todo: "参考图都审过了 ✓", bad: "没有标了问题的参考图", all: "还没有参考图" } : RV.kind === "prompt" ? { todo: "提示词都审过了 ✓", bad: "没有标了问题的提示词", all: "这里没有台词" } : { todo: "没有待审的图了 ✓", bad: "没有标了问题的图", all: "这里没有台词" })[RV.filter] || "没有上游改过、要复查的 ✓"}</div>`);
  body.querySelectorAll("[data-orphdel]").forEach(b => b.onclick = async () => {
    const [kind, id] = b.dataset.orphdel.split(":");
    if (await S.confirm(`删掉${kind === "video" ? "视频分镜表" : "分镜表"}里的 ${id}？（先自动备份；图片、视频文件不动）`, ["删掉", "取消"]) !== 0) return;
    try { if (kind === "video") P.vs = await S.vsDel(P.dir, id); else P.sb = await S.sbSaveShot(P.dir, { id, _delete: true }); toast("已删掉 " + id); rvBuild(); renderTop(); } catch (e) { toast(e.message, true); }
  });
  body.querySelectorAll(".rvcard").forEach(card => {
    const k = +card.dataset.k, it = RV.items[k]; rvBackRow(card, it, k);
    card.addEventListener("click", e => { if (!e.target.closest("button,textarea,input,select")) rvFocus(k, false); });
    card.querySelectorAll("img").forEach(im => im.addEventListener("error", () => { const b = im.closest(".rvc"); if (b) b.remove(); }));
    card.querySelectorAll("[data-a]").forEach(b => b.onclick = () => { rvFocus(k, false); rvAct(b.dataset.a, k); });
    card.querySelectorAll("[data-cand]").forEach(b => b.onclick = () => rvShowCand(k, +b.dataset.cand));
    if (RV.kind === "final") bindFinCard(card, k); else if (RV.kind === "video") bindVCard(card, k); else if (RV.kind === "script") bindScriptCard(card, k); else if (RV.kind === "ref") bindRefCard(card, k); else if (RV.kind === "prompt") bindPvCard(card, k); else bindRvZoom(card, k); bindReviewFlow(card,k); bindRegenQueue(card,k);
  });
  RV.io && RV.io.disconnect();
  if (RV.kind === "ref") bindRefHub();
  RV.io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting && e.intersectionRatio > .55) rvFocus(+e.target.dataset.k, false, true); }), { root: body, threshold: [.55] });
  body.querySelectorAll(".rvcard").forEach(c => RV.io.observe(c));
  rvFocus(Math.min(RV.k, RV.items.length - 1), false);
}
function rvFocus(k, scroll = true, passive = false) {
  if (!RV || k < 0 || k >= RV.items.length) return;
  if (passive && RV.kind === "final") { RV.k = k; return; }
  RV.k = k; RV.el.querySelectorAll(".rvcard").forEach(c => c.classList.toggle("focus", +c.dataset.k === k));
  if (scroll) { const c = RV.el.querySelector(`.rvcard[data-k="${k}"]`); c && c.scrollIntoView({ block: "center", behavior: "smooth" }); }
}
function bindRvZoom(card, k) {
  const im = card.querySelector(".rvmain"); if (!im) return;
  const it = RV.items[k]; im.title = "双击放大"; im.dataset.zoom = `${sceneName(it.nid)} · 第 ${it.i + 1} 句 · ${it.sid}`;
}
function rvShowCand(k, j) {
  const it = RV.items[k], c = rvCands(it.sid)[j], card = RV.el.querySelector(`.rvcard[data-k="${k}"]`); if (!c || !card) return;
  const img = card.querySelector(".rvmain"), ban = card.querySelector(".rvbanner");
  card.querySelectorAll(".rvc").forEach(b => b.classList.toggle("view", +b.dataset.cand === j));
  if (c.cur) { img.src = fileUrl(limgRel(it.im)); ban.hidden = true; return; }
  img.src = fileUrl("../storyboard/out/" + c.dir + "/" + c.file);
  ban.hidden = false;
  ban.innerHTML = `<span>候选：${esc(c.label)}（${candQc(c)}）${c.issues.length ? " · " + esc(c.issues.join("；")) : ""}</span><span class="grow"></span><button class="pri" data-use>用这张</button><button class="ghost" data-back>回到在用的</button>`;
  ban.querySelector("[data-back]").onclick = () => { img.src = fileUrl(limgRel(it.im)); ban.hidden = true; card.querySelectorAll(".rvc").forEach(b => b.classList.remove("view")); };
  ban.querySelector("[data-use]").onclick = () => runTool("fix_box.py", ["accept", it.sid, `storyboard/out/${c.dir}/${c.file}`], `换成候选 · ${it.sid}`);
}
// 审过之后发现漏了：任何一类审阅都能改判「有问题」（写下哪里不对）或改回「待审」
function rvKeyOf(it) {
  if (RV.kind === "ref") return { key: "ref:" + it.ref.id, hash: it.ref.mtime };
  if (RV.kind === "script") return { key: "script:" + it.nid, hash: sceneHash(it.nid) };
  if (RV.kind === "final") { const s = vsShot(it.vid); return s ? { key: "final:" + s.id, hash: finHash(s) } : null; }
  if (RV.kind === "video") { const s = vsShot(it.vid); return s ? { key: "vprompt:" + s.id, hash: vpHash(s), extra: { keym: s._keym } } : null; }
  if (RV.kind === "prompt") { if (it.x === "scene" || it.x === "shot") return { key: "prompt:" + it.sid, hash: xpHash(it) }; const shot = it.im ? shotOf(it.im) : null; return shot ? { key: "prompt:" + shot.id, hash: promptHash(shot) } : null; }
  return it.ok && it.sid ? { key: it.sid, hash: (P.files[limgRel(it.im)] || {}).mtime } : null;
}
function rvBackRow(card, it, k) {
  const st = rvSt(it), kk = rvKeyOf(it); if (!kk || !["ok", "bad"].includes(st)) return;
  const r = ((SB() || {}).review || {})[kk.key], note = st === "bad" && r && r.note ? r.note : "";
  const own = RV.kind === "img" || RV.kind === "script" || RV.kind === "final";      // 这两类卡片上本来就有「✗ 有问题」按钮
  const row = document.createElement("div"); row.className = "rvback";
  row.innerHTML = `<span class="dim">${st === "ok" ? "已标记没问题" : "已标记有问题"}${note ? "：" + esc(note) : ""}${r && r.at ? `（${esc(new Date(r.at).toLocaleString("zh-CN", { hour12: false }).replace(/:\d\d$/, ""))}）` : ""}</span>`
    + (st === "ok" && !own ? '<button class="ghost" data-a="xbad" title="审过之后才发现的问题：写下哪里不对，标成有问题">✗ 其实有问题</button>' : "")
    + (st === "bad" && !own ? '<button class="ghost" data-a="xbad" title="改一下记下的问题">改写问题</button>' : "")
    + '<button class="ghost" data-a="xreset" title="撤销这次审阅结果，回到待审">↺ 改回待审</button>';
  row.querySelectorAll("[data-a]").forEach(b => b.onclick = e => { e.stopPropagation(); rvFocus(k, false); rvAct(b.dataset.a, k); });
  const act = card.querySelector(".rvact"); if (act) act.after(row); else (card.querySelector(".rvinfo") || card).appendChild(row);
}
async function rvAct(a, k) {
  const it = RV.items[k]; if (!it) return;
  if (a === "imageDraft" && RV.kind === "img") { await switchReviewFlow("video",it); return; }
  if (a === "xbad" || a === "xreset") {
    const kk = rvKeyOf(it); if (!kk) return;
    let text = "";
    if (a === "xbad") { const old = ((SB() || {}).review || {})[kk.key]; const v = await askText("哪里有问题？", old && !old.ok && old.note ? old.note : "比如：司机的手没握方向盘；构图写反了左右"); if (!v || !v.text) return; text = v.text; }
    try { P.sb = await S.sbReview(P.dir, kk.key, false, text, a === "xreset" ? 0 : kk.hash, kk.extra); } catch (e) { return toast(e.message, true); }
    rvUpdateCard(k); rvCounts(); renderTop(); if (RV.kind === "img") renderBoard();
    toast(a === "xreset" ? "已改回待审" : "已标记为有问题"); return;
  }
  const card = RV.el.querySelector(`.rvcard[data-k="${k}"]`), note = card && card.querySelector(".rvnote");
  const mtime = it.ok && it.im ? (P.files[limgRel(it.im)] || {}).mtime : 0;
  const mark = async (ok, text) => { try { P.sb = await S.sbReview(P.dir, it.sid, ok, text, mtime); rvUpdateCard(k); rvCounts(); renderTop(); renderBoard(); } catch (e) { toast(e.message, true); } };
  if (RV.kind === "ref") {
    const r = it.ref;
    if (a === "rok") { try { P.sb = await S.sbReview(P.dir, "ref:" + r.id, true, "", r.mtime); rvUpdateCard(k); rvCounts(); renderTop(); } catch (e) { return toast(e.message, true); } rvFocus(k + 1); }
    else if (a === "regen") { if (!(r.desc || "").trim()) return toast("先在右边写描述，AI 才知道画什么", true); runTool("ref_tool.py", ["gen", r.id], `${r.exists ? "重新生成" : "生成"}参考图 · ${r.name}`); }
    else if (a === "rimport") { if (await importRef(r.id)) rvUpdateCard(k); }
    else if (a === "attachAll") { await attachRef(refUse(r).missing, r.id); rvUpdateCard(k); }
    else if (a === "rused") { const ids = new Set(refUse(r).used); RV.kind = "prompt"; RV.filter = "all"; rvBuild(); const kk = RV.items.findIndex(x => x.sid && ids.has(x.sid)); if (kk >= 0) rvFocus(kk); toast(`用到「${r.name}」的镜头：${[...ids].join("、")}`); }
    return;
  }
  if (RV.kind === "script") {
    const key = "script:" + it.nid;
    if (a === "sok") { try { P.sb = await S.sbReview(P.dir, key, true, "", sceneHash(it.nid)); rvUpdateCard(k); rvCounts(); renderTop(); } catch (e) { return toast(e.message, true); } rvFocus(k + 1); }
    else if (a === "sbad") { note.hidden = false; note.querySelector("textarea").focus(); }
    else if (a === "snoteSave") { const text = note.querySelector("textarea").value.trim(); if (!text) return toast("先写一句哪里不对", true); try { P.sb = await S.sbReview(P.dir, key, false, text, sceneHash(it.nid)); rvUpdateCard(k); rvCounts(); renderTop(); } catch (e) { toast(e.message, true); } }
    else if (a === "sdown") { const ids = new Set(scriptDownstream(it.nid).map(x => x.sid)); RV.kind = "prompt"; RV.filter = "up"; rvBuild(); const kk = RV.items.findIndex(x => x.sid && ids.has(x.sid)); if (kk >= 0) rvFocus(kk); }
    else if (a === "goto") { const nid = it.nid; closeReview(); if (mode !== "board") setMode("board"); goScene(nid); setCenter("board"); }
    return;
  }
  if (a === "sketch" || a === "sketchmap") { if (it.sid) openSketch(it.sid, a === "sketchmap" ? "map" : "comp"); return; }
  if (RV.kind === "final") { await finAct(a, k, it); return; }
  if (RV.kind === "video") {
    const s = vsShot(it.vid); if (!s) return;
    const approve = async () => { P.sb = await S.sbReview(P.dir, "vprompt:" + s.id, true, "", vpHash(s), { keym: s._keym }); rvUpdateCard(k); rvCounts(); renderTop(); };
    if (a === "vok") { try { await approve(); } catch (e) { return toast(e.message, true); } rvFocus(k + 1); }
    else if (a === "vsketch") { openMotionSketch(s.id); return; }
    else if (a === "vfinal") { await switchReviewFlow("final",it); return; }
    else if (a === "vwrite") { runTool("write_vprompts.py", [s.id], `AI 写视频提示词 · ${s.id}`); return; }
    else if (a === "vdcode") { runTool("draft_video.py", [s.id], `出草稿 · ${s.id}`); return; }
    else if (a === "vdend") { runTool("draft_video.py", [s.id, "--end"], `AI 画尾帧 + 草稿 · ${s.id}`); return; }
    else if (a === "vd25") { runTool("draft_video.py", [s.id, "--b25d"], `2.5D 预演 · ${s.id}`); return; }
    else if (a === "vd25e") { try { await S.openPath(P.dir + "/../motion_ref/scenes/" + s.id + ".json"); } catch (e) { toast("还没有参数文件：先点一次「2.5D 预演」，会按提示词自动生成一份", true); } return; }
    else if (a === "vdlocal") { runTool("draft_video.py", [s.id, "--local"], `本地模型草稿 · ${s.id}`); return; }
    else if (a === "vduse" || a === "vdunuse") { const dr = vDraftOf(s); try { P.vs = await S.vsSave(P.dir, s.id, { last: a === "vduse" ? dr.end.file : "" }); toast(a === "vduse" ? "正式生成时会用这张当尾帧（首尾帧模式）" : "不用尾帧了"); rvUpdateCard(k); } catch (e) { toast(e.message, true); } return; }
    else if (a === "vgen") {
      if (vpState(it) !== "ok") { if (await S.confirm(`${s.id} 的视频提示词还没审过（或审过之后又改了）。按约定，第一次生成前要人确认提示词。`, ["确认没问题，接着生成", "取消"]) !== 0) return; try { await approve(); } catch (e) { return toast(e.message, true); } }
      if (vLint(s).some(x => x.lv === "bad") && await S.confirm("自动检查还有红色问题，照样生成吗？", ["照样生成", "取消"]) !== 0) return;
      const pick = await pickEngine(s); if (!pick) return;
      runTool("autofix.py", [s.id, "--engine=" + pick.engine, pick.more ? "--more" : "--again"], `生成视频 · ${s.id} · ${ENGINES[pick.engine].label}`);
    }
    else if (a === "goto") { closeReview(); if (P.N[s.id]) { goScene(s.id); setCenter("board"); } }
    return;
  }
  if (a === "upack") { await upAck([it.sid], RV.kind === "img" ? "img" : "prompt"); rvUpdateCard(k); rvCounts(); renderBoard(); return; }
  if (a === "cont") { if (sceneSeq(it.nid).length > 1) runCont([it.nid]); return; }
  if (a === "pok" && (it.x === "scene" || it.x === "shot")) { try { P.sb = await S.sbReview(P.dir, "prompt:" + it.sid, true, "", xpHash(it)); rvUpdateCard(k); rvCounts(); renderTop(); } catch (e) { return toast(e.message, true); } rvFocus(k + 1); return; }
  if (a === "xpvid") { const id = xPrompt(it).id; RV.kind = "video"; RV.filter = "all"; rvBuild(); const kk = RV.items.findIndex(x => x.vid === id); if (kk >= 0) rvFocus(kk); return; }
  if (a === "local") {   // 图片审阅：换成本地图片（剪辑台裁成 16:9、转 1280×720 JPG，原图先备份；本地原图另存成这个镜头的候选）
    if (!it.ok && it.x !== "shot") return toast("这一句还没有图，先去故事板出图", true);
    try { const p = await S.pickAsset("image"); if (!p || !p[0]) return; const r = await S.replace(P.dir, limgRel(it.im), p[0]); await refreshFiles(); rvUpdateCard(k); rvCounts(); renderBoard();
      toast(`已换成本地图片：${it.sid}${r && r.note ? "（" + r.note + "）" : ""}，原图已备份。换过的图回到待审`);
      runTool("fix_box.py", ["local", it.sid, p[0]], `本地替换 · ${it.sid}`); } catch (e) { toast(e.message, true); }
    return;
  }
  if (a === "pok") { const shot = shotOf(it.im); if (!shot) return; try { P.sb = await S.sbReview(P.dir, "prompt:" + shot.id, true, "", promptHash(shot)); await upAck([shot.id], "prompt"); rvUpdateCard(k); rvCounts(); } catch (e) { return toast(e.message, true); } rvFocus(k + 1); return; }
  if (a === "ok") { await mark(true, ""); await upAck([it.sid], "img"); rvUpdateCard(k); rvFocus(k + 1); }
  else if (a === "bad") { note.hidden = false; note.querySelector("textarea").focus(); }
  else if (a === "noteSave" || a === "noteAI") {
    const text = note.querySelector("textarea").value.trim(); if (!text) return toast("先写一句哪里不对", true);
    await mark(false, text);
    if (a === "noteAI") runTool("refine.py", [it.sid, text], `AI 按意见修改 · ${it.sid}`); else rvFocus(k + 1);
  }
  else if (a === "fix") openFixBox(it.i, it.nid, it.x ? it.im : undefined);
  else if (a === "redraw") { if (!shotOf(it.im)) return; runTool("batch.py", [it.sid], `${it.ok ? "重画" : "出图"} · ${it.sid}`); }
  else if (a === "goto") { const nid = it.nid, i = it.i; closeReview(); if (mode !== "board") setMode("board"); goScene(nid); setCenter("board"); selectLine(i); }
}
function rvUpdateCard(k) {
  const old = RV.el.querySelector(`.rvcard[data-k="${k}"]`); if (!old) return;
  const it = RV.items[k];
  if (RV.kind === "final" && old.__finalStamp === finalCardStamp(it)) return;
  if (RV.kind === "ref") it.ref = refById(it.ref.id) || it.ref;
  else if (RV.kind === "script") { if (!P.N[it.nid]) return; }
  else if (RV.kind === "video" || RV.kind === "final") { if (!vsShot(it.vid)) return; }
  else if (it.x) it.ok = has(limgRel(it.im));     // 场景图 / 特写镜头：图固定，不按句子重新找
  else { it.im = limgOf(it.nid, it.i); it.ok = !!(it.im && has(limgRel(it.im))); it.sid = it.im ? shotId(it.im) : null; }
  const t = document.createElement("div"); t.innerHTML = RV.kind === "final" ? finCard(it, k) : RV.kind === "video" ? vCard(it, k) : RV.kind === "script" ? scriptCard(it, k) : RV.kind === "ref" ? refCard(it, k) : RV.kind === "prompt" ? pvCard(it, k) : rvCard(it, k); const card = t.firstElementChild; if (!old.isConnected) return; try { releaseFinalMedia(old); old.replaceWith(card); } catch { return; } rvBackRow(card, it, k);   // 输入框失焦时可能已经换过一次
  if (RV.kind === "final") bindFinCard(card, k); else if (RV.kind === "video") bindVCard(card, k); else if (RV.kind === "script") bindScriptCard(card, k); else if (RV.kind === "ref") bindRefCard(card, k); else if (RV.kind === "prompt") bindPvCard(card, k); else bindRvZoom(card, k); bindReviewFlow(card,k); bindRegenQueue(card,k);
  card.addEventListener("click", e => { if (!e.target.closest("button,textarea,input,select")) rvFocus(k, false); });
  card.querySelectorAll("img").forEach(im => im.addEventListener("error", () => { const b = im.closest(".rvc"); if (b) b.remove(); }));
  card.querySelectorAll("[data-a]").forEach(b => b.onclick = () => { rvFocus(k, false); rvAct(b.dataset.a, k); });
  card.querySelectorAll("[data-cand]").forEach(b => b.onclick = () => rvShowCand(k, +b.dataset.cand));
  RV.io && RV.io.observe(card); card.classList.toggle("focus", RV.k === k);
}
function rvRefresh() { if (!RV) return; if (RV.kind === "ref" && RV.refMode === "voice") { voiceRefsBuild(); return; } if (RV.kind === "dialogue") { dialogueBuild(); return; } RV.items.forEach((_, k) => rvUpdateCard(k)); rvCounts(); }
function rvKey(e) {
  if (RV && (RV.kind === "dialogue" || (RV.kind === "ref" && RV.refMode === "voice"))) { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeReview(); } else if (!e.target.matches("input,select,textarea,audio,button")) { e.stopPropagation(); } return; }
  if (!RV || document.querySelector(".modal")) return;          // 修图窗口、对话框开着时不抢按键
  const inText = e.target && e.target.matches && e.target.matches("textarea,input");
  const mod = e.ctrlKey || e.metaKey;
  if (mod && !inText && /^[zy]$/i.test(e.key)) {     // 审阅页里也能撤销 / 重做（剧本审阅改的是同一份剧本）
    e.preventDefault(); e.stopPropagation(); (e.key.toLowerCase() === "y" || e.shiftKey) ? redo() : undo(); RV.G = null; rvRefresh(); return;
  }
  if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); e.stopPropagation(); if (dirty) save(); return; }
  if (inText) { if (e.key === "Escape") { e.target.closest(".rvnote") && (e.target.closest(".rvnote").hidden = true); e.target.blur(); e.preventDefault(); e.stopPropagation(); } return; }
  const k = RV.k, map = { ArrowDown: () => rvFocus(k + 1), j: () => rvFocus(k + 1), ArrowUp: () => rvFocus(k - 1), k: () => rvFocus(k - 1),
    a: () => rvAct(RV.kind === "final" ? "fok" : RV.kind === "video" ? "vok" : RV.kind === "script" ? "sok" : RV.kind === "ref" ? "rok" : RV.kind === "prompt" ? "pok" : "ok", k), x: () => RV.kind === "img" ? rvAct("bad", k) : RV.kind === "final" ? rvAct("fbad", k) : RV.kind === "script" && rvAct("sbad", k), e: () => RV.kind === "img" && rvAct("fix", k), r: () => RV.kind !== "script" && RV.kind !== "final" && rvAct(RV.kind === "video" ? "vgen" : RV.kind === "ref" ? "regen" : "redraw", k), Escape: closeReview };
  const fn = map[e.key] || map[e.key.toLowerCase()];
  e.stopPropagation();                                            // 审阅页开着时，按键不传给后面的剪辑台（防止误删台词）
  if (fn && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); const it = RV.items[k]; if (RV.kind === "img" && "axer".includes(e.key.toLowerCase()) && e.key.length === 1 && it && !it.ok) return; if (RV.kind === "prompt" && "ar".includes(e.key.toLowerCase()) && e.key.length === 1 && it && promptState(it) === "noshot") return; if (RV.kind === "ref" && e.key.toLowerCase() === "a" && it && !it.ref.exists) return; fn(); }
}

/* ---------- 出图任务（调用 storyboard 里的 Python 脚本） ---------- */
/* ---------- 后台任务：可以同时跑几个（出图、修图、生成参考图、视频……），右下角任务栏每个任务一个标签 ---------- */
const TASKS = []; let taskView = 0; const MAX_TASKS = 3;
function taskShots(script, args) {           // 这个任务会动哪些镜头：同一个镜头不能同时被两个任务改
  const a = args.map(String).filter(x => !x.startsWith("--"));
  if (script === "batch.py") return a.length ? a : ["*"];
  if (script === "refine.py") return !a.length ? ["*"] : (SB() && a.length === 2 && !SB().shots.find(s => s.id === a[1]) ? [a[0]] : a);
  if (script === "fix_box.py") return a[1] ? [a[1]] : [];
  if (script === "autofix.py") return a.length ? a.map(x => "video:" + x) : ["video:*"];
  if (script === "ref_tool.py") return a[1] ? ["ref:" + a[1]] : [];
  if (script === "sketch_ai.py") return a[0] ? ["sketch:" + a[0]] : [];
  return [];
}
function taskClash(shots) {
  for (const t of TASKS.filter(t => t.running)) for (const x of shots) for (const y of t.shots) {
    if (x === y) return { t, x };
    if ((x === "*" && !y.includes(":")) || (y === "*" && !x.includes(":"))) return { t, x: x === "*" ? y : x };
    if ((x === "video:*" && y.startsWith("video:")) || (y === "video:*" && x.startsWith("video:"))) return { t, x };
  }
  return null;
}
async function runTool(script, args, title, owner) {
  const running = TASKS.filter(t => t.running);
  if (running.length >= MAX_TASKS) { toast(`已经有 ${running.length} 个任务在跑，等一个结束再开新的`, true); return false; }
  const shots = taskShots(script, args), c = taskClash(shots);
  if (c) { toast(`「${c.t.title}」还在处理${c.x === "*" ? "这些镜头" : " " + c.x.replace(/^\w+:/, "")}，同一个镜头不能同时跑两个任务，等它结束再来`, true); return false; }
  if (script === "batch.py" && args.length && !(await confirmPrompts(args.map(String)))) return false;
  if (dirty) await save();
  const t = { id: 0, script, args, title, shots, owner: owner || null, log: "", running: true, code: null };
  try { const r = await S.runTool(P.dir, script, args); t.id = r.id; t.log = "▶ " + r.cmd + "\n"; }
  catch (e) { toast(e.message, true); return false; }
  TASKS.push(t); while (TASKS.length > 10) { const k = TASKS.findIndex(x => !x.running); if (k < 0) break; TASKS.splice(k, 1); }
  taskView = t.id; $("taskbar").hidden = false; renderTasks(); return t.id;
}
const taskById = id => TASKS.find(t => t.id === id);
function renderTasks() {
  const v = taskById(taskView) || TASKS[TASKS.length - 1]; if (v) taskView = v.id;
  const n = TASKS.filter(t => t.running).length;
  $("taskTabs").innerHTML = TASKS.map(t => `<button class="tk-tab${t.id === taskView ? " on" : ""}${t.running ? " run" : t.code === 0 ? " ok" : " bad"}" data-tk="${t.id}" title="${esc(t.title)}"><i></i>${esc(t.title.length > 16 ? t.title.slice(0, 16) + "…" : t.title)}${t.running ? "" : `<span data-tkx="${t.id}" title="从列表里去掉">✕</span>`}</button>`).join("");
  $("taskTabs").hidden = TASKS.length < 2;
  $("taskTitle").textContent = v ? v.title + (v.running ? "" : v.code === 0 ? " · 完成" : ` · 结束（代码 ${v.code}）`) + (n > 1 ? `　（${n} 个在跑）` : "") : "出图任务";
  $("taskSpin").className = v && v.running ? "spin" : "spin off"; $("taskStop").disabled = !(v && v.running);
  const lg = $("taskLog"); lg.textContent = v ? v.log : ""; lg.scrollTop = lg.scrollHeight;
  $("taskTabs").querySelectorAll("[data-tk]").forEach(b => b.onclick = e => {
    const x = e.target.closest("[data-tkx]");
    if (x) { const k = TASKS.findIndex(t => t.id === +x.dataset.tkx); if (k >= 0) TASKS.splice(k, 1); } else taskView = +b.dataset.tk;
    renderTasks();
  });
}
S.onToolLog(({ id, text }) => {
  const t = taskById(id); if (!t) return; t.log += text;
  if (id === taskView) { const lg = $("taskLog"), stick = lg.scrollTop + lg.clientHeight >= lg.scrollHeight - 30; lg.textContent += text; if (stick) lg.scrollTop = lg.scrollHeight; }
  if (t.owner && t.owner.kind === "fix") fixLog(text, t.owner.U);
});
S.onToolDone(async ({ id, code }) => {
  const t = taskById(id); if (!t) return; t.running = false; t.code = code; renderTasks();
  try { await refreshFiles(); const sb = await S.sbLoad(P.dir); if (sb) P.sb = sb; const rf = await S.refsLoad(P.dir); if (rf) P.refs = rf; const vs = await S.vsLoad(P.dir); if (vs) P.vs = vs; pinLineImages(); } catch {}
  await ensureUpBase(); renderAll(false); reloadPreview(); if (RV) rvRefresh();
  if (t.owner && t.owner.kind === "sketch") return t.owner.U.done(code, t.log);
  if (t.owner && t.owner.kind === "fix") { t.owner.U.busy = false; return fixDone(code, t.owner.U); }
  if (t.script === "continuity.py") { const m = t.log.match(/INFO:(.+)/); return toast(code === 0 ? "衔接检查完成：" + (m ? m[1] : "结果显示在审阅卡片里") : "衔接检查没完成，看一下日志", code !== 0); }
  toast(code === 0 ? `「${t.title}」完成，画面已更新` : `「${t.title}」结束了，看一下日志`, code !== 0);
});
$("taskStop").onclick = () => { const t = taskById(taskView); if (t && t.running) S.stopTool(t.id).catch(() => {}); };
$("taskHide").onclick = () => { $("taskbar").hidden = true; };

/* ============ 素材检查 / 剪辑表 / 导出 ============ */
function showCheck() {
  const rows = flatOrder().map(id => [id, issues(id)]).filter(x => x[1].length);
  const m = document.createElement("div"); m.className = "modal";
  m.innerHTML = `<div class="mbox"><h3>素材检查</h3>${rows.length ? `<p class="dim">红色会让游戏出错；黄色是缺素材（游戏会用关键帧或静音顶上）。点场景名跳过去。</p><ul>${rows.map(([id, iss]) => `<li><a data-id="${id}">${esc(sceneName(id))}（${id}）</a>：${iss.map(x => `<span class="chip ${x[0] === "b" ? "bad" : "warn"}">${esc(x[1])}</span>`).join("")}</li>`).join("")}</ul>` : '<p><span class="chip ok">全部素材齐全</span></p>'}
    <div class="row" style="justify-content:flex-end;margin-top:14px"><button class="ghost" id="mClose">关闭</button></div></div>`;
  document.body.appendChild(m); m.onclick = e => { if (e.target === m || e.target.id === "mClose") m.remove(); };
  m.querySelectorAll("[data-id]").forEach(a => a.onclick = () => { m.remove(); goScene(a.dataset.id); });
}
async function exportEdl() {
  const rows = [["场景", "场景名", "行号", "类型", "说话的人", "内容", "画面文件", "配音文件", "预计时长(秒)", "线索", "状态"]];
  flatOrder().forEach(id => {
    const n = P.N[id], sc = schedule(id), at = i => sc.items.find(x => x.i === i && x.tr !== "evt");
    rows.push([id, sceneName(id), "", "场景", "", n.img || "", `vid/${id}.mp4`, "", sc.total.toFixed(1), (n.gain || []).filter(c => !(n.gainAt && c in n.gainAt)).join(" "), issues(id).map(x => x[1]).join("；")]);
    n.lines.forEach((l, i) => {
      const it = at(i), clue = Object.keys(n.gainAt || {}).filter(c => n.gainAt[c] === i).join(" "), d = it ? it.d.toFixed(1) : "";
      if (l[0] === "@shot") rows.push([id, "", i + 1, "插入镜头", "", l[1], `vid/s_${l[1]}.mp4`, "", d, clue, has(`vid/s_${l[1]}.mp4`) ? "" : "缺视频"]);
      else if (l[0] === "@cap") rows.push([id, "", i + 1, "字幕卡", "", l[1], "", "", d, clue, ""]);
      else { const k = voKey(l[1]); rows.push([id, "", i + 1, l[0] ? "台词" : "旁白", l[0], l[1], "", k ? `vo/${k}.mp3` : "", d, clue, isSilent(l[1]) ? "" : (!k || !has(`vo/${k}.mp3`)) ? "缺配音" : stale.has(id + ":" + i) ? "配音需重录" : ""]); }
    });
    (n.choices || []).forEach(c => rows.push([id, "", "", "选项", "", c.t + (c.if ? `（需要线索 ${c.if}）` : ""), "", "", "", "", "→ " + c.to]));
    if (n.lock) rows.push([id, "", "", "密码锁", "", `答案 ${n.lock.answer}，${n.lock.tries} 次`, "", "", "", "", `成功 → ${n.lock.ok}，失败 → ${n.lock.fail}`]);
    (n.epi || []).forEach(t => rows.push([id, "", "", "尾声", "", t, "", "", "", "", ""]));
  });
  const csv = "﻿" + rows.map(r => r.map(v => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n");
  try { const p = await S.saveText(`${P.name}_剪辑表.csv`, csv); if (p) toast("剪辑表已保存：" + p); } catch (e) { toast(e.message, true); }
}
async function exportGame() {
  if (dirty) { const r = await S.confirm("导出前先保存改动吗？", ["保存并导出", "取消"]); if (r !== 0) return; await save(); }
  try { toast("正在打包…"); const out = await S.exportGame(P.dir, P.name); toast("已导出：" + out); S.reveal(out); }
  catch (e) { toast("导出失败：" + e.message, true); }
}
$("tbReview").onclick = () => openReview(); $("tbCheck").onclick = showCheck; $("tbEdl").onclick = exportEdl; $("tbSave").onclick = save; $("tbExport").onclick = exportGame;
$("wOpen").onclick = pickAndOpen;

/* ============ 菜单与快捷键 ============ */
S.onMenu(cmd => {
  if (cmd === "open") return pickAndOpen();
  if (!P) return;
  ({ save, import: importAssets, edl: exportEdl, export: exportGame, reveal: () => S.reveal(absPath("index.html")), undo, redo,
     play: togglePause, restart: () => playFrom(0), prevScene: () => stepScene(-1), nextScene: () => stepScene(1), check: showCheck,
     review: () => openReview(),
     fixbox: () => { if (mode !== "board" || !sel || sel.kind !== "line") return toast("先切到故事板模式，选中一句有分镜图的台词", true); openFixBox(sel.i); } }[cmd] || (() => {}))();
});
const typing = () => /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
addEventListener("keydown", e => {
  if (!P || $("studio").hidden) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); if (dirty) save(); return; }
  if (typing()) return;
  if (document.querySelector(".modal")) return;   // 修图窗口、对话框开着时，方向键、Delete 不传给后面的时间线（防止误删、误选台词）
  if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); }
  else if (e.key === " ") { e.preventDefault(); togglePause(); }
  else if (e.key === "Delete" || e.key === "Backspace") { if (sel.kind === "line") { e.preventDefault(); delLine(); } }
  else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    const n = P.N[cur], i = sel.kind === "line" ? sel.i : -1, j = i + (e.key === "ArrowLeft" ? -1 : 1);
    if (j >= 0 && j < n.lines.length) { e.preventDefault(); selectLine(j); }
  }
});
S.onBeforeClose(async () => { if (await askSave()) S.close(); });
addEventListener("resize", () => { clearTimeout(lr); lr = setTimeout(renderTimeline, 120); });

showWelcome();

// REGENERATION_QUEUE_MODULE
"use strict";
// 队列只记录需求；生成必须等待用户另行下达执行指令。
function regenQueueKey(target) { return `regen:${target.kind}:${target.id}`; }
function regenQueueEntries(project = P) {
  return Object.entries(project?.sb?.review || {}).filter(([key,r]) => key.startsWith('regen:') && r?.schema_version === 1 && r.status === 'pending').map(([,r]) => r).sort((a,b) => a.requested_at.localeCompare(b.requested_at));
}
async function regenQueueSave(target, requirements, status = 'pending') {
  if (!P || !['image','video'].includes(target.kind) || !target.id || !['pending','cancelled'].includes(status)) throw new Error('无效的重生成请求');
  const project=P,key=regenQueueKey(target),old=project.sb?.review?.[key],now=new Date().toISOString();
  const entry={...target,schema_version:1,status,requirements:String(requirements || '').trim() || '按当前剧本和审阅意见重新生成',requested_at:old?.status==='pending'?old.requested_at:now,updated_at:now,generation_approval:'awaiting_user_command'};
  if(old?.hide_requirements) entry.hide_requirements=true;
  if(status==='cancelled') entry.cancelled_at=now;
  const saved=await S.sbReviewMany(project.dir,{[key]:entry});
  if(P===project) P.sb=saved;
  return entry;
}
function regenQueueTarget(it, kind = RV?.kind) {
  if (!P || !it) return null;
  if (kind==='img') {
    const im=it.im || (it.nid && it.i>=0 ? `l/${it.nid}_${pad2(it.i)}` : null); if(!im) return null;
    const sh=shotOf(im),rel=limgRel(im),line=it.l||P.N[it.nid]?.lines[it.i];
    return {kind:'image',id:im,asset:rel,reviewKey:it.sid||shotId(im),scene:it.nid,line:it.i,script_text:line?.[1]||'',speaker:line?.[0]||'',description:sh?.desc||stillDesc(im)||P.N[it.nid]?.img||'',source_revision:P.files[rel]?.revision||null};
  }
  if(kind==='final'||kind==='video') {
    const s=vsShot(it.vid); if(!s||s.novideo)return null;
    const v=it.nid ? it : scriptVids().find(x=>x.id===s.id),line=v&&v.i>=0?P.N[v.nid]?.lines[v.i]:null,rel=vRel(s);
    return {kind:'video',id:s.id,asset:rel,reviewKey:'final:'+s.id,scene:v?.nid||'',line:v?.i??-1,script_text:line?.[1]||'',speaker:line?.[0]||'',description:s.describe||'',prompt:s.prompt||'',keyframe:s._keyRel||s.keyframe||'',source_revision:P.files[rel]?.revision||null};
  }
  return null;
}
function regenQueueLabel(target) {return (target.kind==='image'?'图片':'视频')+' · '+target.id;}
function regenQueueDialog(target) {
  const old=SB()?.review?.[regenQueueKey(target)];
  const note=old?.requirements||(SB()?.review?.[target.reviewKey]?.note||'');
  const opinion=target.hide_requirements||old?.hide_requirements;
  return new Promise(resolve=>{
    const m=document.createElement('div');m.className='modal';
    m.innerHTML=`<div class="mbox" style="width:min(580px,92vw)"><h3>${esc(opinion?'编辑审阅意见':old?.status==='pending'?'修改重生成要求':'加入重生成清单')}</h3><div class="dim">${esc(regenQueueLabel(target))}</div><textarea style="min-height:110px;margin-top:12px" placeholder="希望哪里改变？可直接使用已有审阅意见。">${esc(note)}</textarea><p class="dim">保存到项目清单，之后由你下达批量生成指令。</p><div class="row" style="justify-content:flex-end"><button class="ghost" data-qcancel>取消</button><button class="pri" data-qsave>${opinion?'保存意见':old?.status==='pending'?'保存要求':'加入清单'}</button></div></div>`;
    const done=value=>{m.remove();resolve(value)};document.body.appendChild(m);
    m.querySelector('[data-qcancel]').onclick=()=>done(null);
    m.querySelector('[data-qsave]').onclick=()=>{
      const value=m.querySelector('textarea').value.trim();
      if(opinion&&!value){toast('请填写审阅意见',true);return;}
      done(value);
    };
    m.addEventListener('keydown',e=>{if(e.key==='Escape'){e.stopPropagation();done(null)}});m.querySelector('textarea').focus();
  });
}
function regenQueueRefreshUI() {
  if(!RV)return;
  RV.el.querySelectorAll('.rvcard[data-k]').forEach(card=>bindRegenQueue(card,+card.dataset.k));
  regenQueueToolbar();
}
function scriptReviewOpinion(target) {
  return regenQueueRequest({...target,hide_requirements:true});
}
async function regenQueueRequest(target) {
  const project=P,text=await regenQueueDialog(target);if(text===null||P!==project)return;
  try {await regenQueueSave(target,text);if(P!==project)return;regenQueueRefreshUI();toast('已记录到重生成清单，等待你的批量生成指令');}
  catch(error){toast('清单保存失败：'+error.message,true);}
}
async function regenQueueCancel(target) {
  const old=SB()?.review?.[regenQueueKey(target)];if(!old||old.status!=='pending')return;
  try{await regenQueueSave(target,old.requirements,'cancelled');regenQueueRefreshUI();toast('已取消这条重生成请求');}
  catch(error){toast('取消失败：'+error.message,true);}
}
function bindRegenQueue(card,k) {
  card.querySelector('.regen-actions')?.remove();
  const it=RV?.items[k],target=regenQueueTarget(it);if(!target)return;
  const queueRecord=SB()?.review?.[regenQueueKey(target)],queued=queueRecord?.status==='pending',generated=queueRecord?.status==='generated';
  const row=document.createElement('div');row.className='row regen-actions';row.style.marginTop='8px';
  row.innerHTML=queued?'<span class="tag best">已加入重生成清单</span><button class="ghost" data-rqedit>修改要求</button><button class="ghost" data-rqcancel>取消重生成</button>':generated?'<span class="tag best">新版本已生成，待采用</span><button class="ghost" data-rqedit>再次加入重生成清单</button>':'<button class="ghost" data-rqedit title="记录需要重做的素材，稍后统一生成">＋ 加入重生成清单</button>';
  row.querySelector('[data-rqedit]').onclick=e=>{e.stopPropagation();regenQueueRequest(target)};
  const cancel=row.querySelector('[data-rqcancel]');if(cancel)cancel.onclick=e=>{e.stopPropagation();regenQueueCancel(target)};
  (card.querySelector('.rvinfo')||card).appendChild(row);
  regenQueueToolbar();
}
function regenQueueToolbar() {
  if(!RV)return;const host=RV.el.querySelector('.rvtools');if(!host)return;
  let button=host.querySelector('[data-rqopen]');
  if(!button){button=document.createElement('button');button.className='ghost';button.dataset.rqopen='1';button.onclick=showRegenQueue;host.prepend(button)}
  button.textContent=`重生成清单（${regenQueueEntries().length}）`;
}
function showRegenQueue() {
  if(!P)return;const project=P,m=document.createElement('div');m.className='modal';
  const close=()=>m.remove();
  const draw=()=>{
    if(P!==project){close();return}const entries=regenQueueEntries(),images=entries.filter(x=>x.kind==='image').length;
    m.innerHTML=`<div class="mbox" style="width:min(860px,94vw);max-height:85vh;display:flex;flex-direction:column"><h3>重生成清单 · 图片 ${images} / 视频 ${entries.length-images}</h3><p class="dim">这些是你选中的待重做素材。稍后告诉 AI“按重生成清单批量处理”即可读取。</p><div style="overflow:auto;min-height:80px">${entries.length?entries.map((r,i)=>`<div style="padding:12px 0;border-bottom:1px solid var(--line,#444)"><b>${esc(regenQueueLabel(r))}</b><div class="dim">${esc(r.scene)}${r.line>=0?' · 剧本第 '+(r.line+1)+' 项':''}${r.script_text?' · '+esc(r.script_text):''}</div>${r.hide_requirements ? '' : `<div style="white-space:pre-wrap;margin:6px 0">${esc(r.requirements)}</div>`}<div class="row"><button class="ghost" data-rqgo="${i}">定位素材</button><button class="ghost" data-rqedit="${i}">修改要求</button><button class="ghost" data-rqcancel="${i}">取消重生成</button></div></div>`).join(''):'<p class="dim">清单为空。在图片或成片审阅里点击“加入重生成清单”。</p>'}</div><div class="row" style="justify-content:flex-end;margin-top:12px"><button class="ghost" data-rqexport ${entries.length?'':'disabled'}>导出清单…</button><button class="pri" data-rqclose>关闭</button></div></div>`;
    m.querySelector('[data-rqclose]').onclick=close;
    m.querySelector('[data-rqexport]').onclick=async()=>{try{await S.saveText('重生成清单.json',JSON.stringify({schema_version:1,project:project.dir,exported_at:new Date().toISOString(),entries},null,2))}catch(e){toast(e.message,true)}};
    m.querySelectorAll('[data-rqgo]').forEach(b=>b.onclick=()=>{const r=entries[+b.dataset.rqgo];close();jumpToMediaReview(r.kind==='image'?'img':'final',r.kind==='image'?shotId(r.id):r.id)});
    m.querySelectorAll('[data-rqedit]').forEach(b=>b.onclick=async()=>{await regenQueueRequest(entries[+b.dataset.rqedit]);draw()});
    m.querySelectorAll('[data-rqcancel]').forEach(b=>b.onclick=async()=>{await regenQueueCancel(entries[+b.dataset.rqcancel]);draw()});
  };
  m.addEventListener('keydown',e=>{if(e.key==='Escape'){e.stopPropagation();close()}});document.body.appendChild(m);draw();
}
