/* 成片卡片中的本地视频替换：只替换当前镜头，旧文件由现有素材接口备份。 */
"use strict";
function localVideoBox(s) {
  return `<div class="rvact fin-local" data-local-video><button class="ghost" data-local-pick title="选择或拖入本地 MP4，替换当前成片；原片自动备份，配音和剪辑设置保留">更换本地视频…</button><button class="ghost" data-local-candidate>加入本地候选…</button><div class="fin-local-note dim" role="status"></div></div>`;
}
async function useLocalVideo(source, s, k, box) {
  if (!source) return;
  const msg = box.querySelector(".fin-local-note"), button = box.querySelector("[data-local-pick]");
  if (box.dataset.busy) return;
  if (!/\.mp4$/i.test(source)) { msg.textContent = "请选择 MP4 视频，其他格式请先转为 MP4。"; return; }
  const rel = finRel(s);
  if (source.replace(/\\/g, "/").toLowerCase() === absPath(rel).replace(/\\/g, "/").toLowerCase()) {
    msg.textContent = "这个文件已经是当前成片，请选择另一个视频。"; return;
  }
  finStop();
  if (await S.confirm(`用所选本地视频替换 ${s.id} 的成片？\n${source}\n\n目标：${rel}\n原成片会自动备份，配音和剪辑设置保留。`, ["替换成片", "取消"]) !== 0) return;
  box.dataset.busy = "1"; button.disabled = true; msg.textContent = "正在替换…";
  try {
    const result = await S.replace(P.dir, rel, source);
    await refreshFiles();
    if (RV) { RV.fsel = RV.fsel || {}; RV.fsel[s.id] = 0; }
    renderAll(false); reloadPreview();
    if (RV && RV.kind === "final") { rvUpdateCard(k); rvCounts(); }
    toast("已替换本地视频，待重新确认" + (result.backup ? "；原片已备份：" + result.backup : ""));
  } catch (error) { msg.textContent = "替换失败：" + error.message; toast(msg.textContent, true); }
  finally { delete box.dataset.busy; button.disabled = false; }
}
function finalLocalCandidates(s) {
  const suffix = "__" + finRel(s).replaceAll("/", "__").toLowerCase();
  const imports = Object.entries(P.sb?.review || {}).filter(([key, item]) =>
    key.startsWith("local-video:") && item?.shot === s.id &&
    /^_studio\/inbox\/[^/\\]+\.mp4$/i.test(item.file) && has(item.file))
    .map(([, item]) => ({ label: "本地候选 · " + item.file.split("/").pop(), short: "本地候选", src: item.file }));
  const backups = Object.keys(P.files).filter(file =>
    file.startsWith("_studio/backup/") && file.toLowerCase().endsWith(suffix)).sort().reverse()
    .map(file => ({ label: "本地备份 · " + file.split("/").pop().split("__")[0], short: "本地备份", src: file }));
  return [...imports, ...backups];
}

function bindLocalVideo(card, s, k) {
  const box = card.querySelector("[data-local-video]"); if (!box) return;
  box.addEventListener("click", e => e.stopPropagation());
  box.querySelector("[data-local-pick]").onclick = async () => {
    try { const paths = await S.pickAsset("video"); if (paths && paths[0]) await useLocalVideo(paths[0], s, k, box); }
    catch (error) { box.querySelector(".fin-local-note").textContent = error.message; }
  };
  const candidateButton = box.querySelector("[data-local-candidate]");
  candidateButton.onclick = async () => {
    const project = P, review = RV;
    if (box.dataset.busy) return;
    box.dataset.busy = "1"; candidateButton.disabled = true;
    try {
      const paths = await S.pickAsset("video");
      if (P !== project || !paths?.[0]) return;
      if (!/\.mp4$/i.test(paths[0])) throw new Error("请选择 MP4 视频");
      const [file] = await S.importFiles(project.dir, [paths[0]]);
      const saved = await S.sbReviewMany(project.dir, { ["local-video:" + file]: { shot: s.id, file } });
      if (P !== project) return;
      P.sb = saved;
      await refreshFiles();
      if (P !== project || RV !== review || RV?.kind !== "final") return;
      const index = RV.items.findIndex(item => item.vid === s.id);
      if (index < 0) return;
      RV.fsel = RV.fsel || {};
      RV.fsel[s.id] = finCands(s).findIndex(item => item.src === file);
      rvUpdateCard(index);
      toast("已加入本地候选，可试听后点「用作成片」");
    } catch (error) { toast(error.message, true); }
    finally { delete box.dataset.busy; candidateButton.disabled = false; }
  };
  box.ondragover = e => { e.preventDefault(); e.stopPropagation(); box.classList.add("drag-over"); };
  box.ondragleave = () => box.classList.remove("drag-over");
  box.ondrop = async e => {
    e.preventDefault(); e.stopPropagation(); box.classList.remove("drag-over");
    const files = [...e.dataTransfer.files];
    if (files.length !== 1) { box.querySelector(".fin-local-note").textContent = "每次请只拖入一个视频。"; return; }
    try { await useLocalVideo(S.filePath(files[0]), s, k, box); }
    catch (error) { box.querySelector(".fin-local-note").textContent = error.message; }
  };
}
