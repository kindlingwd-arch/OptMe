# 重做声音质检里不合格的两段环境声（ElevenLabs），每段两个版本 _c/_d，放在 el_sfx\out\
import os, sys, time
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, os.path.join(os.path.dirname(HERE), "el_sfx"))
import el_sfx
JOBS = [
 ("amb_check",   16.0, True, "Quiet roadside checkpoint on a snowy forest highway at night, an old car engine idling nearby, cold wind through pine trees, occasional short burst of walkie-talkie static squelch with no speech and no words, no English, no voices, seamless loop"),
 ("amb_kitchen", 16.0, True, "Cozy small apartment kitchen at night in winter, a big pot of water at a rolling boil with dumplings bubbling, lid gently rattling, very faint muffled festive Chinese orchestral TV music from the next room, distant firecrackers outside, no frying, no sizzling, seamless loop"),
]
if __name__ == "__main__":
    if not el_sfx.KEY: print("没有找到环境变量 ELEVENLABS_API_KEY"); sys.exit(2)
    out = os.path.join(os.path.dirname(HERE), "el_sfx", "out"); os.makedirs(out, exist_ok=True)
    for name, secs, loop, text in JOBS:
        for t in ("c", "d"):
            fn = os.path.join(out, f"{name}_{t}.mp3")
            if os.path.exists(fn): continue
            data, err = el_sfx.gen(text, secs, loop)
            if data: open(fn, "wb").write(data); print("OK", fn, flush=True)
            else: print("FAIL", name, t, err, flush=True)
            time.sleep(1)
    print("完成")
