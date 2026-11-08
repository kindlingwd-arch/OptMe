"""方案二：Manim（原本做数学动画的 Python 库）→ 视频。
用法：python manim_ref.py [镜头]   默认 ask，输出 out\\<镜头>_manim.mp4。
第一次用要 pip install manim（Windows 上有现成的安装包，几分钟；Manim 自带 ffmpeg 相关组件）。"""
import os, sys, json, shutil, glob, time
import common as C

try:
    from manim import *          # noqa: F401,F403
except ImportError:
    sys.exit("还没装 Manim：运行 pip install manim（装不上就把报错发给 Claude）")

SID = C.sid_arg()
TRACK, _ = C.build(SID)
FONT = "Microsoft YaHei" if os.name == "nt" else "Noto Sans CJK SC"
CAM = {"push_in": "镜头推近", "pull_out": "镜头拉远", "pan_left": "镜头左摇", "pan_right": "镜头右摇", "tilt_up": "镜头上摇", "tilt_down": "镜头下摇"}.get(TRACK["camera"], "")


class RefScene(MovingCameraScene):
    def construct(self):
        fw, fh = config.frame_width, config.frame_height
        P = lambda x, y: np.array([(x - .5) * fw, (.5 - y) * fh, 0])
        fr = TRACK["frames"]; n = len(fr); fps = TRACK["fps"]
        bg = ImageMobject(os.path.join(C.OUT, TRACK["key"])); bg.height = fh
        if bg.width < fw: bg.width = fw
        dim = Rectangle(width=fw * 1.6, height=fh * 1.6, fill_color=BLACK, fill_opacity=.45, stroke_width=0)
        self.add(bg, dim)
        t = ValueTracker(0)
        idx = lambda: min(n - 1, int(round(t.get_value() * fps)))
        for k, sb in enumerate(TRACK["subjects"]):
            col = ManimColor(sb["color"])
            plan = DashedVMobject(VMobject().set_points_smoothly([P(x, y) for x, y in sb["path"]]), num_dashes=40).set_stroke(col, 2, opacity=.55)
            trail = VMobject().set_stroke(col, 5)
            def upd_trail(m, k=k):
                pts = [P(*f["pos"][k]) for f in fr[:idx() + 1]]
                if len(pts) < 2: pts = pts * 2
                m.set_points_as_corners(pts)
            trail.add_updater(upd_trail)
            dot = Dot(radius=fw * .028, color=col, fill_opacity=.85).set_stroke(WHITE, 3)
            lab = Text(sb["label"], font=FONT, font_size=22).set_stroke(BLACK, 4, background=True)
            dot.add_updater(lambda m, k=k: m.move_to(P(*fr[idx()]["pos"][k])))
            lab.add_updater(lambda m, d=dot: m.next_to(d, UP, buff=.08))
            self.add(plan, trail, dot, lab)
        frame = self.camera.frame
        def upd_cam(m):
            s, dx, dy = fr[idx()]["cam"]; m.set(width=fw / s); m.move_to(np.array([-dx * fw / s, dy * fh / s, 0]))
        frame.add_updater(upd_cam)
        tc = Text("0.0s", font=FONT, font_size=22, color=YELLOW)
        def upd_tc(m):
            s = frame.width / fw; new = Text(f"{fr[idx()]['t']:.1f}s {CAM}", font=FONT, font_size=22, color=YELLOW).scale(s)
            new.move_to(frame.get_corner(DL) + np.array([new.width / 2 + .25 * s, new.height / 2 + .25 * s, 0])); m.become(new)
        tc.add_updater(upd_tc); self.add(tc)
        self.play(t.animate.set_value((n - 1) / fps), run_time=n / fps, rate_func=linear)


if __name__ == "__main__":
    media = os.path.join(C.OUT, "manim_media"); t0 = time.time()
    with tempconfig({"pixel_width": TRACK["w"], "pixel_height": TRACK["h"], "frame_rate": TRACK["fps"], "media_dir": media,
                     "output_file": f"{SID}_manim", "disable_caching": True, "verbosity": "WARNING", "progress_bar": "none"}):
        RefScene().render()
    found = sorted(glob.glob(os.path.join(media, "videos", "**", f"{SID}_manim.mp4"), recursive=True), key=os.path.getmtime)
    if not found: sys.exit("Manim 没生成视频，看上面的报错")
    out = os.path.join(C.OUT, f"{SID}_manim.mp4"); shutil.copy2(found[-1], out); C.timing(SID, "manim", time.time() - t0); print("视频：" + out, flush=True)
