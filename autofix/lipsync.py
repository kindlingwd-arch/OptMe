# 口型同步（sync.so）：把游戏里的配音对到现成视频上，让说话的人嘴巴真的动起来
# 用法：python lipsync.py ride        结果在 autofix\lipsync\ 里，先看效果，满意再加 --install 换进游戏
# 环境变量：SYNC_API_KEY（必需）、SYNC_MODEL（默认 lipsync-2）、GEMINI_API_KEY（可选，用来自动复核）。不打印密钥
import os, sys, json, time, shutil, subprocess, urllib.request, urllib.error
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "qc"))
import qc
KEY = (os.environ.get("SYNC_API_KEY") or "").strip(); MODEL = os.environ.get("SYNC_MODEL", "lipsync-2")
API = "https://api.sync.so/v2"
GAME = os.path.join(ROOT, "moban_game"); OUT = os.path.join(HERE, "lipsync")
# 每个镜头：画面里要对口型的那个人说的台词（配音文件名, 前面空几秒）
PLAN = {
    "ride":      [("ride_01", 0.6), ("ride_04", 1.4)],          # 副驾驶的女人：不用，搁腿上得劲儿 / 吵挺
    "together":  [("together_02", 0.5)],                       # 女人：你敢！密码是我闺女生日……
    "start":     [("start_03", 0.4)],                           # 女人：师傅，上加格达奇火车站……
    "check":     [("check_01", 0.4)],                           # 民警：同志，停一下……
    "E_truth":   [("E_truth_02", 0.4)],                         # 女人：店是我的，货是我的……
}

def req(method, url, body=None, headers=None, raw=None):
    h = {"x-api-key": KEY}; h.update(headers or {})
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    if body is not None: h["Content-Type"] = "application/json"
    r = urllib.request.Request(url, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(r, timeout=300) as f:
            t = f.read(); return f.status, (json.loads(t) if t else {})
    except urllib.error.HTTPError as e:
        return e.code, {"raw": e.read().decode("utf-8", "replace")[:400]}

def upload(path, ctype, kind):
    st, up = req("POST", f"{API}/assets/upload", {"fileName": os.path.basename(path), "contentType": ctype, "size": os.path.getsize(path)})
    if st >= 300 or "uploadUrl" not in up: raise RuntimeError(f"申请上传地址失败 {st} {up}")
    put = urllib.request.Request(up["uploadUrl"], data=open(path, "rb").read(), method="PUT", headers={"Content-Type": ctype})
    with urllib.request.urlopen(put, timeout=300) as f: pass
    st, a = req("POST", f"{API}/assets", {"url": up["url"], "type": kind, "name": os.path.basename(path)})
    if st >= 300 or "id" not in a: raise RuntimeError(f"登记素材失败 {st} {a}")
    return a["id"]

def build_audio(sid, dur, out):
    """把台词按时间排进一条和视频一样长的音轨"""
    ins, filt, t = [], [], 0.0
    for i, (vo, gap) in enumerate(PLAN[sid]):
        p = os.path.join(GAME, "vo", vo + ".mp3"); t += gap
        ins += ["-i", p]; filt.append(f"[{i}:a]aresample=44100,adelay={int(t*1000)}:all=1[a{i}]")
        t += qc.probe(p)[0]
    if t > dur: print(f"  注意：台词总长 {t:.1f}s 超过视频 {dur:.1f}s，后面会被截掉", flush=True)
    n = len(PLAN[sid])
    fc = ";".join(filt) + ";" + "".join(f"[a{i}]" for i in range(n)) + f"amix=inputs={n}:normalize=0,apad[o]"
    r = qc.run([qc.FF, "-y", "-nostdin", *ins, "-filter_complex", fc, "-map", "[o]", "-t", f"{dur:.2f}", "-ac", "1", out])
    if not os.path.exists(out): raise RuntimeError("拼音轨失败：" + r.stderr[-300:])

def main():
    if not KEY: print("没有找到环境变量 SYNC_API_KEY"); sys.exit(2)
    args = [a for a in sys.argv[1:] if not a.startswith("--")]; install = "--install" in sys.argv
    sids = args[0].split(",") if args else ["ride"]
    os.makedirs(OUT, exist_ok=True)
    for sid in sids:
        src = os.path.join(GAME, "vid", sid + ".mp4"); prev = os.path.join(OUT, f"{sid}_preview.mp4"); silent = os.path.join(OUT, f"{sid}.mp4")
        if install:
            if not os.path.exists(silent): print(sid, "还没有口型结果"); continue
            os.makedirs(os.path.join(HERE, "backup"), exist_ok=True)
            shutil.copy2(src, os.path.join(HERE, "backup", f"{sid}_before_lipsync_{time.strftime('%m%d_%H%M')}.mp4")); shutil.copy2(silent, src)
            print(sid, "✓ 已换进游戏（原视频在 autofix\\backup）"); continue
        if sid not in PLAN: print(sid, "没有配置台词"); continue
        dur = qc.probe(src)[0]; wav = os.path.join(OUT, f"{sid}_voice.wav")
        print(f"== {sid}：视频 {dur:.1f}s，模型 {MODEL} ==", flush=True)
        build_audio(sid, dur, wav)
        vid_id = upload(src, "video/mp4", "VIDEO"); aud_id = upload(wav, "audio/wav", "AUDIO"); print("  素材已上传", flush=True)
        st, g = req("POST", f"{API}/generate", {"model": MODEL, "input": [{"type": "video", "assetId": vid_id}, {"type": "audio", "assetId": aud_id}], "options": {"sync_mode": "cut_off"}}, headers={"Idempotency-Key": f"moban-{sid}-{int(time.time())}"})
        if st >= 300 or "id" not in g: print("  提交失败", st, g, flush=True); continue
        jid = g["id"]; print("  已提交，任务", jid, flush=True)
        url = None
        for i in range(120):
            time.sleep(10); st, j = req("GET", f"{API}/generate/{jid}"); s = j.get("status")
            if i % 3 == 0: print("  状态", s, flush=True)
            if s == "COMPLETED": url = j.get("outputUrl") or j.get("output_url"); break
            if s in ("FAILED", "REJECTED"): print("  失败", json.dumps(j, ensure_ascii=False)[:400], flush=True); break
        if not url: continue
        urllib.request.urlretrieve(url, prev)
        qc.run([qc.FF, "-y", "-nostdin", "-i", prev, "-an", "-c:v", "copy", silent])
        print("  ✓ 已保存", prev, "（带声音，给你看效果）和", silent, "（无声，给游戏用）", flush=True)
        if os.environ.get("GEMINI_API_KEY"):
            spec_all = json.load(open(os.path.join(ROOT, "qc", "specs.json"), encoding="utf-8")); qc.RULES = spec_all["rules"]
            spec = dict(next(s for s in spec_all["shots"] if s["id"] == sid)); spec["id"] = sid + "_lipsync"; spec["video"] = prev
            r = qc.check(spec, GAME, OUT, os.path.join(ROOT, "refs"), True); gm = r.get("gemini") or {}
            print(f"  Gemini：{'通过' if gm.get('pass') else '不通过'} {gm.get('score')}/10", flush=True)
            for it in gm.get("issues", []): print("    ", it.get("severity"), it.get("type"), it.get("detail"), flush=True)
            json.dump(r, open(os.path.join(OUT, f"{sid}_qc.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)

if __name__ == "__main__":
    main()
