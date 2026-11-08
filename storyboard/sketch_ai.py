"""手绘构图 → AI 整理成干净的 SVG 构图图。
用法：python sketch_ai.py <镜头> comp|map <手绘图（相对 moban_art 的路径，PNG）>
  comp = 画面构图（16:9，镜头里看到的样子）；map = 俯视位置图（从上往下看：车、座位、机位和拍摄方向）
结果：storyboard\\sketch\\_draft\\<镜头>_<comp|map>_ai.svg，打印 RESULT:<路径>。影游剪辑台的「手绘构图」在后台调用它。
用文字模型（GEMINI_MODEL，默认 gemini-3.8-flash）写 SVG，约 $0.01～0.02 一次。需要 GEMINI_API_KEY 和代理。
"""
import os, sys, json, re, time, base64
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import gen_images as gi

QC_MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.8-flash")
DRAFT = os.path.join(HERE, "sketch", "_draft")

KIND = {
    "comp": """画面构图图（16:9，就是镜头里看到的样子）：
- viewBox="0 0 1280 720"，width="1280" height="720"，浅灰白背景。
- 人物用简洁的人形剪影（头 + 肩膀 / 上半身，按景别决定露多少），每个人一种颜色、轮廓清楚；脸朝哪边用鼻尖方向或一个小三角表示。
- 车、车窗、方向盘、座椅、门框、道具等用简化的线框或色块，透视关系和手绘一致。
- 视线、朝向、动作方向可以用细箭头。
- 可以在人物旁边写很短的中文标签（司机、女人、大军、民警、方向盘、左侧车窗……），字号 22～28，放在不挡主体的地方。""",
    "map": """俯视位置图（从正上方往下看）：
- viewBox="0 0 1280 720"，width="1280" height="720"，浅灰白背景。
- 出租车画成俯视的车身轮廓，车头朝画面上方，标出四个座位；左舵：驾驶座在左前。
- 每个人用一个带颜色的圆点 + 中文名字，放在他的位置上（车内座位或车外的具体位置）。
- 摄像机画成一个小机身图标，并用扇形或箭头表示拍摄方向和视野范围，旁边写「机位」。
- 其他重要的东西（路、站台、检查站、皮箱等）用简单图形加标签。""",
}


def shot_info(sid):
    try:
        sl = json.load(open(os.path.join(HERE, "shotlist.json"), encoding="utf-8"))
    except Exception:
        return {}, {}
    return next((s for s in sl.get("shots", []) if s["id"] == sid), {}), sl.get("bible", {})


def extract_svg(text):
    m = re.search(r"<svg[\s\S]*?</svg>", text or "")
    if not m: return None
    svg = m.group(0)
    if "xmlns=" not in svg[:300]: svg = svg.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"', 1)
    ET.fromstring(svg)          # 解析不了就抛错
    return svg


def main(argv):
    if len(argv) < 3 or argv[1] not in KIND: print(__doc__); return 2
    sid, kind, src = argv[0], argv[1], os.path.join(ROOT, argv[2])
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not key: print("ERROR:没有找到 GEMINI_API_KEY"); return 1
    if not os.path.exists(src): print("ERROR:找不到手绘图 " + argv[2]); return 1
    shot, bible = shot_info(sid)
    rules = "；".join(f"{k}：{v}" for k, v in bible.items() if k in ("出租车", "座位", "人物"))
    info = f"景别 {shot.get('shot', '')}；画面里 {shot.get('in_frame', '')}；场景 {shot.get('location', '')}；构图 {shot.get('layout', '')}；画面描述 {shot.get('desc', '')}" if shot else "（分镜表里没有这个镜头）"
    text = f"""你是电影分镜师。附图是导演用鼠标手画的{'画面构图' if kind == 'comp' else '俯视位置图'}草稿，线条很粗糙。请把它整理成一张干净、清楚的 SVG，作为之后 AI 出图时的构图参考。

最重要：严格照手绘稿的布局。每个人、每样东西的位置、大小、左右关系、朝向、机位都和手绘一致，不要自己挪动、增加或删除；手绘里的文字标签要保留（可以写得更工整）。手绘画得不清楚的地方，参考下面的分镜信息理解，但仍以手绘的位置为准。

{KIND[kind]}

分镜信息：{info}
统一设定：{rules}

要求：只用基本的 SVG 元素（rect、circle、ellipse、line、polyline、polygon、path、text、g），不要图片、不要滤镜、不要外部字体和链接；文字用 font-family="sans-serif"。
只输出 SVG 代码本身（从 <svg 开始，到 </svg> 结束），不要任何解释。"""
    img = base64.b64encode(open(src, "rb").read()).decode()
    body = {"contents": [{"parts": [{"inline_data": {"mime_type": "image/png", "data": img}}, {"text": text}]}],
            "generationConfig": {"temperature": 0.2}}
    print(f"整理手绘{'构图' if kind == 'comp' else '俯视位置图'}：{sid}（{QC_MODEL}）……", flush=True)
    last = ""
    for a in range(3):
        st, js = gi.http(f"{gi.G}/models/{QC_MODEL}:generateContent", body, {"x-goog-api-key": key}, timeout=180)
        if st == 200:
            try:
                out = "".join(p.get("text", "") for p in js["candidates"][0]["content"]["parts"] if not p.get("thought"))
                svg = extract_svg(out)
            except Exception as e:
                svg = None; last = f"返回的 SVG 解析不了：{e}"
            if svg:
                os.makedirs(DRAFT, exist_ok=True)
                f = os.path.join(DRAFT, f"{sid}_{kind}_ai.svg")
                open(f, "w", encoding="utf-8").write(svg)
                try:
                    sp = os.path.join(HERE, "out", "batch", "state.json"); s = json.load(open(sp, encoding="utf-8"))
                    gi.add_spent(sp, 0.02)
                except Exception: pass
                print("RESULT:" + os.path.relpath(f, ROOT).replace("\\", "/"), flush=True); return 0
            last = last or "AI 没返回 SVG：" + json.dumps(js, ensure_ascii=False)[:200]
            print("  " + last, flush=True); continue
        last = f"HTTP {st} " + json.dumps(js, ensure_ascii=False)[:200]
        print("  失败：" + last, flush=True)
        if st in (429, 500, 503, 0): time.sleep(10 * (a + 1)); continue
        break
    print("ERROR:" + last, flush=True); return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
