# 按 targets.json 里每个镜头的 "gen_refs"，用 Codex 生成「这一镜专用」的参考图（人物此刻的样子、关键道具特写、同一场景的另一个角度……）
# 生成好的参考图会和关键帧、角色设定图一起交给 MiniMax-H3 做多图参考（最多 9 张）。已存在的跳过；Codex 一次最多带 5 张输入图。
# 用法：python make_refs.py [镜头id ...]
import os, sys, json, glob, subprocess
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
STYLE = ("Style: cinematic film still, 1998 Northeast China winter night, Kodak 35mm film grain, muted realistic colors. "
         "No subtitles, no watermark, no gore, no blood, no wounds, no guns.")
RULE = ("Treat the attached images as strict references: every person, prop and place must match them exactly "
        "(same face, hairstyle, age, clothing, colors). Do not copy any grey studio background or sheet layout.")

def codex():
    for p in glob.glob(os.path.join(os.environ.get("LOCALAPPDATA", ""), "OpenAI", "Codex", "bin", "*", "codex.exe")): return p
    return "codex"

def main():
    T = json.load(open(os.path.join(HERE, "targets.json"), encoding="utf-8"))
    only = set(sys.argv[1:])
    os.makedirs(os.path.join(HERE, "refs_gen"), exist_ok=True); log = open(os.path.join(HERE, "log_refs.txt"), "a", encoding="utf-8")
    for sid, t in T.items():
        if only and sid not in only: continue
        for g in t.get("gen_refs", []):
            out = os.path.join(HERE, "refs_gen", g["name"] + ".png")
            if os.path.exists(out): print("已有", g["name"]); continue
            ins = [os.path.join(ROOT, p) for p in g["inputs"]][:5]
            miss = [p for p in ins if not os.path.exists(p)]
            if miss: print("缺输入图，跳过", g["name"], miss); continue
            listing = "\n".join(f"- Attached image {i+1}: {os.path.basename(p)}" for i, p in enumerate(ins))
            ptxt = os.path.join(HERE, "refs_gen", "p_" + g["name"] + ".txt")
            open(ptxt, "w", encoding="utf-8").write(f"ATTACHED IMAGES (in this order):\n{listing}\n{RULE}\n\nThis is a REFERENCE image for a video model (not a story frame): {g['desc']}\n{STYLE}\n")
            rel = os.path.relpath(ptxt, ROOT); relout = os.path.relpath(out, ROOT)
            instr = (f"Use your image generation tool to create exactly one new image from the description in the file {rel} (read that file first). "
                     f"Use the attached images as visual references, as that file explains. Landscape format, about 1536x1024. "
                     f"Then copy the generated PNG file into this folder as {relout} (find it under %USERPROFILE%\\.codex\\generated_images if needed). "
                     f"Do nothing else and do not modify any other file.")
            cmd = [codex(), "exec"] + sum([["-i", p] for p in ins], []) + ["--skip-git-repo-check", "-c", 'model_reasoning_effort="low"', "-s", "workspace-write",
                   "--add-dir", os.path.join(os.environ.get("USERPROFILE", ""), ".codex"), "-"]
            print("生成参考图", g["name"], "……", flush=True)
            subprocess.run(cmd, input=instr, text=True, encoding="utf-8", cwd=ROOT, stdout=log, stderr=log)
            print("  " + ("✓" if os.path.exists(out) else "× 没生成（看 autofix\\log_refs.txt，可能被安全审核拦了）"), flush=True)

if __name__ == "__main__":
    main()
