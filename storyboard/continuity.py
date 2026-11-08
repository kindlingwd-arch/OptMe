"""前后镜头衔接检查（continuity）：同一场里相邻两个镜头接不接得上——视线和方位、人物位置、越轴、地点背景、时间光线、衣服道具状态。
单张图的质检（batch.py）只看这张图对不对得上它自己的分镜；这里专门看「连起来播」时对不对得上。
用法：
  python continuity.py prompt [场景id …]   出图前：查同一场相邻镜头的分镜字段（文字模型，每场约 $0.01）
  python continuity.py image  [场景id …]   出图后：把同一场的成图按顺序一起给质检模型看（每场约 $0.01～0.02）
  不写场景 = 全部场景（只有一个镜头的场景跳过）。
结果写进 storyboard\\out\\continuity.json，影游剪辑台的审阅页（① 提示词 / ② 图片）会显示；镜头改过或图换过，对应结果自动标成「已过期」。
需要 GEMINI_API_KEY 和代理（和出图脚本一样）。
"""
import os, sys, json, time, base64
from io import BytesIO

HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import gen_images as gi          # 顺带用上它的代理修正
from PIL import Image

GAME = os.path.join(ROOT, "moban_game"); IMG = os.path.join(GAME, "img", "l")
OUT = os.path.join(HERE, "out", "continuity.json")
STATE = os.path.join(HERE, "out", "batch", "state.json")
QC_MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.8-flash")
LIMG = set()
FP_KEYS = ("shot", "in_frame", "location", "layout", "desc")     # 剪辑台按同样的字段判断「改过没有」


def fp(shot):
    return "|".join(str(shot.get(k) or "") for k in FP_KEYS)


def load_N():
    s = open(os.path.join(GAME, "index.html"), encoding="utf-8").read()
    a = s.index("const N=") + len("const N=")
    N = json.JSONDecoder().raw_decode(s[a:])[0]
    limg = []
    if "const LIMG=" in s:
        try: limg = json.JSONDecoder().raw_decode(s[s.index("const LIMG=") + len("const LIMG="):])[0]
        except Exception: pass
    return N, set(limg)


def scene_items(N, nid, shots, limg=()):
    """一场戏按播放顺序的台词；有分镜图的标上镜头（和剪辑台的 limgOf 同样的规则：台词上登记的图，否则按 场景_两位行号）。"""
    out = []
    for i, l in enumerate(N[nid].get("lines", [])):
        meta = l[2] if len(l) > 2 and isinstance(l[2], dict) else {}
        img = meta.get("img"); sid = img.split("/")[-1] if img else None
        if not sid and not str(l[0] or "").startswith("@"):
            k = f"{nid}_{i:02d}"
            if k in limg or k in shots or os.path.exists(os.path.join(IMG, k + ".jpg")): sid = k
        out.append({"i": i, "who": str(l[0] or ""), "text": str(l[1] if len(l) > 1 else ""), "sid": sid, "shot": shots.get(sid) if sid else None})
    return out


def scene_title(N, nid):
    n = N[nid]; return n.get("end") or n.get("title") or nid


def line_label(it):
    if it["who"].startswith("@"): return f"（字幕 / 旁白提示：{it['text']}）"
    return f"第{it['i'] + 1}句 {it['who'] or '旁白'}：{it['text']}"


def shot_text(s):
    return f"景别 {s.get('shot', '')}；画面里 {s.get('in_frame', '')}；场景 {s.get('location', '')}；构图 {s.get('layout', '')}；画面描述 {s.get('desc', '')}"


RULES = """只检查【相邻两个镜头之间】接不接得上，不要评价单个镜头本身画得好不好（那是另一道检查）：
1. 视线和方位：上一个镜头里人物看向哪里（左侧车窗、右侧车窗、前方、后座、车外某处），下一个镜头里被看的人或东西就应该出现在那个方向，并从对应的位置拍过去。例：司机扭头看左侧车窗外，下一个镜头应从车内透过左侧车窗看到窗外的人，而不是透过前挡风玻璃看到车头前的人。
2. 人物位置：谁坐哪个座位、站在车的哪一侧，前后一致（出租车是左舵，司机在左前座）。
3. 越轴：同一场里两个人在画面里的左右关系不能无故对调。
4. 地点和背景：同一时刻的相邻镜头，地点和背景要是同一个地方。
5. 时间、天气、光线、色调：前后一致（有时间跳过的字幕、或明显换了场景的除外）。
6. 衣服、帽子、手套、道具、车门车窗开关的状态：前后一致，除非台词或描述交代了变化。
7. 人和物的关系前后连贯：在场的人不会无故消失（车在行驶时司机一直在驾驶座、手握方向盘；上一张在后座的人，下一张那个座位不能空着）；拿着、放在腿上的东西不会凭空出现或消失。
只报真正会让观众觉得「接不上、跳了」的问题；可以有合理解释的不要报。"""

SCHEMA = """输出 JSON：{"issues":[{"a":"上一个镜头的 id","b":"下一个镜头的 id","level":"bad（明显接不上）或 warn（可能接不上）","what":"一句话说清楚哪里接不上","fix":"修改建议：改哪个镜头、怎么改","decide":true 或 false}]}
如果改前一个、改后一个都说得通（属于创作选择），在 fix 里写出两种改法，并把 decide 设为 true，由人来定。没有问题就输出 {"issues":[]}。"""


def ask(parts):
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not key: return None, "没有找到 GEMINI_API_KEY"
    body = {"contents": [{"parts": parts}], "generationConfig": {"responseMimeType": "application/json", "temperature": 0.1}}
    last = ""
    for a in range(3):
        st, js = gi.http(f"{gi.G}/models/{QC_MODEL}:generateContent", body, {"x-goog-api-key": key})
        if st == 200:
            v = gi.json_reply(js)
            return (v, "") if v is not None else (None, "质检返回看不懂：" + json.dumps(js, ensure_ascii=False)[:200])
        last = f"HTTP {st} " + json.dumps(js, ensure_ascii=False)[:200]
        print("  失败：" + last, flush=True)
        if st in (429, 500, 503, 0): time.sleep(10 * (a + 1)); continue
        break
    return None, last


def spend(usd):
    try:
        gi.add_spent(STATE, usd)
    except Exception: pass


def clean(issues, sids):
    out = []
    for x in issues or []:
        if not isinstance(x, dict) or not (x.get("what") or "").strip(): continue
        out.append({"a": x.get("a") if x.get("a") in sids else None, "b": x.get("b") if x.get("b") in sids else None,
                    "level": "bad" if x.get("level") == "bad" else "warn", "what": x["what"].strip(),
                    "fix": (x.get("fix") or "").strip(), "decide": bool(x.get("decide"))})
    return out


def check_prompt(N, nid, shots, bible):
    items = scene_items(N, nid, shots, LIMG); seq = [it for it in items if it["shot"]]
    if len(seq) < 2: return None
    lines = []
    for it in items:
        lines.append(line_label(it))
        if it["sid"] and it["shot"]: lines.append(f"  → 镜头 {it['sid']}：{shot_text(it['shot'])}")
        elif it["sid"]: lines.append(f"  → 镜头 {it['sid']}（分镜表里还没有）")
        elif not it["who"].startswith("@"): lines.append("  （这一句没有单独的图，沿用上一张）")
    rules = "；".join(f"{k}：{v}" for k, v in bible.items())
    text = f"""你是电影的场记兼剪辑指导，负责检查镜头之间的衔接（continuity）。
下面是场景「{scene_title(N, nid)}」的台词和每个镜头的分镜要求，按播放顺序排列；画面一张接一张播放，没有单独图的台词沿用上一张。
{chr(10).join(lines)}

统一设定：{rules}

{RULES}
{SCHEMA}"""
    res, err = ask([{"text": text}]); spend(0.01)
    if err: return {"error": err}
    sids = [it["sid"] for it in seq]
    return {"at": time.strftime("%Y-%m-%d %H:%M"), "sids": sids, "fp": {s: fp(shots[s]) for s in sids}, "issues": clean(res.get("issues"), sids)}


def jpg(p, side=768):
    im = Image.open(p).convert("RGB"); im.thumbnail((side, side)); b = BytesIO(); im.save(b, "JPEG", quality=85)
    return base64.b64encode(b.getvalue()).decode()


def check_image(N, nid, shots, bible):
    items = scene_items(N, nid, shots, LIMG)
    seq = [it for it in items if it["sid"] and os.path.exists(os.path.join(IMG, it["sid"] + ".jpg"))]
    if len(seq) < 2: return None
    parts = [{"text": f"下面是场景「{scene_title(N, nid)}」里按播放顺序排列的分镜图（游戏里一张接一张播放）。每张图前面是对应的台词和分镜要求。"}]
    for k, it in enumerate(seq):
        between = [line_label(x) for x in items if seq[k - 1]["i"] < x["i"] < it["i"]] if k else []
        if between: parts.append({"text": "（两张图之间还有：" + "；".join(between) + "）"})
        s = it["shot"] or {}
        parts += [{"text": f"【镜头{k + 1}：{it['sid']}】{line_label(it)}\n分镜要求：{shot_text(s) if s else '（分镜表里没有）'}"},
                  {"inline_data": {"mime_type": "image/jpeg", "data": jpg(os.path.join(IMG, it["sid"] + ".jpg"))}}]
    rules = "；".join(f"{k}：{v}" for k, v in bible.items())
    parts.append({"text": f"""你是电影的场记兼剪辑指导。请看上面这些图连起来播放时接不接得上，以图里实际画出来的为准（分镜要求只用来理解剧情和机位意图）。
统一设定：{rules}

{RULES}
修改建议可以是：回到提示词改某个镜头的构图或描述后重画、用框选修图改局部、或者换成前后一致的机位。
{SCHEMA}"""})
    res, err = ask(parts); spend(0.01 + 0.002 * len(seq))
    if err: return {"error": err}
    sids = [it["sid"] for it in seq]
    return {"at": time.strftime("%Y-%m-%d %H:%M"), "sids": sids,
            "mtime": {s: int(os.path.getmtime(os.path.join(IMG, s + ".jpg"))) for s in sids}, "issues": clean(res.get("issues"), sids)}


def main(argv):
    if not argv or argv[0] not in ("prompt", "image"): print(__doc__); return 2
    kind = argv[0]
    global LIMG
    N, LIMG = load_N(); sl = json.load(open(os.path.join(HERE, "shotlist.json"), encoding="utf-8"))
    shots = {s["id"]: s for s in sl.get("shots", [])}; bible = sl.get("bible", {})
    nodes = argv[1:] or list(N.keys())
    try: data = json.load(open(OUT, encoding="utf-8"))
    except Exception: data = {}
    data.setdefault("prompt", {}); data.setdefault("image", {})
    total = bad = done = 0
    print(f"{'提示词' if kind == 'prompt' else '成图'}衔接检查：{len(nodes)} 个场景", flush=True)
    for nid in nodes:
        if nid not in N: print(f"  {nid}：游戏里没有这个场景，跳过", flush=True); continue
        r = (check_prompt if kind == "prompt" else check_image)(N, nid, shots, bible)
        title = scene_title(N, nid)
        if r is None: print(f"  {title}（{nid}）：不到两个镜头{'有图' if kind == 'image' else ''}，跳过", flush=True); continue
        if "error" in r: print(f"ERROR:{title}（{nid}）没检查成：{r['error']}", flush=True); continue
        data[kind][nid] = r; done += 1
        json.dump(data, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=1)      # 每场写一次，中途停了也不丢
        n = len(r["issues"]); nb = sum(1 for x in r["issues"] if x["level"] == "bad"); total += n; bad += nb
        print(f"  {title}（{nid}）：{'没发现问题 ✓' if not n else f'{n} 处（{nb} 处明显接不上）'}", flush=True)
        for x in r["issues"]: print(f"    · {x['a'] or '?'} → {x['b'] or '?'}：{x['what']}" + (f"  建议：{x['fix']}" if x["fix"] else ""), flush=True)
    print(f"INFO:检查了 {done} 个场景，发现 {total} 处衔接问题（{bad} 处明显接不上）", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
