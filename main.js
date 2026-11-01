// 影游剪辑台 · Electron 主进程
const { app, BrowserWindow, ipcMain, dialog, Menu, shell, nativeImage } = require("electron");
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
  const r = await dialog.showOpenDialog(win, { title: "选择游戏文件夹（里面有 index.html）", properties: ["openDirectory"] });
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
  const r = await dialog.showOpenDialog(win, { title: "选择素材", properties: kind === "multi" ? ["openFile", "multiSelections"] : ["openFile"], filters });
  return r.canceled ? null : r.filePaths;
}));
ipcMain.handle("asset:import", wrap((dir, paths) => core.importFiles(dir, paths)));
ipcMain.handle("asset:read", wrap((dir, rel) => new Uint8Array(core.readAsset(dir, rel))));
ipcMain.handle("asset:write", wrap((dir, rel, bytes) => core.writeAsset(dir, rel, bytes)));
ipcMain.handle("game:export", wrap((dir, name) => core.exportGame(dir, name)));
ipcMain.handle("file:saveText", wrap(async (name, text) => {
  const r = await dialog.showSaveDialog(win, { defaultPath: name }); if (r.canceled) return null;
  fs.writeFileSync(r.filePath, text, "utf8"); return r.filePath;
}));
ipcMain.handle("shell:reveal", wrap(p => shell.showItemInFolder(p)));
ipcMain.handle("app:close", wrap(() => { win.__forceClose = true; win.close(); }));
ipcMain.handle("app:confirm", wrap(async (msg, buttons) => (await dialog.showMessageBox(win, { type: "question", message: msg, buttons: buttons || ["确定", "取消"], cancelId: (buttons || [0, 1]).length - 1, defaultId: 0 })).response));

/* ---- 分镜：读写分镜表、调用出图/修图脚本（storyboard\\batch.py、refine.py、fix_box.py） ---- */
ipcMain.handle("sb:load", wrap(dir => core.sbLoad(dir)));
ipcMain.handle("sb:saveShot", wrap((dir, shot) => core.sbSaveShot(dir, shot)));
ipcMain.handle("refs:load", wrap(dir => core.refsLoad(dir)));
ipcMain.handle("refs:save", wrap((dir, entry) => core.refsSave(dir, entry)));
ipcMain.handle("refs:import", wrap((dir, id, src) => core.refsImport(dir, id, src, nativeImage)));
ipcMain.handle("sb:review", wrap((dir, sid, ok, note, mtime) => core.sbReview(dir, sid, ok, note, mtime)));
ipcMain.handle("sb:refUrl", wrap((dir, rel) => core.refPath(dir, rel)));
let job = null;
function pythonCmd() {
  const c = [];
  if (process.env.YINGYOU_PYTHON) c.push(process.env.YINGYOU_PYTHON);
  if (process.env.USERPROFILE) c.push(path.join(process.env.USERPROFILE, "anaconda3", "python.exe"));
  c.push(process.platform === "win32" ? "python" : "python3");
  return c.find(p => !p.includes(path.sep) || fs.existsSync(p));
}
ipcMain.handle("tool:run", wrap((dir, script, args) => {
  if (job) throw new Error("已经有一个出图任务在跑，等它结束或先停止");
  if (!["batch.py", "refine.py", "fix_box.py", "ref_tool.py"].includes(script)) throw new Error("不认识的脚本");
  const cwd = core.sbDir(dir), py = pythonCmd();
  if (!fs.existsSync(path.join(cwd, script))) throw new Error("没找到 " + path.join(cwd, script));
  job = spawn(py, ["-u", script, ...args.map(String)], { cwd, env: { ...process.env, PYTHONIOENCODING: "utf-8" }, windowsHide: true });
  const fwd = d => send("tool:log", d.toString("utf8"));
  job.stdout.on("data", fwd); job.stderr.on("data", fwd);
  job.on("error", e => { send("tool:log", "启动失败：" + e.message + "（找不到 Python？可以设置环境变量 YINGYOU_PYTHON 指向 python.exe）\n"); });
  job.on("close", code => { job = null; send("tool:done", code); });
  return { cmd: `${py} ${script} ${args.join(" ")}` };
}));
ipcMain.handle("tool:stop", wrap(() => { if (job) { job.kill(); return true; } return false; }));

app.whenReady().then(() => { buildMenu(); createWindow(); });
app.on("window-all-closed", () => app.quit());
