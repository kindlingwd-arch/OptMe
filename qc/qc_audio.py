# 影游声音质检：配音（念的和剧本对不对、音量、留白、语速、音色）+ 音效 / 环境声（音量、削波、循环接缝、像不像）
# 用法：python qc_audio.py <游戏文件夹> [--no-ai] [--only 场景id,场景id]
# Gemini：设置环境变量 GEMINI_API_KEY 才会调用（需要代理）；模型可用 GEMINI_MODEL 改，默认 gemini-3.8-flash。不打印密钥。
import os, re, sys, json, time, html, base64, shutil, difflib, argparse, subprocess, statistics, urllib.request, urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))

def find_ffmpeg():
    p = shutil.which("ffmpeg")
    if p: return p
    try:
        import imageio_ffmpeg; return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        print("没找到 ffmpeg：请先运行 pip install imageio-ffmpeg"); sys.exit(2)
FF = find_ffmpeg()

def ff_err(args):
    return subprocess.run([FF, "-hide_banner", "-nostdin"] + args, capture_output=True, text=True, encoding="utf-8", errors="replace", stdin=subprocess.DEVNULL).stderr

def measure(p):
    """时长、响度(LUFS)、峰值(dB)、开头/结尾静音、循环接缝(首尾 0.2 秒的音量差)"""
    e = ff_err(["-i", p, "-af", "ebur128=peak=true,volumedetect,silencedetect=n=-40dB:d=0.15", "-f", "null", "-"])
    m = re.search(r"Duration: (\d+):(\d+):([\d.]+)", e); dur = int(m.group(1))*3600 + int(m.group(2))*60 + float(m.group(3)) if m else 0.0
    m = re.findall(r"I:\s+(-?[\d.]+) LUFS", e); lufs = float(m[-1]) if m else None
    m = re.search(r"max_volume: (-?[\d.]+) dB", e); peak = float(m.group(1)) if m else None
    starts = [float(x) for x in re.findall(r"silence_start: (-?[\d.]+)", e)]
    ends = [float(x) for x in re.findall(r"silence_end: ([\d.]+)", e)]
    lead = ends[0] if starts and abs(starts[0]) < 0.05 and ends else 0.0
    trail = (dur - starts[-1]) if starts and (len(ends) < len(starts)) else 0.0
    # 首尾音量（循环接缝）
    def seg_db(ss, t):
        x = ff_err(["-ss", f"{ss:.3f}", "-t", f"{t:.3f}", "-i", p, "-af", "volumedetect", "-f", "null", "-"])
        mm = re.search(r"mean_volume: (-?[\d.]+) dB", x); return float(mm.group(1)) if mm else None
    head, tail = seg_db(0, .2), seg_db(max(0, dur - .2), .2)
    seam = (tail - head) if head is not None and tail is not None else None
    return {"dur": round(dur, 2), "lufs": lufs, "peak": peak, "lead": round(lead, 2), "trail": round(trail, 2), "seam": None if seam is None else round(seam, 1)}

# ---------- 读剧本 ----------
def match_brace(s, a):
    d = 0; ins = False; i = a
    while i < len(s):
        c = s[i]
        if ins:
            if c == "\\": i += 1
            elif c == '"': ins = False
        else:
            if c == '"': ins = True
            elif c == "{": d += 1
            elif c == "}":
                d -= 1
                if d == 0: return i + 1
        i += 1
    raise ValueError("剧本数据不完整")

def load_game(game):
    s = open(os.path.join(game, "index.html"), encoding="utf-8").read()
    a = s.index("const N=") + 8; N = json.loads(s[a:match_brace(s, a)])
    a = s.index("const VOT=/*VO_MAP*/") + len("const VOT=/*VO_MAP*/"); VOT = json.loads(s[a:match_brace(s, a)])
    return N, VOT

clean = lambda t: re.sub(r"（[^）]*）", "", t).strip()
plain = lambda t: re.sub(r"[^\u4e00-\u9fffA-Za-z0-9]", "", t)

def diff_html(exp, got):
    a, b = plain(exp), plain(got or "")
    sm = difflib.SequenceMatcher(None, a, b); out = []
    for op, i1, i2, j1, j2 in sm.get_opcodes():
        if op == "equal": out.append(html.escape(a[i1:i2]))
        else:
            if i2 > i1: out.append(f'<del>{html.escape(a[i1:i2])}</del>')
            if j2 > j1: out.append(f'<ins>{html.escape(b[j1:j2])}</ins>')
    return "".join(out), round(sm.ratio(), 3)

# ---------- Gemini ----------
def gemini(parts):
    key = (os.environ.get("GEMINI_API_KEY") or "").strip()
    if not key: return None
    model = os.environ.get("GEMINI_MODEL", "gemini-3.8-flash")
    body = {"contents": [{"parts": parts}], "generationConfig": {"responseMimeType": "application/json", "temperature": 0.1}}
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"; err = "失败"
    for attempt in range(4):
        req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST", headers={"x-goog-api-key": key, "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=240) as r: js = json.loads(r.read())
            return json.loads(js["candidates"][0]["content"]["parts"][0]["text"])
        except urllib.error.HTTPError as e:
            err = f"HTTP {e.code} {e.read().decode('utf-8', 'replace')[:300]}"
            if e.code in (429, 500, 503): time.sleep(10 * (attempt + 1)); continue
            return {"error": err}
        except Exception as e:
            err = str(e)[:300]; time.sleep(4)
    return {"error": err}

def audio_part(p):
    mime = "audio/wav" if p.lower().endswith(".wav") else "audio/mpeg"
    return {"inline_data": {"mime_type": mime, "data": base64.b64encode(open(p, "rb").read()).decode()}}

def ai_voices(batch, profiles):
    parts = [{"text": "你是互动影游的配音质检员。下面有若干条配音，每条前面有编号、角色设定和剧本台词。请逐条认真听，只输出 JSON 数组。"}]
    for k, it in enumerate(batch):
        parts.append({"text": f"第 {k} 条｜角色：{it['who']}（{profiles.get(it['who'], '未设定')}）｜剧本台词：{it['text']}"})
        parts.append(audio_part(it["path"]))
    parts.append({"text": """对每一条输出：
{"k": 编号, "transcript": "你实际听到的内容，逐字写出（用中文）",
 "text_ok": true/false（念的内容和剧本是否一致；多字、少字、念错字、多音字读错都算不一致）,
 "voice_ok": true/false（音色、性别、年龄是否符合角色设定）,
 "emotion_ok": true/false（情绪和语气是否符合角色和台词）,
 "quality_issues": "杂音、电流声、机器味、吞字、突然变调等，没有就写空字符串",
 "severity": "高|中|低|无"（念错字或明显不像这个角色算高）,
 "note": "一句话说明"}
只输出一个 JSON 数组。"""})
    return gemini(parts)

def ai_sfx(batch):
    parts = [{"text": "你是互动影游的音效质检员。故事发生在 1998 年东北小城的冬夜。下面每条音效前有编号和它应该是什么声音。请逐条认真听，只输出 JSON 数组。"}]
    for k, it in enumerate(batch):
        parts.append({"text": f"第 {k} 条｜文件：{it['name']}｜应该是：{it['describe']}" + ("｜这是循环播放的环境声，首尾要能无缝衔接" if it["loop"] else "")})
        parts.append(audio_part(it["path"]))
    parts.append({"text": """对每一条输出：
{"k": 编号, "heard": "你实际听到的声音描述", "match": true/false（像不像应该的声音）,
 "issues": "年代穿帮（如手机铃声、现代汽车提示音）、杂音、突兀的爆音、循环接缝明显等，没有就写空字符串",
 "severity": "高|中|低|无", "note": "一句话说明"}
只输出一个 JSON 数组。"""})
    return gemini(parts)

# ---------- 主流程 ----------
def main():
    ap = argparse.ArgumentParser(); ap.add_argument("game"); ap.add_argument("--no-ai", action="store_true"); ap.add_argument("--only", default="")
    a = ap.parse_args(); game = a.game; only = set(x for x in a.only.split(",") if x)
    specs = json.load(open(os.path.join(HERE, "audio_specs.json"), encoding="utf-8"))
    N, VOT = load_game(game); use_ai = not a.no_ai and bool(os.environ.get("GEMINI_API_KEY"))
    print("Gemini 复核：" + ("开" if use_ai else "关（没设 GEMINI_API_KEY 或加了 --no-ai）"), flush=True)
    out = os.path.join(HERE, "out"); os.makedirs(out, exist_ok=True)

    # 配音
    voices = []
    for sid, n in N.items():
        if only and sid not in only: continue
        for i, l in enumerate(n["lines"]):
            if l[0].startswith("@") or re.fullmatch(r"[…。.！？!?\s—-]*", l[1]): continue
            key = VOT.get(clean(l[1])); p = os.path.join(game, "vo", f"{key}.mp3") if key else None
            it = {"scene": sid, "i": i + 1, "who": l[0] or "旁白", "text": clean(l[1]), "file": f"vo/{key}.mp3" if key else "", "path": p, "flags": []}
            if not p or not os.path.exists(p): it["flags"].append(["bad", "没有配音文件"]); voices.append(it); continue
            it.update(measure(p)); voices.append(it)
    have = [v for v in voices if "lufs" in v and v["lufs"] is not None]
    med = statistics.median([v["lufs"] for v in have]) if have else -20
    for v in have:
        if abs(v["lufs"] - med) > 4: v["flags"].append(["warn", f"音量和其他台词差 {v['lufs'] - med:+.1f} LU（中位数 {med:.1f}）"])
        if v["peak"] is not None and v["peak"] > -0.3: v["flags"].append(["warn", f"峰值 {v['peak']} dB，可能削波"])
        if v["lead"] > 0.6: v["flags"].append(["warn", f"开头留白 {v['lead']} 秒"])
        if v["trail"] > 1.0: v["flags"].append(["warn", f"结尾留白 {v['trail']} 秒"])
        speech = max(.3, v["dur"] - v["lead"] - v["trail"]); rate = len(plain(v["text"])) / speech; v["rate"] = round(rate, 1)
        if rate > 7.5: v["flags"].append(["warn", f"语速偏快（每秒 {rate:.1f} 字）"])
        if rate < 2.0 and len(plain(v["text"])) > 4: v["flags"].append(["warn", f"语速偏慢（每秒 {rate:.1f} 字）"])
    if use_ai:
        todo = [v for v in have]
        for b in range(0, len(todo), 8):
            batch = todo[b:b + 8]; res = ai_voices(batch, specs["voices"])
            if isinstance(res, dict) and "error" in res:
                for v in batch: v["flags"].append(["warn", "Gemini 检查失败：" + res["error"]])
                continue
            for r in (res or []):
                try: v = batch[int(r["k"])]
                except Exception: continue
                v["ai"] = r; v["diff"], v["sim"] = diff_html(v["text"], r.get("transcript", ""))
                lv = "bad" if r.get("severity") == "高" else "warn"
                if not r.get("text_ok", True): v["flags"].append([lv, "念的和剧本不一致"])
                if not r.get("voice_ok", True): v["flags"].append([lv, "音色不像这个角色"])
                if not r.get("emotion_ok", True): v["flags"].append(["warn", "情绪不对"])
                if r.get("quality_issues"): v["flags"].append(["warn", "音质：" + r["quality_issues"]])
            print(f"配音 AI 检查 {min(b + 8, len(todo))}/{len(todo)}", flush=True); time.sleep(2)

    # 音效 / 环境声
    sfx = []
    if not only:
        for name, d in specs["sfx"].items():
            folder = "amb" if name.startswith("amb") else "sfx"; p = os.path.join(game, folder, name + ".mp3")
            it = {"name": name, "file": f"{folder}/{name}.mp3", "path": p, "describe": d["describe"], "loop": d["loop"], "flags": []}
            if not os.path.exists(p): it["flags"].append(["bad", "文件不存在"]); sfx.append(it); continue
            it.update(measure(p))
            if it["peak"] is not None and it["peak"] > -0.3: it["flags"].append(["warn", f"峰值 {it['peak']} dB，可能削波"])
            if d["loop"] and d.get("seam_check", True) and it["seam"] is not None and abs(it["seam"]) > 3: it["flags"].append(["warn", f"循环接缝：首尾音量差 {it['seam']:+.1f} dB，循环时可能听得出来"])
            if not d["loop"] and it["lead"] > 0.3: it["flags"].append(["warn", f"开头有 {it['lead']} 秒空白，触发时会慢半拍"])
            sfx.append(it)
        if use_ai:
            todo = [x for x in sfx if "lufs" in x]
            for b in range(0, len(todo), 8):
                batch = todo[b:b + 8]; res = ai_sfx(batch)
                if isinstance(res, dict) and "error" in res:
                    for x in batch: x["flags"].append(["warn", "Gemini 检查失败：" + res["error"]])
                    continue
                for r in (res or []):
                    try: x = batch[int(r["k"])]
                    except Exception: continue
                    x["ai"] = r
                    if not r.get("match", True): x["flags"].append(["bad" if r.get("severity") == "高" else "warn", "听起来不像应该的声音"])
                    if r.get("issues"): x["flags"].append(["warn", r["issues"]])
                print(f"音效 AI 检查 {min(b + 8, len(todo))}/{len(todo)}", flush=True); time.sleep(2)

    # 报告
    lvl = lambda fl: "bad" if any(f[0] == "bad" for f in fl) else ("warn" if fl else "ok")
    for x in voices + sfx: x["level"] = lvl(x["flags"]); x.pop("path", None)
    json.dump({"voices": voices, "sfx": sfx}, open(os.path.join(out, "audio_report.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    col = {"ok": "#3c9", "warn": "#e8b04a", "bad": "#e5574d"}; nm = {"ok": "通过", "warn": "看一眼", "bad": "不通过"}
    rel = lambda f: "../../moban_game/" + f if os.path.basename(os.path.normpath(game)) == "moban_game" else os.path.relpath(os.path.join(game, f), out).replace("\\", "/")
    vr = "".join(f"""<tr><td><span style="color:{col[v['level']]}">●</span> {nm[v['level']]}</td><td>{html.escape(v['scene'])} · {v['i']}<br><small>{html.escape(v['who'])}</small></td>
<td>{html.escape(v['text'])}{f'<div class="d">听到：{v["diff"]}</div>' if v.get('diff') is not None else ''}{f'<small>{html.escape(v["ai"].get("note",""))}</small>' if v.get('ai') else ''}</td>
<td><small>{v.get('dur','-')}s · {v.get('lufs','-')} LUFS · 峰值 {v.get('peak','-')} · 语速 {v.get('rate','-')}</small>{''.join(f'<div style="color:{col[l]}">{html.escape(m)}</div>' for l, m in v['flags'])}</td>
<td>{f'<audio controls preload="none" src="{rel(v["file"])}"></audio>' if v['file'] else ''}</td></tr>""" for v in voices)
    sr = "".join(f"""<tr><td><span style="color:{col[x['level']]}">●</span> {nm[x['level']]}</td><td>{html.escape(x['name'])}</td><td>{html.escape(x['describe'])}{f'<div class="d">听到：{html.escape(x["ai"].get("heard",""))}</div>' if x.get('ai') else ''}</td>
<td><small>{x.get('dur','-')}s · {x.get('lufs','-')} LUFS · 峰值 {x.get('peak','-')}{' · 接缝 ' + str(x.get('seam')) + ' dB' if x['loop'] else ''}</small>{''.join(f'<div style="color:{col[l]}">{html.escape(m)}</div>' for l, m in x['flags'])}</td>
<td><audio controls preload="none" src="{rel(x['file'])}"></audio></td></tr>""" for x in sfx)
    cnt = lambda L: " · ".join(f"{sum(x['level'] == k for x in L)} {nm[k]}" for k in ("ok", "warn", "bad"))
    page = f"""<!doctype html><meta charset="utf-8"><title>声音质检报告</title><style>body{{font:14px/1.6 "Microsoft YaHei",sans-serif;background:#16171a;color:#e6e2da;padding:20px}}table{{border-collapse:collapse;width:100%;margin-bottom:30px}}td{{border-bottom:1px solid #333;padding:8px;vertical-align:top}}small{{color:#999}}del{{background:#5a2424;color:#ffb3ab}}ins{{background:#1f4a2c;color:#a8e3b6;text-decoration:none}}.d{{margin-top:4px}}audio{{height:32px;width:230px}}</style>
<h2>声音质检报告 · {time.strftime('%Y-%m-%d %H:%M')}</h2>
<h3>配音（{len(voices)} 条：{cnt(voices)}）</h3><p><small>「听到」一行里，<del>红色删除线</del>是剧本里有但没念出来的字，<ins>绿色</ins>是念出来但剧本里没有的字。</small></p><table>{vr}</table>
<h3>音效和环境声（{len(sfx)} 个：{cnt(sfx)}）</h3><table>{sr}</table>"""
    open(os.path.join(out, "audio_report.html"), "w", encoding="utf-8").write(page)
    for v in voices:
        if v["level"] != "ok": print(f"{v['level']:4} 配音 {v['scene']}·{v['i']} {v['who']}：" + "；".join(m for _, m in v["flags"]), flush=True)
    for x in sfx:
        if x["level"] != "ok": print(f"{x['level']:4} 音效 {x['name']}：" + "；".join(m for _, m in x["flags"]), flush=True)
    print(f"配音 {cnt(voices)}；音效 {cnt(sfx)}"); print("报告：", os.path.join(out, "audio_report.html"))

if __name__ == "__main__":
    main()
