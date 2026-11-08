"""2.5D 预演：把首帧图变成有深度的场景，人 / 车抠成卡片在地上走，镜头、光照、颜色、雪都按参数来，用 Blender 渲染成参考视频。
不需要显卡，不花钱，同样的参数每次结果一样。

用法：python scene25d.py <场景名> [--draft]
  场景名：scenes\\<场景名>.json 里写参数（没有就按视频提示词自动生成一份，之后可以改了再跑）。
          一个镜头可以有几个版本，比如 start.json、start_car.json，用 "sid" 指明是哪个镜头的首帧。
  --draft：做完顺便放进游戏的草稿视频（moban_game\\vid_draft\\…），剪辑台预览选「草稿」就能看。
输出：out\\<场景名>_25d.mp4，中间文件（深度图、抠出来的卡片、补过的背景）也在 out\\ 里。

参数（scenes\\<场景名>.json）：
  "sid": "start",                        用哪个镜头的首帧
  "duration": 6, "fps": 15, "size": [640, 360], "hfov": 50,
  "depth": {"near": 2, "far": 40},        画面里最近 / 最远大约多少米（只影响前后景错位的强弱）
  "camera": {"move": "push_in", "amount": 0.3, "start": 0, "end": 6}
            move：static / push_in / pull_out / orbit_left / orbit_right / pan_left / pan_right / tilt_up / tilt_down / crane_up / crane_down / breath
  "look": {"exposure": 1.0, "tint": [1, 1, 1], "flash": {"colors": [[1,.35,.35],[.4,.5,1]], "hz": 1.5, "amount": 0.25}}
  "snow": {"count": 500, "speed": 0.6, "wind": 0.1, "size": 1}
  "cards": [{"label": "女人", "box": [x0, y0, x1, y1], "keys": [[秒, 脚底x, 脚底y], ...]}]
            box：首帧上这个人 / 车所在的框（0～1）；keys：脚底（框的底边中点）在画面上走到哪，深度按地面自动算，越远越小；
            想指定深度就写成 [秒, x, y, 米]。
  "boxes": [{"label": "皮箱", "size": [0.45, 0.15, 0.32], "keys": [[秒, x, y, 米, 转角度], ...]}]   灰模道具
  "arms": "auto"                          用 autofix\\test_motion\\<sid>\\motion.json 里名字带「手」的路线（手绘动作或轨迹测试标的），生成灰色手臂
"""
import os, sys, json, math, glob, shutil, subprocess, hashlib, time

HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
GAME = os.path.join(ROOT, "moban_game"); OUT = os.path.join(HERE, "out"); SCN = os.path.join(HERE, "scenes")
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter


def font(sz):
    for n in ("msyhbd.ttc", "msyh.ttc", "simhei.ttf", "NotoSansCJK-Bold.ttc", "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc", "DejaVuSans.ttf"):
        try: return ImageFont.truetype(n, sz)
        except Exception: pass
    return ImageFont.load_default()


def ffmpeg():
    p = shutil.which("ffmpeg")
    if p: return p
    import imageio_ffmpeg; return imageio_ffmpeg.get_ffmpeg_exe()


def keyframe(sid):
    for p in (f"img/{sid}.jpg", f"img/l/{sid}.jpg"):
        if os.path.exists(os.path.join(GAME, p)): return os.path.join(GAME, p)
    return None


def find_blender():
    """Blender 在哪：环境变量 BLENDER_EXE → Windows 默认安装位置（选版本最新的）→ PATH → 当前 Python 能 import bpy 就直接用它。"""
    e = os.environ.get("BLENDER_EXE", "").strip('" ')
    if e and os.path.exists(e): return [e, "-b", "--factory-startup", "-P"]
    bp = os.path.join(HERE, "blender_path.txt")              # 解压版 / 装在别处：把 blender.exe 的完整路径写在这个文件里
    if os.path.exists(bp):
        e = open(bp, encoding="utf-8-sig").read().strip().strip('"')
        if os.path.isdir(e): e = os.path.join(e, "blender.exe")
        if os.path.exists(e): return [e, "-b", "--factory-startup", "-P"]
        print(f"blender_path.txt 里写的路径不存在：{e}", flush=True)
    cands = []
    home = os.environ.get("USERPROFILE", "")
    for sub in ("Downloads", "Desktop", "Documents"):         # 解压版常放的地方（往下找三层）
        if home: cands += glob.glob(os.path.join(home, sub, "*", "blender.exe")) + glob.glob(os.path.join(home, sub, "*", "*", "blender.exe")) + glob.glob(os.path.join(home, sub, "*", "*", "*", "blender.exe"))
    for base in (os.environ.get("ProgramFiles", r"C:\Program Files"), os.environ.get("ProgramFiles(x86)", ""), os.path.join(os.environ.get("LOCALAPPDATA", ""), "Programs")):
        if base: cands += glob.glob(os.path.join(base, "Blender Foundation", "Blender*", "blender.exe"))
    cands += glob.glob(r"C:\Program Files (x86)\Steam\steamapps\common\Blender\blender.exe")
    if cands:
        def ver(p):
            import re; m = re.search(r"[Bb]lender[\s-]*(\d+(?:\.\d+)*)", p); return [int(x) for x in m.group(1).split(".") if x] if m else [0]
        return [sorted(cands, key=ver)[-1], "-b", "--factory-startup", "-P"]
    w = shutil.which("blender")
    if w: return [w, "-b", "--factory-startup", "-P"]
    try:
        import importlib.util
        if importlib.util.find_spec("bpy"): return [sys.executable]
    except Exception: pass
    return None


# ---------------- 参数 ----------------
def camera_of(prompt):
    import re
    for pat, mv in ((r"拉远|后拉", "pull_out"), (r"推近|推进|拉近|缓推|慢推|微推", "push_in"), (r"向?左摇", "pan_left"), (r"向?右摇", "pan_right"), (r"上摇", "tilt_up"), (r"下摇", "tilt_down"), (r"环绕", "orbit_left")):
        if re.search(pat, prompt or ""): return mv
    return "breath"


def default_spec(name):
    sid = name
    try:
        sys.path.insert(0, os.path.join(ROOT, "autofix")); import video_shots as VS
        s = VS.load()[1].get(sid, {})
    except Exception: s = {}
    p = s.get("prompt") or ""; dur = float(s.get("duration") or 6)
    spec = {"sid": sid, "duration": dur, "fps": 15, "size": [640, 360], "hfov": 50, "depth": {"near": 1.0 if "车内" in p or "车里" in p else 2.0, "far": 40},
            "camera": {"move": camera_of(p), "amount": 0.3, "start": 0, "end": dur},
            "look": {"exposure": 1.0, "tint": [1, 1, 1]}, "snow": {"count": 450, "speed": .6, "wind": .1} if "雪" in p else {}, "cards": [], "boxes": [], "arms": "auto",
            "_说明": "自动按视频提示词生成的，改完重新跑 scene25d.py。参数说明见 scene25d.py 开头。"}
    if "警灯" in p or "红蓝" in p: spec["look"]["flash"] = {"colors": [[1, .35, .35], [.4, .5, 1]], "hz": 1.5, "amount": .22}
    return spec


def load_spec(name):
    os.makedirs(SCN, exist_ok=True); p = os.path.join(SCN, name + ".json")
    if os.path.exists(p): return json.load(open(p, encoding="utf-8")), p
    sp = default_spec(name); json.dump(sp, open(p, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print("还没有参数文件，按视频提示词生成了一份：" + p, flush=True); return sp, p


# ---------------- 抠卡片、补背景 ----------------
def cut_cards(img, cards, tag):
    """每张卡片：框里用 GrabCut 抠出前景（带透明），原图上那块用周围颜色补掉（OpenCV inpaint）。返回补好的背景和卡片文件。"""
    W, H = img.size; arr = np.array(img); hole = np.zeros((H, W), np.uint8); out = []
    try: import cv2
    except ImportError: cv2 = None
    for k, c in enumerate(cards):
        x0, y0, x1, y1 = [int(round(v * s)) for v, s in zip(c["box"], (W, H, W, H))]
        x0, y0, x1, y1 = max(0, x0), max(0, y0), min(W, x1), min(H, y1)
        if cv2 is not None:
            mask = np.zeros((H, W), np.uint8); bgd = np.zeros((1, 65), np.float64); fgd = np.zeros((1, 65), np.float64)
            try:
                cv2.grabCut(cv2.cvtColor(arr, cv2.COLOR_RGB2BGR), mask, (x0, y0, max(2, x1 - x0), max(2, y1 - y0)), bgd, fgd, 4, cv2.GC_INIT_WITH_RECT)
                fg = np.where((mask == 1) | (mask == 3), 255, 0).astype(np.uint8)
            except Exception: fg = np.zeros((H, W), np.uint8); fg[y0:y1, x0:x1] = 255
        else: fg = np.zeros((H, W), np.uint8); fg[y0:y1, x0:x1] = 255
        a = Image.fromarray(fg).filter(ImageFilter.MaxFilter(3)).filter(ImageFilter.GaussianBlur(1.2))
        rgba = img.convert("RGBA"); rgba.putalpha(a); crop = rgba.crop((x0, y0, x1, y1))
        p = os.path.join(OUT, f"{tag}_card{k}.png"); crop.save(p); out.append(p)
        hole = np.maximum(hole, np.array(Image.fromarray(fg).filter(ImageFilter.MaxFilter(15))))
        c["box"] = [x0 / W, y0 / H, x1 / W, y1 / H]
    bg = fill_hole(img, hole) if hole.any() else img
    return bg, out


def fill_hole(img, hole):
    """补掉抠走的人 / 车：从粗到细用周围颜色做「归一化模糊」填进去（比 OpenCV inpaint 拉出来的长条自然），再加一点颗粒。
    只是参考视频的背景；要干净的背景可以先用剪辑台的框选修图把人 / 车去掉，再把那张图当首帧。"""
    a = np.asarray(img, np.float32); m = (hole > 0).astype(np.float32); valid = 1 - m; out = a.copy(); H, W = m.shape
    for s in (96, 48, 24, 12, 6):
        k = int(s * 2) | 1
        try:
            import cv2
            num = cv2.GaussianBlur(a * valid[..., None], (k, k), s); den = cv2.GaussianBlur(valid, (k, k), s)[..., None]
        except ImportError:
            num = np.asarray(Image.fromarray(np.uint8(np.clip(a * valid[..., None], 0, 255))).filter(ImageFilter.GaussianBlur(s)), np.float32)
            den = np.asarray(Image.fromarray(np.uint8(valid * 255)).filter(ImageFilter.GaussianBlur(s)), np.float32)[..., None] / 255
        fill = num / np.maximum(den, 1e-3); ok = (den[..., 0] > .02) & (m > 0)
        out[ok] = fill[ok]; a = np.where(m[..., None] > 0, out, a); valid = np.maximum(valid, (den[..., 0] > .2).astype(np.float32) * m * .0)
    out = np.where(m[..., None] > 0, out + np.random.default_rng(1).normal(0, 4, out.shape), a)
    feather = np.asarray(Image.fromarray(np.uint8(m * 255)).filter(ImageFilter.GaussianBlur(3)), np.float32)[..., None] / 255
    return Image.fromarray(np.uint8(np.clip(out * feather + np.asarray(img, np.float32) * (1 - feather), 0, 255)))


# ---------------- 深度 ----------------
def depth_onnx(img):
    """Depth Anything V2 Small 的 ONNX 版（onnx-community/depth-anything-v2-small，约 100MB，第一次自动下载到 HuggingFace 缓存）。
    只要 onnxruntime（约 15MB），不用 PyTorch，不和电脑上已有的 torch / numpy 版本打架。"""
    import onnxruntime as ort
    from huggingface_hub import hf_hub_download
    repo = os.environ.get("DEPTH_ONNX_REPO", "onnx-community/depth-anything-v2-small")
    mp = hf_hub_download(repo, os.environ.get("DEPTH_ONNX_FILE", "onnx/model.onnx"))
    sess = ort.InferenceSession(mp, providers=["CPUExecutionProvider"])
    W, H = img.size; s = 518 / min(W, H); w14, h14 = max(14, round(W * s / 14) * 14), max(14, round(H * s / 14) * 14)   # 短边 518、长宽都是 14 的倍数（和模型训练时一样）
    x = np.asarray(img.convert("RGB").resize((w14, h14), Image.BICUBIC), np.float32) / 255.0
    x = (x - np.array([.485, .456, .406], np.float32)) / np.array([.229, .224, .225], np.float32)
    x = x.transpose(2, 0, 1)[None].astype(np.float32)
    inp = sess.get_inputs()[0].name; d = sess.run(None, {inp: x})[0]
    d = np.asarray(d, np.float32).reshape(d.shape[-2], d.shape[-1])
    return np.asarray(Image.fromarray(d).resize((W, H), Image.BICUBIC), np.float32)


def depth_map(img, tag):
    """相对深度（越大越近，0～1）。依次试：Depth Anything V2 的 ONNX 版（onnxruntime，推荐）→ transformers 版（要 PyTorch 2.6 以上）→「越往下越近」的简易深度。
    AI 深度会缓存（同一张图不重复算）；简易深度不缓存，装好模型后下次自动换成 AI 深度。"""
    h = hashlib.md5(img.tobytes()).hexdigest()[:10]; cp = os.path.join(OUT, f"{tag}_depthai_{h}.png")
    if os.path.exists(cp): return np.asarray(Image.open(cp), np.float32) / 65535.0, "Depth Anything V2（缓存）"
    errs, d, how = [], None, ""
    try: d = depth_onnx(img); how = "Depth Anything V2（ONNX）"
    except Exception as e: errs.append(f"ONNX：{str(e)[:120]}")
    if d is None:
        try:
            from transformers import pipeline
            pipe = pipeline("depth-estimation", model=os.environ.get("DEPTH_MODEL", "depth-anything/Depth-Anything-V2-Small-hf"), device="cpu")
            d = np.asarray(pipe(img)["predicted_depth"].squeeze().cpu().numpy(), np.float32)
            d = np.asarray(Image.fromarray(d).resize(img.size, Image.BICUBIC), np.float32); how = "Depth Anything V2（transformers）"
        except Exception as e: errs.append(f"transformers：{str(e)[:80]}")
    ai = d is not None
    if not ai:
        W, H = img.size; v = np.linspace(0, 1, H, dtype=np.float32)[:, None].repeat(W, 1)
        hz = .45; d = np.clip((v - hz) / (1 - hz), 0, 1) ** 1.2 + .02
        how = "简易深度（越往下越近）。AI 深度模型没用上——双击 motion_ref\\install_25d.bat 装 onnxruntime。原因：" + "；".join(errs)
    lo, hi = np.percentile(d, 2), np.percentile(d, 98); d = np.clip((d - lo) / max(1e-6, hi - lo), 0, 1)
    if ai: Image.fromarray((d * 65535).astype(np.uint16)).save(cp)
    return d, how


def depth_grid(disp, near, far, gw=160, gh=90):
    """相对深度 → 每个网格点离相机多少米（视差和距离成反比）。先模糊一点，减少前后景交界处的拉扯。"""
    im = Image.fromarray((disp * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(2)).resize((gw, gh), Image.BILINEAR)
    g = np.asarray(im, np.float32) / 255.0; inv = 1 / far + g * (1 / near - 1 / far); D = 1 / inv
    return [[round(float(x), 3) for x in row] for row in D], float(np.median(D))


# ---------------- 主流程 ----------------
def render(name, to_draft=False):
    spec, sp_path = load_spec(name); sid = spec.get("sid", name); os.makedirs(OUT, exist_ok=True)
    kf = keyframe(sid)
    if not kf: raise SystemExit(f"找不到首帧图 img/{sid}.jpg")
    W, H = spec.get("size", [640, 360]); fps = int(spec.get("fps", 15)); dur = float(spec.get("duration", 6)); nf = max(2, int(round(dur * fps)))
    img = Image.open(kf).convert("RGB"); iw, ih = img.size; nh = int(iw * 9 / 16)
    if abs(ih - nh) > 2 and nh <= ih: img = img.crop((0, (ih - nh) // 2, iw, (ih - nh) // 2 + nh))
    img = img.resize((1280, 720), Image.LANCZOS)
    cards = [dict(c) for c in spec.get("cards", [])]
    bg, card_files = cut_cards(img, cards, name); bgp = os.path.join(OUT, f"{name}_bg.jpg"); bg.save(bgp, quality=92)
    disp, how = depth_map(bg, name); print(f"深度：{how}", flush=True)
    dep = spec.get("depth", {}); near, far = float(dep.get("near", 2)), float(dep.get("far", 40))
    grid, med = depth_grid(disp, near, far)
    Image.fromarray((disp * 255).astype(np.uint8)).save(os.path.join(OUT, f"{name}_depth_view.png"))
    for c, f in zip(cards, card_files): c["image"] = f
    arms = []
    if spec.get("arms") == "auto":                      # 手绘动作 / 轨迹测试里名字带「手」的路线 → 手臂
        mp = os.path.join(ROOT, "autofix", "test_motion", sid, "motion.json")
        if os.path.exists(mp):
            mo = json.load(open(mp, encoding="utf-8")); gh, gw = len(grid), len(grid[0])
            for k, s in enumerate(mo.get("subjects", [])):
                if "手" not in s.get("label", "") or len(s.get("points", [])) < 2: continue
                p0 = s["points"][0]; d0 = grid[min(gh - 1, int(p0[1] * gh))][min(gw - 1, int(p0[0] * gw))]
                ov = (spec.get("arm_fix") or {}); d0 = float(ov.get("depth") or d0)
                sc_ = max(.6, min(1.8, d0 / 1.6))                                # 手臂长短跟着距离走，限制在合理范围
                sh = ov.get("shoulder") or [p0[0] + .03, max(0, p0[1] - .22)]      # 肩膀位置猜不准时在 arm_fix 里写
                arms.append({"label": s["label"], "shoulder": sh, "depth": d0, "scale": sc_, "side": ov.get("side", 1 if "右" in s["label"] else -1), "color": [.22, .3, .45],
                             "keys": [[pt[2] * dur / 6.0, pt[0], pt[1]] for pt in s["points"]]})
            print(f"手臂：{len(arms)} 条（来自 {os.path.relpath(mp, ROOT)}）", flush=True)
    elif isinstance(spec.get("arms"), list): arms = spec["arms"]
    fd = os.path.join(OUT, f"{name}_25d_frames")
    if os.path.isdir(fd): shutil.rmtree(fd)
    os.makedirs(fd)
    job = {"size": [W, H], "fps": fps, "frames": nf, "hfov": spec.get("hfov", 50), "bg": bgp, "frames_dir": fd,
           "depth": {"grid": grid, "gw": len(grid[0]), "gh": len(grid), "near": near, "far": far, "median": med},
           "camera": spec.get("camera") or {}, "look": spec.get("look") or {}, "snow": spec.get("snow") or {}, "cards": cards, "boxes": spec.get("boxes") or [], "arms": arms}
    jp = os.path.join(OUT, f"{name}_25d_job.json"); json.dump(job, open(jp, "w", encoding="utf-8"), ensure_ascii=False)
    bl = find_blender()
    if not bl: raise SystemExit("没找到 Blender：请从 https://www.blender.org/download/ 装一个（4.2 以上，免费），装在默认位置；装在别处就设环境变量 BLENDER_EXE 指向 blender.exe")
    print(f"用 Blender 渲染 {nf} 帧（{W}×{H}，{fps} 帧/秒）：{bl[0]}", flush=True); t0 = time.time()
    r = subprocess.run(bl + [os.path.join(HERE, "blender25d.py"), "--", jp], capture_output=True, text=True, encoding="utf-8", errors="replace")
    frames = sorted(glob.glob(os.path.join(fd, "f_*.png")))
    if len(frames) < nf:
        print((r.stdout or "")[-2500:], (r.stderr or "")[-2500:], sep="\n", flush=True); raise SystemExit(f"Blender 渲染失败（只出了 {len(frames)}/{nf} 帧）")
    print(f"  渲染用时 {time.time() - t0:.0f} 秒", flush=True)
    out = os.path.join(OUT, f"{name}_25d.mp4"); f15 = font(15); mv = (spec.get("camera") or {}).get("move", "static")
    ff = subprocess.Popen([ffmpeg(), "-y", "-v", "error", "-f", "image2pipe", "-framerate", str(fps), "-i", "-", "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-pix_fmt", "yuv420p", out], stdin=subprocess.PIPE)
    for i, f in enumerate(frames):
        im = Image.open(f).convert("RGB"); d = ImageDraw.Draw(im, "RGBA"); tag = f"2.5D 预演 · {name} · {i / fps:4.1f}/{dur:g}s · {mv}"
        tw = d.textlength(tag, font=f15); d.rectangle([W - tw - 18, H - 26, W - 4, H - 6], fill=(0, 0, 0, 140)); d.text((W - tw - 11, H - 25), tag, fill=(255, 255, 255, 220), font=f15)
        from io import BytesIO
        b = BytesIO(); im.save(b, "PNG"); ff.stdin.write(b.getvalue())
    ff.stdin.close(); ff.wait()
    print("视频：" + out, flush=True)
    if to_draft: register_draft(sid, name, out, dur)
    return out


def register_draft(sid, name, out, dur):
    """放进游戏的草稿视频，并记进 autofix\\draft\\drafts.json（剪辑台视频卡片上显示）。"""
    af = os.path.join(ROOT, "autofix"); sys.path.insert(0, af)
    try:
        import video_shots as VS; s = VS.load()[1].get(sid, {})
    except Exception: s = {}
    rel = s.get("video") or f"vid/{sid}.mp4"; dst = os.path.join(GAME, "vid_draft", *rel.split("/")[1:]); os.makedirs(os.path.dirname(dst), exist_ok=True)
    dd = os.path.join(af, "draft"); os.makedirs(dd, exist_ok=True); keep = os.path.join(dd, f"{sid}_b25d.mp4")
    shutil.copy2(out, keep); shutil.copy2(out, dst)
    rp = os.path.join(dd, "drafts.json")
    try: rec = json.load(open(rp, encoding="utf-8"))
    except Exception: rec = {}
    r = rec.setdefault(sid, {}); r["b25d"] = {"file": f"draft/{sid}_b25d.mp4", "at": time.strftime("%m-%d %H:%M"), "dur": dur, "prompt": s.get("prompt", ""), "scene": name}
    r["current"] = "b25d"; r["game"] = "vid_draft/" + "/".join(rel.split("/")[1:])
    json.dump(rec, open(rp + ".tmp", "w", encoding="utf-8"), ensure_ascii=False, indent=1); os.replace(rp + ".tmp", rp)
    print("已放进草稿视频：" + r["game"], flush=True)


if __name__ == "__main__":
    a = [x for x in sys.argv[1:] if not x.startswith("--")]
    if not a: print(__doc__); sys.exit(2)
    for n in a: render(n, "--draft" in sys.argv)
    print("RESULT:" + os.path.join("motion_ref", "out", a[-1] + "_25d.mp4").replace("\\", "/"), flush=True)
