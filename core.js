// 影游剪辑台 · 项目读写核心（读写游戏 index.html 里的数据块、素材替换、导出 zip）
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const MEDIA_DIRS = ["img", "vid", "vo", "bgm", "sfx", "amb"];
const STUDIO_DIR = "_studio";          // 备份、状态、导入的素材都放这里
const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);

function gameFile(dir) { return path.join(dir, "index.html"); }
function isProject(dir) { try { return fs.readFileSync(gameFile(dir), "utf8").includes("const N="); } catch { return false; } }

function matchBrace(s, a) {          // 从 a 处的 { 开始，找到配对的 }（跳过字符串）
  let d = 0, inS = false;
  for (let i = a; i < s.length; i++) {
    const c = s[i];
    if (inS) { if (c === "\\") i++; else if (c === '"') inS = false; continue; }
    if (c === '"') inS = true; else if (c === "{") d++; else if (c === "}" && --d === 0) return i + 1;
  }
  throw new Error("剧本数据不完整（括号没配对）");
}
function spanN(s) {
  const a = s.indexOf("const N=") + "const N=".length;
  return [a, matchBrace(s, a)];
}
function spanLine(s, prefix) {
  const i = s.indexOf(prefix); if (i < 0) return null;
  const a = i + prefix.length; let e = s.indexOf("\n", a); if (e < 0) e = s.length;
  let end = e - 1; while (end > a && s[end] !== ";") end--;
  return [a, end];
}
function spanClues(s) {
  const a = s.indexOf("const CLUES={") + "const CLUES=".length;
  return [a, matchBrace(s, a)];
}
function jsObj(txt) {
  const out = {}; const re = /([A-Za-z_][\w]*)\s*:\s*"((?:[^"\\]|\\.)*)"/g; let m;
  while ((m = re.exec(txt))) out[m[1]] = JSON.parse('"' + m[2] + '"');
  return out;
}
const toJsObj = d => "{" + Object.entries(d).map(([k, v]) => `${k}:${JSON.stringify(v)}`).join(",") + "}";

// Read only MP4 headers; the media payload may be much larger than the index.
function mp4HasAudio(file, size) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const header = Buffer.alloc(16);
    function scan(start, end, containers) {
      for (let offset = start; offset + 8 <= end;) {
        if (fs.readSync(fd, header, 0, 8, offset) !== 8) return false;
        let length = header.readUInt32BE(0), head = 8;
        const type = header.toString("ascii", 4, 8);
        if (length === 1) {
          if (fs.readSync(fd, header, 8, 8, offset + 8) !== 8) return false;
          length = Number(header.readBigUInt64BE(8)); head = 16;
        } else if (length === 0) length = end - offset;
        if (length < head || length > end - offset) return false;
        const body = offset + head;
        if (containers.length && type === containers[0] && scan(body, offset + length, containers.slice(1))) return true;
        if (!containers.length && type === "hdlr" && length >= head + 12 &&
            fs.readSync(fd, header, 0, 12, body) === 12 && header.toString("ascii", 8, 12) === "soun") return true;
        offset += length;
      }
      return false;
    }
    return scan(0, size, ["moov", "trak", "mdia"]);
  } catch { return false; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

function listFiles(dir) {
  const files = {};
  const walk = (rel, onlyVideo = false) => {
    const abs = path.join(dir, rel);
    if (!fs.existsSync(abs)) return;
    for (const f of fs.readdirSync(abs)) {
      const r = rel + "/" + f, st = fs.statSync(path.join(dir, r));
      if (st.isDirectory()) { if (!onlyVideo) walk(r); }
      else if (!onlyVideo || /^\d{8}-\d{6}__vid__.+\.mp4$/i.test(f)) {
        const info = files[r] = { size: st.size, mtime: Math.floor(st.mtimeMs / 1000), revision: `${st.mtimeMs}:${st.ctimeMs}:${st.size}` };
        if (r.startsWith("vid/") && /\.mp4$/i.test(f)) info.hasAudio = mp4HasAudio(path.join(dir, r), st.size);
      }
    }
  };
  MEDIA_DIRS.forEach(rel => walk(rel)); walk(STUDIO_DIR + "/inbox"); walk(STUDIO_DIR + "/backup", true); walk("vid_draft");   // 草稿视频（draft_video.py 出的）：预览要用，导出游戏不带
  return files;
}

function loadProject(dir) {
  const s = fs.readFileSync(gameFile(dir), "utf8");
  let [a, b] = spanN(s); const N = JSON.parse(s.slice(a, b));
  const pick = (prefix, parse, dflt) => { const sp = spanLine(s, prefix); return sp ? parse(s.slice(sp[0], sp[1])) : dflt; };
  const VOT = pick("const VOT=/*VO_MAP*/", JSON.parse, {});
  const SHOTS = pick("const SHOTS=new Set(/*SHOTS*/", t => JSON.parse(t.replace(/\)\s*$/, "")), []);
  const LIMG = pick("const LIMG=new Set(/*LIMG*/", t => JSON.parse(t.replace(/\)\s*$/, "")), []);
  const TRIM = pick("const TRIM=/*TRIM*/", JSON.parse, {}), VAUD = pick("const VAUD=/*VAUD*/", JSON.parse, {});
  const BGM = pick("const BGM=", jsObj, {}), AMB = pick("const AMB=", jsObj, {}), SHOT_SFX = pick("const SHOT_SFX=", jsObj, {});
  [a, b] = spanClues(s); const CLUES = jsObj(s.slice(a, b));
  const m = s.match(/const ACTS=(\[.*?\]\]\]);/); const ACTS = m ? JSON.parse(m[1]) : [];
  const tm = s.match(/<title>([^<]*)<\/title>/) || s.match(/<h1>([^<]*)<\/h1>/);
  let STALE = [];
  try { STALE = JSON.parse(fs.readFileSync(path.join(dir, STUDIO_DIR, "state.json"), "utf8")).stale || []; } catch {}
  return { dir, name: tm ? tm[1].trim() : path.basename(dir), N, VOT, SHOTS, LIMG, hasLimg: s.includes("const LIMG=new Set(/*LIMG*/"), muteSupport: muteSupport(upgradeMute(s)), sb: sbLoad(dir), refs: refsLoad(dir), voiceRefs: require("./voice-refs-store").load(dir), vs: vsLoad(dir), TRIM, VAUD, hasClip: s.includes("const TRIM=/*TRIM*/"), BGM, AMB, SHOT_SFX, CLUES, ACTS, STALE, files: listFiles(dir) };
}

/* ---- 参考图登记表（moban_art\refs\refs.json）：名称、类型、生成描述、关键词（提示词里出现这些词时应该附上它） ---- */
const REF_DEFAULTS = {
  char_driver: ["char", "司机", ["司机"]], char_woman: ["char", "穿貂的女人", ["女人"]], char_dajun: ["char", "大军", ["大军"]], char_police: ["char", "民警", ["民警"]],
  prop_taxi: ["prop", "红色夏利出租车", ["出租车", "夏利", "车身", "车头朝", "引擎盖", "车尾"]], prop_case: ["prop", "黑皮箱", ["皮箱", "箱子"]],
  bg_interior: ["bg", "出租车车内", ["车内"]], bg_highway: ["bg", "林间公路", ["公路", "林间"]], bg_checkpoint: ["bg", "检查站", ["检查站"]],
  bg_station: ["bg", "客运站", ["客运站"]], bg_railway: ["bg", "火车站", ["火车站"]],
};
const refsDir = dir => path.join(dir, "..", "refs");
function refsLoad(dir) {
  const d = refsDir(dir), f = path.join(d, "refs.json");
  if (!fs.existsSync(d)) return { dir: d, refs: [] };
  let reg = { refs: [] }; try { reg = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
  const have = new Set(reg.refs.map(x => x.id));
  for (const file of fs.readdirSync(d).filter(x => /\.(png|jpe?g)$/i.test(x))) {      // 第一次打开：按已有的图自动建登记
    const id = file.replace(/\.\w+$/, ""); if (have.has(id)) continue;
    const def = REF_DEFAULTS[id] || [id.split("_")[0] in { char: 1, prop: 1, bg: 1 } ? id.split("_")[0] : "prop", id, []];
    let desc = ""; try { desc = fs.readFileSync(path.join(dir, "..", "ref_prompts", id + ".txt"), "utf8").trim(); } catch {}
    reg.refs.push({ id, kind: def[0], name: def[1], keywords: def[2], desc, inputs: [] }); have.add(id);
  }
  reg.refs.forEach(r => { const p = path.join(d, r.id + ".png"); r.exists = fs.existsSync(p); r.mtime = r.exists ? Math.floor(fs.statSync(p).mtimeMs / 1000) : 0; });
  return { dir: d, refs: reg.refs };
}
function refsWrite(dir, refs) {
  const d = refsDir(dir), f = path.join(d, "refs.json"); fs.mkdirSync(d, { recursive: true });
  if (fs.existsSync(f)) { const b = path.join(d, "_old"); fs.mkdirSync(b, { recursive: true }); fs.copyFileSync(f, path.join(b, stamp() + "__refs.json")); }
  fs.writeFileSync(f, JSON.stringify({ refs: refs.map(({ exists, mtime, ...r }) => r) }, null, 1), "utf8");
}
function refsSave(dir, entry) {               // 新增或修改一条登记
  if (!/^[a-z][a-z0-9_]{1,40}$/.test(entry.id || "")) throw new Error("文件名只能用小写英文、数字和下划线，例如 prop_pager");
  const cur = refsLoad(dir).refs, i = cur.findIndex(x => x.id === entry.id);
  if (entry._delete) { if (i >= 0) cur.splice(i, 1); }
  else if (i >= 0) cur[i] = { ...cur[i], ...entry }; else cur.push({ kind: "prop", name: entry.id, keywords: [], desc: "", inputs: [], ...entry });
  refsWrite(dir, cur); return refsLoad(dir);
}
function refsImport(dir, id, src, nativeImage) {   // 用本地图片做参考图（原图挪到 refs\_old）
  if (!/^[a-z][a-z0-9_]{1,40}$/.test(id || "")) throw new Error("文件名不对");
  const d = refsDir(dir), out = path.join(d, id + ".png");
  if (fs.existsSync(out)) { const b = path.join(d, "_old"); fs.mkdirSync(b, { recursive: true }); fs.renameSync(out, path.join(b, `${id}_${stamp()}.png`)); }
  const img = nativeImage.createFromPath(src); if (img.isEmpty()) throw new Error("读不了这张图片");
  fs.writeFileSync(out, img.toPNG()); return refsLoad(dir);
}

/* ---- 分镜工作区 ---- */
function sbDir(dir) { return path.join(dir, "..", "storyboard"); }
function sbLoad(dir) {
  const d = sbDir(dir), f = path.join(d, "shotlist.json");
  if (!fs.existsSync(f)) return null;
  let list = null, state = { shots: {} };
  try { list = JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return { error: "分镜表读不了：" + e.message }; }
  try { state = JSON.parse(fs.readFileSync(path.join(d, "out", "batch", "state.json"), "utf8")); } catch {}
  const refDir = path.join(dir, "..", "refs");
  const refs = fs.existsSync(refDir) ? fs.readdirSync(refDir).filter(x => /\.(png|jpe?g)$/i.test(x)).map(x => "refs/" + x) : [];
  let review = {};
  try { review = JSON.parse(fs.readFileSync(path.join(d, "out", "review.json"), "utf8")); } catch {}
  let cont = {};   // 前后镜头衔接检查结果（continuity.py 写）
  try { cont = JSON.parse(fs.readFileSync(path.join(d, "out", "continuity.json"), "utf8")); } catch {}
  return { dir: d, bible: list.bible || {}, shots: list.shots || [], state, refs, review, cont };
}
/* ---- 视频分镜表（moban_art\autofix\video_shots.json）：提示词、质检标准、首帧、参考图、生成方式；autofix.py 和 qc.py 也读它 ---- */
function afDir(dir) { return path.join(dir, "..", "autofix"); }
function vsLoad(dir) {
  const f = path.join(afDir(dir), "video_shots.json"); if (!fs.existsSync(f)) return null;
  let d; try { d = JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return { error: "视频分镜表读不了：" + e.message }; }
  const state = {};
  for (const sub of ["out", "out_r3"]) {      // 自动重拍的记录（AUTOFIX_OUT 不同，记录在不同文件夹）
    try { const st = JSON.parse(fs.readFileSync(path.join(afDir(dir), sub, "state.json"), "utf8")); for (const [k, v] of Object.entries(st.shots || {})) if (!state[k] || (v.tries || []).length) state[k] = { ...v, dir: sub }; } catch {}
  }
  const mt = p => { try { return Math.floor(fs.statSync(p).mtimeMs / 1000); } catch { return 0; } };
  const root = path.join(dir, "..");
  (d.shots || []).forEach(s => {
    s._keyRel = s.key ? "../autofix/" + s.key : (s.keyframe || ""); s._keym = mt(path.join(dir, s._keyRel)); try { const st=fs.statSync(path.join(dir,s._keyRel)); s._keyrev=`${st.mtimeMs}:${st.ctimeMs}:${st.size}`; } catch { s._keyrev=""; }
    s._lastRel = s.last ? "../autofix/" + s.last : ""; s._midRel = s.mid ? "../autofix/" + s.mid : "";
    s._refs = (s.refs || []).map(r => { const p = Array.isArray(r) ? r[0] : r; return { rel: "../" + p, label: Array.isArray(r) ? r[1] : path.basename(p, path.extname(p)), ok: fs.existsSync(path.join(root, p)) }; });
    s._gen = (s.gen_refs || []).map(g => ({ rel: "../autofix/refs_gen/" + g.name + ".png", label: g.label || g.name, ok: fs.existsSync(path.join(afDir(dir), "refs_gen", g.name + ".png")) }));
  });
  let draft = null; try { draft = JSON.parse(fs.readFileSync(path.join(afDir(dir), "out", "vprompts_draft.json"), "utf8")); } catch {}   // AI 写的提示词草稿（还没采用）
  let drafts = {}; try { drafts = JSON.parse(fs.readFileSync(path.join(afDir(dir), "draft", "drafts.json"), "utf8")); } catch {}   // 草稿视频的记录（代码草稿 / AI 尾帧 / 本地模型）
  return { suffix: d.suffix || "", shots: d.shots || [], state, draft, drafts };
}
function vsSave(dir, id, patch) {               // 改一条：先备份整个文件到 autofix\backup\
  const f = path.join(afDir(dir), "video_shots.json"), d = JSON.parse(fs.readFileSync(f, "utf8"));
  const s = (d.shots || []).find(x => x.id === id); if (!s) throw new Error("视频分镜表里没有 " + id);
  const b = path.join(afDir(dir), "backup"); fs.mkdirSync(b, { recursive: true }); fs.copyFileSync(f, path.join(b, `video_shots_${stamp()}.json`));
  for (const [k, v] of Object.entries(patch || {})) if (!k.startsWith("_") && k !== "id") s[k] = v;
  fs.writeFileSync(f, JSON.stringify(d, null, 1), "utf8"); return vsLoad(dir);
}
function vsAdd(dir, list) {                     // 剧本里有、视频分镜表里还没有的场景 / 动作镜头：补占位条目（已有的 id 不动）
  const f = path.join(afDir(dir), "video_shots.json"), d = JSON.parse(fs.readFileSync(f, "utf8"));
  const have = new Set((d.shots || []).map(x => x.id)), add = (list || []).filter(x => x && x.id && /^[\w-]+$/.test(x.id) && !have.has(x.id));
  if (!add.length) return vsLoad(dir);
  const b = path.join(afDir(dir), "backup"); fs.mkdirSync(b, { recursive: true }); fs.copyFileSync(f, path.join(b, `video_shots_${stamp()}.json`));
  d.shots = [...(d.shots || []), ...add.map(x => { const o = {}; for (const [k, v] of Object.entries(x)) if (!k.startsWith("_")) o[k] = v; return o; })];
  fs.writeFileSync(f, JSON.stringify(d, null, 1), "utf8"); return vsLoad(dir);
}
function vsDel(dir, id) {                       // 删一条（剧本里已经没有的）：先备份
  const f = path.join(afDir(dir), "video_shots.json"), d = JSON.parse(fs.readFileSync(f, "utf8"));
  const i = (d.shots || []).findIndex(x => x.id === id); if (i < 0) throw new Error("视频分镜表里没有 " + id);
  const b = path.join(afDir(dir), "backup"); fs.mkdirSync(b, { recursive: true }); fs.copyFileSync(f, path.join(b, `video_shots_${stamp()}.json`));
  d.shots.splice(i, 1); fs.writeFileSync(f, JSON.stringify(d, null, 1), "utf8"); return vsLoad(dir);
}
/* ---- 手绘构图：只能读写 storyboard\sketch 里的文件；rel 相对 moban_art（例如 storyboard/sketch/stop_00.png） ---- */
function sketchPath(dir, rel) {
  const root = path.resolve(sbDir(dir), "sketch"), p = path.resolve(sbDir(dir), "..", String(rel || ""));
  if (p !== root && !p.startsWith(root + path.sep)) throw new Error("只能读写 storyboard\\sketch 里的文件");
  return p;
}
function sketchWrite(dir, rel, data, isB64) {   // 正式的构图图被覆盖前，先备份到 sketch\_old\
  const p = sketchPath(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true });
  if (fs.existsSync(p) && !/[\\/]_draft[\\/]/.test(p)) { const o = path.join(path.resolve(sbDir(dir), "sketch"), "_old"); fs.mkdirSync(o, { recursive: true }); fs.copyFileSync(p, path.join(o, path.basename(p).replace(/(\.\w+)$/, `_${stamp()}$1`))); }
  if (isB64) fs.writeFileSync(p, Buffer.from(data, "base64")); else fs.writeFileSync(p, data, "utf8");
  return rel;
}
function sketchRead(dir, rel) { const p = sketchPath(dir, rel); return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null; }
/* 一次写好几条（比如「上游基准」：下游确认时上游是什么样，用来提示「上游改过、要复查」）。entries = {key: 值或 null（删除）} */
function sbReviewMany(dir, entries) {
  const f = path.join(sbDir(dir), "out", "review.json");
  let r = {}; try { r = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
  for (const [k, v] of Object.entries(entries || {})) { if (v === null) delete r[k]; else r[k] = v; }
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(r, null, 1), "utf8");
  return sbLoad(dir);
}
/* 人工审阅结果单独存在 storyboard\out\review.json（不和出图脚本抢着写 state.json）。
   每条记下审阅时游戏里那张图的修改时间，图换了就自动回到「待审」。 */
function sbReview(dir, sid, ok, note, mtime, extra) {
  const f = path.join(sbDir(dir), "out", "review.json");
  let r = {}; try { r = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
  if (ok === null) delete r[sid];
  else r[sid] = { ok: !!ok, note: note || "", mtime: mtime || 0, at: new Date().toISOString(), ...(extra || {}) };
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(r, null, 1), "utf8");
  return sbLoad(dir);
}
function sbSaveShot(dir, shot) {
  const f = path.join(sbDir(dir), "shotlist.json"); const list = JSON.parse(fs.readFileSync(f, "utf8"));
  const bdir = path.join(sbDir(dir), "out", "backup"); fs.mkdirSync(bdir, { recursive: true });
  fs.copyFileSync(f, path.join(bdir, stamp() + "__shotlist.json"));
  const i = list.shots.findIndex(x => x.id === shot.id);
  if (shot._delete) { if (i >= 0) list.shots.splice(i, 1); }
  else if (i >= 0) list.shots[i] = { ...list.shots[i], ...shot }; else list.shots.push(shot);
  fs.writeFileSync(f, JSON.stringify(list, null, 1), "utf8");
  return sbLoad(dir);
}
function refPath(dir, rel) {      // 设定图的绝对路径（只读）
  const parts = rel.replace(/\\/g, "/").split("/"); if (parts[0] !== "refs" || parts.includes("..")) throw new Error("只能读 refs 文件夹");
  return path.join(dir, "..", ...parts);
}

function backup(dir, abs) {
  if (!fs.existsSync(abs)) return null;
  const bdir = path.join(dir, STUDIO_DIR, "backup"); fs.mkdirSync(bdir, { recursive: true });
  const rel = path.relative(dir, abs).split(path.sep).join("__");
  const dst = path.join(bdir, stamp() + "__" + rel); fs.copyFileSync(abs, dst);
  return path.relative(dir, dst).split(path.sep).join("/");
}

/* ---- 静音支持：游戏代码要认 VAUD[...].muted（视频原声静音）和台词第三项的 mute（这句配音静音） ----
   新的游戏模板自带这两处；旧模板在保存时只在原来那两个确切位置升级一次，不再全文替换。
   升级不了（游戏代码改过写法）就返回警告，而不是静默失效。 */
const MUTE_UPGRADES = {
  original: [["va.volume=Math.min(1,a.vol??1)", "va.volume=a.muted?0:Math.min(1,a.vol??1)"]],
  line: [['.mp3";a.volume=1;', '.mp3";a.volume=(N[G.node]?.lines[G.line]?.[2]?.mute)?0:1;'],
         [".mp3';a.volume=1;", ".mp3';a.volume=(N[G.node]?.lines[G.line]?.[2]?.mute)?0:1;"]],
};
function muteSupport(s) {
  return { original: /\.muted\s*\?\s*0\s*:/.test(s), line: /\[2\]\s*\?\.\s*mute\b/.test(s) };
}
function upgradeMute(s) {
  const has = muteSupport(s);
  for (const [kind, pairs] of Object.entries(MUTE_UPGRADES)) if (!has[kind])
    for (const [from, to] of pairs) if (s.includes(from)) s = s.split(from).join(to);
  return s;
}
function muteUsed(data) {
  const line = Object.values(data.N || {}).some(n => (n.lines || []).some(l => l && l[2] && l[2].mute));
  const original = Object.values(data.VAUD || {}).some(v => v && v.muted);
  return { line, original };
}

function saveProject(dir, data) {
  let s = fs.readFileSync(gameFile(dir), "utf8"); const bk = backup(dir, gameFile(dir));
  const put = (sp, txt) => { s = s.slice(0, sp[0]) + txt + s.slice(sp[1]); };
  if (data.N) put(spanN(s), "{\n" + Object.entries(data.N).map(([k, v]) => JSON.stringify(k) + ":" + JSON.stringify(v)).join(",\n") + "\n}");
  if (data.VOT) { const sp = spanLine(s, "const VOT=/*VO_MAP*/"); if (sp) put(sp, JSON.stringify(data.VOT)); }
  if (data.SHOTS) { const sp = spanLine(s, "const SHOTS=new Set(/*SHOTS*/"); if (sp) put(sp, JSON.stringify(data.SHOTS) + ")"); }
  if (data.LIMG) { const sp = spanLine(s, "const LIMG=new Set(/*LIMG*/"); if (sp) put(sp, JSON.stringify(data.LIMG) + ")"); }
  for (const k of ["TRIM", "VAUD"]) if (data[k]) {
    const sp = spanLine(s, `const ${k}=/*${k}*/`);
    if (sp) put(sp, JSON.stringify(data[k]));
    else { const i = s.indexOf("\n", s.indexOf("const SHOTS=new Set(")); s = s.slice(0, i + 1) + `const ${k}=/*${k}*/${JSON.stringify(data[k])};\n` + s.slice(i + 1); }
  }
  for (const k of ["BGM", "AMB"]) if (data[k]) { const sp = spanLine(s, `const ${k}=`); if (sp) put(sp, toJsObj(data[k])); }
  if (data.CLUES) put(spanClues(s), "{\n" + Object.entries(data.CLUES).map(([k, v]) => ` ${k}:${JSON.stringify(v)}`).join(",\n") + "\n}");
  s = upgradeMute(s);
  fs.writeFileSync(gameFile(dir), s, "utf8");
  if (data.STALE) { fs.mkdirSync(path.join(dir, STUDIO_DIR), { recursive: true }); fs.writeFileSync(path.join(dir, STUDIO_DIR, "state.json"), JSON.stringify({ stale: data.STALE })); }
  const has = muteSupport(s), used = muteUsed(data), warnings = [];
  if (used.line && !has.line) warnings.push("有台词设了静音，但这个游戏的 index.html 不认台词静音（找不到 lines[...][2]?.mute），游戏里仍会播配音。请更新游戏文件。");
  if (used.original && !has.original) warnings.push("有视频原声设了静音，但这个游戏的 index.html 不认 VAUD 的 muted，游戏里仍会播原声。请更新游戏文件。");
  return { backup: bk, muteSupport: has, warnings };
}

function safeTarget(dir, rel) {
  const parts = rel.replace(/\\/g, "/").replace(/^\/+/, "").split("/");
  if (parts.includes("..") || !MEDIA_DIRS.includes(parts[0])) throw new Error("只能替换素材文件夹里的文件");
  return path.join(dir, ...parts);
}

// 用一个文件替换某个素材；图片会转成 1280×720 JPG（需要传入 Electron 的 nativeImage）
function replaceAsset(dir, rel, srcPath, nativeImage) {
  const dst = safeTarget(dir, rel); fs.mkdirSync(path.dirname(dst), { recursive: true });
  const bk = backup(dir, dst); let note = "";
  const de = path.extname(dst).toLowerCase(), se = path.extname(srcPath).toLowerCase();
  if ((de === ".jpg" || de === ".jpeg") && nativeImage && se !== ".jpg" && se !== ".jpeg" || (de === ".jpg" && nativeImage)) {
    const img = nativeImage.createFromPath(srcPath);
    if (!img.isEmpty()) {
      let { width: w, height: h } = img.getSize(); let im = img;
      const nh = Math.round(w * 9 / 16);
      if (nh <= h) im = img.crop({ x: 0, y: Math.round((h - nh) / 2), width: w, height: nh });
      else { const nw = Math.round(h * 16 / 9); im = img.crop({ x: Math.round((w - nw) / 2), y: 0, width: nw, height: h }); }
      fs.writeFileSync(dst, im.resize({ width: 1280, height: 720, quality: "best" }).toJPEG(84));
      return { backup: bk, note: "已裁成 16:9 并转成 1280×720 JPG" };
    }
    note = "图片没能自动转换，按原样复制";
  } else if (se && se !== de) note = `上传的是 ${se}，游戏按 ${de} 读取；能播放就行，正式版建议转成 ${de}`;
  fs.copyFileSync(srcPath, dst);
  return { backup: bk, note };
}

function readAsset(dir, rel) { return fs.readFileSync(safeTarget(dir, rel)); }
// 把渲染进程算好的二进制（例如分离出来的 WAV）写进素材文件夹
function writeAsset(dir, rel, bytes) {
  const dst = safeTarget(dir, rel); fs.mkdirSync(path.dirname(dst), { recursive: true });
  const bk = backup(dir, dst); fs.writeFileSync(dst, Buffer.from(bytes)); return { backup: bk };
}

function importFiles(dir, srcPaths) {
  const inbox = path.join(dir, STUDIO_DIR, "inbox"); fs.mkdirSync(inbox, { recursive: true });
  return srcPaths.map(p => { let name = path.basename(p), dst = path.join(inbox, name), i = 1;
    while (fs.existsSync(dst)) { const e = path.extname(name); dst = path.join(inbox, path.basename(name, e) + `_${i++}` + e); }
    fs.copyFileSync(p, dst); return STUDIO_DIR + "/inbox/" + path.basename(dst); });
}

/* ---- 极简 zip 写入（store/deflate），不依赖第三方库 ---- */
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { if (zlib.crc32) return zlib.crc32(buf) >>> 0; let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function writeZip(out, entries) {
  const fd = fs.openSync(out, "w"); let off = 0; const central = [];
  const w = b => { fs.writeSync(fd, b); off += b.length; };
  for (const [name, abs] of entries) {
    const data = fs.readFileSync(abs), nameB = Buffer.from(name, "utf8"), crc = crc32(data);
    const store = /\.(mp4|mp3|jpg|png|zip)$/i.test(name); const body = store ? data : zlib.deflateRawSync(data, { level: 6 });
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(store ? 0 : 8, 8);
    h.writeUInt32LE(0, 10); h.writeUInt32LE(crc, 14); h.writeUInt32LE(body.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(nameB.length, 26); h.writeUInt16LE(0, 28);
    const at = off; w(h); w(nameB); w(body);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(store ? 0 : 8, 10);
    c.writeUInt32LE(0, 12); c.writeUInt32LE(crc, 16); c.writeUInt32LE(body.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(nameB.length, 28);
    c.writeUInt32LE(at, 42); central.push(Buffer.concat([c, nameB]));
  }
  const cd = Buffer.concat(central), cdAt = off; w(cd);
  const e = Buffer.alloc(22); e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(central.length, 8); e.writeUInt16LE(central.length, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(cdAt, 16); w(e);
  fs.closeSync(fd);
}
function exportGame(dir, name) {
  const outDir = path.join(dir, STUDIO_DIR, "export"); fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `${(name || "game").replace(/[\\/:*?"<>|]/g, "")}_${stamp()}.zip`);
  const entries = [["index.html", gameFile(dir)]];
  const walk = rel => { const p = path.join(dir, rel); if (!fs.existsSync(p)) return;
    for (const f of fs.readdirSync(p).sort()) { const r = rel + "/" + f, a = path.join(dir, r); if (fs.statSync(a).isDirectory()) walk(r); else entries.push([r, a]); } };
  MEDIA_DIRS.forEach(walk);
  writeZip(out, entries); return out;
}

module.exports = { MEDIA_DIRS, STUDIO_DIR, muteSupport, upgradeMute, isProject, loadProject, saveProject, replaceAsset, writeAsset, readAsset, importFiles, exportGame, listFiles, sbDir, sbLoad, sbSaveShot, sbReview, sbReviewMany, sketchWrite, sketchRead, vsLoad, vsSave, vsAdd, vsDel, refPath, refsLoad, refsSave, refsImport };
