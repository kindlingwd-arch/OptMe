"""让 Gemini（文字模型）按分镜表和构图草图写精绘 SVG 草图。
用法：python gemini_svg.py [镜头编号 ...]     不写编号 = 默认 11 个问题镜头
输出：sketch/gemini/<镜头>.svg 和 .png（已存在的跳过）
需要 GEMINI_API_KEY 和代理；GEMINI_SVG_MODEL 可指定模型。不打印密钥。
"""
import os, re, sys, json, time, xml.etree.ElementTree as ET
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
os.environ.setdefault("HTTP_TIMEOUT", "600")          # 长 SVG 要写好几分钟
import gen_images as gi                                 # 复用 http / b64 / mime
import gpt_svg                                          # 复用提示词、默认镜头、转 PNG

OUT = os.path.join(HERE, "sketch", "gemini")
STYLE = os.path.join(HERE, "sketch", "gpt", "style_ref.png")

_m = None
def model(key):
    global _m
    if _m: return _m
    if os.environ.get("GEMINI_SVG_MODEL"): _m = os.environ["GEMINI_SVG_MODEL"]; return _m
    st, js = gi.http(f"{gi.G}/models?pageSize=300", headers={"x-goog-api-key": key})
    names = [m["name"].split("/")[-1] for m in js.get("models", []) if "generateContent" in m.get("supportedGenerationMethods", [])]
    bad = ("image", "tts", "audio", "live", "embed", "lite", "omni", "veo", "imagen", "robotics", "computer")
    txt = [n for n in names if n.startswith("gemini") and not any(b in n for b in bad)]
    pro = [n for n in txt if "pro" in n]
    ga = [n for n in pro if "preview" not in n and "exp" not in n]
    pick = sorted(ga or pro or txt, reverse=True)
    _m = pick[0] if pick else "gemini-2.5-pro"
    print("  选用文字模型：", _m, flush=True); return _m


def ask(key, parts):
    body = {"contents": [{"parts": parts}], "generationConfig": {"maxOutputTokens": 65536, "temperature": 0.7}}
    for a in range(3):
        st, js = gi.http(f"{gi.G}/models/{model(key)}:generateContent", body, {"x-goog-api-key": key})
        if st == 200:
            txt = "".join(pt.get("text", "") for c in js.get("candidates", []) for pt in (c.get("content") or {}).get("parts", []) if not pt.get("thought"))
            m = re.search(r"<svg[\s\S]*</svg>", txt)
            return (m.group(0), "") if m else ("", "没返回 SVG：" + txt[:200])
        if st in (429, 500, 503, 0): time.sleep(20 * (a + 1)); continue
        return "", f"HTTP {st} " + json.dumps(js, ensure_ascii=False)[:300]
    return "", "多次失败"


def main():
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not key: print("没有 GEMINI_API_KEY"); return
    sl = json.load(open(os.path.join(HERE, "shotlist.json"), encoding="utf-8"))
    shots = {s["id"]: s for s in sl["shots"]}
    os.makedirs(OUT, exist_ok=True)
    for sid in sys.argv[1:] or gpt_svg.DEFAULT:
        if sid not in shots: print("分镜表里没有", sid); continue
        svg = os.path.join(OUT, sid + ".svg"); png = os.path.join(OUT, sid + ".png")
        if os.path.exists(svg) and os.path.exists(png): print(sid, "已有，跳过"); continue
        shot = shots[sid]
        parts = []
        for r in shot.get("sketch", []):
            p = os.path.join(ROOT, r)
            if os.path.exists(p):
                what = "俯视位置图（车头朝上，左舵）" if r.endswith("_map.png") else "构图草图（只学人物左右位置、朝向、机位，不学画风）"
                parts += [{"text": what}, {"inline_data": {"mime_type": gi.mime(p), "data": gi.b64(p)}}]
        for r in shot.get("refs", []):
            p = os.path.join(ROOT, r)
            if os.path.exists(p):
                parts += [{"text": "角色/场景参考图：" + os.path.splitext(os.path.basename(r))[0]}, {"inline_data": {"mime_type": gi.mime(p), "data": gi.b64(p)}}]
        if os.path.exists(STYLE):
            parts += [{"text": "风格样图（学画风、精细程度、配色和光线；它上面的标题和说明文字不要学）"}, {"inline_data": {"mime_type": "image/png", "data": gi.b64(STYLE)}}]
        text = gpt_svg.prompt(shot, sl.get("bible", {}))
        text = re.sub(r"【只做一件事】.*?\n\n", "【输出】只输出一个完整的 SVG 代码，从 <svg 开始到 </svg> 结束，不要任何解释、不要 markdown 代码块。\n\n", text, flags=re.S)
        text = text.replace("写完后自己检查一遍", "输出前自己检查一遍")
        parts.append({"text": text})
        t0 = time.time(); print(f"== {sid}：交给 Gemini 写 SVG ...", flush=True)
        code, err = ask(key, parts)
        if code:
            try: ET.fromstring(code)
            except Exception as e:                      # 写坏了就再要一次
                print("  SVG 格式有错，重写一次：", e, flush=True); code, err = ask(key, parts)
                try: ET.fromstring(code)
                except Exception as e2: code, err = "", f"SVG 格式有错：{e2}"
        if not code: print("  ×", err); continue
        open(svg, "w", encoding="utf-8").write(code)
        ok = gpt_svg.render(svg, png)
        print(f"  ✓ {len(code)//1000} KB，用时 {time.time()-t0:.0f} 秒；转 PNG", "成功" if ok else "失败（SVG 可用浏览器打开）", flush=True)
    print("全部完成。结果在 storyboard\\sketch\\gemini\\")


if __name__ == "__main__":
    main()
