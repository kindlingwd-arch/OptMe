# 换音色：把「穿貂的女人」的全部台词用新音色重配（默认 热心大婶 Kind-hearted_Antie），并补配新增台词（民警：E_late_01）
# 台词表直接从 moban_game\index.html 读（剧本 N + 配音表 VOT），所以后来加的台词也不会漏
# 用法：python voice_swap.py            旧文件备份到 autofix\backup\audio_voice_swap\
# 读 MINIMAX_API_KEY，不打印密钥
import os, sys, re, json, time, shutil, subprocess, urllib.request, urllib.error
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
GAME = os.path.join(ROOT, "moban_game"); VO = os.path.join(GAME, "vo")
KEY = (os.environ.get("MINIMAX_API_KEY") or os.environ.get("KLING_API_KEY") or "").strip()
WOMAN = "穿貂的女人"
NEW_VOICE = os.environ.get("WOMAN_VOICE", "Chinese (Mandarin)_Kind-hearted_Antie")
POLICE_VOICE = "Chinese (Mandarin)_Reliable_Executive"
EXTRA = {"E_late_01": (POLICE_VOICE, "neutral")}      # 新增的台词：配音名 → (音色, 情绪)
BACKUP = os.path.join(HERE, "backup", "audio_voice_swap")

def ff():
    p = shutil.which("ffmpeg")
    if p: return p
    import imageio_ffmpeg; return imageio_ffmpeg.get_ffmpeg_exe()

def block(h, name):
    i = h.index(name) + len(name); d = 0
    for k, c in enumerate(h[i:]):
        if c == "{": d += 1
        elif c == "}":
            d -= 1
            if d == 0: return json.loads(h[i:i + k + 1])

def tts(text, voice, emotion, out):
    body = {"model": "speech-2.8-hd", "text": text, "stream": False, "language_boost": "Chinese",
            "voice_setting": {"voice_id": voice, "speed": 1.0, "vol": 1, "pitch": 0, "emotion": emotion},
            "audio_setting": {"sample_rate": 32000, "bitrate": 128000, "format": "mp3", "channel": 1}}
    for a in range(3):
        req = urllib.request.Request("https://api.minimaxi.com/v1/t2a_v2", data=json.dumps(body).encode(), method="POST",
                                     headers={"Authorization": "Bearer " + KEY, "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=120) as r: js = json.loads(r.read())
            b = js.get("base_resp") or {}
            if b.get("status_code") == 0 and (js.get("data") or {}).get("audio"):
                open(out, "wb").write(bytes.fromhex(js["data"]["audio"])); return True
            print("  失败", b.get("status_code"), b.get("status_msg"), flush=True)
        except Exception as e: print("  出错", str(e)[:150], flush=True)
        time.sleep(4)
    return False

def norm(src, dst, lufs):
    subprocess.run([ff(), "-y", "-nostdin", "-loglevel", "error", "-i", src, "-af", f"loudnorm=I={lufs}:TP=-1.5:LRA=7",
                    "-ar", "32000", "-ac", "1", "-b:a", "128k", dst], check=True)

def main():
    if not KEY: print("没有找到环境变量 MINIMAX_API_KEY"); sys.exit(2)
    h = open(os.path.join(GAME, "index.html"), encoding="utf-8").read()
    N = block(h, "const N="); VOT = json.loads(re.search(r"const VOT=/\*VO_MAP\*/(\{.*?\});", h, re.S).group(1))
    emo = {}
    lj = os.path.join(ROOT, "minimax_test", "lines.json")
    if os.path.exists(lj):
        for x in json.load(open(lj, encoding="utf-8")): emo[x["id"]] = x.get("emotion", "neutral")
    jobs = {}
    for nid, n in N.items():
        for who, text in n.get("lines", []):
            if who != WOMAN: continue
            key = VOT.get(re.sub(r"（[^）]*）", "", text).strip())
            if key and text.strip("…。. "): jobs[key] = (re.sub(r"（[^）]*）", "", text).strip(), NEW_VOICE, emo.get(key, "angry" if "！" in text else "neutral"))
    for key, (voice, e) in EXTRA.items():
        text = next((t for t, k in VOT.items() if k == key), None)
        if text and not os.path.exists(os.path.join(VO, key + ".mp3")): jobs[key] = (text, voice, e)
    print(f"要配 {len(jobs)} 句（女人用 {NEW_VOICE}）", flush=True)
    os.makedirs(BACKUP, exist_ok=True); tmp = os.path.join(HERE, "staging"); os.makedirs(tmp, exist_ok=True); ok = 0
    for key, (text, voice, e) in jobs.items():
        dst = os.path.join(VO, key + ".mp3"); raw = os.path.join(tmp, key + "_raw.mp3")
        if os.path.exists(dst) and not os.path.exists(os.path.join(BACKUP, key + ".mp3")): shutil.copy2(dst, os.path.join(BACKUP, key + ".mp3"))
        if tts(text, voice, e, raw):
            norm(raw, dst, -22); ok += 1; print("OK", key, e, text[:20], flush=True)
        time.sleep(1.2)
    print(f"完成 {ok}/{len(jobs)}。旧文件在 autofix\\backup\\audio_voice_swap。接着可以跑 qc\\run_qc_audio.bat 复查。")

if __name__ == "__main__":
    main()
