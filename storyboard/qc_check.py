"""只质检、不改图：用现在的出图质检（batch.py 的 qc，含第 7 项「人和人、人和物的关系」）检查游戏里正在用的分镜图。
用法：python qc_check.py <镜头…>      每张约 $0.01；结果打印出来，并存到 storyboard\\out\\qc_check_<时间>.json
"""
import os, sys, json, time
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import batch as B
from PIL import Image


def main(ids):
    if not ids: print(__doc__); return 2
    sl = json.load(open(os.path.join(HERE, "shotlist.json"), encoding="utf-8"))
    shots = {s["id"]: s for s in sl["shots"]}; out = {}
    tmp = os.path.join(HERE, "out", "qc_check"); os.makedirs(tmp, exist_ok=True)
    for sid in ids:
        src = os.path.join(B.FINAL, sid + ".jpg")
        if sid not in shots or not os.path.exists(src): print(f"{sid}：没有分镜或没有图，跳过", flush=True); continue
        png = os.path.join(tmp, sid + ".png"); Image.open(src).convert("RGB").save(png)
        q = B.qc(shots[sid], sl.get("bible", {}), png); out[sid] = q
        if "error" in q: print(f"{sid}：{q['error']}", flush=True); continue
        print(f"{sid}：{'通过' if q.get('pass') else '不通过'}  {q.get('score', '-')}/10", flush=True)
        for x in q.get("issues", []): print(f"    · {x}", flush=True)
    try:
        B.gi.add_spent(os.path.join(B.OUT, "state.json"), 0.01 * len(out))
    except Exception: pass
    f = os.path.join(HERE, "out", f"qc_check_{time.strftime('%m%d_%H%M%S')}.json")
    json.dump(out, open(f, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"结果存在 {os.path.relpath(f, B.ROOT)}", flush=True); return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
