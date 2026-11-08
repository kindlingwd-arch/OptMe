# 第二轮选音：补配更合适的中年女声候选 → 让 Gemini 给所有候选打分排序；同时给新做的两段环境声打分，选出更好的那条
# 读 MINIMAX_API_KEY、GEMINI_API_KEY（需要代理），不打印密钥。结果：autofix\audition\pick.json 和 pick.html
import os, sys, json, time, html
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE); sys.path.insert(0, os.path.join(ROOT, "qc"))
import voice_audition as va
import qc_audio as qa
OUT = va.OUT
PROFILE = "1998 年东北小城的金店老板娘，40 岁左右，穿貂皮大衣。说话冷、硬、干脆，带着防备，有一点东北口音，绝不能娇、嫩、甜、嗲"
# 第一轮的「Mature_Woman」其实是「傲娇御姐」（青年），所以这一轮补真正的中年女声，再试降调
ROUND2 = [  # (voice_id, emotion, pitch)
    ("Chinese (Mandarin)_Wise_Women", "neutral", 0), ("Chinese (Mandarin)_Wise_Women", "angry", 0), ("Chinese (Mandarin)_Wise_Women", "neutral", -2),
    ("female-chengshu-jingpin", "neutral", 0), ("female-chengshu-jingpin", "angry", 0), ("female-chengshu-jingpin", "neutral", -2),
    ("Chinese (Mandarin)_Kind-hearted_Antie", "neutral", 0), ("Chinese (Mandarin)_Kind-hearted_Antie", "angry", 0),
    ("female-yujie-jingpin", "neutral", -2), ("Chinese (Mandarin)_News_Anchor", "neutral", -2),
]
AMB = [("amb_check", "1998 年东北林间公路检查站的冬夜环境声：汽车怠速、寒风、松林。可以有对讲机的短促电流噪声，但绝不能有任何人说话，尤其不能有英文"),
       ("amb_kitchen", "1998 年东北人家除夕夜的厨房：一大锅水滚开在煮饺子（咕嘟咕嘟的沸水声、锅盖轻响），隔壁屋电视里隐约传来春晚的音乐，远处有鞭炮。不能是油煎爆炒声")]

def fname(vid, emo, pitch):
    return f"{vid.replace(' ', '_').replace('(', '').replace(')', '')}_{emo}{'_p' + str(pitch) if pitch else ''}.mp3"

def tts_pitch(text, voice, emotion, pitch, out):
    body = {"model": "speech-2.8-hd", "text": text, "stream": False, "language_boost": "Chinese",
            "voice_setting": {"voice_id": voice, "speed": 1.0, "vol": 1, "pitch": pitch, "emotion": emotion},
            "audio_setting": {"sample_rate": 32000, "bitrate": 128000, "format": "mp3", "channel": 1}}
    for a in range(3):
        st, js = va.call("POST", "/v1/t2a_v2", body); b = js.get("base_resp") or {}
        if st == 200 and b.get("status_code") == 0 and (js.get("data") or {}).get("audio"):
            open(out, "wb").write(bytes.fromhex(js["data"]["audio"])); return True
        print("  失败", voice, st, b.get("status_code"), b.get("status_msg"), js.get("raw", ""), flush=True); time.sleep(4)
    return False

def main():
    if not os.environ.get("GEMINI_API_KEY"): print("没有找到环境变量 GEMINI_API_KEY"); sys.exit(2)
    if va.KEY:
        for vid, emo, p in ROUND2:
            f = os.path.join(OUT, fname(vid, emo, p))
            if not os.path.exists(f): print("配", os.path.basename(f), flush=True); tts_pitch(va.TEST, vid, emo, p, f); time.sleep(1.2)
    cands = sorted(f for f in os.listdir(OUT) if f.endswith(".mp3") and not f.startswith("new_"))
    print(f"共 {len(cands)} 条候选，交给 Gemini 打分……", flush=True)
    res = []
    for i in range(0, len(cands), 8):
        batch = cands[i:i + 8]
        parts = [{"text": f"你是影视配音导演。角色设定：{PROFILE}。下面每条都是不同音色念同一句台词「{va.TEST}」。请逐条认真听，只输出 JSON 数组。"}]
        for k, f in enumerate(batch):
            parts += [{"text": f"第 {k} 条：{f}"}, qa.audio_part(os.path.join(OUT, f))]
        parts.append({"text": '对每一条输出 {"k": 编号, "age": "听起来大约几岁", "fit": 0-10（像不像这个角色）, "natural": 0-10（自然、不机器）, "note": "一句话"}。只输出 JSON 数组。'})
        g = qa.gemini(parts)
        if isinstance(g, dict): print("  Gemini 出错：", g.get("error"), flush=True); continue
        for it in g or []:
            k = it.get("k")
            if isinstance(k, int) and k < len(batch): it["file"] = batch[k]; res.append(it)
    res.sort(key=lambda x: -(x.get("fit", 0) * 2 + x.get("natural", 0)))
    amb = []
    sdir = os.path.join(ROOT, "el_sfx", "out")
    for name, want in AMB:
        fs = [f"{name}_{t}.mp3" for t in "cd" if os.path.exists(os.path.join(sdir, f"{name}_{t}.mp3"))]
        parts = [{"text": f"你是音效质检员。这段环境声应该是：{want}。下面是 {len(fs)} 个候选，请逐条听，只输出 JSON 数组。"}]
        for k, f in enumerate(fs): parts += [{"text": f"第 {k} 条：{f}"}, qa.audio_part(os.path.join(sdir, f))]
        parts.append({"text": '对每一条输出 {"k": 编号, "heard": "实际听到了什么", "match": 0-10, "problem": "穿帮或不对的地方，没有写空字符串"}。只输出 JSON 数组。'})
        g = qa.gemini(parts)
        if isinstance(g, list):
            for it in g:
                if isinstance(it.get("k"), int) and it["k"] < len(fs): it["file"] = fs[it["k"]]; amb.append(it)
        else: print("  Gemini 出错：", (g or {}).get("error"), flush=True)
    json.dump({"voices": res, "amb": amb}, open(os.path.join(OUT, "pick.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    rows = "".join(f"<tr><td>{n+1}</td><td><b>{html.escape(r['file'])}</b><br><small>{html.escape(str(r.get('note','')))}</small></td><td>{r.get('age','')}</td><td>{r.get('fit','')}</td><td>{r.get('natural','')}</td><td><audio controls src='{r['file']}'></audio></td></tr>" for n, r in enumerate(res))
    arows = "".join(f"<tr><td><b>{a['file']}</b></td><td>{a.get('match')}</td><td>{html.escape(str(a.get('heard','')))}<br><small>{html.escape(str(a.get('problem','')))}</small></td><td><audio controls src='../../el_sfx/out/{a['file']}'></audio></td></tr>" for a in amb)
    open(os.path.join(OUT, "pick.html"), "w", encoding="utf-8").write(f"<!doctype html><meta charset=utf-8><title>选音结果</title><style>body{{font:14px 'Microsoft YaHei';background:#16171a;color:#e6e2da;padding:20px}}td{{padding:6px;border-bottom:1px solid #333}}small{{color:#999}}</style><h2>穿貂的女人 · Gemini 排名</h2><table><tr><th>#</th><th>候选</th><th>听着几岁</th><th>像不像</th><th>自然</th><th></th></tr>{rows}</table><h2>环境声</h2><table>{arows}</table>")
    print("前三名："); [print(" ", r["file"], r.get("age"), r.get("fit"), r.get("natural"), r.get("note")) for r in res[:3]]
    for a in amb: print(" ", a["file"], a.get("match"), a.get("problem"))
    print("结果页：", os.path.join(OUT, "pick.html"))

if __name__ == "__main__":
    main()
