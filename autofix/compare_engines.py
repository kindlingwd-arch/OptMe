# 生成器对比：同一个镜头、同一张首帧、同一句提示词，分别用 MiniMax-H3（帧模式）和 Gemini Omni Flash 各生成一条，
# 两条都过同一套质检（机器检查 + Gemini），出对比报告，不自动换进游戏。
# 用法：python compare_engines.py E_cover      读 MINIMAX_API_KEY、GEMINI_API_KEY（Gemini 需要代理，且出口地区要受支持），不打印密钥
import os, sys, json, time, base64, html, urllib.request, urllib.error
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE); sys.path.insert(0, os.path.join(ROOT, "qc"))
import autofix as A, qc
GKEY = (os.environ.get("GEMINI_API_KEY") or "").strip()
OMNI = os.environ.get("OMNI_MODEL", "gemini-omni-1.1-flash")
OUT = os.path.join(HERE, "compare"); os.makedirs(os.path.join(OUT, "sheets"), exist_ok=True)
SHOTS = {
 "E_cover": dict(key="keys3/E_cover.png",
   prompt="火车站门口的雪夜。镜头固定不动，构图保持和首帧一致：左舵红色出租车停着，车头朝画面左侧，司机坐在靠近女人的驾驶座车窗里。穿貂皮大衣的女人弯腰把一卷钱塞进驾驶座车窗，司机低头接过钱；出租车后座空着，没有任何人；女人随后直起身，转身朝画面右侧走开。雪花飘落，写实电影质感，人物脸型和服装从头到尾保持一致",
   describe="火车站门口雪夜，女人把钱塞给出租车司机（左舵：司机在车左侧的驾驶座，车头朝画面左侧），出租车后座是空的（不能有人），女人随后走开"),
}

def omni(img, prompt, out):
    """Gemini Omni Flash：首帧 + 文字，同步返回视频（大于 4MB 时给下载地址）"""
    mime = "image/png" if img.lower().endswith(".png") else "image/jpeg"
    body = {"model": OMNI, "input": [{"type": "image", "data": base64.b64encode(open(img, "rb").read()).decode(), "mime_type": mime},
                                     {"type": "text", "text": prompt}],
            "response_format": {"type": "video", "aspect_ratio": "16:9", "resolution": "720p"},
            "generation_config": {"video_config": {"task": "image_to_video"}},
            "background": False, "store": False, "stream": False}
    url = "https://generativelanguage.googleapis.com/v1beta/interactions"
    for a in range(3):
        req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST", headers={"x-goog-api-key": GKEY, "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=900) as r: js = json.loads(r.read())
            break
        except urllib.error.HTTPError as e:
            msg = e.read().decode("utf-8", "replace")[:500]; print("  Omni 出错", e.code, msg, flush=True)
            if e.code in (429, 500, 503): time.sleep(20 * (a + 1)); continue
            return False, f"Omni {e.code} {msg}"
        except Exception as e:
            print("  Omni 网络出错", str(e)[:200], flush=True); time.sleep(20)
    else: return False, "Omni 多次失败"
    vid = None
    for st in js.get("steps", []) or []:
        for c in (st.get("content") or []):
            if isinstance(c, dict) and c.get("type") == "video": vid = c
    if not vid: return True, "Omni 没返回视频：" + json.dumps(js, ensure_ascii=False)[:400]
    if vid.get("data"): open(out, "wb").write(base64.b64decode(vid["data"])); return True, ""
    u = vid.get("uri")
    for i in range(60):
        try:
            req = urllib.request.Request(u, headers={"x-goog-api-key": GKEY})
            with urllib.request.urlopen(req, timeout=300) as r: open(out, "wb").write(r.read())
            if os.path.getsize(out) > 10000: return True, ""
        except Exception as e: print("  等待文件就绪", str(e)[:80], flush=True)
        time.sleep(10)
    return True, "Omni 下载失败"

def main():
    sid = sys.argv[1] if len(sys.argv) > 1 else "E_cover"; t = SHOTS[sid]
    spec_all = json.load(open(os.path.join(ROOT, "qc", "specs.json"), encoding="utf-8")); qc.RULES = spec_all["rules"]
    spec = dict(next(s for s in spec_all["shots"] if s["id"] == sid)); key = os.path.join(HERE, t["key"]); spec["keyframe"] = key; spec["describe"] = t["describe"]
    res = []
    for eng in ("h3", "omni"):
        out = os.path.join(OUT, f"{sid}_{eng}.mp4")
        if not os.path.exists(out):
            print(f"== {eng} 生成中……", flush=True); t0 = time.time()
            if eng == "h3": charged, err = A.gen_video_h3(key, t["prompt"], out, None, [], "MiniMax-H3")
            else: charged, err = omni(key, t["prompt"], out)
            print(f"   {'完成' if not err else err}（{time.time()-t0:.0f} 秒）", flush=True)
            if err or not os.path.exists(out): res.append({"engine": eng, "error": err}); continue
        s2 = dict(spec); s2["id"] = f"{sid}_{eng}"; s2["video"] = out
        r = None
        for k in range(3):
            r = qc.check(s2, os.path.join(ROOT, "moban_game"), OUT, os.path.join(ROOT, "refs"), True); g = r.get("gemini") or {}
            if g and "error" not in g: break
            time.sleep(20)
        g = (r or {}).get("gemini") or {}
        res.append({"engine": eng, "pass": g.get("pass"), "score": g.get("score"), "issues": g.get("issues", []), "machine": r.get("issues"), "sheet": r.get("sheet"), "dur": r.get("duration")})
        print(f"   {eng}：{'通过' if g.get('pass') else '不通过'} {g.get('score')}/10，时长 {r.get('duration')} 秒", flush=True)
        for i in g.get("issues", []): print("     ", i.get("severity"), i.get("type"), i.get("detail"), flush=True)
    json.dump(res, open(os.path.join(OUT, f"{sid}.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    E = html.escape
    rows = "".join(f"<section><h2>{r['engine']}：{'通过' if r.get('pass') else '不通过'} {r.get('score','')}/10 {E(str(r.get('error','')))}</h2>"
                   + (f"<video src='{sid}_{r['engine']}.mp4' controls width=640></video><br><img src='{r['sheet']}' width=960>" if r.get('sheet') else "")
                   + "<ul>" + "".join(f"<li>[{E(str(i.get('severity')))}] {E(str(i.get('type')))}：{E(str(i.get('detail')))}</li>" for i in r.get('issues', [])) + "</ul></section>" for r in res)
    open(os.path.join(OUT, f"{sid}.html"), "w", encoding="utf-8").write(f"<!doctype html><meta charset=utf-8><title>生成器对比 {sid}</title><style>body{{font:14px 'Microsoft YaHei';background:#16171a;color:#e6e2da;padding:20px}}</style><h1>生成器对比：{sid}（同一首帧、同一提示词）</h1>{rows}")
    print("报告：", os.path.join(OUT, f"{sid}.html"))

if __name__ == "__main__":
    main()
