# 自动重拍循环：生成视频 → Gemini 质检 → 不通过就用（过滤过敏感词的）改写提示词重拍 → 最多重拍 2 次 → 剩下的交给人看
# 用法：python autofix.py [镜头id,镜头id ...]   不写就跑下面 TARGETS 里的全部
# 环境变量：MINIMAX_API_KEY（必需）、GEMINI_API_KEY（质检用）、AUTOFIX_BUDGET（预算，元，默认 20）、COST_PER_VIDEO（每条估价，默认 2）
# 不打印任何密钥
import os, sys, json, time, base64, shutil, html, urllib.request, urllib.error
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "qc")); sys.path.insert(0, HERE)
import qc                      # 复用质检脚本里的机器检查和 Gemini 复核
from sanitize import clean, bad_words
from PIL import Image

KEY = (os.environ.get("MINIMAX_API_KEY") or os.environ.get("KLING_API_KEY") or "").strip()
HOST = "https://api.minimaxi.com"
BUDGET = float(os.environ.get("AUTOFIX_BUDGET", "20")); COST = float(os.environ.get("COST_PER_VIDEO", "2"))
MAX_RETRY = 2
GAME = os.path.join(ROOT, "moban_game"); OUT = os.path.join(HERE, "out"); BACKUP = os.path.join(HERE, "backup")
SUF = "。写实电影质感，镜头运动轻缓，人物脸型和服装从头到尾保持一致。"

# 每个要重拍的镜头：新关键帧（没有就用游戏里原来的）、起始提示词（None = 用上次质检报告里 Gemini 给的改写）、质检时的描述（None = 用 specs.json 原描述）
TARGETS = {
    "start": dict(key=None, prompt=None, describe=None),
    "s_envelope": dict(key=None,
        prompt="特写出租车副驾驶脚垫：一个白色信封已经静静地躺在脚垫上，画面里从头到尾只有这一个信封，没有东西掉下来，也不出现第二个信封。镜头极慢地推近信封，旁边的黑色皮靴轻轻挪动了一下，脚垫上的残雪微微融化，仪表盘绿光微弱闪烁，看不到人脸，没有人说话",
        describe="特写：一个白色信封躺在出租车副驾驶脚垫上（已经从貂皮大衣口袋里滑落），镜头慢慢推近，旁边的靴子动了一下，仪表盘绿光，画面里只能有一个信封，没有人说话"),
    "check": dict(key="keys/check.png",
        prompt="雪夜林间公路检查站，红蓝警灯闪烁。民警已经弯腰站在红色出租车驾驶员一侧的车窗边，戴手套的手拿着手电筒，转头对车里的司机说话，嘴唇清楚地一开一合；出租车停着不动，民警站在原地不走动、不绕车，雪花在手电光柱里飞舞，背景只有松林和积雪",
        describe="雪夜检查站，警灯闪烁，民警弯腰站在出租车驾驶员一侧车窗边，手拿手电筒，张嘴对司机说话，嘴唇一开一合，雪花在光柱里飞舞，背景是松林，没有城市楼房"),
    "E_truth": dict(key="keys/E_truth.png",
        prompt="雪夜林间公路检查站，四周只有雪松和积雪，没有楼房。红色出租车后备箱盖上放着敞开的黑皮箱，满箱挂着小价签的金饰在手电光下闪光。民警举着手电筒照着皮箱；穿貂皮大衣的女人别过脸，张嘴辩解，嘴唇一开一合；戴狗皮帽的年轻人转向她，激动地张嘴质问，嘴唇一开一合；雪花飘落",
        describe="林间公路检查站的雪夜（背景只有松林、雪、路障和警车，没有城市楼房），手电光照着打开的黑皮箱，满箱金饰闪闪发光，女人别过脸张嘴辩解，嘴唇开合，戴狗皮帽的年轻人激动地张嘴质问她，民警举着手电筒，雪花飘落"),
}

def call(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(HOST + path, data=data, method=method, headers={"Authorization": "Bearer " + KEY, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=180) as r: return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        t = e.read().decode("utf-8", "replace")
        try: return e.code, json.loads(t)
        except Exception: return e.code, {"raw": t[:300]}
    except Exception as e: return 0, {"raw": str(e)[:300]}

def gen_video(img, prompt, out):
    """返回 (是否扣费, 错误信息)"""
    mime = "image/png" if img.lower().endswith(".png") else "image/jpeg"
    b64 = base64.b64encode(open(img, "rb").read()).decode()
    body = {"model": "MiniMax-Hailuo-2.3", "prompt": prompt + SUF, "first_frame_image": f"data:{mime};base64," + b64, "duration": 6, "resolution": "768P"}
    for k in range(6):  # 网络抖动（代理断流、SSL EOF）不算一次重拍，等一会儿再交
        st, js = call("POST", "/v1/video_generation", body); b = js.get("base_resp") or {}
        if st != 0: break
        print(f"  网络出错，{20*(k+1)} 秒后重试：{js.get('raw','')[:80]}", flush=True); time.sleep(20 * (k + 1))
    tid = js.get("task_id")
    if not tid: return False, f"提交失败 {st} {b.get('status_code')} {b.get('status_msg')} {js.get('raw','')}"
    for i in range(90):
        time.sleep(10)
        _, j2 = call("GET", f"/v1/query/video_generation?task_id={tid}"); s = j2.get("status")
        if s == "Success":
            _, j3 = call("GET", f"/v1/files/retrieve?file_id={j2.get('file_id')}")
            urllib.request.urlretrieve(j3["file"]["download_url"], out); return True, ""
        if s in ("Fail", "Failed"): return True, "生成失败 " + json.dumps(j2, ensure_ascii=False)[:200]
    return True, "超时"

def install(sid, video, key_png):
    os.makedirs(BACKUP, exist_ok=True); ts = time.strftime("%m%d_%H%M")
    dst = os.path.join(GAME, "vid", sid + ".mp4")
    if os.path.exists(dst): shutil.copy2(dst, os.path.join(BACKUP, f"{sid}_{ts}.mp4"))
    shutil.copy2(video, dst)
    if key_png:  # 新关键帧也换进游戏（裁成 16:9 的 1280x720 jpg）
        kd = os.path.join(GAME, "img", sid + ".jpg")
        if os.path.exists(kd): shutil.copy2(kd, os.path.join(BACKUP, f"{sid}_{ts}.jpg"))
        im = Image.open(key_png).convert("RGB"); w, h = im.size; nh = int(w * 9 / 16)
        if nh <= h: im = im.crop((0, (h - nh) // 2, w, (h - nh) // 2 + nh))
        im.resize((1280, 720), Image.LANCZOS).save(kd, quality=90)

def mouth_only(g):
    hi = [i for i in g.get("issues", []) if i.get("severity") == "高"]
    return bool(hi) and all("口型" in str(i.get("type", "")) for i in hi)

def main():
    if not KEY: print("没有找到环境变量 MINIMAX_API_KEY"); sys.exit(2)
    if not os.environ.get("GEMINI_API_KEY"): print("没有找到环境变量 GEMINI_API_KEY（没有质检就没法自动判断，先退出）"); sys.exit(2)
    spec_all = json.load(open(os.path.join(ROOT, "qc", "specs.json"), encoding="utf-8")); qc.RULES = spec_all["rules"]
    specs = {s["id"]: s for s in spec_all["shots"]}
    try: last = {r["id"]: r for r in json.load(open(os.path.join(ROOT, "qc", "out", "report.json"), encoding="utf-8"))}
    except Exception: last = {}
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    ids = [x for x in (args[0].split(",") if args else TARGETS) if x in TARGETS]
    os.makedirs(os.path.join(OUT, "sheets"), exist_ok=True)
    state_p = os.path.join(OUT, "state.json")
    try: state = json.load(open(state_p, encoding="utf-8"))
    except Exception: state = {"spent": 0, "shots": {}}
    for sid in ids:
        t = TARGETS[sid]; st = state["shots"].setdefault(sid, {"tries": [], "status": "todo"})
        if st["status"] in ("installed", "needs_lipsync", "manual"): print(sid, "之前已完成，跳过", flush=True); continue
        if st["status"] in ("human", "budget", "no_keyframe") and "--redo" in sys.argv: st.update(tries=[], status="todo", fails=0)
        elif st["status"] == "human": print(sid, "上次已交给人看，跳过（要重来加 --redo）", flush=True); continue
        key = os.path.join(HERE, t["key"]) if t["key"] else os.path.join(GAME, specs[sid]["keyframe"])
        if not os.path.exists(key): print(sid, "缺关键帧", key, "→ 先运行 make_keys.bat", flush=True); st["status"] = "no_keyframe"; continue
        spec = dict(specs[sid]); spec["keyframe"] = key
        if t["describe"]: spec["describe"] = t["describe"]
        prompt = t["prompt"] or ((last.get(sid) or {}).get("gemini") or {}).get("fix_prompt") or spec["describe"]
        best = None
        while len(st["tries"]) <= MAX_RETRY:
            if state["spent"] + COST > BUDGET:
                print(f"预算到顶（已花约 ¥{state['spent']:.0f} / ¥{BUDGET:.0f}），停止", flush=True); st["status"] = "budget"; break
            prompt = clean(prompt); n = len(st["tries"]) + 1
            out = os.path.join(OUT, f"{sid}_t{n}.mp4")
            print(f"\n== {sid} 第 {n} 次生成 ==\n提示词：{prompt}", flush=True)
            charged, err = gen_video(key, prompt, out)
            if charged: state["spent"] += COST
            if err or not os.path.exists(out):
                print(sid, "×", err, flush=True)
                if not charged:  # 没扣费的提交失败（网络/审核）不占重拍次数，但连续 3 次就放弃
                    st["fails"] = st.get("fails", 0) + 1
                    if st["fails"] >= 3: st["status"] = "human"; print(sid, "连续提交失败，先跳过", flush=True); json.dump(state, open(state_p, "w", encoding="utf-8"), ensure_ascii=False, indent=1); break
                    if "sensitive" in err: prompt = clean(spec["describe"])
                    continue
                st["tries"].append({"n": n, "prompt": prompt, "error": err})
                json.dump(state, open(state_p, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
                if "sensitive" in err: prompt = clean(spec["describe"])
                continue
            s2 = dict(spec); s2["id"] = f"{sid}_t{n}"; s2["video"] = out
            for k in range(3):  # Gemini 出错（多半是网络）就重新检查，不要把好视频当成不通过
                r = qc.check(s2, GAME, OUT, os.path.join(ROOT, "refs"), True); g = r.get("gemini") or {}
                if g and "error" not in g: break
                print("  Gemini 检查失败，30 秒后重试：", (g or {}).get("error", "没有返回"), flush=True); time.sleep(30)
            if not g or "error" in g:
                st["tries"].append({"n": n, "prompt": prompt, "video": os.path.basename(out), "error": "Gemini 检查失败：" + str((g or {}).get("error", ""))[:150], "sheet": r.get("sheet")})
                st["status"] = "human"; st["best"] = os.path.basename(out)
                print(sid, "质检没跑成，先停下这个镜头，视频留给人看", flush=True); break
            rec = {"n": n, "prompt": prompt, "video": os.path.basename(out), "pass": bool(g.get("pass")), "score": g.get("score"), "issues": g.get("issues", []), "machine": r.get("issues", []), "level": r["level"], "sheet": r.get("sheet")}
            st["tries"].append(rec); print(f"{sid} 第 {n} 次：{'通过' if rec['pass'] else '不通过'} {rec['score']}/10", flush=True)
            for i in rec["issues"]: print("   ", i.get("severity"), i.get("type"), i.get("detail"), flush=True)
            if best is None or (rec["score"] or 0) > (best["score"] or 0): best = rec
            if rec["pass"]:
                install(sid, out, key if t["key"] else None); st["status"] = "installed"; print(sid, "✓ 已换进游戏", flush=True); break
            if mouth_only(g):  # 只差口型：重拍解决不了，内容对了就先换上，排进口型同步
                install(sid, out, key if t["key"] else None); st["status"] = "needs_lipsync"; print(sid, "内容通过、只差口型 → 已换进游戏，等口型同步", flush=True); break
            nxt = g.get("fix_prompt") or prompt
            if bad_words(nxt): print("   （改写提示词里有敏感词，已自动过滤）", flush=True)
            prompt = nxt
            json.dump(state, open(state_p, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        else:
            st["status"] = "human"
        if st["status"] == "human" or st["status"] == "budget": st["best"] = best and best["video"]
        json.dump(state, open(state_p, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    report(state); print(f"\n本次累计花费约 ¥{state['spent']:.0f}（按每条 ¥{COST:.0f} 估）。报告：{os.path.join(OUT, 'autofix.html')}")

def report(state):
    name = {"installed": "✓ 通过，已换进游戏", "needs_lipsync": "◐ 内容通过，只差口型（已换进游戏）", "human": "✗ 重拍 2 次仍不通过，请人工看", "budget": "✗ 预算到顶，未完成", "no_keyframe": "缺关键帧", "todo": "未开始", "manual": "✓ 人工选定，已换进游戏"}
    rows = []
    for sid, st in state["shots"].items():
        tr = "".join(f"<div class=t><b>第 {x['n']} 次</b> {'通过' if x.get('pass') else '不通过'} {x.get('score','')}/10 {html.escape(x.get('error',''))}<br><small>{html.escape(x['prompt'])}</small><ul>" + "".join(f"<li>[{html.escape(str(i.get('severity')))}] {html.escape(str(i.get('type')))}：{html.escape(str(i.get('detail')))}</li>" for i in x.get('issues', [])) + "</ul>" + (f"<img src='{x['sheet']}' width=640>" if x.get('sheet') else "") + "</div>" for x in st["tries"])
        rows.append(f"<h3>{sid} · {name.get(st['status'], st['status'])}{' · 最好的一条：' + st['best'] if st.get('best') else ''}</h3>{tr}")
    open(os.path.join(OUT, "autofix.html"), "w", encoding="utf-8").write(f"""<!doctype html><meta charset=utf-8><title>自动重拍报告</title><style>body{{font:14px/1.6 "Microsoft YaHei",sans-serif;background:#16171a;color:#e6e2da;padding:20px}}.t{{border-left:3px solid #444;padding:6px 12px;margin:8px 0}}small{{color:#aaa}}</style><h2>自动重拍报告 · 已花约 ¥{state['spent']:.0f}</h2>{''.join(rows)}""")

if __name__ == "__main__":
    main()
