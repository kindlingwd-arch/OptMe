"""视频分镜表（autofix\\video_shots.json）：每个要做成视频的镜头一条——首帧、提示词、质检标准、参考图、生成方式、时长、谁要张嘴。
原来散在 autofix\\targets.json、autofix\\autofix.py（写死的 TARGETS）、qc\\specs.json 三处，2026-11-01 合并到这里；
autofix.py（生成 + 质检 + 自动重拍）和 qc.py（视频质检）都从这里读，影游剪辑台「审阅 → ③ 视频提示词」也读写这份。

人审规则（2026-11-01 定，方案 C）：每个镜头第一次生成前，提示词必须在剪辑台里审过（review.json 的 vprompt:<镜头>，
记的是提示词指纹，改过就要重审）；之后质检不通过、AI 改写提示词的自动重拍放行，但每次都记下「AI 改写」，剪辑台里能看到。

用法：python video_shots.py migrate [--force]   从旧的三处生成 video_shots.json（已有就不动，加 --force 覆盖，旧文件先备份）
      python video_shots.py check [镜头…]        看哪些镜头的提示词还没审
"""
import os, sys, json, time, shutil, struct

HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
PATH = os.path.join(HERE, "video_shots.json")
REVIEW = os.path.join(ROOT, "storyboard", "out", "review.json")
SUF = "。写实电影质感，镜头运动轻缓，人物脸型和服装从头到尾保持一致。"


def js_hash(s):
    """和剪辑台 app.js 的 hashStr 一样（djb2，按 UTF-16 编码单元），两边算出来的指纹必须一致。"""
    b = s.encode("utf-16-le"); h = 5381
    for (c,) in struct.iter_unpack("<H", b): h = (h * 33 + c) & 0xFFFFFFFF
    return h


def vp_key(shot):
    return "|".join(str(shot.get(k) or "") for k in ("prompt", "mode", "key", "last", "mid"))


def vp_hash(shot):
    return js_hash(vp_key(shot))


def load():
    d = json.load(open(PATH, encoding="utf-8"))
    return d, {s["id"]: s for s in d.get("shots", [])}


def reviewed(shot):
    """这条提示词（现在的样子）有没有人审过并点了没问题。"""
    try: r = json.load(open(REVIEW, encoding="utf-8")).get("vprompt:" + shot["id"])
    except Exception: return False
    return bool(r and r.get("ok") and r.get("mtime") == vp_hash(shot))


def migrate(force=False):
    if os.path.exists(PATH) and not force: print("已经有 video_shots.json，不覆盖（要重新生成加 --force）"); return 0
    if os.path.exists(PATH):
        os.makedirs(os.path.join(HERE, "backup"), exist_ok=True)
        shutil.copy2(PATH, os.path.join(HERE, "backup", f"video_shots_{time.strftime('%m%d_%H%M%S')}.json"))
    specs = json.load(open(os.path.join(ROOT, "qc", "specs.json"), encoding="utf-8"))
    try: targets = json.load(open(os.path.join(HERE, "targets.json"), encoding="utf-8"))
    except Exception: targets = {}
    old = {}   # autofix.py 里写死的 TARGETS（targets.json 存在时其实没用上，这里只当补充）
    try:
        import ast
        src = open(os.path.join(HERE, "autofix.py"), encoding="utf-8").read()
        for node in ast.walk(ast.parse(src)):
            if isinstance(node, ast.Assign) and any(getattr(t, "id", "") == "TARGETS" for t in node.targets) and isinstance(node.value, ast.Dict):
                for k, v in zip(node.value.keys, node.value.values):
                    if isinstance(v, ast.Call): old[k.value] = {kw.arg: ast.literal_eval(kw.value) for kw in v.keywords}
                break
    except Exception as e: print("（读 autofix.py 里写死的 TARGETS 失败，跳过：", e, "）")
    shots = []
    ids = [s["id"] for s in specs["shots"]] + [k for k in targets if k not in {s["id"] for s in specs["shots"]}]
    sp = {s["id"]: s for s in specs["shots"]}
    for sid in ids:
        s, t, o = sp.get(sid, {}), targets.get(sid, {}), old.get(sid, {})
        prompt, src = (t.get("prompt"), "targets.json") if t.get("prompt") else (o.get("prompt"), "autofix.py 里写死的") if o.get("prompt") else (s.get("describe", ""), "质检标准（原来没单独写提示词）")
        shots.append({
            "id": sid, "kind": s.get("kind", "shot" if sid.startswith("s_") else "scene"),
            "keyframe": s.get("keyframe", f"img/{sid}.jpg"),
            "key": t.get("key") or o.get("key") or "", "last": t.get("last", ""), "mid": t.get("mid", ""),
            "mode": t.get("mode", ""), "model": t.get("model", ""),
            "refs": t.get("refs", []), "gen_refs": t.get("gen_refs", []),
            "cost": t.get("cost", 2), "duration": 6,
            "speakers": s.get("speakers", []), "need_mouth": bool(s.get("need_mouth")),
            "describe": t.get("describe") or o.get("describe") or s.get("describe", ""),
            "prompt": prompt, "prompt_from": src,
            "auto": sid in targets,
            "video": s.get("video", f"vid/{sid}.mp4"), "qc_refs": s.get("refs", []),
        })
    out = {"_说明": "视频分镜表：autofix.py 和 qc.py 都从这里读；影游剪辑台「审阅 → ③ 视频提示词」可以看和改。key/last/mid 相对 autofix 文件夹，keyframe/video 相对游戏文件夹，refs 相对 moban_art。mode：h3（有 refs 是参考模式，没有是帧模式），空 = 海螺。auto=true 的是不写镜头名时默认要做的。",
           "suffix": SUF, "shots": shots}
    json.dump(out, open(PATH, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"已生成 {PATH}：{len(shots)} 个镜头（其中 {sum(x['auto'] for x in shots)} 个标为默认要做）")
    for x in shots: print(f"  {x['id']:12} 提示词来自：{x['prompt_from']}")
    return 0


def check(ids):
    _, m = load()
    for sid in ids or list(m):
        if sid in m: print(f"{sid:12} {'✓ 已审' if reviewed(m[sid]) else '待审'}")
    return 0


if __name__ == "__main__":
    a = sys.argv[1:]
    if a and a[0] == "migrate": sys.exit(migrate("--force" in a))
    if a and a[0] == "check": sys.exit(check(a[1:]))
    print(__doc__); sys.exit(2)
