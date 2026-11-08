# 分镜批量出图：Gemini 出图 → Gemini 看图质检（对照分镜和参考图）→ 不通过带着问题重画（最多再画 2 次）→ 通过的换进游戏
# 用法：python batch.py            全部镜头（已通过的跳过，可以中断后接着跑）
#       python batch.py ride_00     只做某几个
# 读 GEMINI_API_KEY（需代理，出口在美国/日本等）。预算：IMG_BUDGET_USD（默认 15 美元，按每张图约 0.14 美元、每次质检约 0.01 美元估）
import os, sys, json, time, base64, html, re, shutil
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE); sys.path.insert(0, HERE)
import gen_images as gi
from PIL import Image
GAME = os.path.join(ROOT, "moban_game"); OUT = os.path.join(HERE, "out", "batch"); FINAL = os.path.join(GAME, "img", "l")
QC_MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.8-flash")
BUDGET = float(os.environ.get("IMG_BUDGET_USD", "15")); PRICE_IMG, PRICE_QC = 0.14, 0.01
MAX_TRY = 3
# 人和人、人和物的关系（2026-11-01）：只说「画面里只有这些人」会让模型把本来在场的人删掉——车在开，驾驶座却空着、方向盘没人握。
# 所以出图时说明「在场但不是主角的人」照样在位置上；质检时专门查这类关系。影游剪辑台的 promptText 要同步。
PRESENCE = ("【在场的其他人】「画面里」写的是这个镜头的主角。按座位设定本来就在场的其他人，如果他们的位置落在画面里，要画出来（可以只露出手、肩膀、"
            "后脑或虚化的背影），不要让本该有人的座位空着；车在行驶时，驾驶座上一定有司机，双手握着方向盘。除此之外不要出现其他人。")
RELATION_QC = ("人和人、人和物的关系合乎情理：车在行驶时驾驶座上一定有司机、手握方向盘——画面里看得到驾驶座或方向盘，就必须看到司机（至少他的手）；"
               "看得到的座位按座位设定该有人就有人、该空就空；拿着、抱着、放在腿上的东西要有手托着或放稳（皮箱在女人腿上），不能悬空；"
               "人物看着、指着、说话的对象要在对应方向上。")
SKETCH_QC = "已附构图草图和俯视位置图：人物左右位置、朝向、机位、车头方向要和草图一致（草图是示意，画风不同不扣分；成品里出现草图的色块、箭头、文字标注则不通过）。\n"

# 注意：影游剪辑台的「提示词审阅」(renderer/app.js 里的 promptText) 按同样的写法拼提示词给人看，改这里要同步改那边
def prompt(shot, bible, fixes):
    rules = "；".join(f"{k}：{v}" for k, v in bible.items())
    p = (f"为一部互动电影游戏画一张分镜剧照（16:9 横幅）。\n"
         f"【构图，以画面方向为准，必须做到】{shot['layout']}\n"
         f"【画面内容】{shot['desc']}\n【景别】{shot['shot']}。【画面里的主角】{shot['in_frame']}。【场景】{shot['location']}\n" + PRESENCE + "\n"
         f"【统一设定】{rules}\n人物长相、发型、服装、道具必须和对应参考图一致；不要照抄参考图的灰色背景和排版；画面里不要任何文字、字幕或水印。")
    if shot.get("sketch"): p += "\n【构图草图】已附构图草图和俯视位置图：人物的左右位置、朝向、机位、车头方向必须和草图一致；草图只是示意，不要画出草图里的色块、简笔人形、箭头和文字。"
    if fixes: p += "\n【上一次画错了，这次务必改正】" + "；".join(fixes)
    return p

def qc(shot, bible, img):
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    parts = []
    for i, r in enumerate(shot["refs"]):
        p = os.path.join(ROOT, r)
        if os.path.exists(p):
            im = Image.open(p).convert("RGB"); im.thumbnail((640, 640)); from io import BytesIO; b = BytesIO(); im.save(b, "JPEG", quality=80)
            parts += [{"text": f"参考图{i+1}：{os.path.splitext(os.path.basename(r))[0]}"}, {"inline_data": {"mime_type": "image/jpeg", "data": base64.b64encode(b.getvalue()).decode()}}]
    parts += gi.sketch_parts(shot)
    parts += [{"text": "待检查的分镜图："}, {"inline_data": {"mime_type": "image/png", "data": gi.b64(img)}}]
    parts.append({"text": f"""你是电影分镜的审核员。请严格检查最后这张分镜图是否符合要求，只输出 JSON。
要求的构图（以画面方向为准）：{shot['layout']}
画面内容：{shot['desc']}
画面里的主角：{shot['in_frame']}（按座位设定本来就在场、位置落在画面里的人——比如驾驶座上的司机——可以只露出手、肩膀或背影，不算多余；真正多出来的人才算）
统一设定：{'；'.join(f'{k}：{v}' for k, v in bible.items())}
{SKETCH_QC if shot.get("sketch") else ""}重点检查：1) 该出现的人都在、没有多余的人、人物左右位置和构图一致；2) 出租车是左舵（方向盘和司机在车的左侧——从车前方看，司机在画面右侧；从车后方或车内往前看，司机在画面左侧）；3) 人物长相、发型、服装和参考图一致（女人是深色卷发、貂皮大衣；大军戴狗皮帽、军绿棉袄）；4) 1998 年东北，没有现代物品、没有第五套人民币；5) 没有文字、字幕、水印（保险单的红色抬头除外）；6) 没有明显的手指、肢体变形；7) {RELATION_QC}
输出：{{"pass": true/false, "score": 0-10, "issues": ["每条一句话，说清楚哪里不对"], "fix": "重画时要强调的一句话"}}
只要有一条会让观众看错人、看错座位或明显穿帮的问题，就 pass=false。"""})
    body = {"contents": [{"parts": parts}], "generationConfig": {"responseMimeType": "application/json", "temperature": 0.1}}
    for a in range(3):
        st, js = gi.http(f"{gi.G}/models/{QC_MODEL}:generateContent", body, {"x-goog-api-key": key})
        if st == 200:
            q = gi.json_reply(js)
            return q if q is not None else {"error": "质检返回看不懂：" + json.dumps(js, ensure_ascii=False)[:300]}
        time.sleep(10 * (a + 1))
    return {"error": f"质检失败 HTTP {st} " + json.dumps(js, ensure_ascii=False)[:200]}

def install(sid, png):
    os.makedirs(FINAL, exist_ok=True)
    im = Image.open(png).convert("RGB"); w, h = im.size; nh = round(w * 9 / 16)
    if nh <= h: im = im.crop((0, (h - nh) // 2, w, (h - nh) // 2 + nh))
    else: nw = round(h * 16 / 9); im = im.crop(((w - nw) // 2, 0, (w - nw) // 2 + nw, h))
    im.resize((1280, 720), Image.LANCZOS).save(os.path.join(FINAL, sid + ".jpg"), quality=88)

def register(ids):
    with gi.file_lock(os.path.join(GAME, "index.html")): _register(ids)

def _register(ids):
    """把有逐句图的镜头登记到游戏的 LIMG 数据块里（先备份）"""
    p = os.path.join(GAME, "index.html"); h = open(p, encoding="utf-8").read()
    m = re.search(r"const LIMG=new Set\(/\*LIMG\*/(\[.*?\])\);", h)
    if not m: print("游戏里没找到 LIMG 数据块，没登记"); return
    cur = set(json.loads(m.group(1))) | set(ids)   # 只增不减，几个任务先后登记也不会丢
    bk = os.path.join(HERE, "out", "index_before_register.html")
    if not os.path.exists(bk): shutil.copy2(p, bk)
    h = h[:m.start(1)] + json.dumps(sorted(cur)) + h[m.end(1):]
    open(p, "w", encoding="utf-8").write(h)

def main():
    if not os.environ.get("GEMINI_API_KEY"): print("没有找到 GEMINI_API_KEY"); sys.exit(2)
    sl = json.load(open(os.path.join(HERE, "shotlist.json"), encoding="utf-8")); bible = sl["bible"]
    only = set(sys.argv[1:]); os.makedirs(OUT, exist_ok=True)
    sp = os.path.join(OUT, "state.json")
    try: state = json.load(open(sp, encoding="utf-8"))
    except Exception: state = {"spent": 0.0, "shots": {}}
    for v in state["shots"].values(): v["tries"] = [t for t in v.get("tries", []) if t.get("file")]
    state["spent"] = sum(PRICE_IMG + PRICE_QC for v in state["shots"].values() for t in v["tries"])
    touched, base = set(), [state["spent"]]
    def save():   # 只写自己处理过的镜头，别的任务同时在跑也不会互相覆盖
        merged = gi.save_state_merge(sp, state, touched, state["spent"] - base[0]); base[0] = state["spent"]; return merged
    for shot in sl["shots"]:
        sid = shot["id"]
        if only and sid not in only: continue
        touched.add(sid)
        if "reuse" in shot:   # 已有的近景插图，直接复制成逐句图
            src = os.path.join(GAME, "img", shot["reuse"] + ".jpg")
            if os.path.exists(src): os.makedirs(FINAL, exist_ok=True); shutil.copy2(src, os.path.join(FINAL, sid + ".jpg")); state["shots"][sid] = {"status": "reuse", "tries": []}
            continue
        st = state["shots"].setdefault(sid, {"status": "todo", "tries": []})
        if st["status"] in ("pass", "best", "manual", "local") and not only: continue   # local：剪辑台里从本地换的图
        if only: st.update(status="todo", tries=[])
        fixes, best, fails = [], None, 0
        while len(st["tries"]) < MAX_TRY:
            if state["spent"] + PRICE_IMG + PRICE_QC > BUDGET: print(f"预算到顶（约 ${state['spent']:.2f}），停止"); st["status"] = "budget"; break
            n = len(st["tries"]) + 1; out = os.path.join(OUT, f"{sid}_t{n}.png")
            gi.prompt_for = lambda s, b, _f=list(fixes): prompt(s, b, _f)
            t0 = time.time(); err = gi.gen_gemini(shot, bible, out)
            if err:
                print(f"{sid} 第{n}次 × {err[:160]}", flush=True)
                if any(k in err for k in ("402", "RESOURCE_EXHAUSTED", "credits", "billing", "quota")):
                    print("Gemini 账户额度用完了：请到 AI Studio 给项目充值后，再双击 run_batch.bat 接着跑（已完成的会跳过）。", flush=True)
                    cur = save(); register([k for k, v in cur["shots"].items() if v.get("status") in ("pass", "best", "reuse")]); report(sl, cur); return
                time.sleep(10); fails += 1
                if fails >= 3: break
                continue
            state["spent"] += PRICE_IMG
            q = qc(shot, bible, out); state["spent"] += PRICE_QC
            rec = {"n": n, "file": os.path.basename(out), "pass": bool(q.get("pass")), "score": q.get("score", 0), "issues": q.get("issues", []), "fix": q.get("fix", ""), "error": q.get("error")}
            st["tries"].append(rec)
            print(f"{sid} 第{n}次 {'✓ 通过' if rec['pass'] else '× 不通过'} {rec['score']}/10（{time.time()-t0:.0f} 秒）" + ("" if rec["pass"] else "：" + "；".join(rec["issues"])[:200]), flush=True)
            if rec["pass"] or not best or (rec["score"] or 0) > (best["score"] or 0): best = rec   # 通过的那张优先
            if rec["pass"] or rec.get("error"):
                break
            fixes = (rec["issues"] + ([rec["fix"]] if rec["fix"] else []))[:4]
            save()
        if best:
            install(sid, os.path.join(OUT, best["file"])); st["final"] = best["file"]
            st["status"] = "pass" if best["pass"] else "best"
        save()
    cur = save()   # 合并后的完整记录（含同时在跑的其他任务的结果）
    done = [k for k, v in cur["shots"].items() if v.get("status") in ("pass", "best", "reuse")]
    register(done); report(sl, cur); state = cur
    print(f"完成：{sum(v.get('status')=='pass' for v in state['shots'].values())} 张通过，{sum(v.get('status')=='best' for v in state['shots'].values())} 张没通过（用了最好的一张，请人看），"
          f"{sum(v.get('status')=='reuse' for v in state['shots'].values())} 张沿用已有插图。累计约 ${state['spent']:.2f}。报告：{os.path.join(OUT, 'report.html')}")

def report(sl, state):
    E = html.escape; rows = []
    for shot in sl["shots"]:
        st = state["shots"].get(shot["id"]);
        if not st: continue
        tag = {"pass": "✓ 通过", "best": "⚠ 没通过，先用最好的一张，请人看", "reuse": "沿用已有插图", "budget": "预算到顶", "todo": "未完成"}.get(st["status"], st["status"])
        tries = "".join(f"<div class=t><img src='{t['file']}' width=360><br>第{t['n']}次 {'通过' if t.get('pass') else '不通过'} {t.get('score','')}/10<br><small>{E('；'.join(t.get('issues', [])))}{E(t.get('error') or '')}</small></div>" for t in st["tries"] if t.get("file"))
        rows.append(f"<section><h3>{shot['id']} · {tag}</h3><p><small>{E(shot.get('layout',''))}<br>{E(shot['desc'])}</small></p><div class=row>{tries}</div></section>")
    open(os.path.join(OUT, "report.html"), "w", encoding="utf-8").write(
        "<!doctype html><meta charset=utf-8><title>分镜出图报告</title><style>body{font:13px 'Microsoft YaHei';background:#16171a;color:#e6e2da;padding:16px}.row{display:flex;gap:10px;flex-wrap:wrap}.t{width:360px}small{color:#aaa}section{border-top:1px solid #333;padding:6px 0}</style>"
        f"<h2>分镜出图报告 · 累计约 ${state['spent']:.2f}</h2>" + "".join(rows))

if __name__ == "__main__":
    main()
