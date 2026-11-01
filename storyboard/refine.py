# 分镜图「检查 → 局部修改 → 再检查」循环（比整张重画更稳：保留画对的部分，只改错的地方）
# 用法：
#   python refine.py                       处理所有没通过的镜头（批量出图里标「请人看」的），直到通过或用完轮数
#   python refine.py ride_00 start_04      只处理这几个
#   python refine.py ride_00 "去掉车窗外的楼房，换成雪夜松林"     人工提修改意见：按这句话改当前这张图，再检查
#   加 --force：人工修改后即使质检没通过也换进游戏（你确认过画面没问题时用）
# 读 GEMINI_API_KEY（需代理）。结果在 out\refine\，通过的自动换进游戏并登记
import os, sys, json, time, base64, shutil
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import gen_images as gi, batch as B
from PIL import Image
from io import BytesIO
OUT = os.path.join(HERE, "out", "refine"); os.makedirs(OUT, exist_ok=True)
os.makedirs(B.OUT, exist_ok=True)
MAX_ROUNDS = int(os.environ.get("REFINE_ROUNDS", "4"))
CHECKS = ["人物", "位置构图", "左舵", "长相服装", "道具", "年代", "文字水印", "肢体"]

def jpeg_part(path, maxw=None):
    im = Image.open(path).convert("RGB")
    if maxw: im.thumbnail((maxw, maxw))
    b = BytesIO(); im.save(b, "JPEG", quality=88); return {"inline_data": {"mime_type": "image/jpeg", "data": base64.b64encode(b.getvalue()).decode()}}

def ref_parts(shot):
    parts = []
    for i, r in enumerate(shot["refs"]):
        p = os.path.join(B.ROOT, r)
        if os.path.exists(p): parts += [{"text": f"参考图{i+1}：{os.path.splitext(os.path.basename(r))[0]}"}, jpeg_part(p, 640)]
    return parts + gi.sketch_parts(shot)

def qc2(shot, bible, img):
    """逐项检查；每个问题判断是「局部修改」能解决还是必须「重画」，并写好给图像模型的修改指令"""
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    parts = ref_parts(shot) + [{"text": "待检查的分镜图："}, jpeg_part(img)]
    parts.append({"text": f"""你是电影分镜审核员。逐项严格检查最后这张分镜图，只输出 JSON。
要求的构图（以画面方向为准）：{shot['layout']}
画面内容：{shot['desc']}
画面里只能有：{shot['in_frame']}
统一设定：{'；'.join(f'{k}：{v}' for k, v in bible.items())}
{B.SKETCH_QC if shot.get("sketch") else ""}左舵的判断方法：从车前方隔着挡风玻璃看，司机和方向盘在画面右侧；从车内后座或车后方往前看，司机和方向盘在画面左侧；从车外看到驾驶座车窗时，车头朝画面左侧。
逐项检查：人物（该出现的都在、没有多余的人或多余的手）、位置构图（人物左右位置、景别、机位和要求一致）、左舵、长相服装（和参考图一致：女人深色卷发貂皮大衣，大军狗皮帽军绿棉袄，司机棉帽围巾蓝棉袄）、道具（皮箱、BP机、信封、钱等对不对）、年代（1998 年东北，无现代物品，只能是第四套人民币）、文字水印（除保险单红色抬头外不能有字）、肢体（手指、肢体没有变形）。
对每个问题判断修法：只是局部（多一只手、少条围巾、灯上有字、道具颜色不对、背景里多了东西）→ "edit"；人物左右颠倒、主体画错、景别机位完全不对 → "redraw"。
输出：{{"checks": {{{', '.join(f'"{c}": {{"ok": true/false, "note": ""}}' for c in CHECKS)}}},
 "score": 0-10,
 "problems": [{{"what": "哪里不对", "kind": "edit 或 redraw", "instruction": "给图像模型的修改指令：祈使句，只说要改的地方，具体到位置"}}]}}"""})
    body = {"contents": [{"parts": parts}], "generationConfig": {"responseMimeType": "application/json", "temperature": 0.1}}
    for a in range(3):
        st, js = gi.http(f"{gi.G}/models/{B.QC_MODEL}:generateContent", body, {"x-goog-api-key": key})
        if st == 200:
            try:
                q = json.loads(js["candidates"][0]["content"]["parts"][0]["text"])
                q["pass"] = all((q.get("checks", {}).get(c) or {}).get("ok", True) for c in CHECKS) and not any(p.get("kind") == "redraw" for p in q.get("problems", []))
                return q
            except Exception: return {"error": "质检返回看不懂", "pass": False, "score": 0, "problems": []}
        time.sleep(10 * (a + 1))
    return {"error": f"质检失败 HTTP {st}", "pass": False, "score": 0, "problems": []}

def edit(shot, bible, src, instructions, out):
    """在原图上局部修改：只改指出的地方，其余保持不变"""
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    todo = "\n".join(f"{i+1}. {t}" for i, t in enumerate(instructions))
    parts = ref_parts(shot) + [{"text": "要修改的图："}, jpeg_part(src),
        {"text": f"请在「要修改的图」的基础上做以下修改：\n{todo}\n除了这些地方，画面里的其他一切（人物长相、构图、机位、光线、色调、背景）都保持完全不变。"
                 f"人物和道具以参考图为准。这个镜头的要求：{shot['layout']}。画面里不要任何文字或水印。只输出修改后的一张 16:9 图片。"}]
    body = {"contents": [{"parts": parts}], "generationConfig": {"responseModalities": ["IMAGE"], "imageConfig": {"aspectRatio": "16:9"}}}
    for a in range(3):
        st, js = gi.http(f"{gi.G}/models/{gi.gemini_model(key)}:generateContent", body, {"x-goog-api-key": key})
        if st == 200:
            for c in js.get("candidates", []):
                for pt in (c.get("content") or {}).get("parts", []):
                    d = pt.get("inline_data") or pt.get("inlineData")
                    if d and d.get("data"): open(out, "wb").write(base64.b64decode(d["data"])); return ""
            return "没返回图片"
        if st == 402 or "RESOURCE_EXHAUSTED" in json.dumps(js): return "额度用完：" + json.dumps(js, ensure_ascii=False)[:200]
        time.sleep(15 * (a + 1))
    return f"HTTP {st}"

def redraw(shot, bible, fixes, out):
    gi.prompt_for = lambda s, b: B.prompt(s, b, fixes)
    return gi.gen_gemini(shot, bible, out)

def current_image(sid, state):
    f = (state["shots"].get(sid) or {}).get("final")
    for p in ([os.path.join(OUT, f), os.path.join(B.OUT, f)] if f else []) + [os.path.join(B.FINAL, sid + ".jpg")]:
        if p and os.path.exists(p): return p
    return None

def refine(shot, bible, state, manual=None, force=False):
    sid = shot["id"]; st = state["shots"].setdefault(sid, {"status": "todo", "tries": []})
    log = st.setdefault("refine", [])
    cur = current_image(sid, state); best = None; edit_fails = 0
    def record(path, q, how):
        nonlocal best
        rec = {"file": os.path.basename(path), "dir": "refine", "how": how, "pass": q.get("pass"), "score": q.get("score", 0),
               "issues": [p.get("what", "") for p in q.get("problems", [])]}
        log.append(rec); state["spent"] = state.get("spent", 0) + B.PRICE_IMG + B.PRICE_QC
        print(f"{sid} [{how}] {'✓ 通过' if rec['pass'] else '× 不通过'} {rec['score']}/10" + ("" if rec["pass"] else "：" + "；".join(rec["issues"])[:220]), flush=True)
        if rec["pass"] or not best or rec["score"] > best[1]["score"]: best = (path, rec)
        return rec
    if manual:
        if not cur: print(sid, "还没有图，先跑 run_batch.bat"); return
        out = os.path.join(OUT, f"{sid}_m{len(log)+1}.png"); err = edit(shot, bible, cur, [manual], out)
        if err: print(sid, "修改失败：", err); return
        q = qc2(shot, bible, out); rec = record(out, q, "人工意见修改")
        if rec["pass"] or force:
            B.install(sid, out); st.update(final=rec["file"], status="pass" if rec["pass"] else "manual")
            print(sid, "已换进游戏" + ("（--force）" if not rec["pass"] else ""))
        else: print(sid, "修改后质检还没通过，没换进游戏；看图觉得可以就加 --force 再跑一次，或者换一句修改意见")
        return
    q = qc2(shot, bible, cur) if cur else None
    for r in range(MAX_ROUNDS):
        if state["spent"] + B.PRICE_IMG > B.BUDGET: print("预算到顶，停止"); break
        if q and q.get("pass"): break
        probs = (q or {}).get("problems", [])
        out = os.path.join(OUT, f"{sid}_r{len(log)+1}.png")
        if cur and probs and all(p.get("kind") == "edit" for p in probs) and edit_fails < 2:
            err = edit(shot, bible, cur, [p.get("instruction") or p.get("what") for p in probs][:4], out); how = "局部修改"
        else:
            err = redraw(shot, bible, [p.get("what", "") for p in probs][:4], out); how = "重画"
        if err:
            print(sid, how, "失败：", err[:160])
            if "额度" in err or "402" in err: return "quota"
            continue
        q2 = qc2(shot, bible, out); rec = record(out, q2, how)
        if how == "局部修改" and (q2.get("score", 0) < (q or {}).get("score", 0)): edit_fails += 1   # 越改越差就换重画
        cur, q = out, q2
        if rec["pass"]: break
    if best:
        B.install(sid, best[0]); st["final"] = best[1]["file"]; st["status"] = "pass" if best[1]["pass"] else "best"

def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]; force = "--force" in sys.argv
    if not os.environ.get("GEMINI_API_KEY"): print("没有找到 GEMINI_API_KEY"); sys.exit(2)
    sl = json.load(open(os.path.join(HERE, "shotlist.json"), encoding="utf-8")); bible = sl["bible"]
    shots = {s["id"]: s for s in sl["shots"] if "layout" in s}
    sp = os.path.join(B.OUT, "state.json"); state = json.load(open(sp, encoding="utf-8")) if os.path.exists(sp) else {"spent": 0, "shots": {}}
    manual = args[1] if len(args) == 2 and args[1] not in shots else None
    ids = [args[0]] if manual else (args or [k for k in shots if (state["shots"].get(k) or {}).get("status") in ("best", "todo", "budget", None)])
    print(f"要处理 {len(ids)} 个镜头" + (f"，人工意见：{manual}" if manual else ""), flush=True)
    for sid in ids:
        if sid not in shots: print(sid, "不在分镜表里"); continue
        r = refine(shots[sid], bible, state, manual, force)
        json.dump(state, open(sp, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        if r == "quota": print("Gemini 额度用完，充值后再跑"); break
    B.register([k for k, v in state["shots"].items() if v.get("status") in ("pass", "best", "reuse", "manual")])
    print("完成。逐张记录在 out\\batch\\state.json 的 refine 字段；图片在 out\\refine\\")

if __name__ == "__main__":
    main()
