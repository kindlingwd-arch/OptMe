"""完整 3D 预演（Blender 灰模）的启动器：找到 Blender，渲染 blender3d.py 里的场景，合成 mp4。
用法：python run3d.py [场景…] [--cycles]     默认三个示例 start ask check，用 EEVEE（显卡，快）；EEVEE 出不来自动改用 Cycles（CPU）。
输出：out\\<场景>_3d.mp4
"""
import os, sys, glob, shutil, subprocess, time
HERE = os.path.dirname(os.path.abspath(__file__)); OUT = os.path.join(HERE, "out")
sys.path.insert(0, HERE)
from scene25d import find_blender, ffmpeg


def render(name, engine):
    fd = os.path.join(OUT, f"{name}_3d_frames")
    if os.path.isdir(fd): shutil.rmtree(fd)
    os.makedirs(fd); bl = find_blender()
    if not bl: sys.exit("没找到 Blender：把 blender.exe 的完整路径写进 motion_ref\\blender_path.txt")
    env = dict(os.environ, B3D_ENGINE=engine); t0 = time.time()
    print(f"[{name}] 用 {engine.upper()} 渲染（{bl[0]}）…", flush=True)
    r = subprocess.run(bl + [os.path.join(HERE, "blender3d.py"), "--", name, fd], env=env, capture_output=True, text=True, encoding="utf-8", errors="replace")
    frames = sorted(glob.glob(os.path.join(fd, "f_*.png")))
    if len(frames) < 10:
        print((r.stdout or "")[-1500:], (r.stderr or "")[-1500:], sep="\n", flush=True); return None
    out = os.path.join(OUT, f"{name}_3d.mp4")
    subprocess.run([ffmpeg(), "-y", "-v", "error", "-framerate", "15", "-i", os.path.join(fd, "f_%04d.png"), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", out], check=True)
    print(f"[{name}] 完成：{out}（{time.time() - t0:.0f} 秒，{len(frames)} 帧）", flush=True); return out


if __name__ == "__main__":
    names = [a for a in sys.argv[1:] if not a.startswith("--")] or ["start", "ask", "check"]
    os.makedirs(OUT, exist_ok=True)
    for n in names:
        if "--cycles" in sys.argv or not render(n, "eevee"):
            if "--cycles" not in sys.argv: print(f"[{n}] EEVEE 没出来，改用 Cycles（CPU，慢一些）", flush=True)
            render(n, "cycles")
