# 分镜出图：按 shotlist.json，用 Gemini 图像模型 / MiniMax image-01 生成逐句画面
# 用法：python gen_images.py --engines gemini,minimax --only ride_00,together_00     （先拿几张做对比）
#       python gen_images.py --engines gemini                                          （全部镜头）
# 结果：storyboard\out\<引擎>\<镜头>.png，对比页 storyboard\out\compare.html。已生成的跳过。
# 读 GEMINI_API_KEY（需代理，出口在受支持地区）、MINIMAX_API_KEY；GEMINI_IMAGE_MODEL 可指定模型。不打印密钥
import os, sys, json, time, base64, html, argparse, urllib.request, urllib.error
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
G = "https://generativelanguage.googleapis.com/v1beta"

def http(url, body=None, headers=None, timeout=300):
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None, method="POST" if body is not None else "GET",
                                 headers={"Content-Type": "application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r: return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        t = e.read().decode("utf-8", "replace")
        try: return e.code, json.loads(t)
        except Exception: return e.code, {"raw": t[:400]}
    except Exception as e: return 0, {"raw": str(e)[:300]}

def b64(p): return base64.b64encode(open(p, "rb").read()).decode()
def mime(p): return "image/png" if p.lower().endswith(".png") else "image/jpeg"

def prompt_for(shot, bible):
    rules = "；".join(f"{k}：{v}" for k, v in bible.items())
    return (f"为一部互动电影游戏画一张分镜剧照。\n画面：{shot['desc']}\n景别：{shot['shot']}。画面里的人物：{shot['in_frame']}。场景：{shot['location']}。\n"
            f"统一设定（必须遵守）：{rules}\n人物长相、服装、道具必须和对应的参考图一致；不要照抄参考图的灰色背景和排版。只输出一张16:9横幅图片，不要任何文字说明。")

# ---------- Gemini ----------
_gm = None
def gemini_model(key):
    global _gm
    if _gm: return _gm
    if os.environ.get("GEMINI_IMAGE_MODEL"): _gm = os.environ["GEMINI_IMAGE_MODEL"]; return _gm
    st, js = http(f"{G}/models?pageSize=300", headers={"x-goog-api-key": key})
    names = [m["name"].split("/")[-1] for m in js.get("models", []) if "generateContent" in m.get("supportedGenerationMethods", [])]
    img = [n for n in names if "image" in n and "imagen" not in n]
    print("  可用的 Gemini 图像模型：", ", ".join(img) or "（没找到）", flush=True)
    ga = [n for n in img if "preview" not in n]   # 优先正式版，预览版随时会下线
    pref = [n for n in ga if "pro" in n] + [n for n in ga if "flash" in n and "lite" not in n] + ga + img
    _gm = pref[0] if pref else "gemini-3-pro-image-preview"
    print("  选用：", _gm, flush=True); return _gm

def gen_gemini(shot, bible, out):
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not key: return "没有 GEMINI_API_KEY"
    parts = []
    for i, r in enumerate(shot["refs"]):
        p = os.path.join(ROOT, r)
        if os.path.exists(p): parts += [{"text": f"参考图{i+1}：{os.path.splitext(os.path.basename(r))[0]}"}, {"inline_data": {"mime_type": mime(p), "data": b64(p)}}]
    parts.append({"text": prompt_for(shot, bible)})
    body = {"contents": [{"parts": parts}], "generationConfig": {"responseModalities": ["IMAGE"], "imageConfig": {"aspectRatio": "16:9"}}}
    for a in range(3):
        st, js = http(f"{G}/models/{gemini_model(key)}:generateContent", body, {"x-goog-api-key": key})
        if st == 200:
            for c in js.get("candidates", []):
                for pt in (c.get("content") or {}).get("parts", []):
                    d = pt.get("inline_data") or pt.get("inlineData")
                    if d and d.get("data"): open(out, "wb").write(base64.b64decode(d["data"])); return ""
            return "没返回图片：" + json.dumps(js, ensure_ascii=False)[:300]
        if st in (429, 500, 503, 0): time.sleep(15 * (a + 1)); continue
        return f"HTTP {st} " + json.dumps(js, ensure_ascii=False)[:300]
    return "多次失败"

# ---------- MiniMax image-01（只支持一张人物参考图）----------
def gen_minimax(shot, bible, out):
    key = (os.environ.get("MINIMAX_API_KEY") or os.environ.get("KLING_API_KEY") or "").strip()   # 本机的 MiniMax 密钥存在 KLING_API_KEY 里
    if not key: return "没有 MINIMAX_API_KEY / KLING_API_KEY"
    body = {"model": "image-01", "prompt": prompt_for(shot, bible)[:1500], "aspect_ratio": "16:9", "n": 1, "response_format": "base64"}
    chars = [r for r in shot["refs"] if os.path.basename(r).startswith("char_")]
    if chars:
        p = os.path.join(ROOT, chars[0]); body["subject_reference"] = [{"type": "character", "image_file": f"data:{mime(p)};base64," + b64(p)}]
    st, js = http("https://api.minimaxi.com/v1/image_generation", body, {"Authorization": "Bearer " + key})
    b = js.get("base_resp") or {}
    imgs = (js.get("data") or {}).get("image_base64") or []
    if imgs: open(out, "wb").write(base64.b64decode(imgs[0])); return ""
    return f"HTTP {st} {b.get('status_code')} {b.get('status_msg')} {js.get('raw','')}"

ENG = {"gemini": gen_gemini, "minimax": gen_minimax}

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--engines", default="gemini,minimax"); ap.add_argument("--only", default="")
    a = ap.parse_args()
    sl = json.load(open(os.path.join(HERE, "shotlist.json"), encoding="utf-8")); bible = sl["bible"]
    only = [x for x in a.only.split(",") if x]
    shots = [s for s in sl["shots"] if not only or s["id"] in only]
    engines = [e for e in a.engines.split(",") if e in ENG]
    for e in engines: os.makedirs(os.path.join(HERE, "out", e), exist_ok=True)
    log = {}
    for s in shots:
        for e in engines:
            out = os.path.join(HERE, "out", e, s["id"] + ".png")
            if os.path.exists(out): continue
            t0 = time.time(); err = ENG[e](s, bible, out)
            print(f"{s['id']:12} {e:8} {'✓' if not err else '× ' + err}（{time.time()-t0:.0f} 秒）", flush=True)
            log[f"{s['id']}/{e}"] = err
            time.sleep(1)
    E = html.escape
    rows = "".join(f"<tr><td><b>{s['id']}</b><br>{E(s['shot'])} · {E(s['in_frame'])}<br><small>{E(s['desc'])}</small></td>" +
                   "".join(f"<td>{'<img src=' + chr(39) + e + '/' + s['id'] + '.png' + chr(39) + ' width=480>' if os.path.exists(os.path.join(HERE,'out',e,s['id']+'.png')) else E(str(log.get(s['id']+'/'+e,'')))}</td>" for e in engines) + "</tr>"
                   for s in shots)
    open(os.path.join(HERE, "out", "compare.html"), "w", encoding="utf-8").write(
        f"<!doctype html><meta charset=utf-8><title>分镜出图对比</title><style>body{{font:13px 'Microsoft YaHei';background:#16171a;color:#e6e2da;padding:16px}}td{{vertical-align:top;padding:6px;border-bottom:1px solid #333;max-width:480px}}small{{color:#aaa}}</style>"
        f"<h2>分镜出图对比</h2><table><tr><th>镜头</th>{''.join(f'<th>{e}</th>' for e in engines)}</tr>{rows}</table>")
    print("对比页：", os.path.join(HERE, "out", "compare.html"))

if __name__ == "__main__":
    main()
