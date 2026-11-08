"""框选修图：在分镜图上拖出矩形框，写一句修改意见，只改框里的内容，框外像素一个不变。
用法：
  影游剪辑台里：故事板模式选中一句台词 →「框选修图…」（剪辑台在后台调用下面的命令行模式）
  单独使用：双击 run_fix_box.bat（或 python fix_box.py），浏览器会自动打开操作页面
  命令行：python fix_box.py edit <镜头> <base64(JSON)>   JSON = {"src": 相对 moban_art 的路径或空, "mode": "patch"|"whole", "boxes": [{"fx","fy","fw","fh","text"}]}（框用 0~1 的比例，相对 16:9 画面）
两种修改方式：
  patch（只改样子、形状不变，比如换颜色、盖掉字）：裁一块交给 AI，改完只把框里的像素羽化贴回，框外一个像素不变。
  whole（要加东西或改形状，比如箱子里加金子、戴上帽子）：发干净原图 + 标了红框的位置图，用 AI 改完的整张图；会报告框外变化有多大。
  crop（裁切后 AI 重画：改景别、拉近）：按一个 16:9 的框裁下来，交给 AI 照着重画成高清（2K），内容不变只补细节；
         会把结果缩回裁切尺寸逐块对比，报告哪里被改了，并输出一张「变化处」标注图（没变的地方压暗，变了的地方红线圈出）。
         python fix_box.py accept <镜头> <结果文件（相对 moban_art）>
         python fix_box.py approve <镜头>                     不改图，标记为人工确认
原理见下面「两种修改方式」。
需要 GEMINI_API_KEY 和代理（和出图脚本一样）。修改结果在 out\\fix\\，点「采用」才换进游戏。
"""
import os, shutil, sys, json, time, base64, threading, webbrowser, urllib.parse
from io import BytesIO
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
FIX = os.path.join(HERE, "out", "fix"); os.makedirs(FIX, exist_ok=True)
STATE = os.path.join(HERE, "out", "batch", "state.json")
PORT = int(os.environ.get("FIX_BOX_PORT", "8765"))
class _StateLock:
    """同一进程里的线程锁 + 跨进程的文件锁：几个修图 / 出图任务同时跑时，写 state.json 不会互相覆盖。"""
    def __init__(self): self.t = threading.Lock()
    def __enter__(self):
        self.t.acquire()
        import gen_images as gi
        self.cm = gi.file_lock(STATE); self.cm.__enter__()
    def __exit__(self, *a):
        try: self.cm.__exit__(*a)
        finally: self.t.release()
LOCK = _StateLock()


def load_state():
    try: return json.load(open(STATE, encoding="utf-8"))
    except Exception: return {"spent": 0, "shots": {}}


def shots():
    sl = json.load(open(os.path.join(HERE, "shotlist.json"), encoding="utf-8"))
    return sl


def current_image(sid, st):
    """当前在用的那张原图（优先高分辨率 PNG）。"""
    f = (st["shots"].get(sid) or {}).get("final")
    cands = []
    if f: cands += [os.path.join(FIX, f), os.path.join(HERE, "out", "refine", f), os.path.join(HERE, "out", "batch", f)]
    cands.append(os.path.join(ROOT, "moban_game", "img", "l", sid + ".jpg"))
    cands.append(os.path.join(ROOT, "moban_game", "img", sid + ".jpg"))   # 场景图、@shot 特写镜头的图（不是分镜流水线出的）
    for p in cands:
        if os.path.exists(p): return p
    return None


def rel(p):
    return os.path.relpath(p, ROOT).replace("\\", "/")


# ---------------- 核心：只改框里 ----------------
def crop_window(W, H, box, pad_ratio=0.8, min_side=640):
    """以框为中心向外留出上下文，返回裁剪窗口 (x0, y0, x1, y1)。"""
    x, y, w, h = box
    pad = max(w, h) * pad_ratio
    cx, cy = x + w / 2, y + h / 2
    half_w = max(w / 2 + pad, min_side / 2); half_h = max(h / 2 + pad, min_side / 2)
    x0, x1 = cx - half_w, cx + half_w; y0, y1 = cy - half_h, cy + half_h
    if x0 < 0: x1 -= x0; x0 = 0
    if y0 < 0: y1 -= y0; y0 = 0
    if x1 > W: x0 -= x1 - W; x1 = W
    if y1 > H: y0 -= y1 - H; y1 = H
    return snap_aspect(W, H, (int(max(0, x0)), int(max(0, y0)), int(min(W, x1)), int(min(H, y1))))


# 出图模型只会按这些比例出图；裁剪窗口对齐到其中一个，AI 返回的图才能一比一贴回去，不会被拉伸错位（2026-11-01：错位导致红框线漏进框里）
ASPECTS = {"1:1": 1, "4:3": 4 / 3, "3:4": 3 / 4, "3:2": 3 / 2, "2:3": 2 / 3, "16:9": 16 / 9, "9:16": 9 / 16, "5:4": 5 / 4, "4:5": 4 / 5}


def snap_aspect(W, H, win):
    x0, y0, x1, y1 = win; w, h = x1 - x0, y1 - y0; cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    name = min(ASPECTS, key=lambda k: abs(ASPECTS[k] - w / h)); r = ASPECTS[name]
    if w / h < r: w = h * r       # 窗口偏窄：加宽
    else: h = w / r                # 窗口偏扁：加高
    if w > W: w = W; h = w / r
    if h > H: h = H; w = h * r
    x0 = min(max(0, cx - w / 2), W - w); y0 = min(max(0, cy - h / 2), H - h)
    return int(round(x0)), int(round(y0)), int(round(x0 + w)), int(round(y0 + h))


def group_boxes(boxes, W, H, max_frac=0.45):
    """离得近的框合成一组、一次交给 AI；合起来的范围超过画面 45% 就另起一组（范围太大，小细节会画糊）。"""
    groups = []
    for b in sorted(boxes, key=lambda b: (b["y"], b["x"])):
        for g in groups:
            xs = [v for c in g + [b] for v in (c["x"], c["x"] + c["w"])]; ys = [v for c in g + [b] for v in (c["y"], c["y"] + c["h"])]
            if (max(xs) - min(xs)) * (max(ys) - min(ys)) <= max_frac * W * H: g.append(b); break
        else: groups.append([b])
    return groups


def win_aspect(win):
    w, h = win[2] - win[0], win[3] - win[1]
    return min(ASPECTS, key=lambda k: abs(ASPECTS[k] - w / h))


def align_to(ref, img, box_local, max_frac=0.04):
    """AI 返回的图有时整体挪了几个像素：用框外的部分和原图对一下位置（相位相关），挪回来。"""
    import numpy as np
    a = np.asarray(ref.convert("L"), dtype=np.float32); b = np.asarray(img.convert("L"), dtype=np.float32)
    m = np.ones_like(a); bx, by, bw, bh = [int(v) for v in box_local]; pad = int(max(bw, bh) * 0.25) + 8
    m[max(0, by - pad):by + bh + pad, max(0, bx - pad):bx + bw + pad] = 0     # 框和衔接区不参与对齐
    a = (a - a[m > 0].mean()) * m; b = (b - b[m > 0].mean()) * m
    F = np.fft.fft2(a) * np.conj(np.fft.fft2(b)); r = np.fft.ifft2(F / (np.abs(F) + 1e-6)).real
    dy, dx = np.unravel_index(np.argmax(r), r.shape); H, W = a.shape
    if dy > H // 2: dy -= H
    if dx > W // 2: dx -= W
    if abs(dx) > W * max_frac or abs(dy) > H * max_frac or (dx == 0 and dy == 0): return img, (0, 0)
    out = Image.new("RGB", img.size); out.paste(img, (int(dx), int(dy)))
    if dx > 0: out.paste(ref.crop((0, 0, dx, H)), (0, 0))
    if dy > 0: out.paste(ref.crop((0, 0, W, dy)), (0, 0))
    if dx < 0: out.paste(ref.crop((W + dx, 0, W, H)), (W + dx, 0))
    if dy < 0: out.paste(ref.crop((0, H + dy, W, H)), (0, H + dy))
    return out, (int(dx), int(dy))


# 每个框一种颜色（和剪辑台里框的颜色一一对应，按框的顺序轮换）：几处修改一次交给 AI 时，用「颜色 + 编号」对上各自的修改意见
PALETTE = [("红", (255, 0, 0)), ("蓝", (0, 90, 255)), ("绿", (0, 200, 60)), ("黄", (255, 210, 0)), ("紫", (190, 0, 255)), ("青", (0, 210, 220))]
def box_color(k): return PALETTE[k % len(PALETTE)]


def mark_mask(img, ref, band=None, tol=60):
    """和标注框颜色很接近、原图里本来没有的像素（只在 band 范围里找）。"""
    import numpy as np
    a = np.asarray(img.convert("RGB")).astype(int); r = np.asarray(ref.convert("RGB")).astype(int); m = np.zeros(a.shape[:2], bool)
    for _, c in PALETTE:
        c = np.array(c); m |= (np.abs(a - c).max(2) < tol) & ~(np.abs(r - c).max(2) < tol + 30)
    return m & band if band is not None else m


def marker_like(arr, hue_tol=10):
    """像标注框颜色的像素：很鲜艳（饱和度高、够亮）、色相和某个框色很近。肤色、暖黄灯光饱和度和色相都差一截，不会算进来。"""
    import numpy as np
    a = arr.astype(float) / 255; mx = a.max(2); mn = a.min(2); d = mx - mn + 1e-6
    sat = d / (mx + 1e-6); r, g, b = a[..., 0], a[..., 1], a[..., 2]
    h = np.where(mx == r, ((g - b) / d) % 6, np.where(mx == g, (b - r) / d + 2, (r - g) / d + 4)) * 60
    out = np.zeros(arr.shape[:2], bool)
    for _, c in PALETTE:
        cc = np.array(c, float) / 255; cmx, cmn = cc.max(), cc.min(); cd = cmx - cmn
        ch = (((cc[1] - cc[2]) / cd) % 6 if cmx == cc[0] else (cc[2] - cc[0]) / cd + 2 if cmx == cc[1] else (cc[0] - cc[1]) / cd + 4) * 60
        dh = np.abs((h - ch + 180) % 360 - 180)
        out |= (sat > 0.78) & (mx > 0.55) & (dh < hue_tol)
    return out


def stray_lines(img, ref, line):
    """AI 照着位置图画出来的框线，可能挪了位置、不在原来的框边上：全图找标注颜色的「细长直线」（横 / 竖连续很长、很细），
    原图同一位置本来没有这种颜色的才算。返回掩码（已经往外扩了一点）。画面里本来就有的红色东西（穗子、红灯）不是细长直线，不会被当成框线。"""
    import numpy as np
    from PIL import ImageFilter as F
    a = np.asarray(img.convert("RGB")); r = np.asarray(ref.convert("RGB").resize(img.size))
    m = marker_like(a) & ~marker_like(r)
    m = np.asarray(Image.fromarray((m * 255).astype("uint8")).filter(F.MaxFilter(3))) > 0   # 补上线里零星断开的点
    L = max(60, int(line * 12)); keep = np.zeros_like(m)
    for mm, kk in ((m, keep), (m.T, keep.T)):          # 先按行找横线，再按列找竖线
        for y in range(mm.shape[0]):
            row = mm[y]
            if row.sum() < L: continue
            d = np.diff(np.concatenate(([0], row.view(np.int8), [0])))
            for s0, e0 in zip(np.nonzero(d == 1)[0], np.nonzero(d == -1)[0]):
                if e0 - s0 < L: continue
                mid = (s0 + e0) // 2; col = mm[:, mid]; t0 = y; t1 = y   # 线要细：沿垂直方向这个颜色连着超过 3 倍线宽的，是红色物体不是框线
                while t0 > 0 and col[t0 - 1]: t0 -= 1
                while t1 < len(col) - 1 and col[t1 + 1]: t1 += 1
                if t1 - t0 + 1 <= 3 * line + 6: kk[y, s0:e0] = True
    if not keep.any(): return keep
    # 线的两头（短一截、和主线断开的）也收进来：主线附近同样颜色的都算
    near = np.asarray(Image.fromarray((keep * 255).astype("uint8")).filter(F.MaxFilter(41))) > 0
    keep = keep | (m & near)
    mk = Image.fromarray((keep * 255).astype("uint8")).filter(F.MaxFilter(5))   # 再往外扩 2 像素，收掉线边上的过渡色
    return np.asarray(mk) > 0


def inpaint(img, mask, iters=40):
    """把 mask 里的像素用周围的颜色一圈圈填上（没有 OpenCV 时用的简单补洞）。"""
    import numpy as np
    from PIL import ImageFilter as F
    a = np.asarray(img.convert("RGB")).astype(float); valid = (~mask).astype(float)
    out = a.copy(); out[mask] = 0
    for _ in range(iters):
        num = np.stack([np.asarray(Image.fromarray(np.uint8(np.clip(out[:, :, c] * valid, 0, 255))).filter(F.BoxBlur(3))).astype(float) for c in range(3)], 2)
        den = np.asarray(Image.fromarray(np.uint8(valid * 255)).filter(F.BoxBlur(3))).astype(float)[:, :, None] / 255
        fill = num / np.maximum(den, 1e-3)
        newly = (den[:, :, 0] > 0.02) & mask & (valid == 0)
        out[mask] = np.where(den[mask] > 0.02, fill[mask], out[mask]); valid = np.maximum(valid, newly.astype(float))
        if valid.min() > 0: break
    return Image.fromarray(np.uint8(np.clip(out, 0, 255)))


def clean_marks(img, ref, boxes_local, line):
    """把残留的标注框线（任何颜色）换回原图对应的像素；只查各个框边线附近的一圈，不碰画面里本来就鲜艳的东西。"""
    import numpy as np
    H, W = ref.size[1], ref.size[0]; band = np.zeros((H, W), bool); g = int(line * 3) + 6
    for b in boxes_local:
        x, y, w, h = int(b["x"]), int(b["y"]), int(b["w"]), int(b["h"])
        band[max(0, y - g):y + h + g, max(0, x - g):x + w + g] = True
        band[max(0, y + g):max(0, y + h - g), max(0, x + g):max(0, x + w - g)] = False   # 只要边线附近
    m = mark_mask(img, ref, band); n = int(m.sum())
    if not n: return img, 0
    from PIL import ImageFilter as F
    mk = Image.fromarray((m * 255).astype("uint8")).filter(F.MaxFilter(5))
    return Image.composite(ref.convert("RGB"), img.convert("RGB"), mk), n


def red_mask(img, ref=None):
    """像我们画的红框那样的纯红像素（原图里本来就红的不算）。"""
    import numpy as np
    a = np.asarray(img.convert("RGB")).astype(int); red = (a[..., 0] > 170) & (a[..., 1] < 80) & (a[..., 2] < 80) & (a[..., 0] - a[..., 1] > 120)
    if ref is not None:
        r = np.asarray(ref.convert("RGB")).astype(int); red &= ~((r[..., 0] > 150) & (r[..., 1] < 100) & (r[..., 2] < 100))
    return red


def clean_red(img, ref, band=None):
    """把残留的红线换回原图对应的像素（只在 band 掩码范围里，默认整张）。返回 (图, 换掉的像素数)。"""
    import numpy as np
    red = red_mask(img, ref)
    if band is not None: red &= band
    n = int(red.sum())
    if not n: return img, 0
    from PIL import ImageFilter as F
    mk = Image.fromarray((red * 255).astype("uint8")).filter(F.MaxFilter(5))   # 红线边缘的粉色过渡也一起换
    return Image.composite(ref.convert("RGB"), img.convert("RGB"), mk), n


def marked_crop(img, win, box, line=None, poly=None):
    """裁出窗口，在框外侧一圈画红框（只用于发给 AI）。套索选区（poly）沿选区边画红线。"""
    x0, y0, x1, y1 = win
    c = img.crop(win).convert("RGB")
    line = line or max(4, int(min(c.size) / 160))
    bx, by, bw, bh = box[0] - x0, box[1] - y0, box[2], box[3]
    d = ImageDraw.Draw(c)
    if poly:
        pts = [(x - x0, y - y0) for x, y in poly]
        d.line(pts + [pts[0]], fill=(255, 0, 0), width=line, joint="curve")
        return c
    o = line  # 红框画在框外侧，框内像素不被压住
    d.rectangle([bx - o, by - o, bx + bw + o - 1, by + bh + o - 1], outline=(255, 0, 0), width=line)
    return c


def paste_back(orig, edited_crop, win, box, feather=None, poly=None, line=0):
    """只把框内（向内羽化）的像素从 AI 结果贴回原图。套索选区：只贴回选区里面（先往里收掉红线的宽度，再向内羽化），选区外一个像素不变。"""
    x0, y0, x1, y1 = win
    cw, ch = x1 - x0, y1 - y0
    ed = edited_crop.convert("RGB").resize((cw, ch), Image.LANCZOS)
    feather = feather or max(3, int(min(box[2], box[3]) * 0.06))
    if poly:
        pts = [(x - x0, y - y0) for x, y in poly]
        hard = Image.new("L", (cw, ch), 0); ImageDraw.Draw(hard).polygon(pts, fill=255)
        shrink = int(line) + feather
        inner = hard.filter(ImageFilter.MinFilter(2 * shrink + 1)) if shrink > 0 else hard
        mask = inner.filter(ImageFilter.GaussianBlur(feather / 2))
        mask = Image.composite(mask, hard.point(lambda v: 0), hard)
        out = orig.convert("RGB").copy(); region = out.crop(win)
        out.paste(Image.composite(ed, region, mask), (x0, y0))
        return out
    mask = Image.new("L", (cw, ch), 0)
    bx, by = box[0] - x0, box[1] - y0
    ImageDraw.Draw(mask).rectangle([bx + feather, by + feather, bx + box[2] - feather - 1, by + box[3] - feather - 1], fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(feather / 2))
    # 羽化只往框内渗，框外严格为 0
    hard = Image.new("L", (cw, ch), 0); ImageDraw.Draw(hard).rectangle([bx, by, bx + box[2] - 1, by + box[3] - 1], fill=255)
    mask = Image.composite(mask, hard.point(lambda v: 0), hard)
    out = orig.convert("RGB").copy()
    region = out.crop(win)
    region = Image.composite(ed, region, mask)
    out.paste(region, (x0, y0))
    return out


def why(st, js):
    """把失败原因翻译成人话（日志里能看出到底是网络、额度还是模型的问题）。"""
    raw = json.dumps(js, ensure_ascii=False)
    msg = ((js.get("error") or {}).get("message") if isinstance(js.get("error"), dict) else "") or js.get("raw", "") or raw
    msg = str(msg)[:220]
    if st == 0: return "连不上 Gemini（网络或代理问题：代理软件没开、节点断了、或节点不在支持的地区）：" + msg
    if st == 429: return "请求太频繁或额度用完（429）：" + msg
    if st in (500, 503): return f"Gemini 服务暂时出错（{st}），稍后再试：" + msg
    if st == 400 and "location" in raw.lower(): return "代理节点所在地区不支持 Gemini（换美国 / 日本节点）：" + msg
    if st in (401, 403): return f"密钥无效或没有权限（{st}）：" + msg
    if st == 404: return "找不到这个模型（404），可能已下线：" + msg
    return f"HTTP {st}：" + msg


def call_gemini(body, key, tries=3):
    """调用 Gemini 出图，失败时每次都把原因打到日志里。返回 (图片, 错误)。"""
    import gen_images as gi
    model = gi.gemini_model(key); last = ""
    for a in range(tries + 1):
        st, js = gi.http(f"{gi.G}/models/{model}:generateContent", body, {"x-goog-api-key": key})
        if st == 200:
            for c in js.get("candidates", []):
                for pt in (c.get("content") or {}).get("parts", []):
                    d = pt.get("inline_data") or pt.get("inlineData")
                    if d and d.get("data"): return Image.open(BytesIO(base64.b64decode(d["data"]))), ""
            fr = ",".join(str(c.get("finishReason", "")) for c in js.get("candidates", [])) or str((js.get("promptFeedback") or {}).get("blockReason", ""))
            return None, f"AI 没返回图片（{fr or '原因不明'}）：" + json.dumps(js, ensure_ascii=False)[:200]
        ic = body["generationConfig"].get("imageConfig", {})
        if st == 400 and "imageSize" in ic and "image" in json.dumps(js).lower():
            print("INFO:这个模型不支持指定 2K 输出，改用默认尺寸", flush=True); ic.pop("imageSize"); continue
        last = why(st, js)
        print(f"  第 {a + 1} 次失败：{last}", flush=True)
        if st == 402: return None, "Gemini 额度用完了，请到 AI Studio 充值"
        if st in (429, 500, 503, 0) and a < tries: time.sleep(10 * (a + 1)); continue
        return None, last
    return None, f"试了 {tries} 次都失败。最后一次：{last}"


MAX_REFS = 6


def ref_parts(shot):
    """要一起发给 AI 的参考图：修改意见里用 @ 点名的排在前面（标明「@名称 就是这张」），再加上分镜表里这个镜头的参考图，最多 MAX_REFS 张。"""
    named = shot.get("_named") or {}
    order = list(named) + [r for r in shot.get("refs", []) if r not in named]
    parts = []
    for i, r in enumerate(order[:MAX_REFS]):
        p = os.path.join(ROOT, r)
        if not os.path.exists(p): continue
        im = Image.open(p).convert("RGB"); im.thumbnail((640, 640)); b = BytesIO(); im.save(b, "JPEG", quality=85)
        name = named.get(r)
        label = f"参考图{i+1}：{name}（修改意见里的「@{name}」就是指这张图，照它的样子画）" if name else f"参考图{i+1}：{os.path.splitext(os.path.basename(r))[0]}"
        parts += [{"text": label}, {"inline_data": {"mime_type": "image/jpeg", "data": base64.b64encode(b.getvalue()).decode()}}]
    return parts


def ai_edit(crop, instruction, shot, bible, marked=None, aspect=None):
    """局部修改：发干净的局部图（图A，让 AI 改这张）+ 画了红框的同一张（图B，只指位置）。
    以前直接在要改的图上画红框，AI 常把红线留在结果里（2026-11-01 ride_04）。"""
    import gen_images as gi
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not key: return None, "没有找到 GEMINI_API_KEY"
    parts = ref_parts(shot)
    def png(im):
        b = BytesIO(); im.save(b, "PNG"); return base64.b64encode(b.getvalue()).decode()
    if marked is None: marked, crop = crop, crop
    parts += [{"text": "【图A：要修改的图】电影剧照的一个局部，没有任何标记："}, {"inline_data": {"mime_type": "image/png", "data": png(crop)}},
              {"text": "【图B：位置标注】和图A是同一张图，只是用带编号的彩色框（或彩色线）圈出了要改的地方，每个框颜色不同。图B只用来看位置，不要修改图B，也不要把框画进结果里。"}, {"inline_data": {"mime_type": "image/png", "data": png(marked)}}]
    rules = "；".join(f"{k}：{v}" for k, v in bible.items() if k in ("时代地点", "出租车", "人物", "道具", "钱", "风格"))
    parts.append({"text": f"""请在图A上修改：只改图B里彩色框圈出的位置，每个框按下面对应颜色和编号的要求改；其他所有东西（人物、背景、光线、颜色、位置）保持完全不变，不要整体平移或缩放画面。
修改要求：
{instruction}
修改后：画面构图、视角、光线和画风与原图一致，衔接自然；清晰度和景深要和所在位置一致（周围是虚化的，改的东西也要同样虚化）；结果里不能有任何彩色框、线或编号；画面里不要出现任何文字、字母或水印。
背景设定（供参考）：{rules}
特别注意：图B上的彩色矩形框、彩色线和编号是我们后加的位置记号，原画里根本没有。输出时把它们当作不存在——不要画任何矩形框、框线、彩色线条或编号，哪怕只是一段；如果你画出了框线，这张图就作废了。
只输出修改后的完整图A，尺寸比例和图A完全一样。"""})
    gc = {"responseModalities": ["IMAGE"]}
    if aspect: gc["imageConfig"] = {"aspectRatio": aspect}
    return call_gemini({"contents": [{"parts": parts}], "generationConfig": gc}, key)


def frame16x9(img):
    """和游戏里一样取中间的 16:9 画面（剪辑台显示的就是这个范围）。"""
    w, h = img.size; nh = round(w * 9 / 16)
    if nh <= h: return img.crop((0, (h - nh) // 2, w, (h - nh) // 2 + nh))
    nw = round(h * 16 / 9); return img.crop(((w - nw) // 2, 0, (w - nw) // 2 + nw, h))


def mark_boxes(img, boxes, line=None):
    """在原图副本上画编号彩色框（每个框一种颜色，只用来给 AI 指位置，不是要修改的那张）。"""
    m = img.convert("RGB").copy(); d = ImageDraw.Draw(m)
    line = line or max(4, int(min(m.size) / 180))
    from PIL import ImageFont
    font = None
    for name in ("msyhbd.ttc", "msyh.ttc", "arialbd.ttf", "DejaVuSans-Bold.ttf"):
        try: font = ImageFont.truetype(name, max(22, line * 6)); break
        except Exception: pass
    if font is None:
        try: font = ImageFont.load_default(size=max(22, line * 6))
        except Exception: font = None
    for k, b in enumerate(boxes):
        x, y, w, h = int(b["x"]), int(b["y"]), int(b["w"]), int(b["h"]); col = box_color(b.get("k", k))[1]
        if b.get("poly"): d.line(list(map(tuple, b["poly"])) + [tuple(b["poly"][0])], fill=col, width=line, joint="curve")
        else: d.rectangle([x - line, y - line, x + w + line - 1, y + h + line - 1], outline=col, width=line)
        tag = str(b.get("k", k) + 1); ty = max(0, y - line - max(26, line * 7))
        d.rectangle([x - line, ty, x - line + max(26, line * 7), y - line], fill=col)
        d.text((x - line + 6, ty + 1), tag, fill=(255, 255, 255) if col[1] < 180 else (0, 0, 0), font=font)
    return m


def ai_edit_whole(img, marked, boxes, shot, bible):
    """整图模式：发干净原图 + 标了红框的位置图，AI 输出修改后的整张图。"""
    import gen_images as gi
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not key: return None, "没有找到 GEMINI_API_KEY"
    parts = ref_parts(shot)
    def png(im):
        b = BytesIO(); im.save(b, "PNG"); return base64.b64encode(b.getvalue()).decode()
    parts += [{"text": "【图A：要修改的原图】"}, {"inline_data": {"mime_type": "image/png", "data": png(img)}},
              {"text": "【图B：位置标注】和图A是同一张图，只是用带编号的彩色框（或彩色线圈出的区域）标出了要修改的地方，每个框颜色不同。图B只用来看位置，不要修改图B。"}, {"inline_data": {"mime_type": "image/png", "data": png(marked)}}]
    todo = "\n".join(f"- {box_color(k)[0]}色框{k+1}：{b.get('text', '').strip() or '修正这里的问题'}" for k, b in enumerate(boxes))
    rules = "；".join(f"{k}：{v}" for k, v in bible.items() if k in ("时代地点", "出租车", "人物", "道具", "钱", "风格"))
    parts.append({"text": f"""请在图A上做下面的修改，修改的位置看图B里对应颜色和编号的框：
{todo}
要求：
1. 只改这些框标出的地方，每个框按它自己的要求改。新加的东西可以和周围自然衔接（比如影子、反光、被遮挡的边缘），但不要改动画面里其他的人物、物体、背景、构图和机位。
2. 光线、颜色、颗粒感、画风和图A完全一致，看不出修改的痕迹；清晰度和景深要和所在位置一致——那里是虚化的，新加的东西也要同样虚化，不要比周围更清晰。
3. 输出修改后的完整图A，尺寸比例和图A相同；输出里不要有任何彩色框、编号、文字或水印。
4. 特别注意：图B上的彩色矩形框、彩色线和编号是我们后加的位置记号，原画里根本没有。输出时把它们当作不存在——不要画任何矩形框、框线、彩色线条或编号，哪怕只是一段；如果你画出了框线，这张图就作废了。
5. 除了要改的地方，图A里的人和东西保持原来的位置、大小和姿势，不要整体挪动或重新构图。
背景设定（供参考）：{rules}"""})
    body = {"contents": [{"parts": parts}], "generationConfig": {"responseModalities": ["IMAGE"], "imageConfig": {"aspectRatio": "16:9"}}}
    return call_gemini(body, key)


def ai_redraw(crop, note, shot, bible):
    """裁切重画：把低分辨率的裁切图照原样重画成高清，内容不变。"""
    import gen_images as gi
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not key: return None, "没有找到 GEMINI_API_KEY"
    parts = ref_parts(shot)
    b = BytesIO(); crop.save(b, "PNG")
    parts += [{"text": "【要重画的图】从一张电影剧照里裁出来的局部，分辨率低："}, {"inline_data": {"mime_type": "image/png", "data": base64.b64encode(b.getvalue()).decode()}}]
    rules = "；".join(f"{k}：{v}" for k, v in bible.items() if k in ("时代地点", "出租车", "人物", "道具", "钱", "风格"))
    parts.append({"text": f"""请把【要重画的图】重画成同一个画面的高清版本，就像用更好的镜头在同一时刻拍下的同一帧。
1. 取景范围、构图、机位完全不变：画面边缘切到哪里，新图也切到哪里；每个人、每样东西的位置、大小、姿势、手势、视线、表情都一一对应，不增加、不删除、不移动任何东西。
2. 人物长相、发型、服装，道具和背景的形状、颜色都和原图一致；光线方向、明暗、色调、胶片颗粒感保持一致。
3. 只做一件事：提高清晰度，补出真实可信的细节（皮肤、毛发、布料、皮毛、金属、玻璃的质感）。景深和原图一致——原图虚化的地方仍然虚化，不要把背景变清楚。
4. 参考图只用来确认人物长相和道具的细节，不要照参考图改变姿势、角度或构图。
5. 画面里不要出现任何文字、字母或水印（原图里没有的不要加）。
""" + (f"补充要求：{note}\n" if note else "") + f"背景设定（供参考）：{rules}\n只输出一张横幅 16:9 图片。"})
    body = {"contents": [{"parts": parts}], "generationConfig": {"responseModalities": ["IMAGE"], "imageConfig": {"aspectRatio": "16:9", "imageSize": "2K"}}}
    return call_gemini(body, key)


def redraw_report(crop, out):
    """把重画结果缩回裁切尺寸，和裁切图逐块比（先轻微模糊，忽略新补的细节），找出被改掉的地方。
    返回 (变化比例, 程度, 标注图)。标注图：在重画结果上把变化大的地方用红色描出来。"""
    import numpy as np
    w, h = crop.size
    small = out.convert("RGB").resize((w, h), Image.LANCZOS)
    r = max(1.5, w / 400)
    a = np.asarray(crop.convert("RGB").filter(ImageFilter.GaussianBlur(r))).astype(np.int16)
    b = np.asarray(small.filter(ImageFilter.GaussianBlur(r))).astype(np.int16)
    d = np.abs(a - b).mean(2)
    k = max(8, w // 48); H2, W2 = h // k, w // k
    blk = d[:H2 * k, :W2 * k].reshape(H2, k, W2, k).mean((1, 3)) if H2 and W2 else np.zeros((1, 1))
    bad = blk > 18
    changed = float(bad.mean())
    level = "很小" if changed < 0.03 else "有一些" if changed < 0.12 else "较大"
    # 标注图：没变的地方压暗，变了的地方保持原亮度，并用红线圈出边界
    full = out.convert("RGB"); mark = Image.eval(full, lambda v: int(v * 0.35)); dr = ImageDraw.Draw(mark)
    sx, sy = full.size[0] / w, full.size[1] / h; lw = max(2, int(full.size[0] / 500))
    by, bxs = bad.shape
    for y in range(by):
        for x in range(bxs):
            if not bad[y, x]: continue
            box = (int(x * k * sx), int(y * k * sy), int((x + 1) * k * sx), int((y + 1) * k * sy))
            mark.paste(full.crop(box), box[:2])
    for y in range(by):
        for x in range(bxs):
            if not bad[y, x]: continue
            X0, Y0, X1, Y1 = x * k * sx, y * k * sy, (x + 1) * k * sx, (y + 1) * k * sy
            if y == 0 or not bad[y - 1, x]: dr.line([X0, Y0, X1, Y0], fill=(255, 40, 40), width=lw)
            if y == by - 1 or not bad[y + 1, x]: dr.line([X0, Y1, X1, Y1], fill=(255, 40, 40), width=lw)
            if x == 0 or not bad[y, x - 1]: dr.line([X0, Y0, X0, Y1], fill=(255, 40, 40), width=lw)
            if x == bxs - 1 or not bad[y, x + 1]: dr.line([X1, Y0, X1, Y1], fill=(255, 40, 40), width=lw)
    return changed, level, mark


def drift_report(before, after, boxes):
    """整图模式下，框外被 AI 改动了多少（给人参考），以及输出里有没有残留红框。"""
    import numpy as np
    a = np.asarray(before.convert("RGB")).astype(np.int16); b = np.asarray(after.convert("RGB")).astype(np.int16)
    H, W = a.shape[:2]; inside = np.zeros((H, W), bool)
    for bx in boxes:
        mx, my = int(bx["w"] * 0.25) + 8, int(bx["h"] * 0.25) + 8      # 框周围留一圈，衔接区不算
        inside[max(0, int(bx["y"]) - my):int(bx["y"] + bx["h"]) + my, max(0, int(bx["x"]) - mx):int(bx["x"] + bx["w"]) + mx] = True
    d = np.abs(a - b).mean(2)
    out = d[~inside]
    changed = float((out > 24).mean()) if out.size else 0.0
    red = (b[..., 0] > 200) & (b[..., 1] < 50) & (b[..., 2] < 50) & ~((a[..., 0] > 200) & (a[..., 1] < 50) & (a[..., 2] < 50))
    level = "很小" if changed < 0.03 else "有一些" if changed < 0.12 else "较大"
    return changed, level, int(red.sum())


def run_edit(sid, img, boxes, editor=ai_edit, mode="patch", whole_editor=ai_edit_whole, named=None):
    """mode="patch"：只改样子、形状不变——裁一块改完只贴回框内，框外一个像素不变。
       mode="whole"：要加东西或改形状——整张图交给 AI（发干净原图 + 红框位置图），用 AI 的整张结果。"""
    sl = shots(); shot = next((s for s in sl["shots"] if s["id"] == sid), {"id": sid, "refs": []})
    if named:   # 修改意见里 @ 点名的参考图：{路径: 名称}
        shot = dict(shot, _named={r: n for r, n in named.items() if os.path.exists(os.path.join(ROOT, r))})
    img = img.convert("RGB"); W, H = img.size
    stamp = time.strftime("%m%d_%H%M%S") + f"{int(time.time() * 1000) % 1000:03d}"
    boxes = [b for b in boxes if int(b["w"]) >= 8 and int(b["h"]) >= 8]
    if mode == "crop":
        if not boxes: return None, "没有裁切框"
        bx = boxes[0]; x0, y0 = int(round(bx["x"])), int(round(bx["y"]))
        cw = int(round(bx["w"])); ch = round(cw * 9 / 16)
        x0 = max(0, min(x0, W - cw)); y0 = max(0, min(y0, H - ch))
        crop = img.crop((x0, y0, x0 + cw, y0 + ch))
        print(f"INFO:裁切范围 {cw}x{ch}（原图 {W}x{H}，相当于拉近 {W / cw:.1f} 倍）", flush=True)
        crop_path = os.path.join(FIX, f"{sid}_{stamp}_crop.png")
        crop.resize((max(W, cw), max(H, ch)), Image.LANCZOS).save(crop_path)   # 「修改前」显示用：直接放大的裁切图
        ed, err = ai_redraw(crop, bx.get("text", "").strip(), shot, sl.get("bible", {}))
        if err: return None, err
        if abs(ed.size[0] / ed.size[1] - 16 / 9) > 0.03: print(f"INFO:AI 输出的比例不是 16:9（{ed.size[0]}x{ed.size[1]}），已裁成 16:9", flush=True); ed = frame16x9(ed)
        ed = ed.convert("RGB")
        if ed.size[0] < W: ed = ed.resize((W, H), Image.LANCZOS)
        changed, level, mark = redraw_report(crop, ed)
        mark_path = os.path.join(FIX, f"{sid}_{stamp}_diff.png"); mark.save(mark_path)
        print(f"INFO:输出 {ed.size[0]}x{ed.size[1]}；和裁切图相比，内容变化{level}（约 {changed*100:.0f}% 的画面明显不同，红色标出）", flush=True)
        print("CROP:" + rel(crop_path), flush=True); print("DIFF:" + rel(mark_path), flush=True)
        with LOCK:
            stt = load_state(); stt["spent"] = stt.get("spent", 0) + 0.14
            json.dump(stt, open(STATE, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        out = os.path.join(FIX, f"{sid}_{stamp}.png"); ed.save(out)
        return out, ""
    if mode == "whole":
        marked = mark_boxes(img, boxes); marked.save(os.path.join(FIX, f"{sid}_{stamp}_marked.png"))
        ed, err = whole_editor(img, marked, boxes, shot, sl.get("bible", {}))
        if err: return None, err
        if abs(ed.size[0] / ed.size[1] - W / H) > 0.03: print(f"INFO:AI 输出的比例和原图不一样（{ed.size[0]}x{ed.size[1]}），已裁成 16:9", flush=True); ed = frame16x9(ed)
        ed = ed.convert("RGB").resize((W, H), Image.LANCZOS)
        ln = max(4, int(min(W, H) / 180))
        ed, nred = clean_marks(ed, img, boxes, ln)
        if nred: print(f"INFO:AI 的结果里有 {nred} 个像素像标注框线，已换回原图", flush=True)
        strays = stray_lines(ed, img, ln)   # AI 把框线画到了别处（整张输出时画面会挪动）：全图找细长的标注色直线，用周围颜色补掉
        if strays.any(): ed = inpaint(ed, strays); print(f"INFO:AI 在别的位置画了框线（{int(strays.sum())} 个像素），已用周围的颜色补掉，请放大看一下那里", flush=True)
        changed, level, red = drift_report(img, ed, boxes)
        print(f"INFO:框外变化{level}（约 {changed*100:.0f}% 的画面有明显改动）" + (f"；输出里有 {red} 个像素疑似残留红线，请放大看一下" if red > 200 else ""), flush=True)
        with LOCK:
            stt = load_state(); stt["spent"] = stt.get("spent", 0) + 0.14
            json.dump(stt, open(STATE, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        out = os.path.join(FIX, f"{sid}_{stamp}.png"); ed.save(out)
        return out, ""
    for k, b in enumerate(boxes): b["k"] = k        # 框的编号和颜色跟着原来的顺序走
    groups = group_boxes(boxes, W, H)
    if len(boxes) > 1: print(f"INFO:{len(boxes)} 处修改，分 {len(groups)} 次交给 AI（离得近的一次一起改，每次约 $0.14）", flush=True)
    orig = img.copy()
    for gi_, grp in enumerate(groups):
        ux0 = min(b["x"] for b in grp); uy0 = min(b["y"] for b in grp); ux1 = max(b["x"] + b["w"] for b in grp); uy1 = max(b["y"] + b["h"] for b in grp)
        win = crop_window(W, H, (int(ux0), int(uy0), int(ux1 - ux0), int(uy1 - uy0)), pad_ratio=0.8 if len(grp) == 1 else 0.3)
        line = max(4, int(min(win[2] - win[0], win[3] - win[1]) / 160))
        local = [dict(b, x=b["x"] - win[0], y=b["y"] - win[1], poly=[[px - win[0], py - win[1]] for px, py in b["poly"]] if b.get("poly") else None) for b in grp]
        clean = orig.crop(win).convert("RGB"); marked = mark_boxes(clean, local, line)
        marked.save(os.path.join(FIX, f"{sid}_{stamp}_sent{gi_+1}.png"))
        todo = "\n".join(f"- {box_color(b['k'])[0]}色框{b['k']+1}：{b.get('text', '').strip() or '修正这里的问题'}" for b in sorted(grp, key=lambda b: b["k"]))
        ed, err = editor(clean, todo, shot, sl.get("bible", {}), marked=marked, aspect=win_aspect(win))
        if err: return None, err
        cw, ch = win[2] - win[0], win[3] - win[1]; ed = ed.convert("RGB")
        if abs(ed.size[0] / ed.size[1] - cw / ch) > 0.02:   # 比例还是不对：按比例裁中间，不拉伸
            print(f"INFO:AI 返回的比例（{ed.size[0]}x{ed.size[1]}）和发过去的不一样，已按比例裁正，不拉伸", flush=True)
            r = cw / ch; ew, eh = ed.size
            ed = ed.crop(((ew - eh * r) / 2, 0, (ew + eh * r) / 2, eh)) if ew / eh > r else ed.crop((0, (eh - ew / r) / 2, ew, (eh + ew / r) / 2))
        ed = ed.resize((cw, ch), Image.LANCZOS)
        lx0 = min(b["x"] for b in local); ly0 = min(b["y"] for b in local)
        ed, sh = align_to(clean, ed, (lx0, ly0, max(b["x"] + b["w"] for b in local) - lx0, max(b["y"] + b["h"] for b in local) - ly0))
        if sh != (0, 0): print(f"INFO:AI 的结果整体偏了 {sh} 像素，已对齐", flush=True)
        ed, nred = clean_marks(ed, clean, local, line)
        if nred: print(f"INFO:AI 的结果里有 {nred} 个像素像标注框线，已换回原图", flush=True)
        strays = stray_lines(ed, clean, line)
        if strays.any(): ed = inpaint(ed, strays); print(f"INFO:AI 在框里画了框线（{int(strays.sum())} 个像素），已用周围的颜色补掉", flush=True)
        for b in grp:   # 每个框只把自己框里的像素贴回去，框外一个像素不变
            img = paste_back(img, ed, win, (int(b["x"]), int(b["y"]), int(b["w"]), int(b["h"])), poly=b.get("poly"), line=line)
        with LOCK:
            stt = load_state(); stt["spent"] = stt.get("spent", 0) + 0.14
            json.dump(stt, open(STATE, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    out = os.path.join(FIX, f"{sid}_{stamp}.png"); img.save(out)
    return out, ""


def root_image(sid):
    """场景图 / 特写镜头图（moban_game/img/<sid>.jpg）：不在分镜表里、也没有逐句图的，返回路径；否则 None。"""
    g = os.path.join(ROOT, "moban_game", "img")
    if os.path.exists(os.path.join(g, "l", sid + ".jpg")) or any(s["id"] == sid for s in shots().get("shots", [])): return None
    p = os.path.join(g, sid + ".jpg")
    return p if os.path.exists(p) else None


def accept(sid, file_rel):
    import batch as B
    p = os.path.join(ROOT, file_rel)
    tgt = root_image(sid)
    if tgt:   # 场景图 / 特写镜头：原图先备份到 storyboard/out/replaced，按原尺寸替换，不登记逐句图
        bk = os.path.join(HERE, "out", "replaced"); os.makedirs(bk, exist_ok=True)
        shutil.copy2(tgt, os.path.join(bk, f"{sid}_{time.strftime('%m%d_%H%M%S')}.jpg"))
        size = Image.open(tgt).size
        frame16x9(Image.open(p).convert("RGB")).resize(size, Image.LANCZOS).save(tgt, quality=90)
        print(f"INFO:原图已备份到 storyboard/out/replaced", flush=True)
        with LOCK:
            st = load_state(); s = st["shots"].setdefault(sid, {"tries": []})
            s.update(final=os.path.basename(p), status="manual")
            json.dump(st, open(STATE, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        return
    B.install(sid, p)
    with LOCK:
        st = load_state(); s = st["shots"].setdefault(sid, {"tries": []})
        s.update(final=os.path.basename(p), status="manual")
        json.dump(st, open(STATE, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        B.register([k for k, v in st["shots"].items() if v.get("status") in ("pass", "best", "reuse", "manual")])


# ---------------- 网页 ----------------
PAGE = r"""<!doctype html><html lang="zh"><meta charset="utf-8"><title>框选修图</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{--bg:#15171b;--panel:#1d2026;--line:#2c3038;--fg:#e8e4dc;--mut:#9a9fa8;--acc:#ffb547;--red:#ff4d4d;--ok:#5fd18b}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 "Microsoft YaHei","PingFang SC",sans-serif;display:flex;height:100vh}
#side{width:230px;border-right:1px solid var(--line);overflow:auto;flex:none}
#side h3{margin:12px 14px 6px;font-size:13px;color:var(--mut);font-weight:normal}
.shot{padding:7px 14px;cursor:pointer;display:flex;justify-content:space-between;gap:8px;border-left:3px solid transparent}
.shot:hover{background:var(--panel)}.shot.on{background:var(--panel);border-left-color:var(--acc)}
.tag{font-size:12px;color:var(--mut)}.tag.best{color:var(--acc)}.tag.manual{color:#7fb6ff}.tag.pass{color:var(--ok)}
#main{flex:1;display:flex;flex-direction:column;min-width:0}
#top{padding:10px 16px;border-bottom:1px solid var(--line);display:flex;gap:12px;align-items:center;flex-wrap:wrap}
#title{font-size:16px;font-weight:bold}#desc{color:var(--mut);font-size:13px;flex:1;min-width:200px}
#work{flex:1;display:flex;min-height:0}
#stage{flex:1;overflow:auto;padding:14px;position:relative}
#wrap{position:relative;display:inline-block;cursor:crosshair;user-select:none}
#wrap img{display:block;max-width:100%;height:auto}
.box{position:absolute;border:2px solid var(--red);background:rgba(255,77,77,.08)}
.box b{position:absolute;left:-2px;top:-22px;background:var(--red);color:#fff;font-size:12px;padding:0 6px;border-radius:3px 3px 0 0}
#panel{width:340px;border-left:1px solid var(--line);padding:14px;overflow:auto;flex:none;display:flex;flex-direction:column;gap:10px}
.item{background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:8px}
.item .h{display:flex;justify-content:space-between;color:var(--red);font-size:12px;margin-bottom:4px}
textarea{width:100%;min-height:58px;background:#111317;color:var(--fg);border:1px solid var(--line);border-radius:4px;padding:6px;font:inherit;resize:vertical}
button{background:var(--panel);color:var(--fg);border:1px solid var(--line);border-radius:5px;padding:7px 12px;cursor:pointer;font:inherit}
button:hover{border-color:var(--acc)}button.main{background:var(--acc);color:#1a1300;border-color:var(--acc);font-weight:bold}
button:disabled{opacity:.45;cursor:default}
.x{background:none;border:none;color:var(--mut);padding:0 4px}
#msg{font-size:13px;color:var(--mut);white-space:pre-wrap}
.hint{font-size:12px;color:var(--mut)}
#cmp{display:none;gap:10px;align-items:center;flex-wrap:wrap}
.seg{display:inline-flex;border:1px solid var(--line);border-radius:5px;overflow:hidden}.seg button{border:none;border-radius:0}.seg button.on{background:var(--acc);color:#1a1300}
@media (max-width:900px){body{flex-direction:column;height:auto}#side{width:auto;max-height:160px}#work{flex-direction:column}#panel{width:auto;border-left:none;border-top:1px solid var(--line)}}
</style>
<div id="side"><h3>镜头（黄色 = 没通过）</h3><div id="list"></div></div>
<div id="main">
 <div id="top"><span id="title">选一个镜头</span><span id="desc"></span>
  <span id="cmp"><span class="seg"><button id="vOld">修改前</button><button id="vNew" class="on">修改后</button></span></span></div>
 <div id="work">
  <div id="stage"><div id="wrap"><img id="img" alt=""></div></div>
  <div id="panel">
   <div class="hint">在图上按住鼠标拖出方框，框住要改的地方，再在右边写一句怎么改。可以框好几处，会依次修改。框外的像素保证一个不变。</div>
   <div id="items"></div>
   <div class="item" id="modeBox"><label style="display:flex;gap:6px;align-items:flex-start;margin-bottom:6px"><input type="radio" name="mode" value="patch" checked> <span>只改样子，形状不变<br><span class="hint">换颜色、盖掉字……框外一个像素不变</span></span></label>
    <label style="display:flex;gap:6px;align-items:flex-start"><input type="radio" name="mode" value="whole"> <span>要加东西或改形状<br><span class="hint">箱子里加金子、戴上帽子……整张交给 AI，框外可能有细微变化</span></span></label></div>
   <button id="go" class="main" disabled>修改框里的内容</button>
   <div id="after" style="display:none;flex-direction:column;gap:8px">
    <button id="ok" class="main">采用这张，换进游戏</button>
    <button id="more">在这张基础上继续改</button>
    <button id="drop">不要，回到修改前</button>
   </div>
   <div id="msg"></div>
  </div>
 </div>
</div>
<script>
const $=s=>document.querySelector(s);let S=[],cur=null,src=null,boxes=[],cand=null,orig=null,view='new';
async function api(p,b){const r=await fetch(p,b?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}:{});return r.json()}
const L={best:'没通过',pass:'通过',manual:'手动修过',reuse:'沿用',todo:'未出图'};
async function load(){S=await api('/api/shots');const l=$('#list');l.innerHTML='';
 S.sort((a,b)=>(a.status==='best'?0:1)-(b.status==='best'?0:1));
 for(const s of S){const d=document.createElement('div');d.className='shot'+(cur&&cur.id===s.id?' on':'');d.innerHTML=`<span>${s.id}</span><span class="tag ${s.status}">${L[s.status]||s.status||''}</span>`;d.onclick=()=>pick(s);l.appendChild(d)}}
function pick(s){cur=s;src=s.img;orig=s.img;cand=null;boxes=[];$('#title').textContent=s.id;$('#desc').textContent=s.desc;show(src);render();$('#after').style.display='none';$('#cmp').style.display='none';$('#msg').textContent=s.img?'':'这个镜头还没有图';load()}
function show(p){$('#img').src=p?('/file?p='+encodeURIComponent(p)+'&t='+Date.now()):''}
const img=$('#img'),wrap=$('#wrap');let drag=null;
function sc(){return img.naturalWidth/img.clientWidth}
wrap.onmousedown=e=>{if(!src||cand)return;const r=img.getBoundingClientRect();drag={x:e.clientX-r.left,y:e.clientY-r.top};drag.el=document.createElement('div');drag.el.className='box';wrap.appendChild(drag.el)};
window.onmousemove=e=>{if(!drag)return;const r=img.getBoundingClientRect();let x=Math.max(0,Math.min(e.clientX-r.left,r.width)),y=Math.max(0,Math.min(e.clientY-r.top,r.height));
 const a=Math.min(x,drag.x),b=Math.min(y,drag.y),w=Math.abs(x-drag.x),h=Math.abs(y-drag.y);Object.assign(drag.el.style,{left:a+'px',top:b+'px',width:w+'px',height:h+'px'});drag.box={a,b,w,h}};
window.onmouseup=()=>{if(!drag)return;const bx=drag.box;drag.el.remove();if(bx&&bx.w>6&&bx.h>6){const k=sc();boxes.push({x:Math.round(bx.a*k),y:Math.round(bx.b*k),w:Math.round(bx.w*k),h:Math.round(bx.h*k),text:''});render();setTimeout(()=>{const t=document.querySelectorAll('#items textarea');t[t.length-1]&&t[t.length-1].focus()},0)}drag=null};
function render(){wrap.querySelectorAll('.box').forEach(e=>e.remove());const k=sc()||1;
 boxes.forEach((b,i)=>{const d=document.createElement('div');d.className='box';Object.assign(d.style,{left:b.x/k+'px',top:b.y/k+'px',width:b.w/k+'px',height:b.h/k+'px'});d.innerHTML=`<b>${i+1}</b>`;if(!cand)wrap.appendChild(d)});
 const it=$('#items');it.innerHTML='';boxes.forEach((b,i)=>{const d=document.createElement('div');d.className='item';d.innerHTML=`<div class="h"><span>框 ${i+1}</span><button class="x" title="删掉这个框">✕</button></div><textarea placeholder="比如：把钞票换成第四套人民币，灰蓝色，不要粉红色"></textarea>`;
  const t=d.querySelector('textarea');t.value=b.text;t.oninput=()=>{b.text=t.value;upd()};d.querySelector('.x').onclick=()=>{boxes.splice(i,1);render()};it.appendChild(d)});upd()}
function upd(){$('#go').disabled=!(boxes.length&&boxes.every(b=>b.text.trim())&&!cand)}
window.onresize=render;img.onload=render;
$('#go').onclick=async()=>{$('#go').disabled=true;$('#msg').textContent='AI 正在修改，每个框大约 30～60 秒…';
 const mode=(document.querySelector('input[name=mode]:checked')||{}).value||'patch';
 const r=await api('/api/edit',{sid:cur.id,src,boxes,mode});if(r.error){$('#msg').textContent='× '+r.error;upd();return}
 cand=r.file;view='new';show(cand);$('#cmp').style.display='flex';$('#vNew').classList.add('on');$('#vOld').classList.remove('on');$('#after').style.display='flex';$('#msg').textContent='改好了。用上面的「修改前 / 修改后」切换对比。'+(r.info?'\n'+r.info:'');render()};
$('#vOld').onclick=()=>{show(src);$('#vOld').classList.add('on');$('#vNew').classList.remove('on')};
$('#vNew').onclick=()=>{show(cand);$('#vNew').classList.add('on');$('#vOld').classList.remove('on')};
$('#ok').onclick=async()=>{const r=await api('/api/accept',{sid:cur.id,file:cand});$('#msg').textContent=r.error?'× '+r.error:'✓ 已换进游戏（原来的图还留在 out 文件夹里）';if(!r.error){src=cand;cand=null;boxes=[];$('#after').style.display='none';$('#cmp').style.display='none';render();load()}};
$('#more').onclick=()=>{src=cand;cand=null;boxes=[];show(src);$('#after').style.display='none';$('#cmp').style.display='none';$('#msg').textContent='在修改后的图上继续框选（还没换进游戏）';render()};
$('#drop').onclick=()=>{cand=null;show(src);$('#after').style.display='none';$('#cmp').style.display='none';$('#msg').textContent='';render()};
load();
</script></html>"""


class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass

    def send(self, code, body, ctype="application/json; charset=utf-8"):
        if isinstance(body, (dict, list)): body = json.dumps(body, ensure_ascii=False).encode()
        elif isinstance(body, str): body = body.encode()
        self.send_response(code); self.send_header("Content-Type", ctype); self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store"); self.end_headers(); self.wfile.write(body)

    def do_GET(self):
        u = urllib.parse.urlparse(self.path); q = urllib.parse.parse_qs(u.query)
        if u.path == "/": return self.send(200, PAGE, "text/html; charset=utf-8")
        if u.path == "/api/shots":
            st = load_state(); out = []
            for s in shots()["shots"]:
                p = current_image(s["id"], st)
                out.append({"id": s["id"], "desc": s.get("desc", ""), "status": (st["shots"].get(s["id"]) or {}).get("status", "todo"), "img": rel(p) if p else None})
            return self.send(200, out)
        if u.path == "/file":
            p = os.path.normpath(os.path.join(ROOT, q.get("p", [""])[0]))
            if not p.startswith(os.path.normpath(ROOT)) or not os.path.isfile(p): return self.send(404, {"error": "没有这个文件"})
            ct = "image/png" if p.lower().endswith(".png") else "image/jpeg"
            return self.send(200, open(p, "rb").read(), ct)
        self.send(404, {"error": "not found"})

    def do_POST(self):
        n = int(self.headers.get("Content-Length", "0")); b = json.loads(self.rfile.read(n) or b"{}")
        try:
            if self.path == "/api/edit":
                print(f"修改 {b['sid']}：{len(b['boxes'])} 个框 …", flush=True)
                import io, contextlib
                buf = io.StringIO()
                with contextlib.redirect_stdout(buf):
                    out, err = run_edit(b["sid"], Image.open(os.path.join(ROOT, b["src"])), b["boxes"], mode=b.get("mode", "patch"))
                info = "\n".join(l[5:] for l in buf.getvalue().splitlines() if l.startswith("INFO:"))
                print("  ×", err if err else "  ✓ " + rel(out) + ("  " + info if info else ""), flush=True)
                return self.send(200, {"error": err} if err else {"file": rel(out), "info": info})
            if self.path == "/api/accept":
                accept(b["sid"], b["file"]); print(f"{b['sid']} 已换进游戏：{b['file']}", flush=True)
                return self.send(200, {"ok": True})
        except Exception as e:
            return self.send(200, {"error": f"{type(e).__name__}: {e}"})
        self.send(404, {"error": "not found"})


def approve(sid):
    with LOCK:
        st = load_state(); s = st["shots"].setdefault(sid, {"tries": []}); s["status"] = "manual"
        json.dump(st, open(STATE, "w", encoding="utf-8"), ensure_ascii=False, indent=1)


def cli(argv):
    cmd, sid = argv[0], argv[1]
    if cmd == "edit":
        req = json.loads(base64.b64decode(argv[2]).decode("utf-8"))
        st = load_state()
        src = os.path.join(ROOT, req["src"]) if req.get("src") else current_image(sid, st)
        if not src or not os.path.exists(src): print("ERROR:这个镜头还没有图"); return 1
        img = frame16x9(Image.open(src).convert("RGB")); W, H = img.size
        boxes = []
        for b in req["boxes"]:
            bb = {"x": b["fx"] * W, "y": b["fy"] * H, "w": b["fw"] * W, "h": b["fh"] * H, "text": b.get("text", "")}
            if b.get("poly") and len(b["poly"]) >= 3 and req.get("mode") != "crop":   # 套索选区：多边形（0~1 比例）
                bb["poly"] = [[px * W, py * H] for px, py in b["poly"]]
                xs, ys = [p[0] for p in bb["poly"]], [p[1] for p in bb["poly"]]
                bb.update(x=min(xs), y=min(ys), w=max(xs) - min(xs), h=max(ys) - min(ys))
            boxes.append(bb)
        mode = req.get("mode", "patch")
        how = {"whole": "整张交给 AI（可以加东西、改形状）", "crop": "裁切后 AI 重画成高清"}.get(mode, "只改框里、贴回原图（框外一个像素不变）")
        print(f"修改 {sid}：{len(boxes)} 个框，{how}；原图 {rel(src)}", flush=True)
        for i, b in enumerate(boxes): print(f"  框{i+1}：{b['text']}", flush=True)
        named = {r["path"]: r["name"] for r in req.get("refs", []) if r.get("path")}
        if named: print("  @ 点名的参考图：" + "、".join(f"{n}（{p}）" for p, n in named.items()), flush=True)
        out, err = run_edit(sid, img, boxes, mode=mode, named=named)
        if err: print("ERROR:" + err, flush=True); return 1
        with LOCK:   # 记成这个镜头的候选：修图窗口关了也能在审阅页「其他候选」里找到、换进游戏
            stt = load_state(); sh = stt["shots"].setdefault(sid, {"tries": []})
            sh.setdefault("fixes", []).append({"file": os.path.basename(out), "how": {"whole": "整张修改", "crop": "裁切重画"}.get(mode, "框选修图"),
                                               "note": "；".join(b["text"] for b in boxes if b.get("text"))[:200], "at": time.strftime("%Y-%m-%d %H:%M")})
            json.dump(stt, open(STATE, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        print("RESULT:" + rel(out), flush=True); return 0
    if cmd == "local":   # 剪辑台「换成本地图片」之后调用：游戏里的图剪辑台已经换好了，这里只把本地原图存成这个镜头的候选、记成当前用的图
        src = argv[2]
        if not os.path.exists(src): print("ERROR:找不到本地图片 " + src); return 1
        ext = os.path.splitext(src)[1].lower() or ".png"
        dst = os.path.join(FIX, f"{sid}_{time.strftime('%m%d_%H%M%S')}_local{ext}"); shutil.copy2(src, dst)
        with LOCK:
            stt = load_state(); sh = stt["shots"].setdefault(sid, {"tries": []})
            sh.setdefault("fixes", []).append({"file": os.path.basename(dst), "how": "本地替换", "note": "从本地换的：" + os.path.basename(src), "at": time.strftime("%Y-%m-%d %H:%M")})
            sh.update(final=os.path.basename(dst), status="local")   # local：人换的图，还没审；出图脚本不会再覆盖它
            json.dump(stt, open(STATE, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        print(f"{sid} 已记下本地替换的原图：{rel(dst)}", flush=True); return 0
    if cmd == "accept":
        accept(sid, argv[2]); print(f"{sid} 已换进游戏：{argv[2]}", flush=True); return 0
    if cmd == "approve":
        approve(sid); print(f"{sid} 已标记为人工确认", flush=True); return 0
    print("ERROR:不认识的命令 " + cmd); return 2


def main():
    if len(sys.argv) >= 3: sys.exit(cli(sys.argv[1:]))
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), H)
    url = f"http://127.0.0.1:{PORT}/"
    print("框选修图已启动：", url, "\n用完关掉这个窗口即可。", flush=True)
    threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    srv.serve_forever()


if __name__ == "__main__":
    main()
