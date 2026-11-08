"""让 Gemini 看首帧图 + 剧本，写视频提示词（写进 autofix\\video_shots.json）。

用法：python write_vprompts.py [镜头…] [--all] [--dry] [--draft]   /   python write_vprompts.py --apply [镜头…]
  --draft：先写成草稿 out\\vprompts_draft.json 和图片版预览 out\\vprompts_draft.html（自动打开），不动视频分镜表；--apply 把草稿（选中的几条）写进去。
  不写镜头名：只写「需要写的」——剪辑台自动占位的、提示词直接抄了质检标准 / 环境描写的、游戏里的视频比首帧图旧的（首帧换过）。
  --all：所有条目都重写（标了「不做视频」的除外）。
  --dry：只打印，不写文件。
每条写入：prompt（视频提示词）、describe（质检标准）、speakers、need_mouth、prompt_from；原来的提示词存到 prompt_prev。
写进去的提示词照样要在影游剪辑台「审阅 → ③ 视频提示词」里人审过才会生成（方案 C）——改过提示词，原来的「已审」自动失效。
用文字模型（GEMINI_MODEL，默认 gemini-3.8-flash），每条约 $0.01。需要 GEMINI_API_KEY 和代理（和出图脚本一样，自动读系统代理）。
"""
import os, sys, json, re, time, shutil, base64

HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
GAME = os.path.join(ROOT, "moban_game"); SB = os.path.join(ROOT, "storyboard")
sys.path.insert(0, SB)
import gen_images as gi                      # 代理设置、http、json_reply 都复用出图脚本的
import video_shots as VS

MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.8-flash")
SENS = ["血", "伤", "打斗", "殴打", "抢劫", "劫匪", "削", "枪", "刀", "尸", "杀", "死", "押解", "挣扎"]   # 和剪辑台 V_SENS 一致：视频平台审核可能拦
LEAD = {"pager": "s_pager", "policy": "s_envelope"}                                                  # 和游戏一致：@shot 播哪条视频


def load_script():
    h = open(os.path.join(GAME, "index.html"), encoding="utf-8").read()
    a = h.index("const N=") + len("const N="); depth = 0; i = a; ins = False; esc = False
    while True:                                # 找到和开头 { 配对的 }（跳过字符串里的括号）
        c = h[i]
        if ins:
            if esc: esc = False
            elif c == "\\": esc = True
            elif c == '"': ins = False
        elif c == '"': ins = True
        elif c == "{": depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0: break
        i += 1
    return json.loads(h[a:i + 1])


def stills(N):
    out = {}
    for n in N.values(): out.update(n.get("stills") or {})
    return out


def line_text(l):
    t = str(l[0])
    if t == "@cap": return f"【字幕卡】{l[1]}"
    if t == "@shot": return f"【插入镜头 {l[1]}】"
    return f"{t or '旁白'}：{l[1]}"


WHO = {"你": "司机（剧本里的「你」，玩家扮演的出租车司机）"}   # 剧本里的说话人 → 画面里是谁


def context(sid, N):
    """这条视频在剧本里的位置：哪一场、前后台词、环境。"""
    if sid in N:
        n = N[sid]
        return "scene", sid, -1, n
    for nid, n in N.items():
        for i, l in enumerate(n.get("lines", [])):
            if l[0] == "@shot" and LEAD.get(l[1], "s_" + l[1]) == sid: return "shot", nid, i, n
    try:                                   # 台词页视频：id 是这句分镜图的名字
        import durations as DU
        nid, i, l = DU.find_line(sid, N)
        if l: return "line", nid, i, N[nid]
    except Exception: pass
    return None, None, -1, None


def need(s, N):
    if s.get("novideo"): return False
    k = os.path.join(GAME, s.get("keyframe") or f"img/{s['id']}.jpg"); v = os.path.join(GAME, s.get("video") or f"vid/{s['id']}.mp4")
    stale = os.path.exists(k) and os.path.exists(v) and os.path.getmtime(v) < os.path.getmtime(k)
    copied = not s.get("prompt") or s.get("prompt") == s.get("describe") or "质检标准" in str(s.get("prompt_from", "")) or s.get("placeholder")
    return stale or copied


def ask(s, N, bible, key):
    kind, nid, i, n = context(s["id"], N)
    if not n: return None, "剧本里找不到这条（可能已经删了）"
    kf = os.path.join(GAME, s.get("keyframe") or f"img/{s['id']}.jpg")
    if not os.path.exists(kf): return None, "首帧图不存在：" + os.path.relpath(kf, ROOT)
    lines = n.get("lines", [])
    try:                                   # 这段视频该多长：按剧本算（durations.py）；插入镜头让 AI 按动作估
        import durations as DU
        vot, limg = DU.vo_map(), DU.limg_set()
        s2 = s
        if kind == "line":                 # 分镜表里写了「说话的人不在画面里」（比如拍听的人的反应），配音照放，但画面里没人张嘴说这句
            try:
                sh = next((x for x in json.load(open(os.path.join(SB, "shotlist.json"), encoding="utf-8"))["shots"] if x["id"] == s["id"]), {})
                if str(sh.get("speaker_in_frame", "")).strip() in ("否", "不在", "no", "false"): s2 = dict(s, speaker_in_frame=False)
            except Exception: pass
        need_s, need_why = DU.need(s2, N, vot, limg); sp = DU.speech(s2, N, vot, limg)
    except Exception: need_s, need_why, sp = None, "", []
    # 这段视频播放时同时响起的台词：嘴型要和它对上（谁说、说什么、什么时候说）；没有台词的时间画面里的人不张嘴
    if sp:
        speech_txt = ("这段视频播放的同时，游戏会放下面这些台词配音（时间从视频开始算）：\n" + "\n".join(
            f"  {x['t0']:.1f}～{x['t1']:.1f} 秒 {WHO.get(x['who'], x['who'])}{'' if x['onscreen'] else '（画外，不在画面里）'}：「{x['text']}」" for x in sp) +
            "\n嘴型必须和这些台词对上：在对应的时间里写明谁张嘴说哪句，把台词原文一字不改地写进提示词（例如：女人张嘴说「三百。」），只有省略号的台词写成欲言又止、嘴唇动了动没出声；画外的声音（收音机、旁白、BP机）画面里的人都不张嘴；没有台词的时间里谁都不说话。")
    else:
        speech_txt = ("这段视频播放时游戏里没有任何台词配音（" + ("插入镜头只放音效" if kind != "scene" else "场景视频在台词开始前就切走了，或者第一句有自己的图") +
                      "），所以画面里的人都不要张嘴说话，最多有表情、呼吸、看的动作。")
    # 时长让 AI 按内容估（seconds），规则算出来的「游戏里能看到多久」只给它参考
    if kind == "scene":
        dur_txt = "按画面里要发生的事自然需要的时长（3～10 秒）"
        ref = f"参考：按台词和字幕卡算，游戏里这段场景视频大约能看到 {need_s:.1f} 秒（{need_why}）" if need_s else ("参考：" + need_why if need_why else "")
        sec_rule = f"\n6. seconds：这段视频按内容自然需要几秒（3～10 的数字：动作、说话、镜头运动做完要多久，不拖也不赶）。{ref}"
    else:
        dur_txt = "这个动作需要的时长（3～9 秒，按动作自然的快慢定）"
        sec_rule = "\n6. seconds：这个动作自然做完需要几秒（3～9 的数字，插入镜头游戏会播到视频结束，太长会拖节奏）。"
    if kind == "line":
        l = lines[i]
        try: shot = next((x for x in json.load(open(os.path.join(SB, "shotlist.json"), encoding="utf-8"))["shots"] if x["id"] == s["id"]), {})
        except Exception: shot = {}
        before = [line_text(x) for x in lines[max(0, i - 2):i]]; after = [line_text(x) for x in lines[i + 1:i + 2]]
        where = f"这是「台词页」视频：场景「{n.get('title') or nid}」第 {i + 1} 句「{WHO.get(l[0], l[0] or '旁白')}：{l[1]}」。游戏里这一页先显示这句的分镜图（就是首帧），同时放这句的配音，视频放这句话说的时候画面里的动作。"
        detail = (f"这一场的环境：{n.get('img', '')}\n这一句的分镜画面：{shot.get('desc', '')}（构图：{shot.get('layout', '')}；景别：{shot.get('shot', '')}；说话的人在不在画面里：{shot.get('speaker_in_frame', '没写')}）\n"
                  f"前面：" + " / ".join(before) + "\n后面：" + " / ".join(after))
        dur_txt = f"约 {need_s:.1f} 秒（{need_why}）" if need_s else "这句配音的长度"
        sec_rule = ""
    elif kind == "scene":
        own = [line_text(l) for l in lines]
        where = f"这是场景「{n.get('title') or n.get('end') or nid}」（{nid}）的场景视频：游戏里进入这一场时播放，台词字幕叠在上面。"
        detail = f"这一场的环境：{n.get('img', '')}\n这一场的全部台词和镜头（按顺序）：\n" + "\n".join("  " + x for x in own)
        if n.get("end"): detail += f"\n这是结局「{n['end']}」。尾声：" + " / ".join(n.get("epi") or [])
    else:
        name = lines[i][1]; st = stills(N)
        desc = st.get(s["id"]) or s.get("describe") or ""
        before = [line_text(l) for l in lines[max(0, i - 3):i]]; after = [line_text(l) for l in lines[i + 1:i + 3]]
        where = f"这是插入镜头 {s['id']}（剧本里写作 @shot {name}），在场景「{n.get('title') or nid}」第 {i + 1} 行：没有台词，画面里发生一个动作。"
        detail = (f"这一场的环境：{n.get('img', '')}\n这个镜头的画面描述：{desc}\n"
                  f"前面几行：\n" + "\n".join("  " + x for x in before) + "\n后面几行：\n" + "\n".join("  " + x for x in after))
    detail += "\n\n【台词和嘴型】" + speech_txt
    rules = "；".join(f"{k}：{v}" for k, v in bible.items())
    text = f"""你是电影的分镜导演，要为一部互动影游写视频生成提示词。附图是这个镜头的首帧（视频从这张图开始动）。

{where}
{detail}

统一设定：{rules}

请写：
1. prompt：交给图生视频模型（海螺 / H3）的提示词，中文，60～140 字。要求：
   - 从首帧画面出发，只写画面里看得到的人和东西，人物位置、朝向、左右关系必须和首帧一致（左舵车：司机在车的左侧）。
   - 写清楚这段视频里（时长：{dur_txt}）按顺序发生什么（最多三个动作），谁先动、动作幅度要小而自然；镜头怎么动（固定、缓慢推近、轻微摇移），不要大幅运镜、不要换机位、不要切镜头。
   - 嘴型照下面【台词和嘴型】：有台词的时间写明谁张嘴说哪句（台词原文写进去，嘴唇一开一合），没台词的时间谁都不说话；不说话的人写在做什么（看、听、手的动作）。
   - 环境的动态（飘雪、车窗外路灯掠过、仪表盘灯光、呼出的白气）可以写一两处。
   - 不要写这些词（视频平台审核会拦）：{"、".join(SENS)}。大军脸上的伤写成「脸上有淤青」，不要用「伤」「血」字。不要出现字幕、文字、水印；提到钱写「第四套人民币」。
   - 不要写画质、风格、胶片感这类词（程序会统一加）。
2. describe：质检标准，一两句话写这条视频应该是什么样子（谁在哪、做了什么、谁在说话），生成后 AI 按它检查。
3. speakers：画面里张嘴说话的人（用剧本里的称呼），照【台词和嘴型】里画面内的说话人写；没有就是空列表。
4. need_mouth：speakers 不为空就是 true。
5. notes：如果首帧和剧本对不上（人数、座位、道具、时间不一致），写一句提醒；没有就写空字符串。{sec_rule}

只输出 JSON：{{"prompt": "...", "describe": "...", "speakers": [...], "need_mouth": true/false, "notes": "..."{', "seconds": 5' if sec_rule else ''}}}"""
    body = {"contents": [{"parts": [{"inline_data": {"mime_type": gi.mime(kf), "data": gi.b64(kf)}}, {"text": text}]}],
            "generationConfig": {"responseMimeType": "application/json", "temperature": 0.4}}
    last = ""
    for a in range(3):
        st, js = gi.http(f"{gi.G}/models/{MODEL}:generateContent", body, {"x-goog-api-key": key}, timeout=180)
        if st == 200:
            r = gi.json_reply(js)
            if isinstance(r, list) and r: r = r[0]
            if isinstance(r, dict) and r.get("prompt"):
                # 谁张嘴不让 AI 猜：按这段视频播放时真正响起的台词定（画外的不算）
                ons = []
                for x in sp:
                    w = "司机" if x["who"] == "你" else x["who"]
                    if x["onscreen"] and w not in ons and not re.fullmatch(r"[…。.\s]*", str(x["text"])): ons.append(w)   # 只有省略号的不算张嘴
                r["speakers"], r["need_mouth"], r["_speech"] = ons, bool(ons), sp
                return r, ""
            last = "返回看不懂：" + json.dumps(js, ensure_ascii=False)[:200]
        else:
            last = f"HTTP {st} " + json.dumps(js, ensure_ascii=False)[:200]
            if st not in (429, 500, 503, 0): break
        print("  重试：" + last, flush=True); time.sleep(8 * (a + 1))
    return None, last


DRAFT = os.path.join(HERE, "out", "vprompts_draft.json")


def board(items, path):
    """草稿的图片版预览：每条一张卡片（首帧、原来的和 AI 写的提示词、时长、提醒），浏览器打开。"""
    import html as H
    rel = lambda p: os.path.relpath(os.path.join(GAME, p), os.path.dirname(path)).replace("\\", "/")
    cards = []
    for it in items:
        pt = it["patch"]; old = it.get("old") or {}
        cards.append(f"""<article><img src="{rel(it['keyframe'])}" loading="lazy"><div class=b><h3>{H.escape(it['id'])} <small>{H.escape(it.get('where', ''))}</small></h3>
<p class=d>时长：{old.get('duration', '?')} 秒 → <b>{it.get('dur_new', '?')} 秒</b>　{H.escape(it.get('dur_why', ''))}</p>
<p class=n><b>AI 写的提示词</b><br>{H.escape(pt.get('prompt', ''))}</p><p class=q><b>质检标准</b> {H.escape(pt.get('describe', ''))}</p>
<p class=q><b>说话的人</b> {H.escape('、'.join(pt.get('speakers') or []) or '没人说话')}</p>
{f'<p class=w>⚠ {H.escape(it["notes"])}</p>' if it.get('notes') else ''}<details><summary>原来的提示词</summary><p class=o>{H.escape(old.get('prompt', ''))}</p></details></div></article>""")
    page = f"""<!doctype html><meta charset=utf-8><title>视频提示词草稿预览</title><style>body{{background:#16171b;color:#e8e4dc;font:14px/1.6 "Microsoft YaHei",sans-serif;margin:20px}}
.g{{display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:16px}}article{{background:#1f2026;border:1px solid #333;border-radius:8px;overflow:hidden}}
img{{width:100%;aspect-ratio:16/9;object-fit:cover;display:block}}.b{{padding:10px 14px}}h3{{margin:0 0 4px}}small{{color:#999;font-weight:normal}}.d{{color:#ffd23c;margin:2px 0}}
.n{{margin:6px 0}}.q{{color:#aaa;margin:4px 0;font-size:13px}}.w{{color:#f2b84b}}.o{{color:#888;text-decoration:line-through}}</style>
<h1>视频提示词草稿预览（{len(items)} 条，{time.strftime('%m-%d %H:%M')}）</h1><p>还没写进视频分镜表。在影游剪辑台「审阅 → ③ 视频提示词」顶部点「📋 草稿预览」勾选要采用的，或者运行 write_vprompts.py --apply。</p><div class=g>{''.join(cards)}</div>"""
    open(path, "w", encoding="utf-8").write(page)


def apply_draft(ids):
    """把草稿里的（选中的）几条写进视频分镜表，再重算时长；写进去的从草稿里拿掉。"""
    try: dr = json.load(open(DRAFT, encoding="utf-8"))
    except Exception: print("ERROR:没有草稿（先跑一遍 --draft）"); return 1
    pick = [it for it in dr["items"] if not ids or it["id"] in ids]
    if not pick: print("草稿里没有这些镜头"); return 1
    with gi.file_lock(VS.PATH):
        d2 = json.load(open(VS.PATH, encoding="utf-8"))
        os.makedirs(os.path.join(HERE, "backup"), exist_ok=True)
        shutil.copy2(VS.PATH, os.path.join(HERE, "backup", f"video_shots_{time.strftime('%m%d_%H%M%S')}.json"))
        by = {x["id"]: x for x in d2.get("shots", [])}
        for it in pick:
            if it["id"] in by: by[it["id"]].update(dict(it["patch"], prompt_prev=by[it["id"]].get("prompt", "")))
        gi._write_json(VS.PATH, d2)
    try:
        import durations as DU
        for sid, dur, sec, why, locked in DU.plan([it["id"] for it in pick], quiet=True): print(f"  时长 {sid}：{dur} 秒（{why}）", flush=True)
    except Exception as e: print("  （算时长失败：" + str(e) + "）", flush=True)
    left = [it for it in dr["items"] if it not in pick]
    if left: dr["items"] = left; json.dump(dr, open(DRAFT, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    else: os.remove(DRAFT)
    print(f"采用了 {len(pick)} 条（草稿里还剩 {len(left)} 条）。提示词变了，要在剪辑台里审过才会生成视频。", flush=True)
    print("RESULT:applied", flush=True); return 0


def main(argv):
    if "--apply" in argv: return apply_draft([a for a in argv if not a.startswith("--")])
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not key: print("ERROR:没有找到 GEMINI_API_KEY"); return 1
    ids = [a for a in argv if not a.startswith("--")]
    d, m = VS.load(); N = load_script()
    try: bible = json.load(open(os.path.join(SB, "shotlist.json"), encoding="utf-8")).get("bible", {})
    except Exception: bible = {}
    todo = [m[i] for i in ids if i in m] if ids else [s for s in d["shots"] if ("--all" in argv and not s.get("novideo")) or need(s, N)]
    miss = [i for i in ids if i not in m]
    if miss: print("视频分镜表里没有：" + "、".join(miss) + "（先打开剪辑台的审阅，会按剧本自动补占位）", flush=True)
    if not todo: print("没有需要写的（要全部重写加 --all，或写镜头名）"); return 0
    print(f"让 Gemini 看首帧图和剧本写视频提示词：{len(todo)} 条（{MODEL}，约 ${len(todo) * 0.01:.2f}）", flush=True)
    done, spent = [], 0.0
    for s in todo:
        print(f"· {s['id']} …", flush=True)
        r, err = ask(s, N, bible, key); spent += 0.01
        if not r: print(f"  × {err}", flush=True); continue
        p = re.sub(r"\s+", "", str(r.get("prompt", "")))
        bad = [w for w in SENS if w in p]
        print(f"  提示词：{p}", flush=True)
        if bad: print(f"  ⚠ 里面有「{'、'.join(bad)}」，审阅时换个说法", flush=True)
        if r.get("notes"): print(f"  ⚠ {r['notes']}", flush=True)
        done.append((s["id"], {"prompt": p, "describe": str(r.get("describe", "")).strip() or s.get("describe", ""),
                               "speakers": [str(x) for x in (r.get("speakers") or [])], "need_mouth": bool(r.get("need_mouth")) and bool(r.get("speakers")),
                               "prompt_from": f"Gemini 看首帧图和剧本写的（{time.strftime('%m-%d %H:%M')}）" + (f"；提醒：{r['notes']}" if r.get("notes") else ""),
                               "prompt_prev": s.get("prompt", ""), "placeholder": False, "lines_during": r.get("_speech", []),
                               **({"action_sec": round(min(10.0 if s["id"] in N else 9.5, max(3.0, float(r["seconds"]))), 1)} if str(r.get("seconds", "")).replace(".", "", 1).isdigit() else {})}))
        if r.get("seconds"): print(f"  动作时长：约 {r['seconds']} 秒", flush=True)
    if "--dry" in argv: print(f"（--dry：没有写文件）共 {len(done)} 条"); return 0
    if "--draft" in argv:                 # 先出草稿和图片版预览，人看过再采用（--apply）
        import durations as DU
        vot, limg, items = DU.vo_map(), DU.limg_set(), []
        for sid, patch in done:
            s = m[sid]; ns = dict(s, **patch); sec, why = DU.need(ns, N, vot, limg); dur, rule = (DU.snap(sec, ns) if sec else (s.get("duration") or 6, "保持原来的"))
            kind, nid, i, n = context(sid, N)
            items.append({"id": sid, "keyframe": s.get("keyframe") or f"img/{sid}.jpg", "where": (f"{n.get('title') or nid} · 场景视频" if kind == "scene" else f"{n.get('title') or nid} 第 {i + 1} 行 · 台词页" if kind == "line" else f"{n.get('title') or nid} 第 {i + 1} 行 · 插入镜头") if n else "",
                          "old": {k: s.get(k) for k in ("prompt", "describe", "duration", "speakers")}, "patch": patch, "notes": patch["prompt_from"].split("提醒：")[-1] if "提醒：" in patch["prompt_from"] else "",
                          "dur_new": s.get("duration") if s.get("duration_locked") else dur, "dur_why": ("手改过，不动；" if s.get("duration_locked") else "") + why + "；" + rule})
        os.makedirs(os.path.dirname(DRAFT), exist_ok=True)
        try: old = json.load(open(DRAFT, encoding="utf-8"))["items"]
        except Exception: old = []
        items = [it for it in old if it["id"] not in {x["id"] for x in items}] + items
        json.dump({"created": time.strftime("%Y-%m-%d %H:%M"), "items": items}, open(DRAFT, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        hp = DRAFT.replace(".json", ".html"); board(items, hp)
        try: gi.add_spent(os.path.join(SB, "out", "batch", "state.json"), spent)
        except Exception: pass
        print(f"草稿写好了：{len(done)} 条（失败 {len(todo) - len(done)} 条），还没写进视频分镜表。图片版预览：{hp}", flush=True)
        try: os.startfile(hp)
        except Exception: pass
        print("RESULT:draft", flush=True); return 0
    if done:
        with gi.file_lock(VS.PATH):
            d2 = json.load(open(VS.PATH, encoding="utf-8"))
            os.makedirs(os.path.join(HERE, "backup"), exist_ok=True)
            shutil.copy2(VS.PATH, os.path.join(HERE, "backup", f"video_shots_{time.strftime('%m%d_%H%M%S')}.json"))
            by = {x["id"]: x for x in d2.get("shots", [])}
            for sid, patch in done:
                if sid in by: by[sid].update(patch)
            gi._write_json(VS.PATH, d2)
        try:                                # 按新的动作时长、剧本重算这几条的视频时长
            import durations as DU
            for sid, dur, sec, why, locked in DU.plan([sid for sid, _ in done], quiet=True): print(f"  时长 {sid}：{dur} 秒（{why}）", flush=True)
        except Exception as e: print("  （算时长失败：" + str(e) + "）", flush=True)
    try: gi.add_spent(os.path.join(SB, "out", "batch", "state.json"), spent)
    except Exception: pass
    print(f"写好了 {len(done)} 条（失败 {len(todo) - len(done)} 条）。到剪辑台「审阅 → ③ 视频提示词」逐条看过、点「没问题」后才会生成视频。", flush=True)
    print("RESULT:" + ",".join(sid for sid, _ in done), flush=True)
    return 0 if done else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
