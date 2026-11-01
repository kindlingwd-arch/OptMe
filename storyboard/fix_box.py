"""框选修图：在分镜图上拖出矩形框，写一句修改意见，只改框里的内容，框外像素一个不变。
用法：
  影游剪辑台里：故事板模式选中一句台词 →「框选修图…」（剪辑台在后台调用下面的命令行模式）
  单独使用：双击 run_fix_box.bat（或 python fix_box.py），浏览器会自动打开操作页面
  命令行：python fix_box.py edit <镜头> <base64(JSON)>   JSON = {"src": 相对 moban_art 的路径或空, "mode": "patch"|"whole", "boxes": [{"fx","fy","fw","fh","text"}]}（框用 0~1 的比例，相对 16:9 画面）
两种修改方式：
  patch（只改样子、形状不变，比如换颜色、盖掉字）：裁一块交给 AI，改完只把框里的像素羽化贴回，框外一个像素不变。
  whole（要加东西或改形状，比如箱子里加金子、戴上帽子）：发干净原图 + 标了红框的位置图，用 AI 改完的整张图；会报告框外变化有多大。
         python fix_box.py accept <镜头> <结果文件（相对 moban_art）>
         python fix_box.py approve <镜头>                     不改图，标记为人工确认
原理见下面「两种修改方式」。
需要 GEMINI_API_KEY 和代理（和出图脚本一样）。修改结果在 out\\fix\\，点「采用」才换进游戏。
"""
import os, sys, json, time, base64, threading, webbrowser, urllib.parse
from io import BytesIO
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
FIX = os.path.join(HERE, "out", "fix"); os.makedirs(FIX, exist_ok=True)
STATE = os.path.join(HERE, "out", "batch", "state.json")
PORT = int(os.environ.get("FIX_BOX_PORT", "8765"))
LOCK = threading.Lock()


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
    return int(max(0, x0)), int(max(0, y0)), int(min(W, x1)), int(min(H, y1))


def marked_crop(img, win, box, line=None):
    """裁出窗口，在框外侧一圈画红框（只用于发给 AI）。"""
    x0, y0, x1, y1 = win
    c = img.crop(win).convert("RGB")
    line = line or max(4, int(min(c.size) / 160))
    bx, by, bw, bh = box[0] - x0, box[1] - y0, box[2], box[3]
    d = ImageDraw.Draw(c)
    o = line  # 红框画在框外侧，框内像素不被压住
    d.rectangle([bx - o, by - o, bx + bw + o - 1, by + bh + o - 1], outline=(255, 0, 0), width=line)
    return c


def paste_back(orig, edited_crop, win, box, feather=None):
    """只把框内（向内羽化）的像素从 AI 结果贴回原图。"""
    x0, y0, x1, y1 = win
    cw, ch = x1 - x0, y1 - y0
    ed = edited_crop.convert("RGB").resize((cw, ch), Image.LANCZOS)
    feather = feather or max(3, int(min(box[2], box[3]) * 0.06))
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


def ai_edit(crop, instruction, shot, bible):
    import gen_images as gi
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not key: return None, "没有找到 GEMINI_API_KEY"
    parts = []
    for i, r in enumerate(shot.get("refs", [])):
        p = os.path.join(ROOT, r)
        if os.path.exists(p):
            im = Image.open(p).convert("RGB"); im.thumbnail((640, 640)); b = BytesIO(); im.save(b, "JPEG", quality=85)
            parts += [{"text": f"参考图{i+1}：{os.path.splitext(os.path.basename(r))[0]}"}, {"inline_data": {"mime_type": "image/jpeg", "data": base64.b64encode(b.getvalue()).decode()}}]
    b = BytesIO(); crop.save(b, "PNG")
    parts += [{"text": "要修改的图（电影剧照的一个局部，红色方框标出了要改的地方）："}, {"inline_data": {"mime_type": "image/png", "data": base64.b64encode(b.getvalue()).decode()}}]
    rules = "；".join(f"{k}：{v}" for k, v in bible.items() if k in ("时代地点", "出租车", "人物", "道具", "钱", "风格"))
    parts.append({"text": f"""请修改这张图：只改红色方框里面的内容，方框外的所有东西（人物、背景、光线、颜色、位置）保持完全不变。
修改要求：{instruction}
修改后：画面构图、视角、光线和画风与原图一致，衔接自然；清晰度和景深要和所在位置一致（周围是虚化的，改的东西也要同样虚化）；删除红色方框本身，不要留下任何红线；画面里不要出现任何文字、字母或水印。
背景设定（供参考）：{rules}
只输出修改后的完整图片，尺寸比例和输入的图一样。"""})
    body = {"contents": [{"parts": parts}], "generationConfig": {"responseModalities": ["IMAGE"]}}
    for a in range(3):
        st, js = gi.http(f"{gi.G}/models/{gi.gemini_model(key)}:generateContent", body, {"x-goog-api-key": key})
        if st == 200:
            for c in js.get("candidates", []):
                for pt in (c.get("content") or {}).get("parts", []):
                    d = pt.get("inline_data") or pt.get("inlineData")
                    if d and d.get("data"): return Image.open(BytesIO(base64.b64decode(d["data"]))), ""
            return None, "AI 没返回图片：" + json.dumps(js, ensure_ascii=False)[:200]
        if st == 402: return None, "Gemini 额度用完了，请到 AI Studio 充值"
        if st in (429, 500, 503, 0): time.sleep(10 * (a + 1)); continue
        return None, f"HTTP {st} " + json.dumps(js, ensure_ascii=False)[:200]
    return None, "多次失败"


def frame16x9(img):
    """和游戏里一样取中间的 16:9 画面（剪辑台显示的就是这个范围）。"""
    w, h = img.size; nh = round(w * 9 / 16)
    if nh <= h: return img.crop((0, (h - nh) // 2, w, (h - nh) // 2 + nh))
    nw = round(h * 16 / 9); return img.crop(((w - nw) // 2, 0, (w - nw) // 2 + nw, h))


def mark_boxes(img, boxes):
    """在原图副本上画编号红框（只用来给 AI 指位置，不是要修改的那张）。"""
    m = img.convert("RGB").copy(); d = ImageDraw.Draw(m)
    line = max(4, int(min(m.size) / 180))
    from PIL import ImageFont
    font = None
    for name in ("msyhbd.ttc", "msyh.ttc", "arialbd.ttf", "DejaVuSans-Bold.ttf"):
        try: font = ImageFont.truetype(name, max(22, line * 6)); break
        except Exception: pass
    if font is None:
        try: font = ImageFont.load_default(size=max(22, line * 6))
        except Exception: font = None
    for k, b in enumerate(boxes):
        x, y, w, h = int(b["x"]), int(b["y"]), int(b["w"]), int(b["h"])
        d.rectangle([x - line, y - line, x + w + line - 1, y + h + line - 1], outline=(255, 0, 0), width=line)
        tag = str(k + 1); ty = max(0, y - line - max(26, line * 7))
        d.rectangle([x - line, ty, x - line + max(26, line * 7), y - line], fill=(255, 0, 0))
        d.text((x - line + 6, ty + 1), tag, fill=(255, 255, 255), font=font)
    return m


def ai_edit_whole(img, marked, boxes, shot, bible):
    """整图模式：发干净原图 + 标了红框的位置图，AI 输出修改后的整张图。"""
    import gen_images as gi
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not key: return None, "没有找到 GEMINI_API_KEY"
    parts = []
    for i, r in enumerate(shot.get("refs", [])):
        p = os.path.join(ROOT, r)
        if os.path.exists(p):
            im = Image.open(p).convert("RGB"); im.thumbnail((640, 640)); b = BytesIO(); im.save(b, "JPEG", quality=85)
            parts += [{"text": f"参考图{i+1}：{os.path.splitext(os.path.basename(r))[0]}"}, {"inline_data": {"mime_type": "image/jpeg", "data": base64.b64encode(b.getvalue()).decode()}}]
    def png(im):
        b = BytesIO(); im.save(b, "PNG"); return base64.b64encode(b.getvalue()).decode()
    parts += [{"text": "【图A：要修改的原图】"}, {"inline_data": {"mime_type": "image/png", "data": png(img)}},
              {"text": "【图B：位置标注】和图A是同一张图，只是用编号红框标出了要修改的地方。图B只用来看位置，不要修改图B。"}, {"inline_data": {"mime_type": "image/png", "data": png(marked)}}]
    todo = "\n".join(f"- 红框{k+1}：{b.get('text', '').strip() or '修正这里的问题'}" for k, b in enumerate(boxes))
    rules = "；".join(f"{k}：{v}" for k, v in bible.items() if k in ("时代地点", "出租车", "人物", "道具", "钱", "风格"))
    parts.append({"text": f"""请在图A上做下面的修改，修改的位置看图B里对应编号的红框：
{todo}
要求：
1. 只改红框标出的地方。新加的东西可以和周围自然衔接（比如影子、反光、被遮挡的边缘），但不要改动画面里其他的人物、物体、背景、构图和机位。
2. 光线、颜色、颗粒感、画风和图A完全一致，看不出修改的痕迹；清晰度和景深要和所在位置一致——那里是虚化的，新加的东西也要同样虚化，不要比周围更清晰。
3. 输出修改后的完整图A，尺寸比例和图A相同；输出里不要有红框、编号、任何文字或水印。
背景设定（供参考）：{rules}"""})
    body = {"contents": [{"parts": parts}], "generationConfig": {"responseModalities": ["IMAGE"], "imageConfig": {"aspectRatio": "16:9"}}}
    for a in range(3):
        st, js = gi.http(f"{gi.G}/models/{gi.gemini_model(key)}:generateContent", body, {"x-goog-api-key": key})
        if st == 200:
            for c in js.get("candidates", []):
                for pt in (c.get("content") or {}).get("parts", []):
                    d = pt.get("inline_data") or pt.get("inlineData")
                    if d and d.get("data"): return Image.open(BytesIO(base64.b64decode(d["data"]))), ""
            return None, "AI 没返回图片：" + json.dumps(js, ensure_ascii=False)[:200]
        if st == 402: return None, "Gemini 额度用完了，请到 AI Studio 充值"
        if st in (429, 500, 503, 0): time.sleep(10 * (a + 1)); continue
        return None, f"HTTP {st} " + json.dumps(js, ensure_ascii=False)[:200]
    return None, "多次失败"


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


def run_edit(sid, img, boxes, editor=ai_edit, mode="patch", whole_editor=ai_edit_whole):
    """mode="patch"：只改样子、形状不变——裁一块改完只贴回框内，框外一个像素不变。
       mode="whole"：要加东西或改形状——整张图交给 AI（发干净原图 + 红框位置图），用 AI 的整张结果。"""
    sl = shots(); shot = next((s for s in sl["shots"] if s["id"] == sid), {"id": sid, "refs": []})
    img = img.convert("RGB"); W, H = img.size
    stamp = time.strftime("%m%d_%H%M%S") + f"{int(time.time() * 1000) % 1000:03d}"
    boxes = [b for b in boxes if int(b["w"]) >= 8 and int(b["h"]) >= 8]
    if mode == "whole":
        marked = mark_boxes(img, boxes); marked.save(os.path.join(FIX, f"{sid}_{stamp}_marked.png"))
        ed, err = whole_editor(img, marked, boxes, shot, sl.get("bible", {}))
        if err: return None, err
        if abs(ed.size[0] / ed.size[1] - W / H) > 0.03: print(f"INFO:AI 输出的比例和原图不一样（{ed.size[0]}x{ed.size[1]}），已裁成 16:9", flush=True); ed = frame16x9(ed)
        ed = ed.convert("RGB").resize((W, H), Image.LANCZOS)
        changed, level, red = drift_report(img, ed, boxes)
        print(f"INFO:框外变化{level}（约 {changed*100:.0f}% 的画面有明显改动）" + (f"；输出里有 {red} 个像素疑似残留红线，请放大看一下" if red > 200 else ""), flush=True)
        with LOCK:
            stt = load_state(); stt["spent"] = stt.get("spent", 0) + 0.14
            json.dump(stt, open(STATE, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        out = os.path.join(FIX, f"{sid}_{stamp}.png"); ed.save(out)
        return out, ""
    for i, bx in enumerate(boxes):
        box = (int(bx["x"]), int(bx["y"]), int(bx["w"]), int(bx["h"]))
        if box[2] < 8 or box[3] < 8: continue
        win = crop_window(W, H, box)
        crop = marked_crop(img, win, box)
        crop.save(os.path.join(FIX, f"{sid}_{stamp}_sent{i+1}.png"))
        ed, err = editor(crop, bx.get("text", "").strip() or "修正这里的问题", shot, sl.get("bible", {}))
        if err: return None, err
        img = paste_back(img, ed, win, box)
        with LOCK:
            stt = load_state(); stt["spent"] = stt.get("spent", 0) + 0.14
            json.dump(stt, open(STATE, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    out = os.path.join(FIX, f"{sid}_{stamp}.png"); img.save(out)
    return out, ""


def accept(sid, file_rel):
    import batch as B
    p = os.path.join(ROOT, file_rel)
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
        boxes = [{"x": b["fx"] * W, "y": b["fy"] * H, "w": b["fw"] * W, "h": b["fh"] * H, "text": b.get("text", "")} for b in req["boxes"]]
        mode = req.get("mode", "patch")
        print(f"修改 {sid}：{len(boxes)} 个框，{'整张交给 AI（可以加东西、改形状）' if mode == 'whole' else '只改框里、贴回原图（框外一个像素不变）'}；原图 {rel(src)}", flush=True)
        for i, b in enumerate(boxes): print(f"  框{i+1}：{b['text']}", flush=True)
        out, err = run_edit(sid, img, boxes, mode=mode)
        if err: print("ERROR:" + err, flush=True); return 1
        print("RESULT:" + rel(out), flush=True); return 0
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
