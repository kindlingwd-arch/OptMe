"""手绘动作 → AI 整理 → 参考视频。影游剪辑台「视频审阅 → ✎ 手绘动作」在后台调用它。

输入：storyboard\\sketch\\<镜头>_motion.json（剪辑台里用鼠标录下来的轨迹：每个对象一串 [x, y, 秒]，x、y 是画面比例位置）
做三件事：
  1. 用代码把抖动的鼠标轨迹修顺、精简成几个关键点（坐标和时间照人画的，不让 AI 改）；
  2. 让 Gemini 看首帧 + 画好的路线 + 剧本：认出每条路线是谁、写一句动作和视频提示词、指出不合理的地方（比如起点不在那个人身上）；
  3. 写成 autofix\\test_motion\\<镜头>\\motion.json（轨迹测试和参考视频都读这份），再用 motion_ref 的 SVG 方式生成参考视频 motion_ref\\out\\<镜头>_svg.mp4。
用法：python motion_sketch.py <镜头> [--no-ai]（--no-ai：不调用 Gemini，只修顺 + 出参考视频）
"""
import os, sys, json, time, math, shutil

HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "storyboard")); sys.path.insert(0, HERE)
import gen_images as gi
from PIL import Image

MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.8-flash")
DUR = 6.0


TW = .35   # 精简轨迹时时间也算一维（6 秒折成 0.35 个画面宽）：路线一样、快慢不同的点不会被删掉，停顿也保得住


def rdp(pts, eps):
    """Ramer–Douglas–Peucker：去掉几乎在一条直线上的点（x、y 加上时间一起看）。"""
    if len(pts) < 3: return pts
    v = lambda q: (q[0], q[1], q[2] / DUR * TW)
    a, b = v(pts[0]), v(pts[-1]); ab = [b[k] - a[k] for k in range(3)]; L2 = sum(c * c for c in ab) or 1e-12
    dmax, idx = 0, 0
    for i in range(1, len(pts) - 1):
        p = v(pts[i]); f = max(0, min(1, sum((p[k] - a[k]) * ab[k] for k in range(3)) / L2))
        d = math.dist(p, [a[k] + f * ab[k] for k in range(3)])
        if d > dmax: dmax, idx = d, i
    if dmax <= eps: return [pts[0], pts[-1]]
    return rdp(pts[:idx + 1], eps)[:-1] + rdp(pts[idx:], eps)


def tidy(points):
    """鼠标轨迹 → 平滑、精简的关键点：先做滑动平均去抖，再按形状精简到最多 8 个点；时间保持单调、不超过 6 秒。"""
    p = [[float(x), float(y), float(t)] for x, y, t in points if 0 <= float(t) <= DUR + .5]
    if len(p) < 2: return p
    sm = []
    for i in range(len(p)):
        a, b = max(0, i - 2), min(len(p), i + 3); seg = p[a:b]
        sm.append([sum(q[0] for q in seg) / len(seg), sum(q[1] for q in seg) / len(seg), p[i][2]])
    sm[0], sm[-1] = p[0], p[-1]                         # 起点、终点照人画的
    eps = .004; out = rdp(sm, eps)
    while len(out) > 8: eps *= 1.5; out = rdp(sm, eps)
    last = -1
    for q in out:
        q[2] = min(DUR, max(q[2], last + .05)); last = q[2]
        q[0], q[1], q[2] = round(min(1, max(0, q[0])), 3), round(min(1, max(0, q[1])), 3), round(q[2], 2)
    # 人在 6 秒之前就松手了：保持最后的位置到第 6 秒（不拉伸动作）
    return out


def ask_ai(sid, kf, motion, raw_cam, key):
    import test_motion as TM
    import write_vprompts as W
    ov = os.path.join(HERE, "test_motion", sid, "sketch_overlay.png"); TM.draw_plan(Image.open(kf), motion).save(ov)
    try:
        N = W.load_script(); kind, nid, i, n = W.context(sid, N)
        ctx = (f"这是场景「{n.get('title') or nid}」的场景视频。环境：{n.get('img', '')}\n台词：" + " / ".join(W.line_text(l) for l in n.get('lines', [])[:8])) if kind == "scene" else \
              (f"这是场景「{n.get('title') or nid}」第 {i + 1} 行的插入镜头。前后：" + " / ".join(W.line_text(l) for l in n.get('lines', [])[max(0, i - 2):i + 3])) if kind else "（剧本里没找到这个镜头）"
    except Exception as e:
        ctx = f"（读剧本失败：{e}）"
    subs = "\n".join(f"  路线{k + 1}（{s['label'] or '没写名字'}）：" + " → ".join(f"({p[0]:.2f},{p[1]:.2f}) {p[2]:g}秒" for p in s["points"]) for k, s in enumerate(motion["subjects"]))
    text = f"""图1是一段 6 秒视频的首帧（镜头 {sid}），图2是导演在首帧上用鼠标画的运动路线（彩色线，圆点是起点，箭头是终点，数字是秒）。
剧本：{ctx}
路线（x、y 是画面比例位置，左上 0,0，右下 1,1）：
{subs}
导演选的镜头运动：{raw_cam.get('move', 'static')}（{'请你根据画面和剧本建议一个' if raw_cam.get('move') == 'auto' else '照这个'}）

请：
1. labels：给每条路线起一个准确的名字（看起点落在画面里的什么东西上，例如「女人的右手」「黑皮箱」「镜头取景」），按路线顺序；导演写了名字而且对得上就保留。
2. action：一句话写这 6 秒发生的动作，不写坐标。
3. prompt：交给图生视频模型的提示词，中文 60～140 字：从首帧出发，按路线的方向和快慢写动作的先后，写清镜头怎么动，有人说话写谁张嘴；不写画质风格；不用这些词：血、伤、打斗、抢劫、劫匪、枪、刀、死、挣扎。
4. camera：镜头运动，move 取 static/push_in/pull_out/pan_left/pan_right/tilt_up/tilt_down 之一，amount 0～1。导演已经选了具体运动就原样返回。
5. warnings：不合理的地方，每条一句（例如路线起点不在任何人或物体上、手穿过了身体、动作和剧本对不上、6 秒做不完）；没有就空列表。
只输出 JSON：{{"labels": [...], "action": "...", "prompt": "...", "camera": {{"move": "...", "amount": 0.3}}, "warnings": [...]}}"""
    parts = [{"inline_data": {"mime_type": gi.mime(kf), "data": gi.b64(kf)}}, {"inline_data": {"mime_type": "image/png", "data": gi.b64(ov)}}, {"text": text}]
    body = {"contents": [{"parts": parts}], "generationConfig": {"responseMimeType": "application/json", "temperature": 0.3}}
    for a in range(3):
        st, js = gi.http(f"{gi.G}/models/{MODEL}:generateContent", body, {"x-goog-api-key": key}, timeout=180)
        if st == 200:
            r = gi.json_reply(js)
            if isinstance(r, list) and r: r = r[0]
            if isinstance(r, dict): return r, ""
            return None, "返回看不懂：" + json.dumps(js, ensure_ascii=False)[:200]
        if st not in (429, 500, 503, 0): return None, f"HTTP {st} " + json.dumps(js, ensure_ascii=False)[:200]
        time.sleep(8 * (a + 1))
    return None, "多次失败"


def main(argv):
    ids = [a for a in argv if not a.startswith("--")]
    if not ids: print(__doc__); return 2
    sid = ids[0]
    rawp = os.path.join(ROOT, "storyboard", "sketch", f"{sid}_motion.json")
    if not os.path.exists(rawp): print(f"ERROR:还没有手绘动作：{rawp}"); return 1
    raw = json.load(open(rawp, encoding="utf-8"))
    kf = None
    for p in (f"img/{sid}.jpg", f"img/l/{sid}.jpg"):
        if os.path.exists(os.path.join(ROOT, "moban_game", p)): kf = os.path.join(ROOT, "moban_game", p); break
    if not kf: print(f"ERROR:找不到首帧图 img/{sid}.jpg"); return 1
    subs = []
    for s in raw.get("subjects", []):
        pts = tidy(s.get("points", []))
        if len(pts) >= 2: subs.append({"label": str(s.get("label", "")).strip(), "points": pts})
        print(f"· {s.get('label') or '（没写名字）'}：录了 {len(s.get('points', []))} 个点 → 整理成 {len(pts)} 个关键点", flush=True)
    if not subs: print("ERROR:没有可用的路线（每个对象至少要拖出一段）"); return 1
    cam = raw.get("camera") or {"move": "static", "amount": .3}
    motion = {"action": raw.get("action", ""), "subjects": subs, "camera": {"move": cam.get("move", "static") if cam.get("move") != "auto" else "static", "amount": float(cam.get("amount", .3))},
              "source": "手绘", "drawn_at": time.strftime("%Y-%m-%d %H:%M")}
    od = os.path.join(HERE, "test_motion", sid); os.makedirs(od, exist_ok=True)
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    if "--no-ai" not in argv:
        if not key: print("ERROR:没有找到 GEMINI_API_KEY（可以先用 --no-ai 只修顺、出参考视频）"); return 1
        print(f"让 Gemini 看首帧和路线，认对象、写动作和提示词（{MODEL}，约 $0.01）…", flush=True)
        r, err = ask_ai(sid, kf, motion, cam, key)
        if r:
            for k, lab in enumerate(r.get("labels") or []):
                if k < len(subs) and str(lab).strip(): subs[k]["label"] = str(lab).strip()
            motion["action"] = str(r.get("action") or motion["action"]); motion["prompt"] = str(r.get("prompt") or "")
            if cam.get("move") == "auto" and isinstance(r.get("camera"), dict): motion["camera"] = {"move": r["camera"].get("move", "static"), "amount": float(r["camera"].get("amount", .3) or .3)}
            motion["warnings"] = [str(w) for w in (r.get("warnings") or [])]
            print("  对象：" + "、".join(s["label"] for s in subs), flush=True)
            print("  动作：" + motion["action"], flush=True)
            print("  提示词：" + motion.get("prompt", ""), flush=True)
            for w in motion["warnings"]: print("  ⚠ " + w, flush=True)
            try: gi.add_spent(os.path.join(ROOT, "storyboard", "out", "batch", "state.json"), .01)
            except Exception: pass
        else:
            print("  AI 整理失败（" + err + "），先用你写的名字继续", flush=True)
    mp = os.path.join(od, "motion.json")
    if os.path.exists(mp): shutil.copy2(mp, os.path.join(od, time.strftime("motion_%m%d_%H%M%S.json")))
    json.dump(motion, open(mp, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    for f in ("plan.png", "first_frame_arrows.png"):        # 轨迹换了，轨迹测试的图下次重画
        try: os.remove(os.path.join(od, f))
        except Exception: pass
    print("轨迹已写入：" + os.path.relpath(mp, ROOT), flush=True)
    print("生成参考视频（motion_ref 的 SVG 方式）…", flush=True)
    sys.path.insert(0, os.path.join(ROOT, "motion_ref"))
    try:
        import svg_ref
        sys.argv = ["svg_ref.py", sid]; svg_ref.main()
    except SystemExit as e:
        if e.code not in (None, 0): print("ERROR:参考视频没生成：" + str(e.code), flush=True); return 1
    except Exception as e:
        print("ERROR:参考视频没生成：" + str(e), flush=True); return 1
    out = os.path.join(ROOT, "motion_ref", "out", f"{sid}_svg.mp4")
    print("RESULT:" + os.path.relpath(out, ROOT).replace("\\", "/"), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
