# 自动重拍循环：生成视频 → Gemini 质检 → 不通过就用（过滤过敏感词的）改写提示词重拍 → 最多重拍 1 次（共 2 次生成）→ 剩下的交给人看
# 用法：python autofix.py [镜头id,镜头id ...] [--redo] [--again] [--force]   不写镜头就跑 video_shots.json 里 auto=true 的
#   第一次生成前提示词必须在剪辑台里审过（--force 跳过这个检查）；之后的自动重拍放行，每次 AI 改写都记进 state.json
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
MAX_RETRY = 1
GAME = os.path.join(ROOT, "moban_game"); OUT = os.path.join(HERE, os.environ.get("AUTOFIX_OUT", "out")); BACKUP = os.path.join(HERE, "backup")
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

# 本轮要重拍的镜头也可以写在 targets.json 里（优先于上面的 TARGETS）：
# {"镜头id": {"key": "关键帧（首帧）", "last": "尾帧（可选，给了就用首尾帧模式）", "model": "可选", "prompt": "...", "describe": "..."}}
_TJ = os.path.join(HERE, "targets.json")
if os.path.exists(_TJ): TARGETS = json.load(open(_TJ, encoding="utf-8"))
# 2026-11-01 起：从视频分镜表 video_shots.json 读（python video_shots.py migrate 生成，剪辑台「审阅 → ③ 视频提示词」里看和改）。
# 有它就不再用上面的 TARGETS 和 targets.json。不写镜头名时做 auto=true 的那些。
import video_shots as VS
VSHOTS = None
if os.path.exists(VS.PATH):
    _VD, VSHOTS = VS.load(); SUF = _VD.get("suffix", SUF)
    TARGETS = {k: v for k, v in VSHOTS.items() if v.get("auto")}
LAST_MODEL = os.environ.get("MINIMAX_FL_MODEL", "MiniMax-Hailuo-02")   # 首尾帧用的模型
# 可选的视频模型（剪辑台「生成视频」时选，命令行 --engine=名字）。价格按 MiniMax 开放平台定价（2026-11）：海螺按条，H3 按秒
ENGINES = {
    "hailuo":       {"label": "海螺 2.3 · 768P",      "kind": "hailuo", "model": "MiniMax-Hailuo-2.3",      "res": "768P", "clip": {6: 2.0, 10: 4.0}},
    "hailuo_fast":  {"label": "海螺 2.3 Fast · 768P", "kind": "hailuo", "model": "MiniMax-Hailuo-2.3-Fast", "res": "768P", "clip": {6: 1.35, 10: 2.25}},
    "hailuo02_512": {"label": "海螺 02 · 512P（低清草稿）", "kind": "hailuo", "model": "MiniMax-Hailuo-02", "res": "512P", "clip": {6: 0.6, 10: 1.0}},
    "h3":           {"label": "H3 · 768P",            "kind": "h3", "model": "MiniMax-H3",      "res": "768P", "sec": 0.50},
    "h3_lite":      {"label": "H3-Lite · 768P",       "kind": "h3", "model": "MiniMax-H3-Lite", "res": "768P", "sec": 0.26},
    "h3_lite480":   {"label": "H3-Lite · 480P（低清草稿）", "kind": "h3", "model": "MiniMax-H3-Lite", "res": "480P", "sec": 0.16},
}


def engine_dur(e, t):
    """这个模型实际生成几秒：海螺只有 6 / 10；H3 取 4～10 秒的整数（按需要的时长往上取）。"""
    need = float(t.get("duration_need") or t.get("duration") or 6)
    if ENGINES[e]["kind"] == "hailuo": return 10 if float(t.get("duration") or 6) >= 8 else 6
    return int(min(10, max(4, -(-need // 1))))


def engine_cost(e, dur):
    E = ENGINES[e]; return E["clip"][10 if dur >= 8 else 6] if E["kind"] == "hailuo" else round(E["sec"] * dur, 2)

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

def data_url(img):
    mime = "image/png" if img.lower().endswith(".png") else "image/jpeg"
    return f"data:{mime};base64," + base64.b64encode(open(img, "rb").read()).decode()

def gen_video(img, prompt, out, last=None, model=None, duration=6, res="768P"):
    """返回 (是否扣费, 错误信息)。给了 last（尾帧）就用首尾帧模式：画面从首帧走到尾帧，动作方向更可控"""
    body = {"model": model or (LAST_MODEL if last else "MiniMax-Hailuo-2.3"), "prompt": prompt + SUF, "first_frame_image": data_url(img), "duration": 10 if int(duration or 6) >= 8 else 6, "resolution": res}   # 海螺只接受 6 / 10 秒
    if last: body["last_frame_image"] = data_url(last)
    for k in range(1 if '--single' in sys.argv else 6):  # 单次模式不自动重提网络异常任务
        st, js = call("POST", "/v1/video_generation", body); b = js.get("base_resp") or {}
        if st != 0: break
        print(f"  网络出错，{20*(k+1)} 秒后重试：{js.get('raw','')[:80]}", flush=True); time.sleep(20 * (k + 1))
    tid = js.get("task_id")
    if not tid and last and st != 0 and '--single' not in sys.argv:  # 首尾帧模式不被接受时，退回只用首帧，并说明原因
        print(f"  首尾帧模式提交失败（{b.get('status_code')} {b.get('status_msg')} {js.get('raw','')[:120]}），改用只给首帧", flush=True)
        return gen_video(img, prompt, out, None, model if model and "02" not in model else None, duration, res)
    if not tid: return False, f"提交失败 {st} {b.get('status_code')} {b.get('status_msg')} {js.get('raw','')}"
    for i in range(90):
        time.sleep(10)
        _, j2 = call("GET", f"/v1/query/video_generation?task_id={tid}"); s = j2.get("status")
        if s == "Success":
            _, j3 = call("GET", f"/v1/files/retrieve?file_id={j2.get('file_id')}")
            urllib.request.urlretrieve(j3["file"]["download_url"], out); return True, ""
        if s in ("Fail", "Failed"): return True, "生成失败 " + json.dumps(j2, ensure_ascii=False)[:200]
    return True, "超时"

# ---------- MiniMax-H3：多图参考（最多 9 张参考图）+ 首尾帧，走 v2 接口 ----------
def _find(js, keys):
    """在返回的 JSON 里找第一个出现的字段（v2 接口字段名以官方文档为准，这里容错）"""
    if isinstance(js, dict):
        for k, v in js.items():
            if k in keys and isinstance(v, (str, int)): return v
        for v in js.values():
            r = _find(v, keys)
            if r is not None: return r
    elif isinstance(js, list):
        for v in js:
            r = _find(v, keys)
            if r is not None: return r
    return None

def gen_video_h3(img, prompt, out, last=None, refs=(), model="MiniMax-H3", mid=None, duration=6, res="768P"):
    """H3 两种用法（官方规定二选一，不能混用）：
    1) 参考模式：有 refs 时。关键帧当参考图 1（定构图），后面是这一镜专用的生成参考图和角色设定图，总共最多 9 张；
    2) 帧模式：没有 refs 时。首帧 +（可选）中间帧 + 尾帧，用来控制动作走向。
    refs 每项是 (路径, 说明)"""
    if refs:
        items = [(img, "本镜头的构图、机位和光线（视频要和它一致）")] + list(refs)
        items = items[:9]
        tip = "；".join(f"参考图{i+1}：{lab}" for i, (_, lab) in enumerate(items))
        content = [{"type": "text", "text": f"{prompt}{SUF}（{tip}。画面构图以参考图1为准，人物长相、服装、道具与对应参考图一致）"}]
        content += [{"type": "image_url", "image_url": {"url": data_url(p)}, "role": "reference_image"} for p, _ in items]
        mode = f"参考模式 {len(items)} 张图"
    else:
        content = [{"type": "text", "text": prompt + SUF}, {"type": "image_url", "image_url": {"url": data_url(img)}, "role": "first_frame"}]
        if mid: content.append({"type": "image_url", "image_url": {"url": data_url(mid)}, "role": "middle_frame"})
        if last: content.append({"type": "image_url", "image_url": {"url": data_url(last)}, "role": "last_frame"})
        mode = "帧模式 首帧" + ("+中间帧" if mid else "") + ("+尾帧" if last else "")
    body = {"model": model, "content": content, "duration": int(duration or 6), "resolution": res}
    for k in range(1 if '--single' in sys.argv else 6):
        st, js = call("POST", "/v2/video_generation", body)
        if st != 0: break
        print(f"  网络出错，{20*(k+1)} 秒后重试", flush=True); time.sleep(20 * (k + 1))
    tid = _find(js, ("task_id", "id"))
    if not tid and '--single' not in sys.argv and body["duration"] != 6 and "duration" in json.dumps(js, ensure_ascii=False).lower():   # 这个时长不被接受：退回 6 秒再交一次
        print(f"  H3 不接受 {body['duration']} 秒（{json.dumps(js, ensure_ascii=False)[:120]}），改成 6 秒", flush=True)
        body["duration"] = 6; st, js = call("POST", "/v2/video_generation", body); tid = _find(js, ("task_id", "id"))
    if not tid: return False, f"H3 提交失败 {st} " + json.dumps(js, ensure_ascii=False)[:300]
    print(f"  H3 已提交（{mode}）", flush=True)
    for i in range(120):
        time.sleep(10)
        _, j2 = call("GET", f"/v2/query/video_generation/{tid}")
        s = str(_find(j2, ("status",)) or "").lower()
        if s in ("success", "succeeded", "completed", "done"):
            url = _find(j2.get("content") or j2, ("url", "video_url", "download_url"))
            if not url and _find(j2, ("file_id",)):
                _, j3 = call("GET", f"/v1/files/retrieve?file_id={_find(j2, ('file_id',))}"); url = (j3.get("file") or {}).get("download_url")
            if not url: return True, "H3 成功但找不到下载地址：" + json.dumps(j2, ensure_ascii=False)[:300]
            urllib.request.urlretrieve(url, out); return True, ""
        if s in ("fail", "failed", "error", "cancelled"): return True, "H3 生成失败 " + json.dumps(j2, ensure_ascii=False)[:300]
    return True, "H3 超时"

def h3_refs(t):
    """这一镜的参考图：先放生成的专用参考图（refs_gen/），再放角色设定图；文件不存在的跳过"""
    out = []
    for g in t.get("gen_refs", []):
        p = os.path.join(HERE, "refs_gen", g["name"] + ".png")
        if os.path.exists(p): out.append((p, g.get("label", g["name"])))
    for r in t.get("refs", []):
        p, lab = (r, os.path.splitext(os.path.basename(r))[0]) if isinstance(r, str) else (r[0], r[1])
        p = os.path.join(ROOT, p)
        if os.path.exists(p): out.append((p, lab))
    return out

def install(sid, video, key_png):
    os.makedirs(BACKUP, exist_ok=True); ts = time.strftime("%m%d_%H%M")
    t = (VSHOTS or {}).get(sid) if "VSHOTS" in globals() else None
    dst = os.path.join(GAME, *((t or {}).get("video") or f"vid/{sid}.mp4").split("/"))   # 台词页视频放在 vid/l/ 里
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    if os.path.exists(dst): shutil.copy2(dst, os.path.join(BACKUP, f"{sid}_{ts}.mp4"))
    shutil.copy2(video, dst)
    if key_png:  # 新关键帧也换进游戏（裁成 16:9 的 1280x720 jpg）
        kd = os.path.join(GAME, *((t or {}).get("keyframe") or f"img/{sid}.jpg").split("/"))   # 台词页的首帧在 img/l/
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
    ALL = VSHOTS if VSHOTS is not None else TARGETS
    ids = [x for x in (args[0].split(",") if args else TARGETS) if x in ALL]
    if args: [print(x, "：视频分镜表里没有这个镜头，跳过", flush=True) for x in args[0].split(",") if x not in ALL]
    os.makedirs(os.path.join(OUT, "sheets"), exist_ok=True)
    state_p = os.path.join(OUT, "state.json")
    try: state = json.load(open(state_p, encoding="utf-8"))
    except Exception: state = {"spent": 0, "shots": {}}
    for sid in ids:
        t = ALL[sid]; st = state["shots"].setdefault(sid, {"tries": [], "status": "todo"})
        if t.get("novideo"): print(sid, "在视频分镜表里标了「不做视频」，跳过", flush=True); continue
        if sid not in specs:   # 剪辑台按剧本补的占位条目：质检标准直接用视频分镜表里的
            specs[sid] = {"id": sid, "kind": t.get("kind", "shot"), "keyframe": t.get("keyframe", f"img/{sid}.jpg"), "describe": t.get("describe") or t.get("prompt", ""),
                          "refs": t.get("qc_refs", []), "speakers": t.get("speakers", []), "need_mouth": bool(t.get("need_mouth")), "video": t.get("video", f"vid/{sid}.mp4")}
        ENG = next((a.split("=", 1)[1] for a in sys.argv if a.startswith("--engine=")), None)
        if ENG and ENG not in ENGINES: print(f"不认识的模型 {ENG}，可选：{'、'.join(ENGINES)}", flush=True); ENG = None
        MORE = "--more" in sys.argv          # 多生成一版：保留以前的版本，只生成一次、不自动换进游戏（到「④ 成片」里挑）
        if "--again" in sys.argv and not MORE: st.update(tries=[], status="todo", fails=0)   # 剪辑台点「生成视频」：不管之前什么状态都重新来
        if MORE: st["fails"] = 0
        if st["status"] in ("installed", "needs_lipsync", "manual") and not MORE: print(sid, "之前已完成，跳过", flush=True); continue
        if st["status"] in ("human", "budget", "no_keyframe", "await_review") and "--redo" in sys.argv: st.update(tries=[], status="todo", fails=0)
        elif st["status"] == "human": print(sid, "上次已交给人看，跳过（要重来加 --redo）", flush=True); continue
        key = os.path.join(HERE, t["key"]) if t.get("key") else os.path.join(GAME, specs[sid]["keyframe"])
        if not os.path.exists(key): print(sid, "缺关键帧", key, "→ 先运行 make_keys.bat", flush=True); st["status"] = "no_keyframe"; continue
        spec = dict(specs[sid]); spec["keyframe"] = key
        if t.get("describe"): spec["describe"] = t["describe"]
        prompt = t.get("prompt") or ((last.get(sid) or {}).get("gemini") or {}).get("fix_prompt") or spec["describe"]
        best = None; rewritten = False; n0 = len(st["tries"]); prev_status = st["status"]
        # 人审（方案 C）：第一次生成前，提示词必须在剪辑台里审过；之后的自动重拍放行，但记下「AI 改写」
        if VSHOTS is not None and (not st["tries"] or MORE) and "--force" not in sys.argv and not VS.reviewed(t):
            print(f"{sid}：提示词还没人审过（或审过之后又改了），先不生成。到影游剪辑台「审阅 → ③ 视频提示词」点「没问题」后再跑；确实不用审可以加 --force", flush=True)
            st["status"] = "await_review"; json.dump(state, open(state_p, "w", encoding="utf-8"), ensure_ascii=False, indent=1); continue
        if st["status"] == "await_review": st["status"] = "todo"
        while len(st["tries"]) <= (0 if '--single' in sys.argv else MAX_RETRY) or (MORE and len(st["tries"]) == n0):
            if MORE and len(st["tries"]) > n0: break
            dur = engine_dur(ENG, t) if ENG else t.get("duration", 6); cost = engine_cost(ENG, dur) if ENG else float(t.get("cost", COST))
            if state["spent"] + cost > BUDGET:
                print(f"预算到顶（已花约 ¥{state['spent']:.0f} / ¥{BUDGET:.0f}），停止", flush=True); st["status"] = "budget"; break
            cp = clean(prompt)
            if cp != prompt: print("   （提示词里有视频平台会拦的词，已自动过滤；最好回剪辑台改掉）", flush=True)
            prompt = cp; n = len(st["tries"]) + 1
            out = os.path.join(OUT, f"{sid}_t{n}.mp4")
            print(f"\n== {sid} 第 {n} 次生成 ==\n提示词：{prompt}", flush=True)
            lastf = os.path.join(HERE, t["last"]) if t.get("last") else None
            if lastf and not os.path.exists(lastf): print("  缺尾帧", lastf, "→ 只用首帧", flush=True); lastf = None
            if ENG:                                  # 剪辑台里选了模型
                E = ENGINES[ENG]; print(f"  模型：{E['label']}，{dur} 秒，约 ¥{cost:g}", flush=True)
                if E["kind"] == "h3":
                    midf = os.path.join(HERE, t["mid"]) if t.get("mid") and os.path.exists(os.path.join(HERE, t["mid"])) else None
                    charged, err = gen_video_h3(key, prompt, out, lastf, h3_refs(t) if t.get("mode") == "h3" else (), E["model"], midf, dur, E["res"])
                else: charged, err = gen_video(key, prompt, out, lastf, E["model"] if not lastf else None, dur, E["res"])
            elif t.get("mode") == "h3":
                midf = os.path.join(HERE, t["mid"]) if t.get("mid") and os.path.exists(os.path.join(HERE, t["mid"])) else None
                charged, err = gen_video_h3(key, prompt, out, lastf, h3_refs(t), t.get("model") or "MiniMax-H3", midf, t.get("duration", 6))
                if not charged and err:  # H3 用不了（没开通 / 参数不对）就退回海螺 2.3 / 02，并把原因写进日志
                    print("  H3 不可用：", err[:200], "\n  → 退回海螺视频模型", flush=True)
                    charged, err = gen_video(key, prompt, out, lastf, None, t.get("duration", 6))
            else:
                charged, err = gen_video(key, prompt, out, lastf, t.get("model"), t.get("duration", 6))
            if charged: state["spent"] += cost
            eng_rec = {"engine": ENG or ("h3" if t.get("mode") == "h3" else "hailuo"), "engine_label": ENGINES[ENG]["label"] if ENG else ("H3 · 768P" if t.get("mode") == "h3" else "海螺 2.3 · 768P"), "dur": dur, "cost": cost}
            if err or not os.path.exists(out):
                print(sid, "×", err, flush=True)
                if not charged:  # 没扣费的提交失败（网络/审核）不占重拍次数，但连续 3 次就放弃
                    if '--single' in sys.argv:
                        st['status'] = 'human'; st['last_submit_error'] = err
                        print(sid, '单次模式提交失败，不自动重提', flush=True)
                        json.dump(state, open(state_p, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
                        break
                    st["fails"] = st.get("fails", 0) + 1
                    if st["fails"] >= 3: st["status"] = "human"; print(sid, "连续提交失败，先跳过", flush=True); json.dump(state, open(state_p, "w", encoding="utf-8"), ensure_ascii=False, indent=1); break
                    if "sensitive" in err: prompt = clean(spec["describe"])
                    continue
                st["tries"].append({"n": n, "prompt": prompt, "error": err, "ai_rewrite": rewritten, **eng_rec})
                json.dump(state, open(state_p, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
                if "sensitive" in err: prompt = clean(spec["describe"]); rewritten = True
                continue
            s2 = dict(spec); s2["id"] = f"{sid}_t{n}"; s2["video"] = out
            for k in range(3):  # Gemini 出错（多半是网络）就重新检查，不要把好视频当成不通过
                r = qc.check(s2, GAME, OUT, os.path.join(ROOT, "refs"), True); g = r.get("gemini") or {}
                if g and "error" not in g: break
                print("  Gemini 检查失败，30 秒后重试：", (g or {}).get("error", "没有返回"), flush=True); time.sleep(30)
            if not g or "error" in g:
                st["tries"].append({"n": n, "prompt": prompt, "video": os.path.basename(out), "error": "Gemini 检查失败：" + str((g or {}).get("error", ""))[:150], "sheet": r.get("sheet"), "ai_rewrite": rewritten, **eng_rec})
                if MORE: st["status"] = prev_status if prev_status not in ("todo", "await_review") else "human"; break
                st["status"] = "human"; st["best"] = os.path.basename(out)
                print(sid, "质检没跑成，先停下这个镜头，视频留给人看", flush=True); break
            rec = {"n": n, "prompt": prompt, "video": os.path.basename(out), "pass": bool(g.get("pass")), "score": g.get("score"), "issues": g.get("issues", []), "machine": r.get("issues", []), "level": r["level"], "sheet": r.get("sheet"), "ai_rewrite": rewritten, **eng_rec}
            st["tries"].append(rec); print(f"{sid} 第 {n} 次：{'通过' if rec['pass'] else '不通过'} {rec['score']}/10", flush=True)
            for i in rec["issues"]: print("   ", i.get("severity"), i.get("type"), i.get("detail"), flush=True)
            if best is None or (rec["score"] or 0) > (best["score"] or 0): best = rec
            if MORE:                                  # 多生成一版：不换进游戏，状态保持原样，到「④ 成片」里挑
                st["status"] = prev_status if prev_status not in ("todo", "await_review") else ("human" if not rec["pass"] else "todo")
                print(sid, f"多生成的一版已保存（{os.path.basename(out)}），到剪辑台「④ 成片」里对比、选用", flush=True); break
            if rec["pass"]:
                install(sid, out, key if t.get("key") else None); st["status"] = "installed"; print(sid, "✓ 已换进游戏", flush=True); break
            if mouth_only(g):  # 只差口型：重拍解决不了，内容对了就先换上，排进口型同步
                install(sid, out, key if t.get("key") else None); st["status"] = "needs_lipsync"; print(sid, "内容通过、只差口型 → 已换进游戏，等口型同步", flush=True); break
            nxt = g.get("fix_prompt") or prompt
            if bad_words(nxt): print("   （改写提示词里有敏感词，已自动过滤）", flush=True)
            if nxt != prompt: rewritten = True; print("   下一次用 AI 改写的提示词（没经过人审，剪辑台里会标出来）", flush=True)
            prompt = nxt
            json.dump(state, open(state_p, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        else:
            st["status"] = "human"
        if st["status"] == "human" or st["status"] == "budget": st["best"] = best and best["video"]
        json.dump(state, open(state_p, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    report(state); print(f"\n本次累计花费约 ¥{state['spent']:.0f}（按每条 ¥{COST:.0f} 估）。报告：{os.path.join(OUT, 'autofix.html')}")

def report(state):
    name = {"await_review": "… 提示词还没人审，没生成", "installed": "✓ 通过，已换进游戏", "needs_lipsync": "◐ 内容通过，只差口型（已换进游戏）", "human": "✗ 未完成，请查看生成或质检日志（每条最多 2 次生成）", "budget": "✗ 预算到顶，未完成", "no_keyframe": "缺关键帧", "todo": "未开始", "manual": "✓ 人工选定，已换进游戏"}
    rows = []
    for sid, st in state["shots"].items():
        tr = "".join(f"<div class=t><b>第 {x['n']} 次</b> {'通过' if x.get('pass') else '不通过'} {x.get('score','')}/10 {html.escape(x.get('error',''))}<br><small>{html.escape(x['prompt'])}</small><ul>" + "".join(f"<li>[{html.escape(str(i.get('severity')))}] {html.escape(str(i.get('type')))}：{html.escape(str(i.get('detail')))}</li>" for i in x.get('issues', [])) + "</ul>" + (f"<img src='{x['sheet']}' width=640>" if x.get('sheet') else "") + "</div>" for x in st["tries"])
        rows.append(f"<h3>{sid} · {name.get(st['status'], st['status'])}{' · 最好的一条：' + st['best'] if st.get('best') else ''}</h3>{tr}")
    open(os.path.join(OUT, "autofix.html"), "w", encoding="utf-8").write(f"""<!doctype html><meta charset=utf-8><title>自动重拍报告</title><style>body{{font:14px/1.6 "Microsoft YaHei",sans-serif;background:#16171a;color:#e6e2da;padding:20px}}.t{{border-left:3px solid #444;padding:6px 12px;margin:8px 0}}small{{color:#aaa}}</style><h2>自动重拍报告 · 已花约 ¥{state['spent']:.0f}</h2>{''.join(rows)}""")

if __name__ == "__main__":
    main()
