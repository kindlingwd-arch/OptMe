// 影游剪辑台 · Electron 主进程
const { app, BrowserWindow, ipcMain, dialog, Menu, shell, nativeImage, clipboard } = require("electron");
const { fileURLToPath } = require("url");
const path = require("path");
const fs = require("fs");
const core = require("./core");
const { spawn } = require("child_process");

let win = null;
const RECENT = () => path.join(app.getPath("userData"), "recent.json");
const readRecent = () => { try { return JSON.parse(fs.readFileSync(RECENT(), "utf8")).filter(p => core.isProject(p)); } catch { return []; } };
const pushRecent = dir => { const r = [dir, ...readRecent().filter(x => x !== dir)].slice(0, 10); fs.mkdirSync(path.dirname(RECENT()), { recursive: true }); fs.writeFileSync(RECENT(), JSON.stringify(r)); };

function createWindow() {
  win = new BrowserWindow({
    width: 1480, height: 920, minWidth: 1100, minHeight: 680, backgroundColor: "#141417", show: false,
    title: "影游剪辑台", autoHideMenuBar: false,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  win.once("ready-to-show", () => win.show());
  win.on("close", e => {
    if (win.__forceClose) return;
    e.preventDefault(); win.webContents.send("app:before-close");
  });
}

const send = (ch, ...a) => win && win.webContents.send(ch, ...a);
function buildMenu() {
  const t = [
    { label: "文件", submenu: [
      { label: "打开项目文件夹…", accelerator: "CmdOrCtrl+O", click: () => send("menu", "open") },
      { label: "保存", accelerator: "CmdOrCtrl+S", click: () => send("menu", "save") },
      { type: "separator" },
      { label: "导入素材…", accelerator: "CmdOrCtrl+I", click: () => send("menu", "import") },
      { label: "导出剪辑表（CSV）", click: () => send("menu", "edl") },
      { label: "导出游戏包", accelerator: "CmdOrCtrl+E", click: () => send("menu", "export") },
      { type: "separator" },
      { label: "在文件夹中显示项目", click: () => send("menu", "reveal") },
      { type: "separator" },
      { role: "quit", label: "退出" },
    ]},
    { label: "编辑", submenu: [
      { label: "撤销", accelerator: "CmdOrCtrl+Z", click: () => send("menu", "undo") },
      { label: "重做", accelerator: "CmdOrCtrl+Shift+Z", click: () => send("menu", "redo") },
      { type: "separator" },
      { label: "审图 · 框选修图（选中的那一句）…", accelerator: "CmdOrCtrl+Shift+F", click: () => send("menu", "fixbox") },
      { type: "separator" },
      { role: "cut", label: "剪切" }, { role: "copy", label: "复制" }, { role: "paste", label: "粘贴" }, { role: "selectAll", label: "全选" },
    ]},
    { label: "播放", submenu: [
      { label: "暂停 / 继续（空格）", click: () => send("menu", "play") },
      { label: "从本场开头播放", click: () => send("menu", "restart") },
      { label: "上一场", accelerator: "CmdOrCtrl+Up", click: () => send("menu", "prevScene") },
      { label: "下一场", accelerator: "CmdOrCtrl+Down", click: () => send("menu", "nextScene") },
    ]},
    { label: "视图", submenu: [
      { label: "审阅分镜图", accelerator: "CmdOrCtrl+Shift+A", click: () => send("menu", "review") },
      { label: "素材检查", accelerator: "CmdOrCtrl+Shift+C", click: () => send("menu", "check") },
      { type: "separator" },
      { role: "reload", label: "重新加载界面" }, { role: "toggleDevTools", label: "开发者工具" },
      { type: "separator" }, { role: "resetZoom", label: "实际大小" }, { role: "zoomIn", label: "放大" }, { role: "zoomOut", label: "缩小" },
      { role: "togglefullscreen", label: "全屏" },
    ]},
    { label: "帮助", submenu: [{ label: "关于影游剪辑台", click: () => dialog.showMessageBox(win, { title: "影游剪辑台", message: "影游剪辑台 " + app.getVersion(), detail: "用剪辑软件的方式做互动影游：剧本即剪辑表，素材可替换，一键导出游戏包。" }) }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(t));
}

const wrap = fn => async (_e, ...a) => { try { return { ok: true, data: await fn(...a) }; } catch (err) { return { ok: false, error: String(err && err.message || err) }; } };
ipcMain.handle("project:recent", wrap(() => readRecent().map(dir => { try { const p = core.loadProject(dir); return { dir, name: p.name, scenes: Object.keys(p.N).length }; } catch { return { dir, name: path.basename(dir), scenes: 0 }; } })));
ipcMain.handle("project:pick", wrap(async () => {
  const r = await dialog.showOpenDialog(win, { title: "选择游戏文件夹（里面有 index.html）", properties: ["openDirectory"] }); refocus();
  if (r.canceled || !r.filePaths[0]) return null;
  const dir = r.filePaths[0]; if (!core.isProject(dir)) throw new Error("这个文件夹里没有可识别的游戏 index.html（需要包含 const N= 剧本数据）");
  return dir;
}));
ipcMain.handle("project:load", wrap(dir => { const p = core.loadProject(dir); pushRecent(dir); win.setTitle(`${p.name} — 影游剪辑台`); return p; }));
ipcMain.handle("project:files", wrap(dir => core.listFiles(dir)));
ipcMain.handle("project:save", wrap((dir, data) => core.saveProject(dir, data)));
ipcMain.handle("asset:replace", wrap((dir, rel, src) => core.replaceAsset(dir, rel, src, nativeImage)));
ipcMain.handle("asset:pick", wrap(async (kind) => {
  const filters = kind === "video" ? [{ name: "视频", extensions: ["mp4", "webm", "mov"] }] : kind === "audio" ? [{ name: "音频", extensions: ["mp3", "wav", "m4a", "ogg"] }]
    : kind === "image" ? [{ name: "图片", extensions: ["jpg", "jpeg", "png", "webp"] }] : [{ name: "素材", extensions: ["jpg", "jpeg", "png", "webp", "mp4", "webm", "mov", "mp3", "wav", "m4a", "ogg"] }];
  const r = await dialog.showOpenDialog(win, { title: "选择素材", properties: kind === "multi" ? ["openFile", "multiSelections"] : ["openFile"], filters }); refocus();
  return r.canceled ? null : r.filePaths;
}));
ipcMain.handle("asset:import", wrap((dir, paths) => core.importFiles(dir, paths)));
ipcMain.handle("asset:read", wrap((dir, rel) => new Uint8Array(core.readAsset(dir, rel))));
ipcMain.handle("asset:write", wrap((dir, rel, bytes) => core.writeAsset(dir, rel, bytes)));
ipcMain.handle("game:export", wrap((dir, name) => core.exportGame(dir, name)));
ipcMain.handle("file:saveText", wrap(async (name, text) => {
  const r = await dialog.showSaveDialog(win, { defaultPath: name }); refocus(); if (r.canceled) return null;
  fs.writeFileSync(r.filePath, text, "utf8"); return r.filePath;
}));
ipcMain.handle("shell:reveal", wrap(p => shell.showItemInFolder(p)));
ipcMain.handle("shell:open", wrap(async p => {          // 只用来打开 2.5D 参数文件（motion_ref\scenes\*.json）
  const f = path.resolve(p); if (!/[\\/]motion_ref[\\/]scenes[\\/][^\\/]+\.json$/i.test(f)) throw new Error("不能打开这个文件");
  if (!fs.existsSync(f)) throw new Error("还没有参数文件"); const e = await shell.openPath(f); if (e) throw new Error(e); return true; }));
/* ---- 图片右键：复制图片、复制路径、另存为（src 是界面里的 file:// 地址） ---- */
function imgPath(src) {
  if (!/^file:/i.test(src || "")) throw new Error("这张图不是本地文件");
  const p = fileURLToPath(String(src).split("?")[0]);
  if (!fs.existsSync(p)) throw new Error("找不到这张图的文件：" + p);
  return p;
}
ipcMain.handle("img:path", wrap(src => imgPath(src)));
ipcMain.handle("img:copy", wrap(src => { const img = nativeImage.createFromPath(imgPath(src)); if (img.isEmpty()) throw new Error("读不了这张图"); clipboard.writeImage(img); return true; }));
ipcMain.handle("img:copyText", wrap(t => { clipboard.writeText(String(t)); return true; }));
ipcMain.handle("img:saveAs", wrap(async src => {
  const p = imgPath(src), r = await dialog.showSaveDialog(win, { defaultPath: path.basename(p), filters: [{ name: "图片", extensions: [path.extname(p).slice(1) || "png"] }] }); refocus();
  if (r.canceled || !r.filePath) return null; fs.copyFileSync(p, r.filePath); return r.filePath;
}));
ipcMain.handle("app:close", wrap(() => { win.__forceClose = true; win.close(); }));
ipcMain.handle("app:confirm", wrap(async (msg, buttons) => {
  const r = (await dialog.showMessageBox(win, { type: "question", message: msg, buttons: buttons || ["确定", "取消"], cancelId: (buttons || [0, 1]).length - 1, defaultId: 0 })).response;
  refocus(); return r;
}));
// 对话框关掉后把键盘焦点还给页面：Windows 上弹框之后输入框有时打不了字（Electron 的老问题），blur 再 focus 一次就恢复
function refocus() { try { if (win && !win.isDestroyed()) { win.blur(); win.focus(); win.webContents.focus(); } } catch (e) {} }
ipcMain.handle("app:refocus", wrap(async () => { refocus(); return true; }));

/* ---- 分镜：读写分镜表、调用出图/修图脚本（storyboard\\batch.py、refine.py、fix_box.py） ---- */
ipcMain.handle("sb:load", wrap(dir => core.sbLoad(dir)));
ipcMain.handle("sb:saveShot", wrap((dir, shot) => core.sbSaveShot(dir, shot)));
ipcMain.handle("refs:load", wrap(dir => core.refsLoad(dir)));
const voiceRefsStore = require("./voice-refs-store");
ipcMain.handle("voiceRefs:load", wrap(dir => voiceRefsStore.load(dir)));
ipcMain.handle("voiceRefs:save", wrap((dir, entry) => voiceRefsStore.save(dir, entry)));
ipcMain.handle("voiceRefs:import", wrap((dir, id, src) => voiceRefsStore.importAudio(dir, id, src)));
ipcMain.handle("voiceRefs:generate", wrap((dir, id, action, text) => require("./voice-clone-service").generate(dir, id, action, text, pythonCmd())));
ipcMain.handle("refs:save", wrap((dir, entry) => core.refsSave(dir, entry)));
ipcMain.handle("refs:import", wrap((dir, id, src) => core.refsImport(dir, id, src, nativeImage)));
ipcMain.handle("sb:review", wrap((dir, sid, ok, note, mtime, extra) => core.sbReview(dir, sid, ok, note, mtime, extra)));
ipcMain.handle("sb:reviewMany", wrap((dir, entries) => core.sbReviewMany(dir, entries)));
ipcMain.handle("sketch:write", wrap((dir, rel, data, isB64) => core.sketchWrite(dir, rel, data, isB64)));
ipcMain.handle("sketch:read", wrap((dir, rel) => core.sketchRead(dir, rel)));
ipcMain.handle("vs:load", wrap(dir => core.vsLoad(dir)));
ipcMain.handle("vs:save", wrap((dir, id, patch) => core.vsSave(dir, id, patch)));
ipcMain.handle("vs:add", wrap((dir, list) => core.vsAdd(dir, list)));
ipcMain.handle("vs:del", wrap((dir, id) => core.vsDel(dir, id)));
ipcMain.handle("sb:refUrl", wrap((dir, rel) => core.refPath(dir, rel)));
function pythonCmd() {
  const c = [];
  if (process.env.YINGYOU_PYTHON) c.push(process.env.YINGYOU_PYTHON);
  if (process.env.USERPROFILE) c.push(path.join(process.env.USERPROFILE, "anaconda3", "python.exe"));
  c.push(process.platform === "win32" ? "python" : "python3");
  return c.find(p => !p.includes(path.sep) || fs.existsSync(p));
}
const jobs = new Map(); let jobSeq = 0; const MAX_JOBS = 4;   // 几个出图 / 修图任务可以同时跑（脚本写记录时会合并，不会互相覆盖）
ipcMain.handle("tool:run", wrap((dir, script, args) => {
  if (jobs.size >= MAX_JOBS) throw new Error(`已经有 ${jobs.size} 个任务在跑，等一个结束再开新的`);
  const AF = ["autofix.py", "video_shots.py", "write_vprompts.py", "motion_sketch.py", "durations.py", "draft_video.py"];   // 视频脚本在 moban_art\autofix\ 里
  if (![...["batch.py", "refine.py", "fix_box.py", "ref_tool.py", "continuity.py", "sketch_ai.py"], ...AF].includes(script)) throw new Error("不认识的脚本");
  const cwd = AF.includes(script) ? path.join(dir, "..", "autofix") : core.sbDir(dir), py = pythonCmd();
  if (!fs.existsSync(path.join(cwd, script))) throw new Error("没找到 " + path.join(cwd, script));
  const id = ++jobSeq, p = spawn(py, ["-u", script, ...args.map(String)], { cwd, env: { ...process.env, PYTHONIOENCODING: "utf-8" }, windowsHide: true });
  jobs.set(id, p);
  const fwd = d => send("tool:log", { id, text: d.toString("utf8") });
  p.stdout.on("data", fwd); p.stderr.on("data", fwd);
  p.on("error", e => { send("tool:log", { id, text: "启动失败：" + e.message + "（找不到 Python？可以设置环境变量 YINGYOU_PYTHON 指向 python.exe）\n" }); });
  p.on("close", code => { jobs.delete(id); send("tool:done", { id, code }); });
  return { id, cmd: `${py} ${script} ${args.join(" ")}` };
}));
ipcMain.handle("tool:stop", wrap(id => { const p = jobs.get(id); if (p) { p.kill(); return true; } return false; }));

app.whenReady().then(() => { buildMenu(); createWindow(); });
app.on("window-all-closed", () => app.quit());
