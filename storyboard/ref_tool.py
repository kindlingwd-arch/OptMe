"""参考图工具：按参考图登记表（moban_art\\refs\\refs.json）里的描述，用 Gemini 生成或重新生成参考图。
用法：python ref_tool.py gen <参考图id>
  - 生成的图存为 refs\\<id>.png；原来的图先挪到 refs\\_old\\<id>_<时间>.png，不会丢。
  - 登记表里 inputs 列的其他参考图会一起发给模型（比如 BP机 参考女人的设定图，保证是同一个人身上的那个）。
影游剪辑台的「参考图审阅」和「新增参考图」在后台调用它。需要 GEMINI_API_KEY 和代理。
"""
import os, sys, json, time, base64, shutil
from io import BytesIO

HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
REFS = os.path.join(ROOT, "refs"); REG = os.path.join(REFS, "refs.json")
KIND = {"char": "人物", "prop": "道具", "bg": "场景"}
LAYOUT = {
    "char": "灰色摄影棚纯色背景；左半边是这个人的正面半身特写，右半边是同一个人的正面全身站姿；表情自然，衣服、发型、配饰都要清楚。",
    "prop": "灰色纯色背景；道具放在画面中央，完整、清楚；可以并排展示两个角度（正面和侧面 / 正面和背面）。",
    "bg": "没有人的场景照，写实，交代清楚这个地方的样子、光线和天气。",
}


def load_reg():
    try: return json.load(open(REG, encoding="utf-8"))
    except Exception: return {"refs": []}


def bible():
    try: return json.load(open(os.path.join(HERE, "shotlist.json"), encoding="utf-8")).get("bible", {})
    except Exception: return {}


def build_prompt(e):
    b = bible()
    rules = "；".join(f"{k}：{v}" for k, v in b.items() if k in ("时代地点", "出租车", "人物", "道具", "钱", "风格"))
    return (f"为一部互动电影游戏制作一张{KIND.get(e.get('kind'), '')}参考图（设定图）：{e.get('name', e['id'])}。\n"
            f"内容：{e.get('desc', '')}\n"
            f"用途：之后所有分镜都会照着这张图画「{e.get('name', e['id'])}」，所以要清楚、准确、完整，细节符合年代。\n"
            f"版式：{LAYOUT.get(e.get('kind'), LAYOUT['prop'])}\n"
            + (f"附上的图是相关的其他参考图（同一部作品里的人物或道具），要和它们保持一致。\n" if e.get("inputs") else "")
            + f"统一设定（供参考）：{rules}\n"
            f"画面里不要任何文字、标签、标注或水印。只输出一张横幅图片。")


def gen(rid):
    import gen_images as gi
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not key: print("ERROR:没有找到 GEMINI_API_KEY"); return 1
    reg = load_reg(); e = next((x for x in reg["refs"] if x["id"] == rid), None)
    if not e: print("ERROR:登记表里没有 " + rid); return 1
    if not (e.get("desc") or "").strip(): print("ERROR:这张参考图还没写描述"); return 1
    parts = []
    for i, iid in enumerate((e.get("inputs") or [])[:4]):
        p = os.path.join(REFS, iid + ".png")
        if os.path.exists(p):
            from PIL import Image
            im = Image.open(p).convert("RGB"); im.thumbnail((768, 768)); b = BytesIO(); im.save(b, "JPEG", quality=88)
            parts += [{"text": f"相关参考图{i+1}：{iid}"}, {"inline_data": {"mime_type": "image/jpeg", "data": base64.b64encode(b.getvalue()).decode()}}]
    prompt = build_prompt(e); parts.append({"text": prompt})
    print(f"生成参考图 {rid}（{e.get('name', '')}）……", flush=True)
    for line in prompt.splitlines(): print("  " + line, flush=True)
    body = {"contents": [{"parts": parts}], "generationConfig": {"responseModalities": ["IMAGE"], "imageConfig": {"aspectRatio": "3:2"}}}
    for a in range(3):
        st, js = gi.http(f"{gi.G}/models/{gi.gemini_model(key)}:generateContent", body, {"x-goog-api-key": key})
        if st == 200:
            for c in js.get("candidates", []):
                for pt in (c.get("content") or {}).get("parts", []):
                    d = pt.get("inline_data") or pt.get("inlineData")
                    if d and d.get("data"):
                        out = os.path.join(REFS, rid + ".png")
                        if os.path.exists(out):
                            os.makedirs(os.path.join(REFS, "_old"), exist_ok=True)
                            shutil.move(out, os.path.join(REFS, "_old", f"{rid}_{time.strftime('%m%d_%H%M%S')}.png"))
                        from PIL import Image
                        Image.open(BytesIO(base64.b64decode(d["data"]))).save(out, "PNG")
                        try:
                            gi.add_spent(os.path.join(HERE, "out", "batch", "state.json"), 0.14)
                        except Exception: pass
                        print("RESULT:refs/" + rid + ".png", flush=True); return 0
            print("ERROR:AI 没返回图片：" + json.dumps(js, ensure_ascii=False)[:200]); return 1
        if st == 402: print("ERROR:Gemini 额度用完了，请到 AI Studio 充值"); return 1
        if st in (429, 500, 503, 0): time.sleep(10 * (a + 1)); continue
        print(f"ERROR:HTTP {st} " + json.dumps(js, ensure_ascii=False)[:200]); return 1
    print("ERROR:多次失败"); return 1


if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] == "gen": sys.exit(gen(sys.argv[2]))
    print(__doc__); sys.exit(2)
