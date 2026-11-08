# 给「穿貂的女人」重新选音色：列出 MiniMax 的系统女声，每个用同一句台词各配一条，放进 autofix\audition\ 让人挑
# 用法：python voice_audition.py            试听
#       python voice_audition.py --use <voice_id>   用选中的音色重配她的全部台词（旧的备份到 autofix\backup\audio）
# 读 MINIMAX_API_KEY，不打印密钥
import os, sys, json, time, shutil, urllib.request, urllib.error
KEY = (os.environ.get("MINIMAX_API_KEY") or os.environ.get("KLING_API_KEY") or "").strip()
HOST = "https://api.minimaxi.com"
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
GAME = os.path.join(ROOT, "moban_game"); LINES = os.path.join(ROOT, "minimax_test", "lines.json")
OUT = os.path.join(HERE, "audition")
WHO = "穿貂的女人"
TEST = "店是我的，货是我的，我拿我自个儿的东西不行？"
WANT = ["mature", "woman", "lady", "female", "sister", "wife", "mom", "mother", "boss", "elegant", "reserved", "calm", "sophisticated", "sincere", "成熟", "女", "御姐", "冷"]
NOT = ["girl", "child", "kid", "boy", "young man", "male", "少女", "萝莉", "童", "男"]

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

def tts(text, voice, emotion, speed, out):
    body = {"model": "speech-2.8-hd", "text": text, "stream": False, "language_boost": "Chinese",
            "voice_setting": {"voice_id": voice, "speed": speed, "vol": 1, "pitch": 0, "emotion": emotion},
            "audio_setting": {"sample_rate": 32000, "bitrate": 128000, "format": "mp3", "channel": 1}}
    for attempt in range(3):
        st, js = call("POST", "/v1/t2a_v2", body); b = js.get("base_resp") or {}
        if st == 200 and b.get("status_code") == 0 and (js.get("data") or {}).get("audio"):
            open(out, "wb").write(bytes.fromhex(js["data"]["audio"])); return True
        print("  失败", voice, st, b.get("status_code"), b.get("status_msg"), js.get("raw", ""), flush=True); time.sleep(4)
    return False

def candidates():
    st, js = call("POST", "/v1/get_voice", {"voice_type": "system"})
    vs = js.get("system_voice") or []
    if not vs: print("拿不到音色列表：", st, json.dumps(js, ensure_ascii=False)[:300]); return []
    pick = []
    for v in vs:
        vid = v.get("voice_id", ""); txt = (vid + " " + str(v.get("voice_name", "")) + " " + " ".join(v.get("description") or [])).lower()
        if not (vid.startswith("Chinese (Mandarin)") or "中文" in txt or "普通话" in txt): continue
        if any(n in txt for n in NOT) and not any(w in txt for w in ("woman", "lady", "女士", "女性")): continue
        if any(w in txt for w in WANT): pick.append(v)
    json.dump(vs, open(os.path.join(OUT, "all_system_voices.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    return pick[:10]

def main():
    if not KEY: print("没有找到环境变量 MINIMAX_API_KEY"); sys.exit(2)
    os.makedirs(OUT, exist_ok=True)
    if "--use" in sys.argv:
        voice = sys.argv[sys.argv.index("--use") + 1]
        L = [x for x in json.load(open(LINES, encoding="utf-8")) if x["who"] == WHO]
        bk = os.path.join(HERE, "backup", "audio"); os.makedirs(bk, exist_ok=True)
        for x in L:
            dst = os.path.join(GAME, "vo", x["id"] + ".mp3"); tmp = os.path.join(OUT, "new_" + x["id"] + ".mp3")
            if tts(x["text"], voice, x["emotion"], x["speed"], tmp):
                if os.path.exists(dst) and not os.path.exists(os.path.join(bk, x["id"] + ".mp3")): shutil.copy2(dst, os.path.join(bk, x["id"] + ".mp3"))
                shutil.copy2(tmp, dst); print("OK", x["id"], flush=True)
            time.sleep(1.2)
        print(f"完成：{len(L)} 句换成 {voice}。旧的在 autofix\\backup\\audio。记得再跑一次 qc\\run_qc_audio.bat"); return
    cur = "Chinese (Mandarin)_Mature_Woman"
    vs = candidates(); print(f"挑出 {len(vs)} 个候选女声", flush=True)
    rows = []
    for v in vs:
        vid = v["voice_id"]
        for emo in ("neutral", "angry"):
            fn = f"{vid.replace(' ', '_').replace('(', '').replace(')', '')}_{emo}.mp3"
            p = os.path.join(OUT, fn)
            if os.path.exists(p) or tts(TEST, vid, emo, 1.0, p): rows.append((vid, v.get("voice_name", ""), " ".join(v.get("description") or []), emo, fn))
            time.sleep(1.2)
    html = "".join(f"<tr><td><b>{a}</b>{' （现在用的）' if a == cur else ''}<br><small>{b} {c}</small></td><td>{e}</td><td><audio controls src='{f}'></audio></td></tr>" for a, b, c, e, f in rows)
    open(os.path.join(OUT, "audition.html"), "w", encoding="utf-8").write(f"<!doctype html><meta charset=utf-8><title>选音色</title><style>body{{font:14px 'Microsoft YaHei';background:#16171a;color:#e6e2da;padding:20px}}td{{padding:8px;border-bottom:1px solid #333}}small{{color:#999}}</style><h2>穿貂的女人 · 40 岁金店老板娘，冷、硬、防备</h2><p>台词：{TEST}</p><table>{html}</table>")
    print("试听页：", os.path.join(OUT, "audition.html"))

if __name__ == "__main__":
    main()
