# 影游视频质检：免费的机器检查 + 缩略图拼版 +（可选）Gemini 复核
# 用法：python qc.py <游戏文件夹> [--only id1,id2] [--refs <参考图文件夹>] [--no-ai]
# Gemini：设置环境变量 GEMINI_API_KEY 才会调用；模型可用 GEMINI_MODEL 改（默认 gemini-3.8-flash）。不打印密钥。
import os, sys, json, base64, subprocess, time, html, urllib.request, urllib.error, argparse
import numpy as np
from PIL import Image, ImageDraw, ImageFont

import re, shutil
HERE = os.path.dirname(os.path.abspath(__file__))
def find_ffmpeg():
    p = shutil.which("ffmpeg")
    if p: return p
    try:
        import imageio_ffmpeg; return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        print("没找到 ffmpeg：请先运行 pip install imageio-ffmpeg"); sys.exit(2)
FF = find_ffmpeg()
def probe(p):
    """用 ffmpeg 自己读时长和画面尺寸（不依赖 ffprobe）"""
    err = subprocess.run([FF, "-hide_banner", "-i", p], capture_output=True, text=True, encoding="utf-8", errors="replace", stdin=subprocess.DEVNULL).stderr
    m = re.search(r"Duration: (\d+):(\d+):([\d.]+)", err); d = int(m.group(1))*3600 + int(m.group(2))*60 + float(m.group(3)) if m else 0.0
    m = re.search(r"Video:.*?(\d{2,5})x(\d{2,5})", err); wh = (int(m.group(1)), int(m.group(2))) if m else (0, 0)
    return d, wh

def run(cmd):
    return subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", stdin=subprocess.DEVNULL)

def duration(p):
    return probe(p)[0]

def frames(p, fps=4, w=320):
    """按 fps 抽灰度帧（numpy），用于运动、冻结、口型分析"""
    r = subprocess.run([FF, "-v", "error", "-nostdin", "-i", p, "-vf", f"fps={fps},scale={w}:-2,format=gray", "-f", "rawvideo", "-"],
                       capture_output=True, stdin=subprocess.DEVNULL)
    W, H = probe(p)[1]
    if not W: return []
    h = int(round(H * w / W / 2) * 2); n = len(r.stdout) // (w * h)
    return [np.frombuffer(r.stdout[i*w*h:(i+1)*w*h], np.uint8).reshape(h, w).astype(np.float32) for i in range(n)]

def detect(p, filt, key):
    r = run([FF, "-v", "info", "-nostdin", "-i", p, "-vf", filt, "-an", "-f", "null", "-"])
    tot = 0.0
    for line in r.stderr.splitlines():
        if key in line:
            try: tot += float(line.split(key)[1].split()[0])
            except Exception: pass
    return tot

def corr(a, b):
    a = np.asarray(Image.fromarray(a.astype(np.uint8)).resize((64, 36)), np.float32).ravel()
    b = np.asarray(Image.fromarray(b.astype(np.uint8)).resize((64, 36)), np.float32).ravel()
    a -= a.mean(); b -= b.mean(); d = np.sqrt((a*a).sum() * (b*b).sum())
    return float((a*b).sum() / d) if d else 0.0

def sheet(p, out, dur, n=8):
    ts = [dur * (i + .5) / n for i in range(n)]; tiles = []
    for t in ts:
        r = subprocess.run([FF, "-v", "error", "-nostdin", "-ss", f"{t:.2f}", "-i", p, "-frames:v", "1", "-vf", "scale=384:-2", "-f", "image2pipe", "-vcodec", "png", "-"],
                           capture_output=True, stdin=subprocess.DEVNULL)
        try:
            from io import BytesIO
            im = Image.open(BytesIO(r.stdout)).convert("RGB")
        except Exception:
            im = Image.new("RGB", (384, 216))
        ImageDraw.Draw(im).text((6, 4), f"{t:.1f}s", fill=(255, 220, 80))
        tiles.append(im)
    W, H = tiles[0].size; cols = 4; rows = (n + cols - 1) // cols
    canvas = Image.new("RGB", (W*cols, H*rows))
    for i, im in enumerate(tiles): canvas.paste(im.resize((W, H)), ((i % cols)*W, (i // cols)*H))
    canvas.save(out, quality=82)

def gemini(spec, rules, video, refs_dir):
    key = (os.environ.get("GEMINI_API_KEY") or "").strip()
    if not key: return None
    model = os.environ.get("GEMINI_MODEL", "gemini-3.8-flash")
    parts = []
    ref_names = []
    for r in spec.get("refs", [])[:4]:
        rp = os.path.join(refs_dir, r + ".png")
        if os.path.exists(rp):
            im = Image.open(rp).convert("RGB"); im.thumbnail((640, 640))
            from io import BytesIO
            b = BytesIO(); im.save(b, "JPEG", quality=80)
            parts.append({"inline_data": {"mime_type": "image/jpeg", "data": base64.b64encode(b.getvalue()).decode()}}); ref_names.append(r)
    data = open(video, "rb").read()
    if len(data) > 15 * 1024 * 1024: return {"error": "视频太大，跳过 AI 检查"}
    parts.append({"inline_data": {"mime_type": "video/mp4", "data": base64.b64encode(data).decode()}, "video_metadata": {"fps": 3}})
    speak = "、".join(spec["speakers"]) if spec["speakers"] else "（无）"
    prompt = f"""你是互动影游的视频质检员。前面 {len(ref_names)} 张图是参考设定图（依次是：{', '.join(ref_names) or '无'}），最后是一段 AI 生成的视频。
请严格检查这段视频是否满足要求，只输出 JSON。

这一镜头应该是：{spec['describe']}
画面设定：{spec.get('img_prompt','')}
这一场有台词的人物：{speak}（{'需要看到说话的人嘴巴一开一合' if spec['need_mouth'] else '不需要说话'}）
全局规则：
- """ + "\n- ".join(rules) + """

输出格式：
{"pass": true/false, "score": 0-10,
 "issues": [{"type": "人物一致|左右舵|年代穿帮|口型|变形|文字水印|与描述不符|画面质量|其他", "severity": "高|中|低", "time": "大约第几秒", "detail": "具体看到了什么"}],
 "fix_prompt": "如果不通过，给出改写后的中文视频提示词（保持原意，针对问题改；说话的人必须写明张嘴、嘴唇一开一合）"}
只要有一条「高」严重度问题就 pass=false。"""
    parts.append({"text": prompt})
    body = {"contents": [{"parts": parts}], "generationConfig": {"responseMimeType": "application/json", "temperature": 0.2}}
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
    for attempt in range(3):
        req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST", headers={"x-goog-api-key": key, "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=240) as r: js = json.loads(r.read())
            txt = js["candidates"][0]["content"]["parts"][0]["text"]
            return json.loads(txt)
        except urllib.error.HTTPError as e:
            msg = e.read().decode("utf-8", "replace")[:300]
            if e.code in (429, 500, 503): time.sleep(8 * (attempt + 1)); continue
            return {"error": f"HTTP {e.code} {msg}"}
        except Exception as e:
            err = str(e)[:300]; time.sleep(3)
    return {"error": err if 'err' in dir() else "失败"}

def check(spec, game, outdir, refs_dir, use_ai):
    p = os.path.join(game, spec["video"]); res = {"id": spec["id"], "issues": [], "level": "ok"}
    def flag(lv, msg):
        res["issues"].append([lv, msg])
        if lv == "bad" or (lv == "warn" and res["level"] == "ok"): res["level"] = lv
    if not os.path.exists(p): flag("bad", "视频文件不存在"); return res
    d = duration(p); res["duration"] = round(d, 2)
    if d < 3: flag("bad", f"时长只有 {d:.1f} 秒")
    blk = detect(p, "blackdetect=d=0.4:pix_th=0.08", "black_duration:")
    if blk > 0.4: flag("warn", f"有 {blk:.1f} 秒黑屏")
    frz = detect(p, "freezedetect=n=0.003:d=2", "lavfi.freezedetect.freeze_duration:")
    if frz > 2: flag("warn", f"画面静止 {frz:.1f} 秒")
    fr = frames(p, fps=4)
    if fr:
        motion = float(np.mean([abs(fr[i] - fr[i-1]).mean() for i in range(1, len(fr))])); res["motion"] = round(motion, 2)
        if motion < 0.6: flag("warn", f"几乎不动（运动量 {motion:.2f}）")
        drift = corr(fr[0], fr[-1]); res["first_last_corr"] = round(drift, 2)
        # 镜头推拉、转头都会让首尾差别大，这个数只记录不报警
        kf = os.path.join(game, spec["keyframe"])
        if os.path.exists(kf):
            k = np.asarray(Image.open(kf).convert("L").resize((fr[0].shape[1], fr[0].shape[0])), np.float32)
            c = corr(k, fr[0]); res["keyframe_corr"] = round(c, 2)
            if c < 0.45: flag("warn", f"首帧和关键帧不像（相似度 {c:.2f}）")
    # 口型：传统人脸检测在 AI 视频上分不清「说话」和「晃头」，实测不可靠，交给 AI 复核判断
    sp = os.path.join(outdir, "sheets", spec["id"] + ".jpg"); sheet(p, sp, d); res["sheet"] = "sheets/" + spec["id"] + ".jpg"
    if use_ai:
        g = gemini(spec, RULES, p, refs_dir)
        if g is not None:
            res["gemini"] = g
            try:  # 改写提示词里去掉会触发 MiniMax 审核的词
                sys.path.insert(0, os.path.join(HERE, "..", "autofix")); from sanitize import clean
                if g.get("fix_prompt"): g["fix_prompt"] = clean(g["fix_prompt"])
            except Exception: pass
            if "error" in g: flag("warn", "Gemini 检查失败：" + g["error"])
            elif not g.get("pass", True): flag("bad", "Gemini 判定不通过：" + "；".join(i.get("detail", "") for i in g.get("issues", []) if i.get("severity") == "高") )
    return res

def report_html(results, outdir):
    col = {"ok": "#3c9", "warn": "#e8b04a", "bad": "#e5574d"}; name = {"ok": "通过", "warn": "需要看一眼", "bad": "不通过"}
    rows = []
    for r in results:
        g = r.get("gemini") or {}
        gi = "" if not g else (f"<b>Gemini：{'通过' if g.get('pass') else '不通过'} {g.get('score','')}/10</b><ul>" + "".join(f"<li>[{html.escape(str(i.get('severity','')))}] {html.escape(str(i.get('type','')))}：{html.escape(str(i.get('detail','')))}</li>" for i in g.get("issues", [])) + "</ul>" + (f"<p><b>建议提示词：</b>{html.escape(g['fix_prompt'])}</p>" if g.get('fix_prompt') and not g.get('pass') else "") if "error" not in g else html.escape(g["error"]))
        rows.append(f"""<tr><td><b>{r['id']}</b><br><span style="color:{col[r['level']]}">● {name[r['level']]}</span><br><small>{r.get('duration','')}s · 运动 {r.get('motion','-')} · 首帧相似 {r.get('keyframe_corr','-')}</small></td>
<td>{''.join(f'<div style="color:{col[l]}">{html.escape(m)}</div>' for l, m in r['issues']) or '—'}{gi}</td>
<td>{f'<img src="{r["sheet"]}" width="560">' if r.get('sheet') else ''}</td></tr>""")
    t = f"""<!doctype html><meta charset="utf-8"><title>视频质检报告</title><style>body{{font:14px/1.6 "Microsoft YaHei",sans-serif;background:#16171a;color:#e6e2da;padding:20px}}table{{border-collapse:collapse;width:100%}}td{{border-bottom:1px solid #333;padding:10px;vertical-align:top}}small{{color:#999}}ul{{margin:4px 0;padding-left:18px}}</style>
<h2>视频质检报告 · {time.strftime('%Y-%m-%d %H:%M')}</h2><p>{sum(r['level']=='ok' for r in results)} 通过 · {sum(r['level']=='warn' for r in results)} 需要看一眼 · {sum(r['level']=='bad' for r in results)} 不通过</p><table>{''.join(rows)}</table>"""
    open(os.path.join(outdir, "report.html"), "w", encoding="utf-8").write(t)

if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("game"); ap.add_argument("--only", default=""); ap.add_argument("--refs", default=os.path.join(HERE, "..", "refs")); ap.add_argument("--no-ai", action="store_true")
    a = ap.parse_args()
    spec = json.load(open(os.path.join(HERE, "specs.json"), encoding="utf-8")); RULES = spec["rules"]
    try:   # 2026-11-01 起质检标准（describe）以视频分镜表为准，在剪辑台「③ 视频提示词」里改
        _vs = {x["id"]: x for x in json.load(open(os.path.join(HERE, "..", "autofix", "video_shots.json"), encoding="utf-8"))["shots"]}
        for s in spec["shots"]:
            if s["id"] in _vs and _vs[s["id"]].get("describe"): s["describe"] = _vs[s["id"]]["describe"]
    except Exception: pass
    only = set(x for x in a.only.split(",") if x)
    outdir = os.path.join(HERE, "out"); os.makedirs(os.path.join(outdir, "sheets"), exist_ok=True)
    use_ai = not a.no_ai and bool(os.environ.get("GEMINI_API_KEY"))
    print("Gemini 复核：" + ("开" if use_ai else "关（没设 GEMINI_API_KEY 或加了 --no-ai）"), flush=True)
    results = []
    for s in spec["shots"]:
        if only and s["id"] not in only: continue
        r = check(s, a.game, outdir, a.refs, use_ai); results.append(r)
        print(f"{r['level']:4} {s['id']:12} " + "；".join(m for _, m in r["issues"]), flush=True)
    json.dump(results, open(os.path.join(outdir, "report.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    report_html(results, outdir)
    print("报告：", os.path.join(outdir, "report.html"))
