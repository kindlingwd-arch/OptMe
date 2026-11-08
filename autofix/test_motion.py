"""测试：H3 能不能按我们指定的运动轨迹动起来。同一张首帧、同一条轨迹，用几种不同的给法各生成一条视频，抽帧对比，再让 Gemini 打分。

双击 test_motion.bat 直接开始：默认测 ask，Gemini 先标轨迹、打开轨迹图给你看，确认后才生成视频（A、B、C 三条，约 ¥6）。
用法：python test_motion.py [镜头] [--variants A,B,C,D,E] [--motion 路径] [--dry] [--yes] [--new]
  例：python test_motion.py ask --dry          先只看 AI 标的轨迹（不花视频的钱），满意了去掉 --dry 再跑
      python test_motion.py ask --variants A,B  只跑基线和带时间点的文字

轨迹（motion.json）：第一次由 Gemini 看首帧图标出来，存在 autofix\\test_motion\\<镜头>\\motion.json，可以手改坐标后用 --motion 再跑：
  {"action": "一句话动作", "subjects": [{"label": "女人的右手", "points": [[x, y, 秒], ...]}], "camera": {"move": "static|push_in|pull_out|pan_left|pan_right|tilt_up|tilt_down|orbit_left|orbit_right", "amount": 0~1}}
  x、y 是画面上的比例位置（左上角 0,0，右下角 1,1）。

几种给法（--variants，默认 A,B,C）：
  A 基线：只写一句动作，不说位置——看模型自己会怎么动
  B 时间点 + 位置写成文字：「00:00 右手在画面左下（20%,80%）→ 00:03 移到画面中间（50%,50%）…」，镜头运动也写成文字
  C 箭头画在首帧上：首帧上画了轨迹箭头，提示词让它照箭头动（箭头会出现在第一帧；这是测它看不看得懂图上的箭头）
  D 首尾帧：先让 Gemini 出一张「主体已经到了终点」的尾帧，再走 H3 首尾帧模式（多一次出图，约 $0.14）
  E 镜头轨迹参数：在官方接口里加 camera_trajectory（第三方平台 H3 Max 的镜头控制参数）——官方不接受会直接报错、不扣费
每条视频约 ¥2～6（按 COST_PER_VIDEO 估）。结果：autofix\\test_motion\\<镜头>\\report.html（轨迹图、每种给法的抽帧对比和打分）。
需要 MINIMAX_API_KEY、GEMINI_API_KEY 和代理（和 autofix 一样）。
"""
import os, sys, json, time, math, html, base64
from io import BytesIO
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
SB = os.path.join(ROOT, "storyboard"); sys.path.insert(0, SB); sys.path.insert(0, HERE)
import gen_images as gi                 # 代理、http、json_reply
import autofix as AF                    # H3 / 海螺 的提交和下载、qc 抽帧
from PIL import Image, ImageDraw, ImageFont

QC_MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.8-flash")
COLORS = [(255, 70, 70), (60, 200, 255), (120, 255, 120), (255, 210, 60)]
CAM_TEXT = {"static": "镜头固定不动", "push_in": "镜头缓慢推近", "pull_out": "镜头缓慢拉远", "pan_left": "镜头缓慢向左摇", "pan_right": "镜头缓慢向右摇",
            "tilt_up": "镜头缓慢上摇", "tilt_down": "镜头缓慢下摇", "orbit_left": "镜头向左绕主体小幅环绕", "orbit_right": "镜头向右绕主体小幅环绕"}


def font(sz):
    for n in ("msyhbd.ttc", "msyh.ttc", "simhei.ttf", "NotoSansCJK-Regular.ttc", "wqy-microhei.ttc", "DejaVuSans.ttf"):
        try: return ImageFont.truetype(n, sz)
        except Exception: pass
    return ImageFont.load_default()


def draw_plan(img, motion, alpha=1.0, labels=True):
    """在图上画轨迹：每个主体一条带箭头的折线，起点圆点、终点箭头、每个点标秒数；镜头运动画在画面边上。"""
    im = img.convert("RGB").copy(); W, H = im.size; d = ImageDraw.Draw(im); lw = max(3, W // 260); f = font(max(16, W // 48))
    for k, s in enumerate(motion.get("subjects", [])):
        c = COLORS[k % len(COLORS)]; pts = [(p[0] * W, p[1] * H) for p in s.get("points", [])]
        if len(pts) < 2: continue
        d.line(pts, fill=c, width=lw, joint="curve")
        x0, y0 = pts[0]; d.ellipse([x0 - lw * 2, y0 - lw * 2, x0 + lw * 2, y0 + lw * 2], fill=c)
        (xa, ya), (xb, yb) = pts[-2], pts[-1]; ang = math.atan2(yb - ya, xb - xa); L = lw * 6
        d.polygon([(xb, yb), (xb - L * math.cos(ang - .45), yb - L * math.sin(ang - .45)), (xb - L * math.cos(ang + .45), yb - L * math.sin(ang + .45))], fill=c)
        if labels:
            for p in s["points"]: d.text((p[0] * W + lw * 2, p[1] * H + lw * 2), f"{p[2]:g}s", fill=c, font=f)
            d.text((x0 + lw * 3, y0 - lw * 9), s.get("label", ""), fill=c, font=f)
    cam = (motion.get("camera") or {}).get("move", "static")
    if cam != "static":
        c = (255, 255, 255); cx, cy = W / 2, H / 2; r = min(W, H) * .42
        if cam in ("push_in", "pull_out"):
            for sx, sy in ((-1, -1), (1, -1), (-1, 1), (1, 1)):
                a, b = (cx + sx * r, cy + sy * r * .55), (cx + sx * r * .7, cy + sy * r * .38)
                if cam == "pull_out": a, b = b, a
                d.line([a, b], fill=c, width=lw)
        else:
            dx, dy = {"pan_left": (-1, 0), "pan_right": (1, 0), "tilt_up": (0, -1), "tilt_down": (0, 1), "orbit_left": (-1, 0), "orbit_right": (1, 0)}[cam]
            a = (cx - dx * r * .5, H * .08 if dy == 0 else cy - dy * r * .5); b = (cx + dx * r * .5, H * .08 if dy == 0 else cy + dy * r * .5)
            d.line([a, b], fill=c, width=lw)
        if labels: d.text((W * .02, H * .02), CAM_TEXT.get(cam, cam), fill=c, font=f)
    return im


def where(x, y):
    h = "左" if x < .34 else "右" if x > .66 else "中"; v = "上" if y < .34 else "下" if y > .66 else "中"
    name = "画面正中" if h == v == "中" else f"画面{h}{v}" if h != "中" and v != "中" else f"画面{h}侧" if v == "中" else f"画面{v}方正中"
    return name + f"（横 {x * 100:.0f}%、竖 {y * 100:.0f}%）"


def timed_text(motion):
    out = []
    for s in motion.get("subjects", []):
        steps = [f"00:{p[2]:04.1f} {where(p[0], p[1])}" for p in s.get("points", [])]
        out.append(f"{s.get('label', '主体')}的运动路线：" + " → ".join(steps) + "，沿这条路线平稳移动")
    cam = (motion.get("camera") or {}).get("move", "static")
    out.append(CAM_TEXT.get(cam, "镜头固定不动"))
    return "；".join(out)


def propose(img_path, sid, key):
    """让 Gemini 看首帧，标一条清楚、合理、看得出来的运动轨迹。"""
    text = f"""这是一段 6 秒视频的首帧（镜头 {sid}，1998 年东北冬夜的出租车剧情）。我们要测试视频模型能不能按指定轨迹运动，请设计一个清楚、幅度明显、在这个画面里合理的动作：
- 选画面里一个主体（人的手、头、身体，或一个物体），给出它 6 秒里的运动路线：2～4 个点，每个点是 [x, y, 秒]，x、y 是画面比例位置（左上 0,0，右下 1,1），起点必须就在首帧里这个主体现在的位置上。
- 路线要明显（起点到终点至少移动画面宽度的 20%），但要合乎情理（手不能穿过人，人不能飞出车外）。
- 可以再给一个小的镜头运动（static/push_in/pull_out/pan_left/pan_right/tilt_up/tilt_down），amount 0～1。
- action：一句话写这个动作，不说具体位置（例如「女人伸手去摸车门把手」）。
只输出 JSON：{{"action": "...", "subjects": [{{"label": "...", "points": [[x, y, t], ...]}}], "camera": {{"move": "...", "amount": 0.3}}}}"""
    body = {"contents": [{"parts": [{"inline_data": {"mime_type": gi.mime(img_path), "data": gi.b64(img_path)}}, {"text": text}]}],
            "generationConfig": {"responseMimeType": "application/json", "temperature": 0.3}}
    st, js = gi.http(f"{gi.G}/models/{QC_MODEL}:generateContent", body, {"x-goog-api-key": key}, timeout=180)
    r = gi.json_reply(js) if st == 200 else None
    if isinstance(r, list) and r: r = r[0]
    return r if isinstance(r, dict) and r.get("subjects") else None


def last_frame(img_path, motion, out, key):
    """D 用：让 Gemini 出图模型画一张「主体已经到了终点」的尾帧。"""
    import fix_box as FB
    s = motion["subjects"][0]; e = s["points"][-1]
    ins = (f"同一个画面、同一个机位，6 秒之后的样子：{motion.get('action', '')}。{s.get('label', '主体')}已经移动到{where(e[0], e[1])}。"
           "其他所有东西（人物长相、服装、背景、光线、构图）保持不变，不要加任何箭头、线条或文字。")
    im = Image.open(img_path).convert("RGB")
    b = BytesIO(); im.save(b, "PNG")
    body = {"contents": [{"parts": [{"inline_data": {"mime_type": "image/png", "data": base64.b64encode(b.getvalue()).decode()}}, {"text": ins}]}],
            "generationConfig": {"responseModalities": ["IMAGE"], "imageConfig": {"aspectRatio": "16:9"}}}
    res, err = FB.call_gemini(body, key)
    if err or res is None: return None, err or "没返回图"
    res.convert("RGB").resize(im.size, Image.LANCZOS).save(out); return out, ""


def cam_trajectory(cam):
    """把镜头运动换成 H3 Max 的 camera_trajectory 关键帧（azimuth 方位角、elevation 俯仰角、distance 距离、time 秒）。"""
    move, a = cam.get("move", "static"), float(cam.get("amount", .3) or .3)
    end = {"push_in": (0, 0, 1 - .4 * a), "pull_out": (0, 0, 1 + .6 * a), "orbit_left": (-40 * a, 0, 1), "orbit_right": (40 * a, 0, 1),
           "pan_left": (-15 * a, 0, 1), "pan_right": (15 * a, 0, 1), "tilt_up": (0, 15 * a, 1), "tilt_down": (0, -15 * a, 1)}.get(move, (0, 0, 1))
    return [{"azimuth": 0, "elevation": 0, "distance": 1, "time": 0}, {"azimuth": end[0], "elevation": end[1], "distance": end[2], "time": 6}]


def h3_with_extra(img, prompt, out, extra):
    """E 用：和 autofix 的 H3 帧模式一样，只是请求里多带几个字段。返回 (是否扣费, 错误)。"""
    body = {"model": "MiniMax-H3", "content": [{"type": "text", "text": prompt + AF.SUF}, {"type": "image_url", "image_url": {"url": AF.data_url(img)}, "role": "first_frame"}],
            "duration": 6, "resolution": "768P", **extra}
    st, js = AF.call("POST", "/v2/video_generation", body)
    tid = AF._find(js, ("task_id", "id"))
    if not tid: return False, f"官方接口没接受（{st}）：" + json.dumps(js, ensure_ascii=False)[:300]
    print("  H3 已提交（带 camera_trajectory）——接口接受了这个参数，但不一定真的生效，看结果", flush=True)
    for i in range(120):
        time.sleep(10)
        _, j2 = AF.call("GET", f"/v2/query/video_generation/{tid}"); s = str(AF._find(j2, ("status",)) or "").lower()
        if s in ("success", "succeeded", "completed", "done"):
            url = AF._find(j2.get("content") or j2, ("url", "video_url", "download_url"))
            if not url and AF._find(j2, ("file_id",)):
                _, j3 = AF.call("GET", f"/v1/files/retrieve?file_id={AF._find(j2, ('file_id',))}"); url = (j3.get("file") or {}).get("download_url")
            if not url: return True, "成功但找不到下载地址"
            import urllib.request; urllib.request.urlretrieve(url, out); return True, ""
        if s in ("fail", "failed", "error", "cancelled"): return True, "生成失败 " + json.dumps(j2, ensure_ascii=False)[:200]
    return True, "超时"


def ref_video(sid, kinds=("svg", "manim", "remotion")):
    """F 用：motion_ref 生成的参考视频（优先 SVG 版，其次 Manim、Remotion）；G 用 3D 预演（three）。"""
    for k in kinds:
        p = os.path.join(ROOT, "motion_ref", "out", f"{sid}_{k}.mp4")
        if os.path.exists(p): return p
    return None


def h3_ref_video(img, prompt, out, video):
    """F 用：把参考视频交给 H3。官方文档里参考视频的写法我们没法直接查到，这里按顺序试几种写法，
    第一个被接口接受的就用它（没被接受的不扣费），每次的返回都打印出来。"""
    vurl = "data:video/mp4;base64," + base64.b64encode(open(video, "rb").read()).decode()
    text = {"type": "text", "text": prompt + AF.SUF}
    first = {"type": "image_url", "image_url": {"url": AF.data_url(img)}, "role": "first_frame"}
    refimg = {"type": "image_url", "image_url": {"url": AF.data_url(img)}, "role": "reference_image"}
    vid = {"type": "video_url", "video_url": {"url": vurl}, "role": "reference_video"}
    # 2026-11-02 实测：官方接口说参考模式不能和首帧混用，接受的是「参考图 + 参考视频」，所以先试它
    tries = [("MiniMax-H3", [text, refimg, vid], "参考图 + 参考视频"), ("MiniMax-H3", [text, first, vid], "首帧 + 参考视频"),
             ("MiniMax-H3-Max", [text, first, vid], "H3-Max：首帧 + 参考视频"), ("MiniMax-H3-Max", [text, refimg, vid], "H3-Max：参考图 + 参考视频")]
    tid = None
    for model, content, how in tries:
        st, js = AF.call("POST", "/v2/video_generation", {"model": model, "content": content, "duration": 6, "resolution": "768P"})
        tid = AF._find(js, ("task_id", "id"))
        if tid: print(f"  接口接受了：{how}（{model}）", flush=True); break
        print(f"  不接受「{how}」（{st}）：" + json.dumps(js, ensure_ascii=False)[:240], flush=True)
    if not tid: return False, "几种参考视频的写法官方接口都不接受（没有扣费），看上面每次的返回"
    for i in range(120):
        time.sleep(10)
        _, j2 = AF.call("GET", f"/v2/query/video_generation/{tid}"); s = str(AF._find(j2, ("status",)) or "").lower()
        if s in ("success", "succeeded", "completed", "done"):
            url = AF._find(j2.get("content") or j2, ("url", "video_url", "download_url"))
            if not url and AF._find(j2, ("file_id",)):
                _, j3 = AF.call("GET", f"/v1/files/retrieve?file_id={AF._find(j2, ('file_id',))}"); url = (j3.get("file") or {}).get("download_url")
            if not url or str(url).startswith("data:"): return True, "成功但找不到下载地址：" + json.dumps(j2, ensure_ascii=False)[:200]
            import urllib.request; urllib.request.urlretrieve(url, out); return True, ""
        if s in ("fail", "failed", "error", "cancelled"): return True, "生成失败 " + json.dumps(j2, ensure_ascii=False)[:200]
    return True, "超时"


def sheet_with_plan(video, out, motion, n=8):
    """抽 8 帧拼成一张，每格上用半透明画出计划的轨迹，方便看它有没有照着走。"""
    dur = AF.qc.duration(video) or 6
    AF.qc.sheet(video, out, dur, n)
    sh = Image.open(out).convert("RGB"); W, H = sh.size; tw, th = W // 4, H // ((n + 3) // 4)
    over = Image.new("RGB", (tw, th)); plan = draw_plan(over, motion, labels=False)
    mask = plan.convert("L").point(lambda v: 160 if v > 0 else 0)
    for i in range(n): sh.paste(plan, ((i % 4) * tw, (i // 4) * th), mask)
    sh.save(out, quality=85); return out


def judge(sheet, plan_png, motion, label, key):
    text = f"""图1是计划：首帧上画了想要的运动轨迹（{timed_text(motion)}）。图2是生成的视频按时间抽的 8 帧（左上到右下，每格左上角是秒数，半透明的线是计划轨迹，只是对照用，不是视频内容）。
请判断视频有没有按计划动：主体有没有沿着这条路线、在差不多的时间到达各个点；镜头运动对不对。这一条的给法是：{label}。
只输出 JSON：{{"follow": 0-10, "camera_ok": true/false, "actual": "一两句话描述视频里实际发生的运动", "artifacts": "画面问题（变形、闪烁、箭头残留、多出来的人等），没有写空字符串"}}"""
    parts = [{"inline_data": {"mime_type": "image/png", "data": gi.b64(plan_png)}}, {"inline_data": {"mime_type": "image/jpeg", "data": gi.b64(sheet)}}, {"text": text}]
    st, js = gi.http(f"{gi.G}/models/{QC_MODEL}:generateContent", {"contents": [{"parts": parts}], "generationConfig": {"responseMimeType": "application/json", "temperature": 0.1}},
                     {"x-goog-api-key": key}, timeout=180)
    r = gi.json_reply(js) if st == 200 else None
    if isinstance(r, list) and r: r = r[0]
    return r if isinstance(r, dict) else {"follow": None, "actual": f"打分失败 HTTP {st}"}


class Tee:                                       # 屏幕上的输出同时写进日志文件，窗口关了也能看
    def __init__(self, *s): self.s = s
    def write(self, t):
        for x in self.s:
            try: x.write(t); x.flush()
            except Exception: pass
    def flush(self):
        for x in self.s:
            try: x.flush()
            except Exception: pass


def safe_save(make, path, src):
    """画好的图存盘。已经有、而且比轨迹文件新，就直接用（不重画）；存不进去（Windows 上文件正被看图软件打开，
    或者桌面在 OneDrive 同步中，会报 Errno 22）就换个文件名存。"""
    if os.path.exists(path) and os.path.getmtime(path) >= os.path.getmtime(src): return path
    im = make()
    try: im.save(path); return path
    except OSError as e:
        alt = path.replace(".png", time.strftime("_%H%M%S.png")); im.save(alt)
        print(f"  （{os.path.basename(path)} 存不进去：{e}；先关掉打开它的看图窗口。这次存成 {os.path.basename(alt)}）", flush=True); return alt


def main(argv):
    if not argv or argv[0].startswith("--"): argv = ["ask"] + list(argv)   # 双击不带参数：默认测 ask
    sid = argv[0]
    os.makedirs(os.path.join(HERE, "test_motion", sid), exist_ok=True)
    sys.stdout = Tee(sys.__stdout__, open(os.path.join(HERE, "test_motion", sid, "log.txt"), "a", encoding="utf-8"))
    print(f"\n===== {time.strftime('%Y-%m-%d %H:%M:%S')} 轨迹控制测试：{sid} =====", flush=True)
    opt = lambda k: argv[argv.index(k) + 1] if k in argv and argv.index(k) + 1 < len(argv) else None
    variants = [v.strip().upper() for v in (opt("--variants") or "A,B,C").split(",") if v.strip()]
    gkey = os.environ.get("GEMINI_API_KEY", "").strip()
    if not gkey: print("ERROR:没有找到 GEMINI_API_KEY"); return 1
    dry = "--dry" in argv
    if not dry and not AF.KEY: print("ERROR:没有找到 MINIMAX_API_KEY"); return 1
    vs = {}
    try: vs = {s["id"]: s for s in json.load(open(os.path.join(HERE, "video_shots.json"), encoding="utf-8"))["shots"]}
    except Exception: pass
    kf = os.path.join(AF.GAME, (vs.get(sid) or {}).get("keyframe") or f"img/{sid}.jpg")
    if not os.path.exists(kf): kf = os.path.join(AF.GAME, "img", "l", sid + ".jpg")
    if not os.path.exists(kf): print("ERROR:找不到首帧图（img/<镜头>.jpg 或 img/l/<镜头>.jpg）"); return 1
    od = os.path.join(HERE, "test_motion", sid); os.makedirs(od, exist_ok=True)
    mp = opt("--motion") or os.path.join(od, "motion.json")
    if os.path.exists(mp) and (opt("--motion") or "--new" not in argv):
        motion = json.load(open(mp, encoding="utf-8")); print(f"用已有的轨迹：{mp}（要让 AI 重新标加 --new）", flush=True)
    else:
        print("让 Gemini 看首帧标一条运动轨迹…", flush=True)
        motion = propose(kf, sid, gkey)
        if not motion: print("ERROR:Gemini 没给出轨迹"); return 1
        json.dump(motion, open(mp, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print("轨迹：" + json.dumps(motion, ensure_ascii=False), flush=True)
    plan_png = safe_save(lambda: draw_plan(Image.open(kf), motion), os.path.join(od, "plan.png"), mp)
    arrow_png = safe_save(lambda: draw_plan(Image.open(kf), motion, labels=False), os.path.join(od, "first_frame_arrows.png"), mp)
    base = motion.get("action") or "画面里的人自然地动一下"
    prompts = {"A": base + "。" + CAM_TEXT.get((motion.get("camera") or {}).get("move", "static"), ""),
               "B": base + "。" + timed_text(motion),
               "C": base + "。画面上的彩色箭头标出了运动方向和路线：主体从箭头起点的圆点出发，沿箭头路线移动到箭头尖端。箭头和线条只是示意，第一帧之后画面里不要出现任何箭头、线条或文字",
               "D": base + "。" + timed_text(motion) + "。从首帧自然过渡到尾帧",
               "E": base + "。" + CAM_TEXT.get((motion.get("camera") or {}).get("move", "static"), ""),
               "F": base + "。参考视频只提供运动：参考视频里带名字的彩色圆点代表" + "、".join(s.get("label", "主体") for s in motion.get("subjects", [])) +
                    "，请让它沿参考视频里圆点的路线、按同样的快慢移动；镜头运动也照参考视频。画面里不要出现圆点、线条、文字；人物长相、服装、场景、光线和画风都以首帧为准",
               "G": base + "。参考视频是动作预演：里面灰白色的简化人体模型代表首帧里的人，请让首帧里的人照模型的手臂和身体动作、按同样的快慢去做；镜头运动也照参考视频。"
                    "画面里不要出现人体模型、圆柱、圆球或任何三维示意物体；人物长相、服装、场景、光线和画风都以首帧为准"}
    names = {"A": "A 基线：只写动作", "B": "B 时间点+位置写成文字", "C": "C 箭头画在首帧上", "D": "D 首尾帧（AI 出尾帧）", "E": "E camera_trajectory 参数", "F": "F 参考视频（motion_ref 生成的）", "G": "G 3D 预演当参考视频（three.js）"}
    for v in variants: print(f"  {names.get(v, v)}：{prompts.get(v, '')}", flush=True)
    est = len([v for v in variants if v in prompts]) * AF.COST
    print(f"计划生成 {len(variants)} 条视频，约 ¥{est:.0f}" + ("（--dry：只出轨迹图和提示词，不生成）" if dry else ""), flush=True)
    print("RESULT:" + os.path.relpath(plan_png, ROOT).replace("\\", "/"), flush=True)
    print(f"轨迹图：{plan_png}", flush=True)
    try: os.startfile(plan_png)                     # Windows：直接打开轨迹图给人看
    except Exception: pass
    if dry: return 0
    if "--yes" not in argv:
        try: ok = input(f"看一下打开的轨迹图。确认生成这 {len(variants)} 条视频（约 ¥{est:.0f}）？输入 y 回车开始，直接回车取消：").strip().lower() == "y"
        except EOFError: ok = False
        if not ok: print(f"取消了。要改轨迹：编辑 {mp} 里的坐标后再双击；要 AI 重新标：test_motion.bat ask --new"); return 0
    rp_json = os.path.join(od, "results.json")
    try: rows = [r for r in json.load(open(rp_json, encoding="utf-8")) if r.get("v") not in variants]   # 以前跑过的其他给法保留在报告里
    except Exception: rows = []
    for v in variants:
        if v not in prompts: print(f"不认识的给法 {v}，跳过"); continue
        out = os.path.join(od, f"{v}.mp4"); print(f"\n== {names[v]} ==", flush=True); err = ""; charged = False; lastf = None
        if v == "A" or v == "B": charged, err = AF.gen_video_h3(kf, prompts[v], out)
        elif v == "C": charged, err = AF.gen_video_h3(arrow_png, prompts[v], out)
        elif v == "D":
            lastf, err = last_frame(kf, motion, os.path.join(od, "D_last.png"), gkey)
            if lastf: charged, err = AF.gen_video_h3(kf, prompts[v], out, last=lastf)
        elif v == "E": charged, err = h3_with_extra(kf, prompts[v], out, {"camera_trajectory": cam_trajectory(motion.get("camera") or {})})
        elif v == "F":
            rv = ref_video(sid)
            if not rv: err = "还没有参考视频：先双击 motion_ref\\ref_svg.bat 生成"
            else: print(f"  参考视频：{rv}", flush=True); charged, err = h3_ref_video(kf, prompts[v], out, rv)
        elif v == "G":
            rv = ref_video(sid, ("three",))
            if not rv: err = "还没有 3D 预演：先双击 motion_ref\\ref_three.bat 生成"
            else: print(f"  参考视频：{rv}", flush=True); charged, err = h3_ref_video(kf, prompts[v], out, rv)
        row = {"v": v, "name": names[v], "prompt": prompts[v], "err": err, "charged": charged, "last": lastf}
        if not err and os.path.exists(out):
            sh = sheet_with_plan(out, os.path.join(od, f"{v}_sheet.jpg"), motion); row["sheet"] = sh
            row["judge"] = judge(sh, plan_png, motion, names[v], gkey); print("  打分：" + json.dumps(row["judge"], ensure_ascii=False), flush=True)
        else: print("  × " + err, flush=True)
        rows.append(row); rows.sort(key=lambda r: r["v"])
        json.dump(rows, open(os.path.join(od, "results.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    rel = lambda p: os.path.relpath(p, od).replace("\\", "/")
    cards = "".join(f"""<section><h2>{html.escape(r['name'])}</h2><p class=p>{html.escape(r['prompt'])}</p>
      {f'<p class=err>× {html.escape(r["err"])}</p>' if r['err'] else ''}{f'<img src="{rel(r["last"])}" class=half title="尾帧">' if r.get('last') else ''}
      {f'<video src="{r["v"]}.mp4" controls muted loop class=half></video><img src="{rel(r["sheet"])}">' if r.get('sheet') else ''}
      {f'<p><b>跟随轨迹 {r["judge"].get("follow")}/10</b>　镜头{"对" if r["judge"].get("camera_ok") else "不对"}<br>实际：{html.escape(str(r["judge"].get("actual", "")))}<br>{html.escape(str(r["judge"].get("artifacts", "")))}</p>' if r.get('judge') else ''}</section>""" for r in rows)
    page = f"""<!doctype html><meta charset=utf-8><title>轨迹控制测试 {sid}</title><style>body{{background:#16171b;color:#e8e4dc;font:14px/1.6 "Microsoft YaHei",sans-serif;max-width:1300px;margin:20px auto;padding:0 16px}}
img,video{{max-width:100%;border-radius:6px;margin:6px 0}}.half{{width:49%}}section{{border-top:1px solid #333;padding:10px 0}}.p{{color:#aaa}}.err{{color:#ff6b6b}}</style>
<h1>轨迹控制测试：{sid}</h1><p>计划的轨迹（{html.escape(timed_text(motion))}）：</p><img src="plan.png" class=half><img src="first_frame_arrows.png" class=half title="C 用的首帧">
{f'<p>F 用的参考视频：</p><video src="{os.path.relpath(ref_video(sid), od).replace(chr(92), "/")}" controls muted loop class=half></video>' if ref_video(sid) else ''}{f'<p>G 用的 3D 预演：</p><video src="{os.path.relpath(ref_video(sid, ("three",)), od).replace(chr(92), "/")}" controls muted loop class=half></video>' if ref_video(sid, ("three",)) else ''}{cards}"""
    rp = os.path.join(od, "report.html"); open(rp, "w", encoding="utf-8").write(page)
    print(f"\n完成。报告：{rp}", flush=True); print("RESULT:" + os.path.relpath(rp, ROOT).replace("\\", "/"), flush=True)
    try: os.startfile(rp)
    except Exception: pass
    return 0


if __name__ == "__main__":
    try: rc = main(sys.argv[1:])
    except Exception:
        import traceback; traceback.print_exc(); rc = 1
        print("\n出错了，上面是详细信息（也写在 test_motion\\<镜头>\\log.txt）。把它发给 Claude 看看。", flush=True)
    sys.exit(rc)
