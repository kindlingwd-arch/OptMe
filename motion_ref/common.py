"""三种参考视频生成方式共用：读首帧图和轨迹（autofix\\test_motion\\<镜头>\\motion.json），算出每一帧的位置，写成 out\\<镜头>_track.json。
三种方式（SVG / Manim / Remotion）都只读这份逐帧数据来画，所以动作完全一样，只比较画法和工具好不好用。"""
import os, sys, json, math, shutil

HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
GAME = os.path.join(ROOT, "moban_game"); OUT = os.path.join(HERE, "out")
W, H, FPS, DUR = 960, 540, 24, 6.0
COLORS = ["#ff4646", "#3cc8ff", "#78ff78", "#ffd23c"]


def keyframe(sid):
    for p in (f"img/{sid}.jpg", f"img/l/{sid}.jpg"):
        if os.path.exists(os.path.join(GAME, p)): return os.path.join(GAME, p)
    return None


def catmull(pts, u):
    """经过所有点的平滑曲线（Catmull-Rom），u 从 0 到 len-1。"""
    n = len(pts); i = min(int(u), n - 2); f = u - i
    p0, p1, p2, p3 = pts[max(i - 1, 0)], pts[i], pts[i + 1], pts[min(i + 2, n - 1)]
    return tuple(.5 * ((2 * p1[k]) + (-p0[k] + p2[k]) * f + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * f * f + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * f ** 3) for k in (0, 1))


def at(points, t):
    """按时间取位置：点之间用缓入缓出，路线用平滑曲线。points: [[x, y, 秒], ...]"""
    if t <= points[0][2]: return points[0][0], points[0][1]
    if t >= points[-1][2]: return points[-1][0], points[-1][1]
    for i in range(len(points) - 1):
        a, b = points[i], points[i + 1]
        if a[2] <= t <= b[2]:
            f = (t - a[2]) / max(1e-6, b[2] - a[2]); f = f * f * (3 - 2 * f)
            return catmull([(p[0], p[1]) for p in points], i + f)
    return points[-1][0], points[-1][1]


def camera(cam, t):
    """镜头：返回 (缩放, x 平移, y 平移)，平移是画面宽高的比例。推近 = 放大，向左摇 = 画面往右移。"""
    move, a = (cam or {}).get("move", "static"), float((cam or {}).get("amount", .3) or .3)
    f = t / DUR; f = f * f * (3 - 2 * f)
    s, dx, dy = 1.0, 0.0, 0.0
    if move == "push_in": s = 1 + .35 * a * f
    elif move == "pull_out": s = 1 + .35 * a * (1 - f)
    elif move in ("pan_left", "orbit_left"): s, dx = 1.15, .12 * a * f
    elif move in ("pan_right", "orbit_right"): s, dx = 1.15, -.12 * a * f
    elif move == "tilt_up": s, dy = 1.15, .12 * a * f
    elif move == "tilt_down": s, dy = 1.15, -.12 * a * f
    return s, dx, dy


def build(sid):
    mp = os.path.join(ROOT, "autofix", "test_motion", sid, "motion.json")
    if not os.path.exists(mp): sys.exit(f"找不到轨迹 {mp}：先双击 autofix\\test_motion.bat（或 test_motion.bat {sid} --dry）让 AI 标一条")
    kf = keyframe(sid)
    if not kf: sys.exit(f"找不到首帧图 img/{sid}.jpg")
    motion = json.load(open(mp, encoding="utf-8")); os.makedirs(OUT, exist_ok=True)
    key = f"{sid}_key.jpg"; shutil.copy2(kf, os.path.join(OUT, key))
    n = int(DUR * FPS); subs = [s for s in motion.get("subjects", []) if len(s.get("points", [])) >= 2]
    frames = []
    for i in range(n):
        t = i / FPS; s, dx, dy = camera(motion.get("camera"), t)
        frames.append({"t": round(t, 3), "cam": [round(s, 4), round(dx, 4), round(dy, 4)], "pos": [[round(v, 4) for v in at(sb["points"], t)] for sb in subs]})
    track = {"sid": sid, "w": W, "h": H, "fps": FPS, "frames": frames, "key": key, "action": motion.get("action", ""),
             "subjects": [{"label": sb.get("label", ""), "color": COLORS[k % len(COLORS)], "path": [[round(v, 4) for v in at(sb["points"], j / 40 * DUR)] for j in range(41)]} for k, sb in enumerate(subs)],
             "camera": (motion.get("camera") or {}).get("move", "static")}
    p = os.path.join(OUT, f"{sid}_track.json"); json.dump(track, open(p, "w", encoding="utf-8"), ensure_ascii=False)
    return track, p


def ffmpeg():
    p = shutil.which("ffmpeg")
    if p: return p
    try:
        import imageio_ffmpeg; return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception: sys.exit("没找到 ffmpeg：运行 pip install imageio-ffmpeg")


def sid_arg():
    a = [x for x in sys.argv[1:] if not x.startswith("-")]
    return a[0] if a else "ask"


def timing(sid, name, sec):
    p = os.path.join(OUT, f"{sid}_timing.json")
    try: d = json.load(open(p, encoding="utf-8"))
    except Exception: d = {}
    d[name] = round(sec, 1); json.dump(d, open(p, "w", encoding="utf-8"))
