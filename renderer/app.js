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
const has = rel => !!(P && P.files[rel]);
function fileUrl(rel) {
  const base = P.dir.replace(/\\/g, "/");
  const u = (base.startsWith("/") ? "file://" : "file:///") + base.split("/").map(encodeURIComponent).join("/").replace(/^([A-Za-z])%3A/, "$1:");
  return u + "/" + rel.split("/").map(encodeURIComponent).join("/") + "?t=" + bust;
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
    setDirty(false); toast("已保存" + (bk ? "（旧版本备份在 " + bk + "）" : "")); reloadPreview();
  } catch (e) { toast("保存失败：" + e.message, true); }
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
    renderAll(true); playFrom(0);
  } catch (e) { toast("打开失败：" + e.message, true); }
}
async function refreshFiles() { P.files = await S.files(P.dir); bust = Date.now(); Object.keys(meta).forEach(k => delete meta[k]); }
async function askSave() {
  if (!dirty) return true;
  const r = await S.confirm("有未保存的改动，要先保存吗？", ["保存", "不保存", "取消"]);
  if (r === 0) { await save(); return true; } if (r === 1) return true; return false;
}

/* ============ 渲染总入口 ============ */
function renderAll(full) { renderTop(); renderLib(); renderTimeline(); renderProps(); renderStat(); renderNav(); renderBoard(); renderModes(); }
function renderTop() { const iss = Object.keys(P.N).reduce((s, id) => s + issues(id).length, 0); $("issueN").hidden = !iss; $("issueN").textContent = iss;
  const rv = pendingCount(), pv = SB() ? reviewItems("all").filter(it => promptState(it) === "todo").length : 0, fv = SB() ? refItems().filter(it => refState(it) !== "ok").length : 0;
  $("reviewN").hidden = !(rv + pv + fv); $("reviewN").textContent = `${fv} · ${pv} · ${rv}`; $("tbReview").title = `参考图待审 ${fv} 张 · 提示词待审 ${pv} 条 · 图片待审 ${rv} 张（Ctrl+Shift+A）`; }
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
  else if (libTab === "audio") { libBar([["all", "全部"], ["vo", "配音"], ["bgm", "音乐"], ["sfx", "音效"], ["amb", "环境"], ["inbox", "导入"]], "audio"); renderLibBody = libAudio; }
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
  const sets = { vo: ["vo/"], bgm: ["bgm/"], sfx: ["sfx/"], amb: ["amb/"], inbox: ["_studio/inbox/"] };
  let list = libFilter === "all" ? mediaItems(["vo/", "bgm/", "sfx/", "amb/", "_studio/inbox/"]) : mediaItems(sets[libFilter]);
  list = list.filter(r => /\.(mp3|wav|m4a|ogg)$/i.test(r));
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
function schedule(id) {
  const n = P.N[id], items = []; let t = 0;
  n.lines.forEach((l, i) => {
    if (l[0] === "@shot") {
      const rel = `vid/s_${l[1]}.mp4`, full = dur(rel, 6), tr = P.TRIM[rel], d = tr ? Math.max(.3, (tr[1] || full) - (tr[0] || 0)) : full;
      items.push({ tr: "shot", i, t, d, rel, label: "镜头 · " + l[1] + (tr ? `（剪 ${tr[0]}–${tr[1]} 秒）` : ""), miss: !has(rel), thumb: `img/s_${l[1]}.jpg` });
      items.push({ tr: "pic", i, t, d, label: "插入 · " + l[1], thumb: `img/s_${l[1]}.jpg`, miss: !has(`img/s_${l[1]}.jpg`) });
      if (P.VAUD[rel]) items.push({ tr: "va", i: null, t, d, rel, kind: "va", label: "原声 · " + l[1] });
      t += d;
    }
    else if (l[0] === "@cap") { items.push({ tr: "cap", i, t, d: 2.6, label: l[1] }); items.push({ tr: "pic", i, t, d: 2.6, label: "字幕卡", thumb: null }); t += 2.6; }
    else {
      const k = voKey(l[1]), rel = k ? `vo/${k}.mp3` : null, est = Math.max(1.6, l[1].length * .24);
      const d = rel && has(rel) ? dur(rel, est) + .5 : est;
      items.push({ tr: "dlg", i, t, d, label: (l[0] ? l[0] + "：" : "") + l[1], miss: !isSilent(l[1]) && (!rel || !has(rel)), stale: stale.has(id + ":" + i), nar: !l[0] });
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
  if (P.VAUD[vrel]) items.push({ tr: "va", i: null, t: 0, d: Math.min(vlen, t), rel: vrel, kind: "va", label: "原声 · 场景视频" });
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
      const cls = ["blk", "b-" + (k === "v" ? "video" : k === "dlg" && x.nar ? "nar" : k), x.miss ? "miss" : "", x.fb ? "fallback" : "", x.stale ? "stale" : "", isSel ? "sel" : "", pvLine === x.i && x.i != null ? "cur" : ""].join(" ");
      const bg = x.thumb && has(x.thumb) ? `background-image:url('${fileUrl(x.thumb)}');` : "";
      const inner = k === "dlg" ? `<i class="wave"></i><span>${esc(x.label)}</span>` : (k === "v" || k === "shot" || k === "pic") ? `<span class="lbl">${esc(x.label)}</span>` : `<span>${esc(x.label)}</span>`;
      const handles = k === "shot" && !x.miss ? '<b class="hl" title="拖动设置入点"></b><b class="hr" title="拖动设置出点"></b>' : "";
      return `<div class="${cls}" data-i="${x.i ?? ""}" data-kind="${x.kind || ""}" data-rel="${x.rel || ""}" title="${esc(x.label)}" style="${bg}left:${x.t * z}px;width:${Math.max(x.d * z - 2, 8)}px;${x.dim ? "opacity:.55;" : ""}">${inner}${handles}</div>`;
    }).join("")}</div>`;
  }).join("");
  $("tracks").innerHTML = `<div class="ruler" id="ruler" style="width:${W}px">${ruler}</div>${rows}<div class="ph" id="ph" style="left:-20px"></div>`;
  $("tDur").textContent = "本场约 " + fmt(total);
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
    else if (i !== "") { const l = n.lines[+i]; if (b.classList.contains("b-pic")) { if (l[0] === "@shot") target = `img/s_${l[1]}.jpg`; else if (isSpoken(l)) { bindLineImgDrop(b, +i); return; } } else if (l[0] === "@shot") target = `vid/s_${l[1]}.mp4`; else if (l[0] !== "@cap") target = ensureVoTarget(+i, true); }
    if (target) bindDropTarget(b, target);
  });
  movePlayhead();
}
$("zoom").oninput = renderTimeline;
function movePlayhead() {
  const ph = $("ph"); if (!ph || pvLine == null || !P || !P.N[cur]) return;
  const { items, total } = schedule(cur), it = items.find(x => x.i === pvLine && x.tr !== "evt");
  ph.style.left = (it ? it.t * +$("zoom").value : -20) + "px";
  $("tc").innerHTML = `<b>${fmt(it ? it.t : 0)}</b> / ${fmt(total)}`;
}
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
    const a = P.VAUD[sel.rel] || {};
    h = `<h3>原声（音画分离）</h3><div class="sub">来自 ${esc(sel.rel)} · 跟着画面一起播放，原视频静音</div>${vaSection(sel.rel)}`;
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
  if (!a) return `<div class="sec"><label>音画分离</label><div class="row"><button class="ghost vaDo" data-rel="${esc(rel)}">分离音频</button></div>
    <div class="hint">把视频里的声音单独拿出来，放到「原声」轨上，可以调音量、换掉或删掉；原视频改为静音。AI 生成的视频一般没有声音。</div></div>`;
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
    select({ kind: "va", rel }); toast(`已分离到 ${out}，原视频改为静音`); reloadPreview();
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
$("tAddShot").onclick = () => { const nm = prompt("新镜头的名字（英文或拼音，用来找 img/s_名.jpg 和 vid/s_名.mp4）", "shot" + (Date.now() % 1000)); if (!nm) return; if (!/^[\w-]+$/.test(nm)) return toast("镜头名只能用英文、数字、下划线", true); insertLine(["@shot", nm]); if (!P.SHOTS.includes(nm)) P.SHOTS.push(nm); };
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
  if (!P || !cur) return; setPausedUI(false); const clues = $("allClues").checked ? cluesBefore(cur) : [];
  if (!pvLoaded) { $("pv").src = fileUrl("index.html") + `&embed=1&jump=${encodeURIComponent(cur)}&line=${line}&clues=${clues.join(",")}`; return; }
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
window.addEventListener("message", e => {
  const d = e.data || {}; if (d.src !== "moban") return;
  $("pvWhere").textContent = `${d.paused ? "已暂停 · " : ""}${P.N[d.node] ? sceneName(d.node) : d.node} · 第 ${d.line + 1} 行`;
  const wasPaused = pvPaused; setPausedUI(!!d.paused);
  // 暂停时自动选中正在播的那一句，右边直接改
  if (d.paused && !wasPaused) { if (d.node !== cur && P.N[d.node]) { cur = d.node; renderAll(false); } if (P.N[cur].lines[d.line]) selectLine(d.line); }
  if (d.node === cur) {
    pvLine = d.line; document.querySelectorAll(".blk.cur").forEach(x => x.classList.remove("cur"));
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
  return ({ pass: ["pass", "✓ 通过质检"], best: ["best", "⚠ 需人看"], manual: ["manual", "人工确认"], reuse: ["reuse", "沿用插图"] })[st.status] || ["none", "未质检"];
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
      <span class="no">${i + 1}</span><span class="tag ${tc}">${tt}</span>${ok && SB() ? `<button class="fbquick" data-fix="${i}" title="审图 · 框选修图">✎ 修图</button>` : ""}
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
function pinImage(i) {                  // 确保这一句有图名（没有就起一个），返回 "l/xxx"
  const l = P.N[cur].lines[i]; let im = limgOf(cur, i);
  if (!im || !(l[2] && l[2].img)) { im = im || newImgId(cur, i); const v = im; edit(() => { l[2] = { img: v }; }); }
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
async function ensureShot(i) {          // 分镜表里没有这一句就自动建一条（之后可以在右边改）
  const sb = SB(); if (!sb) throw new Error("没有分镜工作区");
  const l = P.N[cur].lines[i], im = pinImage(i), id = shotId(im);
  if (sb.shots.find(x => x.id === id)) return id;
  const refs = [SPEAKER_REF[l[0]]].filter(Boolean);
  P.sb = await S.sbSaveShot(P.dir, { id, node: cur, line: i, shot: "近景", in_frame: l[0] || "", speaker_in_frame: "是", location: "", desc: `${l[0] || "旁白"}说：「${l[1]}」时的画面`, layout: "", refs, note: "剪辑台新建，请补充画面描述和构图" });
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
      <button id="sbRedraw" title="按分镜表要求整张重画（最多 3 次，挑通过的那张）">重画这一张</button><button class="ghost" id="sbClear" ${l[2] && l[2].img ? "" : "disabled"} title="这一句不单独配图，沿用场景图（图片文件保留）">不用分镜图</button>
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
function openFixBox(i, nid = cur) {
  const im = limgOf(nid, i); if (!im || !has(limgRel(im))) return toast("这一句还没有分镜图", true);
  const sid = shotId(im), l = P.N[nid].lines[i], shot = shotOf(im), st = sbState(im);
  const last = st ? (st.refine && st.refine.length ? st.refine[st.refine.length - 1] : (st.tries || []).filter(t => t.file).slice(-1)[0]) : null;
  const [tc, tt] = statusTag(im);
  const m = document.createElement("div"); m.className = "modal fbx";
  m.innerHTML = `<div class="fbbox" role="dialog" aria-label="审图 · 框选修图">
    <div class="fbhead"><b>审图 · 框选修图</b><span class="chip">${esc(sid)}</span><span class="tag ${tc}">${tt}</span>
      <span class="dim fbline">${esc(l[0] || "旁白")}：${esc(l[1])}</span><span class="grow"></span>
      <span class="fbseg" id="fbSeg" hidden><button data-v="old">修改前</button><button data-v="new" class="on">修改后</button></span>
      <button class="icon" id="fbX" title="关闭（Esc）">✕</button></div>
    <div class="fbwork">
      <div class="fbstage" id="fbStage"><div class="fbwrap" id="fbWrap"><img id="fbImg" alt="" draggable="false" data-nozoom></div></div>
      <div class="fbside">
        ${last && last.issues && last.issues.length ? `<div class="fbqc"><label>质检发现的问题（${last.score ?? "-"}/10）</label><ul class="qc">${last.issues.map(x => `<li>${esc(x)}</li>`).join("")}</ul></div>` : ""}
        ${shot ? `<div class="fbreq"><label>分镜要求</label><div class="dim">${esc(shot.shot || "")} · ${esc(shot.in_frame || "")}</div><div class="dim">${esc(shot.layout || shot.desc || "")}</div></div>` : ""}
        <div class="hint">在图上按住鼠标拖出方框，框住要改的地方，再写一句怎么改。可以框好几处。然后在下面选修改方式。</div>
        <div id="fbItems" class="fbitems"></div>
        <div class="fbmode" id="fbMode">
          <label><input type="radio" name="fbm" value="patch" checked><span><b>只改样子，形状不变</b><small>换颜色、盖掉字、换道具花纹……只把框里贴回原图，框外一个像素不变</small></span></label>
          <label><input type="radio" name="fbm" value="whole"><span><b>要加东西或改形状</b><small>箱子里加金子、给人戴上帽子……整张交给 AI，衔接更自然，框外可能有细微变化</small></span></label>
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
  const U = fixUI = { sid, i, m, src: "", srcUrl: fileUrl(limgRel(im)), cand: null, boxes: [], busy: false, log: "", view: "new" };
  const q = s => m.querySelector(s), img = q("#fbImg"), wrap = q("#fbWrap");
  const show = url => { img.src = url; };
  show(U.srcUrl);
  function draw() {
    wrap.querySelectorAll(".fbr").forEach(e => e.remove());
    if (!U.cand) U.boxes.forEach((b, k) => { const d = document.createElement("div"); d.className = "fbr"; Object.assign(d.style, { left: b.fx * 100 + "%", top: b.fy * 100 + "%", width: b.fw * 100 + "%", height: b.fh * 100 + "%" }); d.innerHTML = `<b>${k + 1}</b>`; wrap.appendChild(d); });
    const it = q("#fbItems"); it.innerHTML = "";
    U.boxes.forEach((b, k) => {
      const d = document.createElement("div"); d.className = "fbitem";
      d.innerHTML = `<div class="fbih"><span>框 ${k + 1}</span><button class="icon" title="删掉这个框">✕</button></div><textarea placeholder="比如：把钞票换成第四套人民币，灰蓝色，不要粉红色" ${U.cand || U.busy ? "disabled" : ""}></textarea>`;
      const t = d.querySelector("textarea"); t.value = b.text; t.oninput = () => { b.text = t.value; upd(); };
      d.querySelector("button").onclick = () => { if (U.busy || U.cand) return; U.boxes.splice(k, 1); draw(); };
      it.appendChild(d);
    });
    upd();
  }
  function upd() { q("#fbGo").disabled = !(U.boxes.length && U.boxes.every(b => b.text.trim()) && !U.cand && !U.busy); q("#fbGo").hidden = q("#fbMode").hidden = !!U.cand; q("#fbMode").querySelectorAll("input").forEach(x => x.disabled = U.busy); }
  let dg = null;
  wrap.addEventListener("pointerdown", e => {
    if (U.busy || U.cand || e.button !== 0) return;
    const r = img.getBoundingClientRect(); dg = { x: e.clientX - r.left, y: e.clientY - r.top, r, el: document.createElement("div") };
    dg.el.className = "fbr live"; wrap.appendChild(dg.el); wrap.setPointerCapture(e.pointerId);
  });
  wrap.addEventListener("pointermove", e => {
    if (!dg) return; const r = dg.r, x = Math.max(0, Math.min(e.clientX - r.left, r.width)), y = Math.max(0, Math.min(e.clientY - r.top, r.height));
    dg.b = { fx: Math.min(x, dg.x) / r.width, fy: Math.min(y, dg.y) / r.height, fw: Math.abs(x - dg.x) / r.width, fh: Math.abs(y - dg.y) / r.height };
    Object.assign(dg.el.style, { left: dg.b.fx * 100 + "%", top: dg.b.fy * 100 + "%", width: dg.b.fw * 100 + "%", height: dg.b.fh * 100 + "%" });
  });
  wrap.addEventListener("pointerup", () => {
    if (!dg) return; const b = dg.b; dg.el.remove(); dg = null;
    if (b && b.fw * img.clientWidth > 8 && b.fh * img.clientHeight > 8) { U.boxes.push({ ...b, text: "" }); draw(); const ts = q("#fbItems").querySelectorAll("textarea"); ts[ts.length - 1].focus(); }
  });
  const msg = (t, err) => { const e = q("#fbMsg"); e.textContent = t; e.classList.toggle("err", !!err); };
  const setView = v => { U.view = v; show(v === "old" ? U.srcUrl : U.candUrl); q("#fbSeg").querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset.v === v)); };
  q("#fbSeg").querySelectorAll("button").forEach(b => b.onclick = () => setView(b.dataset.v));
  U.close = () => { if (U.busy && !confirm("修改还在进行中，关掉窗口后任务会继续在后台跑完。确定关闭？")) return; m.remove(); document.removeEventListener("keydown", U.key); if (fixUI === U) fixUI = U.busy ? Object.assign(U, { detached: true }) : null; };
  U.key = e => { if (e.key === "Escape" && !e.target.matches("textarea")) U.close(); };
  document.addEventListener("keydown", U.key);
  q("#fbX").onclick = U.close;
  q("#fbGo").onclick = async () => {
    const boxes = U.boxes.map(b => ({ fx: +b.fx.toFixed(5), fy: +b.fy.toFixed(5), fw: +b.fw.toFixed(5), fh: +b.fh.toFixed(5), text: b.text.trim() }));
    const mode = (q("input[name=fbm]:checked") || {}).value || "patch";
    U.busy = true; U.log = ""; U.task = "edit"; U.mode = mode; draw();
    msg(mode === "whole" ? `整张交给 AI 修改 ${boxes.length} 处，大约 30～60 秒…` : `AI 正在修改 ${boxes.length} 处，每处大约 30～60 秒…`);
    if (!await runTool("fix_box.py", ["edit", sid, b64(JSON.stringify({ src: U.src, mode, boxes }))], `框选修图 · ${sid}`)) { U.busy = false; draw(); msg("没能启动修改任务", true); }
  };
  q("#fbOk").onclick = async () => { U.busy = true; U.task = "accept"; msg("正在换进游戏…"); if (!await runTool("fix_box.py", ["accept", sid, U.cand], `采用修改 · ${sid}`)) U.busy = false; };
  q("#fbMore").onclick = () => { U.src = U.cand; U.srcUrl = U.candUrl; U.cand = null; U.boxes = []; q("#fbAfter").hidden = true; q("#fbSeg").hidden = true; show(U.srcUrl); draw(); msg("在修改后的图上继续框选（还没换进游戏）"); };
  q("#fbDrop").onclick = () => { U.cand = null; q("#fbAfter").hidden = true; q("#fbSeg").hidden = true; show(U.srcUrl); draw(); msg(""); };
  q("#fbApprove").onclick = async () => { U.busy = true; U.task = "approve"; msg("正在标记…"); if (!await runTool("fix_box.py", ["approve", sid], `标记人工确认 · ${sid}`)) U.busy = false; };
  U.msg = msg; U.draw = draw; U.show = show; U.q = q; U.setView = setView;
  draw();
}
function fixLog(t) {
  const U = fixUI; U.log += t;
  const lines = U.log.split(/\r?\n/).filter(Boolean), lastL = lines[lines.length - 1] || "";
  if (!U.detached && U.task === "edit" && !/^(RESULT|ERROR|INFO):/.test(lastL)) U.msg("AI 正在修改…\n" + lastL.slice(0, 120));
}
function fixDone(code) {
  const U = fixUI, res = (U.log.match(/RESULT:(\S+)/) || [])[1], err = (U.log.match(/ERROR:(.+)/) || [])[1];
  if (U.detached) { fixUI = null; toast(res ? `框选修图完成（${U.sid}），结果在 storyboard\\out\\fix\\，没换进游戏` : `框选修图结束：${err || "看一下日志"}`, !res); return; }
  if (U.task === "edit") {
    if (code !== 0 || !res) { U.draw(); U.msg("× " + (err || "修改失败，看一下右下角的日志"), true); return; }
    U.cand = res; U.candUrl = fileUrl("../" + res); U.q("#fbAfter").hidden = false; U.q("#fbSeg").hidden = false; U.setView("new"); U.draw();
    const info = [...U.log.matchAll(/INFO:(.+)/g)].map(x => x[1]).join("\n");
    U.msg("改好了。用上面的「修改前 / 修改后」切换对比，满意就采用。" + (U.mode === "whole" ? "\n" + (info || "整张由 AI 重新输出，请留意框外有没有被改动。") : ""));
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
function openLightbox(list, idx = 0) {
  if (!list.length) return;
  const m = document.createElement("div"); m.className = "modal lbx";
  m.innerHTML = `<button class="icon lbx-x" title="关闭（Esc）">✕</button>${list.length > 1 ? '<button class="icon lbx-p" title="上一张（←）">‹</button><button class="icon lbx-n" title="下一张（→）">›</button>' : ""}<figure><img alt=""><figcaption></figcaption></figure>`;
  document.body.appendChild(m);
  let k = idx;
  const show = () => { m.querySelector("img").src = list[k].src; m.querySelector("figcaption").textContent = list[k].cap + (list.length > 1 ? `　${k + 1} / ${list.length}` : ""); };
  const close = () => { m.remove(); document.removeEventListener("keydown", key, true); };
  const step = d => { k = (k + d + list.length) % list.length; show(); };
  const key = e => {
    if (e.key === "Escape") close(); else if (e.key === "ArrowLeft" && list.length > 1) step(-1); else if (e.key === "ArrowRight" && list.length > 1) step(1); else return;
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
function promptText(shot) {
  const sb = SB(), rules = Object.entries(sb.bible || {}).map(([k, v]) => `${k}：${v}`).join("；");
  let p = `为一部互动电影游戏画一张分镜剧照（16:9 横幅）。\n【构图，以画面方向为准，必须做到】${shot.layout || ""}\n【画面内容】${shot.desc || ""}\n【景别】${shot.shot || ""}。【画面里只有这些人】${shot.in_frame || ""}，不要出现其他人。【场景】${shot.location || ""}\n【统一设定】${rules}\n人物长相、发型、服装、道具必须和对应参考图一致；不要照抄参考图的灰色背景和排版；画面里不要任何文字、字幕或水印。`;
  if (shot.sketch && shot.sketch.length) p += "\n【构图草图】已附构图草图和俯视位置图：人物的左右位置、朝向、机位、车头方向必须和草图一致；草图只是示意，不要画出草图里的色块、简笔人形、箭头和文字。";
  return p;
}
function promptHash(shot) {                  // 提示词、参考图、构图图任何一样变了，就回到「待审」
  const s = promptText(shot) + "|" + (shot.refs || []).join(",") + "|" + (shot.sketch || []).join(","); let h = 5381;
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
function promptState(it) {
  if (!it.im) return "noshot"; const shot = shotOf(it.im); if (!shot) return "noshot";
  const r = ((SB() || {}).review || {})["prompt:" + shot.id];
  return r && r.mtime === promptHash(shot) ? (r.ok ? "ok" : "bad") : "todo";
}
function pvCard(it, k) {
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
      <div class="rvsec"><label>参考图（${refs.length} / 5，单击增减，双击放大）</label><div class="pvrefs">${[...new Set([...REFS().filter(x => x.exists).map(x => refRel(x.id)), ...refs])].map(r => `<button class="pvref${refs.includes(r) ? " on" : ""}" data-ref="${esc(r)}" title="${esc(r.split("/").pop())}：单击增减，双击放大"><img src="${fileUrl("../" + r)}" data-zoom="参考图 · ${esc(r.split("/").pop().replace(/\.\w+$/, ""))}" loading="lazy" alt=""><span>${esc((refById(r.split("/").pop().replace(/\.\w+$/, "")) || {}).name || r.split("/").pop().replace(/\.\w+$/, ""))}</span></button>`).join("")}<button class="pvref pvadd" data-newref="" title="新增一张参考图">＋<span>新增</span></button></div></div>
      <details class="pvfull"><summary>实际发给模型的完整提示词</summary><pre>${esc(promptText(shot))}</pre><div class="dim">附图：${refs.map(r => esc(r.split("/").pop())).join("、") || "无"}${sk.length ? "；构图图 " + sk.length + " 张" : ""}</div></details>
    </div>
    <div class="rvinfo">
      <div class="rvwhere"><span class="dim">${esc(sceneName(it.nid))} · 第 ${it.i + 1} 句</span><span class="chip">${esc(shot.id)}</span></div>
      <div class="rvline"><b>${esc(it.l[0] || "旁白")}</b>：${esc(it.l[1])}</div>
      <div class="rvtags">${stag}${nBad ? `<span class="tag rvbad">${nBad} 处矛盾</span>` : ""}${nWarn ? `<span class="tag best">${nWarn} 处提醒</span>` : ""}${!lint.length ? '<span class="tag pass">自动检查没发现问题</span>' : ""}</div>
      ${lint.length ? `<ul class="pvlint">${lint.map(x => `<li class="${x.lv}">${esc(x.t)}${x.addref ? ` <button class="pvfix" data-addref="${x.addref}">附上</button>` : ""}${x.newref ? ` <button class="pvfix" data-newref="${esc(x.newref)}">＋ 新增参考图</button>` : ""}</li>`).join("")}</ul>` : ""}
      <div class="pvfields">
        <div class="pvrow"><label>景别<input data-sf="shot" value="${esc(shot.shot || "")}"></label><label>场景<input data-sf="location" value="${esc(shot.location || "")}"></label></div>
        <label>画面里只有这些人<input data-sf="in_frame" value="${esc(shot.in_frame || "")}"></label>
        <label>构图（按画面方向写：谁在左、谁在右、机位）<textarea data-sf="layout" rows="4">${esc(shot.layout || "")}</textarea></label>
        <label>画面描述<textarea data-sf="desc" rows="3">${esc(shot.desc || "")}</textarea></label>
        <label>备注 <span class="pvnosend">不会发给模型</span><input data-sf="note" value="${esc(shot.note || "")}"></label>
      </div>
      <div class="rvact"><button class="pri" data-a="pok">✓ 提示词没问题<kbd>A</kbd></button><button class="ghost" data-a="redraw">↻ 按这条${it.ok ? "重画" : "出图"}<kbd>R</kbd></button></div>
    </div></article>`;
}
function bindPvCard(card, k) {
  const it = RV.items[k], shot = it.im ? shotOf(it.im) : null; if (!shot) return;
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
  if (st && st.status === "manual") return { ok: true, note: "" };   // 在修图窗口里采用 / 标记过
  return null;
}
function reviewItems(scope) {
  const out = [];
  (scope === "scene" ? [cur] : flatOrder()).forEach(nid => P.N[nid].lines.forEach((l, i) => {
    if (!isSpoken(l)) return; const im = limgOf(nid, i), ok = !!(im && has(limgRel(im)));
    out.push({ nid, i, l, im, ok, sid: im ? shotId(im) : null });
  }));
  return out;
}
const rvState = it => !it.ok ? "missing" : (r => r ? (r.ok ? "ok" : "bad") : "todo")(reviewOf(it.sid, it.im));
const pendingCount = () => SB() ? reviewItems("all").filter(it => rvState(it) === "todo").length : 0;
function rvCands(sid) {
  const st = ((SB() || {}).state || { shots: {} }).shots[sid]; if (!st) return [];
  const c = [], seen = new Set();
  (st.tries || []).forEach(t => t.file && c.push({ file: t.file, dir: "batch", label: `第${t.n}次`, pass: t.pass, score: t.score, issues: t.issues || [] }));
  (st.refine || []).forEach((t, k) => t.file && c.push({ file: t.file, dir: t.dir || "refine", label: `${t.how || "修改"}${k + 1}`, pass: t.pass, score: t.score, issues: t.issues || [] }));
  return c.filter(x => !seen.has(x.file) && seen.add(x.file)).map(x => ({ ...x, cur: x.file === st.final }));
}
function openReview(scope = "all", filter = "todo", kind) {
  if (!SB()) return toast("没找到分镜工作区（storyboard\\shotlist.json），审阅不可用", true);
  const prevKind = RV && RV.kind; if (RV) { RV.io && RV.io.disconnect(); RV.el.remove(); document.removeEventListener("keydown", rvKey, true); }
  if (!kind && prevKind) kind = prevKind;
  const el = document.createElement("div"); el.className = "rv"; el.setAttribute("role", "dialog"); el.setAttribute("aria-label", "审阅分镜图");
  el.innerHTML = `<div class="rvhead"><span class="fbseg rvkind" id="rvKind"><button data-v="ref">⓪ 参考图 <i></i></button><button data-v="prompt">① 提示词 <i></i></button><button data-v="img">② 图片 <i></i></button></span><button class="ghost" id="rvNewRef" hidden>＋ 新增参考图</button>
      <span class="fbseg" id="rvScope"><button data-v="scene">本场</button><button data-v="all">全部场景</button></span>
      <span class="fbseg" id="rvFilter"><button data-v="todo">待审 <i></i></button><button data-v="bad">有问题 <i></i></button><button data-v="all">全部 <i></i></button></span>
      <span class="rvprog"><span class="prog"><i></i></span><span class="dim" id="rvProg"></span></span>
      <span class="grow"></span><span class="hint rvkeys" id="rvKeys"></span>
      <button class="icon" id="rvX" title="关闭（Esc）">✕</button></div>
    <div class="rvbody" id="rvBody"></div>`;
  document.body.appendChild(el);
  RV = { el, scope, filter, kind: kind || (RV && RV.kind) || (() => { try { return localStorage.getItem("studio_rvkind") || "img"; } catch { return "img"; } })(), k: 0, items: [] };
  el.querySelectorAll("#rvKind button").forEach(b => b.onclick = () => { RV.kind = b.dataset.v; try { localStorage.setItem("studio_rvkind", RV.kind); } catch {} rvBuild(); });
  el.querySelector("#rvX").onclick = closeReview;
  el.querySelector("#rvNewRef").onclick = () => openNewRef();
  el.querySelectorAll("#rvScope button").forEach(b => b.onclick = () => { RV.scope = b.dataset.v; rvBuild(); });
  el.querySelectorAll("#rvFilter button").forEach(b => b.onclick = () => { RV.filter = b.dataset.v; rvBuild(); });
  document.addEventListener("keydown", rvKey, true);
  rvBuild();
}
function closeReview() { if (!RV) return; RV.io && RV.io.disconnect(); RV.el.remove(); RV = null; document.removeEventListener("keydown", rvKey, true); renderTop(); }
const rvSt = it => RV.kind === "ref" ? refState(it) : RV.kind === "prompt" ? promptState(it) : rvState(it);
const refItems = () => [...REFS()].sort((x, y) => ["char", "prop", "bg"].indexOf(x.kind) - ["char", "prop", "bg"].indexOf(y.kind)).map(ref => ({ ref }));
const rvAll = () => RV.kind === "ref" ? refItems() : reviewItems(RV.scope);
function rvBuild() {                          // 按范围和筛选重新取一遍列表（审过的不会马上消失，换筛选时才更新）
  const all = rvAll();
  RV.el.querySelector("#rvScope").hidden = RV.kind === "ref"; RV.el.querySelector("#rvNewRef").hidden = RV.kind !== "ref";
  RV.items = all.filter(it => RV.filter === "all" ? true : RV.kind === "ref" && RV.filter === "todo" ? ["todo", "missing"].includes(rvSt(it)) : rvSt(it) === RV.filter);
  RV.el.querySelector("#rvKeys").textContent = RV.kind === "ref" ? "↑↓ 上一张 / 下一张 · A 参考图没问题 · R 按描述重新生成 · 双击放大 · Esc 关闭" : RV.kind === "prompt" ? "↑↓ 上一条 / 下一条 · A 提示词没问题 · R 按这条出图 · 改完字段点别处自动保存 · Esc 关闭" : "↑↓ 上一张 / 下一张 · A 通过 · X 有问题 · E 修图 · R 重画 · Esc 关闭";
  RV.k = 0; rvRender(); rvCounts(all);
}
function rvCounts(all) {
  all = all || rvAll();
  const n = s => all.filter(it => rvSt(it) === s).length, ok = n("ok");
  const withImg = RV.kind === "ref" ? all.filter(it => it.ref.exists).length : RV.kind === "prompt" ? all.filter(it => promptState(it) !== "noshot").length : all.filter(it => it.ok).length;
  const kb = RV.el.querySelectorAll("#rvKind button i"), li = reviewItems("all");
  kb[0].textContent = refItems().filter(it => refState(it) === "todo" || refState(it) === "missing").length || ""; kb[1].textContent = li.filter(it => promptState(it) === "todo").length || ""; kb[2].textContent = li.filter(it => rvState(it) === "todo").length || "";
  const f = RV.el.querySelectorAll("#rvFilter button i"); f[0].textContent = n("todo") + (RV.kind === "ref" ? n("missing") : 0); f[1].textContent = n("bad"); f[2].textContent = all.length;
  RV.el.querySelectorAll("#rvKind button").forEach(b => b.classList.toggle("on", b.dataset.v === RV.kind));
  RV.el.querySelectorAll("#rvScope button").forEach(b => b.classList.toggle("on", b.dataset.v === RV.scope));
  RV.el.querySelectorAll("#rvFilter button").forEach(b => b.classList.toggle("on", b.dataset.v === RV.filter));
  RV.el.querySelector(".rvprog i").style.width = (withImg ? ok / withImg * 100 : 0) + "%";
  RV.el.querySelector("#rvProg").textContent = RV.kind === "ref" ? `已审 ${ok} / ${withImg} 张参考图` + (all.length > withImg ? ` · ${all.length - withImg} 张还没有图` : "") : RV.kind === "prompt" ? `已审 ${ok} / ${withImg} 条` + (all.length > withImg ? ` · ${all.length - withImg} 句不在分镜表里` : "")
    : `已通过 ${ok} / ${withImg} 张` + (all.length > withImg ? ` · ${all.length - withImg} 句没有图` : "");
}
function rvCard(it, k) {
  const st = rvState(it), shot = it.im ? shotOf(it.im) : null, sst = it.im ? sbState(it.im) : null, [tc, tt] = statusTag(it.im), r = it.ok ? reviewOf(it.sid, it.im) : null;
  const last = sst ? (sst.refine && sst.refine.length ? sst.refine[sst.refine.length - 1] : (sst.tries || []).filter(t => t.file).slice(-1)[0]) : null;
  const cands = it.ok ? rvCands(it.sid) : [];
  const rtag = { ok: '<span class="tag pass">人工 ✓ 已通过</span>', bad: '<span class="tag rvbad">人工 ✗ 有问题</span>', todo: '<span class="tag none">待审</span>', missing: '<span class="tag fb">没有图</span>' }[st];
  return `<article class="rvcard st-${st}" data-k="${k}">
    <div class="rvimg">${it.ok ? `<img class="rvmain" src="${fileUrl(limgRel(it.im))}" loading="lazy" alt="">` : `<div class="rvmiss">这一句还没有分镜图<br><small>播放时沿用场景图</small></div>`}<div class="rvbanner" hidden></div></div>
    <div class="rvinfo">
      <div class="rvwhere"><span class="dim">${esc(sceneName(it.nid))} · 第 ${it.i + 1} 句</span>${it.sid ? `<span class="chip">${esc(it.sid)}</span>` : ""}</div>
      <div class="rvline"><b>${esc(it.l[0] || "旁白")}</b>：${esc(it.l[1])}</div>
      <div class="rvtags">${it.ok ? `<span class="tag ${tc}">AI ${tt}</span>` : ""}${rtag}</div>
      ${shot ? `<div class="rvsec"><label>分镜要求</label><div>${esc(shot.shot || "")}${shot.in_frame ? " · 画面里：" + esc(shot.in_frame) : ""}</div><div class="dim">${esc(shot.layout || shot.desc || "")}</div></div>` : ""}
      ${last && last.issues && last.issues.length && sst.status !== "pass" ? `<div class="rvsec"><label>AI 质检发现的问题（${last.score ?? "-"}/10）</label><ul class="qc">${last.issues.map(x => `<li>${esc(x)}</li>`).join("")}</ul></div>` : ""}
      ${r && !r.ok && r.note ? `<div class="rvsec"><label>审阅意见</label><div class="rvnotev">${esc(r.note)}</div></div>` : ""}
      ${cands.length > 1 ? `<div class="rvsec"><label>其他候选（单击在左边看，双击放大）</label><div class="rvcands">${cands.map((c, j) => `<button class="rvc${c.cur ? " cur" : ""}" data-cand="${j}" title="单击在左边大图里看，双击放大${c.issues.length ? "\n" + esc(c.issues.join("\n")) : ""}"><img src="${fileUrl("../storyboard/out/" + c.dir + "/" + c.file)}" data-zoom="候选 · ${esc(c.label)}（${c.pass ? "通过" : "没通过"} ${c.score ?? "-"}/10）" loading="lazy" alt=""><span>${esc(c.label)} ${c.pass ? "✓" : (c.score ?? "")}${c.cur ? " · 在用" : ""}</span></button>`).join("")}</div></div>` : ""}
      ${it.ok ? `<div class="rvact"><button class="pri" data-a="ok">✓ 通过<kbd>A</kbd></button><button class="ghost" data-a="bad">✗ 有问题<kbd>X</kbd></button><button class="ghost" data-a="fix">✎ 修图<kbd>E</kbd></button><button class="ghost" data-a="redraw" ${shot ? "" : "disabled"}>↻ 重画<kbd>R</kbd></button></div>
      <div class="rvnote" hidden><textarea placeholder="哪里不对？比如：女人坐到了后座，应该在副驾驶">${esc(r && !r.ok ? r.note : "")}</textarea><div class="row"><button class="ghost" data-a="noteSave">只记下</button><button class="pri" data-a="noteAI" title="按这句意见让 AI 在整张图上修改，再质检">记下并让 AI 按意见修改</button></div></div>`
      : `<div class="rvact"><button class="ghost" data-a="goto">去故事板给这一句出图</button></div>`}
    </div></article>`;
}
function rvRender() {
  const body = RV.el.querySelector("#rvBody");
  body.innerHTML = RV.items.length ? RV.items.map((it, k) => RV.kind === "ref" ? refCard(it, k) : RV.kind === "prompt" ? pvCard(it, k) : rvCard(it, k)).join("") + `<div class="rvend dim">${RV.filter === "todo" ? "这一批看完了 ✓" : "到底了"}</div>` : `<div class="rvempty">${(RV.kind === "ref" ? { todo: "参考图都审过了 ✓", bad: "没有标了问题的参考图", all: "还没有参考图" } : RV.kind === "prompt" ? { todo: "提示词都审过了 ✓", bad: "没有标了问题的提示词", all: "这里没有台词" } : { todo: "没有待审的图了 ✓", bad: "没有标了问题的图", all: "这里没有台词" })[RV.filter]}</div>`;
  body.querySelectorAll(".rvcard").forEach(card => {
    const k = +card.dataset.k, it = RV.items[k];
    card.addEventListener("click", e => { if (!e.target.closest("button,textarea")) rvFocus(k, false); });
    card.querySelectorAll("img").forEach(im => im.addEventListener("error", () => { const b = im.closest(".rvc"); if (b) b.remove(); }));
    card.querySelectorAll("[data-a]").forEach(b => b.onclick = () => { rvFocus(k, false); rvAct(b.dataset.a, k); });
    card.querySelectorAll("[data-cand]").forEach(b => b.onclick = () => rvShowCand(k, +b.dataset.cand));
    if (RV.kind === "ref") bindRefCard(card, k); else if (RV.kind === "prompt") bindPvCard(card, k); else bindRvZoom(card, k);
  });
  RV.io && RV.io.disconnect();
  RV.io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting && e.intersectionRatio > .55) rvFocus(+e.target.dataset.k, false, true); }), { root: body, threshold: [.55] });
  body.querySelectorAll(".rvcard").forEach(c => RV.io.observe(c));
  rvFocus(Math.min(RV.k, RV.items.length - 1), false);
}
function rvFocus(k, scroll = true, passive = false) {
  if (!RV || k < 0 || k >= RV.items.length) return;
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
  ban.innerHTML = `<span>候选：${esc(c.label)}（${c.pass ? "通过" : "没通过"} ${c.score ?? "-"}/10）${c.issues.length ? " · " + esc(c.issues.join("；")) : ""}</span><span class="grow"></span><button class="pri" data-use>用这张</button><button class="ghost" data-back>回到在用的</button>`;
  ban.querySelector("[data-back]").onclick = () => { img.src = fileUrl(limgRel(it.im)); ban.hidden = true; card.querySelectorAll(".rvc").forEach(b => b.classList.remove("view")); };
  ban.querySelector("[data-use]").onclick = () => runTool("fix_box.py", ["accept", it.sid, `storyboard/out/${c.dir}/${c.file}`], `换成候选 · ${it.sid}`);
}
async function rvAct(a, k) {
  const it = RV.items[k]; if (!it) return;
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
  if (a === "pok") { const shot = shotOf(it.im); if (!shot) return; try { P.sb = await S.sbReview(P.dir, "prompt:" + shot.id, true, "", promptHash(shot)); rvUpdateCard(k); rvCounts(); } catch (e) { return toast(e.message, true); } rvFocus(k + 1); return; }
  if (a === "ok") { await mark(true, ""); rvFocus(k + 1); }
  else if (a === "bad") { note.hidden = false; note.querySelector("textarea").focus(); }
  else if (a === "noteSave" || a === "noteAI") {
    const text = note.querySelector("textarea").value.trim(); if (!text) return toast("先写一句哪里不对", true);
    await mark(false, text);
    if (a === "noteAI") runTool("refine.py", [it.sid, text], `AI 按意见修改 · ${it.sid}`); else rvFocus(k + 1);
  }
  else if (a === "fix") openFixBox(it.i, it.nid);
  else if (a === "redraw") { if (!shotOf(it.im)) return; runTool("batch.py", [it.sid], `${it.ok ? "重画" : "出图"} · ${it.sid}`); }
  else if (a === "goto") { const nid = it.nid, i = it.i; closeReview(); if (mode !== "board") setMode("board"); goScene(nid); setCenter("board"); selectLine(i); }
}
function rvUpdateCard(k) {
  const old = RV.el.querySelector(`.rvcard[data-k="${k}"]`); if (!old) return;
  const it = RV.items[k];
  if (RV.kind === "ref") it.ref = refById(it.ref.id) || it.ref;
  else { it.im = limgOf(it.nid, it.i); it.ok = !!(it.im && has(limgRel(it.im))); it.sid = it.im ? shotId(it.im) : null; }
  const t = document.createElement("div"); t.innerHTML = RV.kind === "ref" ? refCard(it, k) : RV.kind === "prompt" ? pvCard(it, k) : rvCard(it, k); const card = t.firstElementChild; old.replaceWith(card);
  if (RV.kind === "ref") bindRefCard(card, k); else if (RV.kind === "prompt") bindPvCard(card, k); else bindRvZoom(card, k);
  card.addEventListener("click", e => { if (!e.target.closest("button,textarea")) rvFocus(k, false); });
  card.querySelectorAll("img").forEach(im => im.addEventListener("error", () => { const b = im.closest(".rvc"); if (b) b.remove(); }));
  card.querySelectorAll("[data-a]").forEach(b => b.onclick = () => { rvFocus(k, false); rvAct(b.dataset.a, k); });
  card.querySelectorAll("[data-cand]").forEach(b => b.onclick = () => rvShowCand(k, +b.dataset.cand));
  RV.io && RV.io.observe(card); card.classList.toggle("focus", RV.k === k);
}
function rvRefresh() { if (!RV) return; RV.items.forEach((_, k) => rvUpdateCard(k)); rvCounts(); }
function rvKey(e) {
  if (!RV || document.querySelector(".modal")) return;          // 修图窗口、对话框开着时不抢按键
  const inText = e.target && e.target.matches && e.target.matches("textarea,input");
  if (inText) { if (e.key === "Escape") { e.target.closest(".rvnote") && (e.target.closest(".rvnote").hidden = true); e.target.blur(); e.preventDefault(); e.stopPropagation(); } return; }
  const k = RV.k, map = { ArrowDown: () => rvFocus(k + 1), j: () => rvFocus(k + 1), ArrowUp: () => rvFocus(k - 1), k: () => rvFocus(k - 1),
    a: () => rvAct(RV.kind === "ref" ? "rok" : RV.kind === "prompt" ? "pok" : "ok", k), x: () => RV.kind === "img" && rvAct("bad", k), e: () => RV.kind === "img" && rvAct("fix", k), r: () => rvAct(RV.kind === "ref" ? "regen" : "redraw", k), Escape: closeReview };
  const fn = map[e.key] || map[e.key.toLowerCase()];
  e.stopPropagation();                                            // 审阅页开着时，按键不传给后面的剪辑台（防止误删台词）
  if (fn && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); const it = RV.items[k]; if (RV.kind === "img" && "axer".includes(e.key.toLowerCase()) && e.key.length === 1 && it && !it.ok) return; if (RV.kind === "prompt" && "ar".includes(e.key.toLowerCase()) && e.key.length === 1 && it && promptState(it) === "noshot") return; if (RV.kind === "ref" && e.key.toLowerCase() === "a" && it && !it.ref.exists) return; fn(); }
}

/* ---------- 出图任务（调用 storyboard 里的 Python 脚本） ---------- */
let toolBusy = false;
async function runTool(script, args, title) {
  if (toolBusy) { toast("已经有一个出图任务在跑，等它结束或先停止", true); return false; }
  if (script === "batch.py" && args.length && !(await confirmPrompts(args.map(String)))) return false;
  if (dirty) await save();
  $("taskbar").hidden = false; $("taskTitle").textContent = title; $("taskLog").textContent = ""; $("taskSpin").className = "spin"; $("taskStop").disabled = false;
  try { const r = await S.runTool(P.dir, script, args); toolBusy = true; $("taskLog").textContent = "▶ " + r.cmd + "\n"; return true; }
  catch (e) { $("taskSpin").className = "spin off"; $("taskLog").textContent = "没能启动：" + e.message; toast(e.message, true); return false; }
}
S.onToolLog(t => { const lg = $("taskLog"); lg.textContent += t; lg.scrollTop = lg.scrollHeight; if (fixUI && fixUI.busy) fixLog(t); });
S.onToolDone(async code => {
  toolBusy = false; $("taskSpin").className = "spin off"; $("taskStop").disabled = true;
  $("taskTitle").textContent += code === 0 ? " · 完成" : ` · 结束（代码 ${code}）`;
  try { await refreshFiles(); const sb = await S.sbLoad(P.dir); if (sb) P.sb = sb; const rf = await S.refsLoad(P.dir); if (rf) P.refs = rf; pinLineImages(); } catch {}
  renderAll(false); reloadPreview(); if (RV) rvRefresh();
  if (fixUI && fixUI.busy) { fixUI.busy = false; fixDone(code); return; }
  toast(code === 0 ? "出图任务完成，画面已更新" : "出图任务结束了，看一下日志", code !== 0);
});
$("taskStop").onclick = () => S.stopTool().catch(() => {});
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
