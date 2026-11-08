"""草稿视频：花钱生成正式视频之前，先出便宜 / 免费的草稿，放进游戏里把整个剧情过一遍。

三档：
  code（默认，免费，每条几秒）：首帧图 + 代码做镜头运动（按提示词里的推近 / 拉远 / 摇）+ 顶部动作提示条（提示词按句拆成几个动作，按时间依次亮起）
        + 有尾帧就在后半段淡入尾帧 + 有动作轨迹（test_motion/<镜头>/motion.json，手绘动作或轨迹测试标的）就画出彩色圆点和路线
        + 台词页带这句的配音。时长和正式视频一样（video_shots.json 的 duration）。
  --end（Gemini 画尾帧，约 $0.14 一张）：按提示词画「这段视频最后一刻」的画面，存 autofix/draft/end/<镜头>.png；
        之后的 code 草稿会淡入它；觉得对，可以在剪辑台里「用作正式尾帧」，正式生成就走首尾帧模式，终点锁得更准。
  --local（本地开源视频模型 LTX-Video，不花 API 钱，要 NVIDIA 显卡）：首帧 + 提示词（自动翻成英文）出一段会动的草稿，约 736×416。
        第一次要装 install_local_video.bat，并下载模型（约 20GB）。--gpu 只检查这台电脑能不能跑。

输出：moban_game/vid_draft/<和正式视频一样的相对路径>（比如 vid_draft/l/ride_00.mp4）——游戏的草稿模式（?draft=1，剪辑台预览选「草稿」）播这里的；
      每一档另存一份 autofix/draft/<镜头>_code.mp4 / _ltx.mp4，记录在 autofix/draft/drafts.json。
  --b25d（2.5D 预演，免费，要装 Blender）：首帧估深度变成立体场景，人 / 车抠成卡片在地上走，镜头、光照、颜色、雪按参数（motion_ref/scenes/<镜头>.json），
        有手绘动作就加灰模手臂；Blender 渲染。见 motion_ref/scene25d.py。
用法：python draft_video.py [镜头…|--all] [--end] [--local] [--b25d] [--gpu]
      --all：视频分镜表里全部（「不做视频」的、游戏里用不上的场景视频除外）
"""
import os, sys, json, re, math, time, shutil, subprocess, hashlib

HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE); GAME = os.path.join(ROOT, "moban_game")
DRAFT = os.path.join(HERE, "draft"); REC = os.path.join(DRAFT, "drafts.json")
sys.path.insert(0, os.path.join(ROOT, "storyboard")); sys.path.insert(0, HERE); sys.path.insert(0, os.path.join(ROOT, "motion_ref"))
from PIL import Image, ImageDraw, ImageFont, ImageFilter

W, H, FPS = 960, 540, 15
COLORS = [(255, 70, 70), (60, 200, 255), (120, 255, 120), (255, 210, 60)]
MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.8-flash")


def font(sz):
    for n in ("msyhbd.ttc", "msyh.ttc", "simhei.ttf", "NotoSansCJK-Bold.ttc", "NotoSansCJK-Regular.ttc", "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc", "wqy-microhei.ttc", "DejaVuSans.ttf"):
        try: return ImageFont.truetype(n, sz)
        except Exception: pass
    return ImageFont.load_default()


def ffmpeg():
    p = shutil.which("ffmpeg")
    if p: return p
    import imageio_ffmpeg; return imageio_ffmpeg.get_ffmpeg_exe()


def load_rec():
    try: return json.load(open(REC, encoding="utf-8"))
    except Exception: return {}


def save_rec(rec):
    os.makedirs(DRAFT, exist_ok=True); tmp = REC + ".tmp"
    json.dump(rec, open(tmp, "w", encoding="utf-8"), ensure_ascii=False, indent=1); os.replace(tmp, REC)


# ---------------- 从提示词里读出镜头运动和动作 ----------------
def camera_of(prompt):
    p = prompt or ""
    for pat, mv in ((r"拉远|后拉|向后拉|镜头后退", "pull_out"), (r"推近|推进|拉近|缓推|慢推|靠近", "push_in"), (r"向?左摇|左移|向左平移", "pan_left"),
                    (r"向?右摇|右移|向右平移", "pan_right"), (r"上摇|向上摇|抬起镜头", "tilt_up"), (r"下摇|向下摇", "tilt_down")):
        if re.search(pat, p): return mv
    return "breath"          # 没写运镜：极慢的推近，画面不至于死板


def cam_at(move, f):
    """f：0～1 的进度（已做缓入缓出）。返回 (缩放, x 平移比例, y 平移比例)。"""
    if move == "push_in": return 1 + .12 * f, 0, 0
    if move == "pull_out": return 1.12 - .12 * f, 0, 0
    if move == "pan_left": return 1.1, .04 * f, 0
    if move == "pan_right": return 1.1, -.04 * f, 0
    if move == "tilt_up": return 1.1, 0, .04 * f
    if move == "tilt_down": return 1.1, 0, -.04 * f
    return 1 + .035 * f, 0, 0


def beats(prompt, maxn=5):
    """提示词拆成几个动作：去掉纯环境描写（没有动词的短句），按顺序最多 maxn 段。"""
    parts = [x.strip() for x in re.split(r"[。；;！!？?\n]|，(?=(?:然后|接着|随后|同时|最后|再|又|镜头))", prompt or "") if x.strip()]
    act = re.compile(r"(伸|拿|放|推|拉|走|转|抬|低|看|递|捂|敲|拧|打开|关|掉|滑|笑|说|喊|问|跑|站|坐|靠|摸|握|张嘴|开口|回头|扭头|点头|摇头|起身|弯腰|探|按|拍|指|抱|攥|松开|闪|晃|亮|熄|驶|开过|停|镜头)")
    a = [x for x in parts if act.search(x)] or parts
    if len(a) <= 2 and sum(map(len, a)) > 40:           # 一两句长句：再按逗号拆开
        a = [y.strip() for x in a for y in re.split(r"[，,]", x) if y.strip()]; a = [x for x in a if act.search(x)] or a
    if len(a) > maxn:                                   # 太多就两两合并
        k = math.ceil(len(a) / maxn); a = ["，".join(a[i:i + k]) for i in range(0, len(a), k)]
    return [x[:46] + ("…" if len(x) > 46 else "") for x in a]


def wrap(d, text, f, width):
    out, line = [], ""
    for ch in text:
        if d.textlength(line + ch, font=f) > width: out.append(line); line = ch
        else: line += ch
    return out + ([line] if line else [])


# ---------------- 第一档：代码草稿 ----------------
def kb_origin(s, dx, dy):                            # 输出画面 (x, y) 取原图 (x / s + x0, y / s + y0)
    return W / 2 * (1 - 1 / s) - dx * W / s, H / 2 * (1 - 1 / s) - dy * H / s


def kenburns(im, s, dx, dy):
    x0, y0 = kb_origin(s, dx, dy)
    return im.transform((W, H), Image.AFFINE, (1 / s, 0, x0, 0, 1 / s, y0), Image.BILINEAR)


def fit(path):
    im = Image.open(path).convert("RGB"); w, h = im.size; nh = int(w * 9 / 16)
    if abs(h - nh) > 2:
        if nh <= h: im = im.crop((0, (h - nh) // 2, w, (h - nh) // 2 + nh))
        else: nw = int(h * 16 / 9); im = im.crop(((w - nw) // 2, 0, (w - nw) // 2 + nw, h))
    return im.resize((W, H), Image.LANCZOS)


def end_frame_of(s):
    p = os.path.join(DRAFT, "end", s["id"] + ".png")
    if os.path.exists(p): return p, "AI 尾帧"
    if s.get("last") and os.path.exists(os.path.join(HERE, s["last"])): return os.path.join(HERE, s["last"]), "尾帧"
    return None, ""


def motion_of(sid):
    p = os.path.join(HERE, "test_motion", sid, "motion.json")
    try: m = json.load(open(p, encoding="utf-8")); return m if m.get("subjects") else None
    except Exception: return None


def code_draft(s, kf, dur, audio, out, line_info=None):
    import common as MC                                  # motion_ref/common.py：轨迹插值（和参考视频同一套算法）
    base = fit(kf); endp, endlab = end_frame_of(s); end = fit(endp) if endp else None
    move = camera_of(s.get("prompt")); bs = beats(s.get("prompt") or s.get("describe") or ""); mo = motion_of(s["id"])
    fB, fS, fT = font(22), font(17), font(15)
    n = max(1, int(round(dur * FPS)))
    cmd = [ffmpeg(), "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-"]
    if audio: cmd += ["-i", audio]
    cmd += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-pix_fmt", "yuv420p"]
    cmd += (["-c:a", "aac", "-b:a", "96k", "-af", f"apad=whole_dur={dur:.2f}", "-t", f"{dur:.2f}"] if audio else ["-t", f"{dur:.2f}"]) + [out]
    pp = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    trail = [[] for _ in (mo or {}).get("subjects", [])]
    for i in range(n):
        t = i / FPS; f = min(1, t / max(dur, .1)); e = f * f * (3 - 2 * f)
        sc, dx, dy = cam_at(move, e); fr = kenburns(base, sc, dx, dy)
        if end is not None:                                # 后半段淡入尾帧（50%～85%）
            a = min(1, max(0, (f - .5) / .35))
            if a > 0: fr = Image.blend(fr, kenburns(end, sc, dx, dy), a)
        d = ImageDraw.Draw(fr, "RGBA")
        if mo:                                             # 轨迹：按 6 秒画的，换算到这条的时长
            tm = t * 6.0 / dur
            for k, sb in enumerate(mo["subjects"]):
                if len(sb.get("points", [])) < 2: continue
                x, y = MC.at(sb["points"], tm); ox, oy = kb_origin(sc, dx, dy); x, y = (x * W - ox) * sc, (y * H - oy) * sc
                c = COLORS[k % 4]; trail[k].append((x, y))
                if len(trail[k]) > 1: d.line(trail[k], fill=c + (200,), width=4)
                d.ellipse([x - 9, y - 9, x + 9, y + 9], fill=c + (230,), outline=(255, 255, 255, 230), width=2)
                d.text((x + 12, y - 22), sb.get("label", ""), fill=c + (255,), font=fT, stroke_width=2, stroke_fill=(0, 0, 0, 200))
        if bs:                                             # 顶部动作提示条：当前这一步亮，下一步淡
            k = min(len(bs) - 1, int(f * len(bs)))
            d.rectangle([0, 0, W, 64], fill=(0, 0, 0, 150))
            lines = wrap(d, f"{'①②③④⑤⑥'[k]} {bs[k]}", fB, W - 40)[:2]
            for j, ln in enumerate(lines): d.text((20, 8 + j * 27), ln, fill=(255, 236, 170, 255), font=fB)
            seg = (W - 40) / len(bs)
            for j in range(len(bs)): d.rectangle([20 + j * seg + 2, 58, 20 + (j + 1) * seg - 2, 61], fill=(255, 210, 60, 230) if j <= k else (255, 255, 255, 70))
        if line_info and line_info.get("mouth") and t <= line_info["t1"]:
            d.text((20, 74), f"● {line_info['who']} 在说话（嘴要动）", fill=(140, 230, 255, 255), font=fS, stroke_width=2, stroke_fill=(0, 0, 0, 200))
        tag = f"草稿 · {s['id']} · {t:4.1f}/{dur:g}s" + (f" · 淡入{endlab}" if end is not None and f > .5 else "")
        tw = d.textlength(tag, font=fT); d.rectangle([W - tw - 22, H - 30, W - 6, H - 8], fill=(0, 0, 0, 140)); d.text((W - tw - 14, H - 28), tag, fill=(255, 255, 255, 220), font=fT)
        pp.stdin.write(fr.tobytes())
    pp.stdin.close(); pp.wait()
    if pp.returncode: raise RuntimeError("ffmpeg 合成失败")
    return {"camera": move, "beats": bs, "end": endlab, "motion": bool(mo)}


# ---------------- 第二档：Gemini 画尾帧 ----------------
def ai_end_frame(s, kf, dur, key):
    import fix_box as FB, gen_images as gi
    from io import BytesIO
    import base64
    ins = (f"图里是一段 {dur:g} 秒视频的第一帧。请画出同一个画面、同一个机位，这段视频最后一刻的样子。视频里发生的事：{s.get('prompt') or s.get('describe')}\n"
           "要求：只画动作做完之后的变化（人的姿势、手的位置、物体的位置、表情）；人物长相、服装、背景、光线、构图、机位都和第一帧一样，不要换角度、不要重新构图；"
           "镜头如果有推近，画面可以稍微近一点。不要加任何箭头、线条、边框或文字。")
    im = Image.open(kf).convert("RGB"); b = BytesIO(); im.save(b, "PNG")
    body = {"contents": [{"parts": [{"inline_data": {"mime_type": "image/png", "data": base64.b64encode(b.getvalue()).decode()}}, {"text": ins}]}],
            "generationConfig": {"responseModalities": ["IMAGE"], "imageConfig": {"aspectRatio": "16:9"}}}
    res, err = FB.call_gemini(body, key)
    if err or res is None: return None, err or "没返回图"
    od = os.path.join(DRAFT, "end"); os.makedirs(od, exist_ok=True); p = os.path.join(od, s["id"] + ".png")
    if os.path.exists(p): os.makedirs(os.path.join(od, "_old"), exist_ok=True); shutil.copy2(p, os.path.join(od, "_old", f"{s['id']}_{time.strftime('%m%d_%H%M%S')}.png"))
    res.convert("RGB").resize(im.size, Image.LANCZOS).save(p)
    try: gi.add_spent(os.path.join(ROOT, "storyboard", "out", "batch", "state.json"), .14)
    except Exception: pass
    return p, ""


# ---------------- 第三档：本地 LTX-Video ----------------
PIPE = None


def gpu_report():
    try: import torch
    except ImportError: return False, "没装 PyTorch。先双击 autofix\\install_local_video.bat 安装（装 CUDA 版 PyTorch、diffusers 等，约 3GB）。"
    if not torch.cuda.is_available(): return False, f"PyTorch {torch.__version__} 已装，但没检测到能用的 NVIDIA 显卡（CUDA）。本地视频模型需要 NVIDIA 显卡；没有的话只能用代码草稿 + AI 尾帧。"
    p = torch.cuda.get_device_properties(0); g = p.total_memory / 2 ** 30
    try: import diffusers; dv = diffusers.__version__
    except ImportError: dv = None
    tip = "显存够，可以直接跑" if g >= 20 else "显存偏小，会把模型分批放进显卡（慢一些，内存最好 32GB 以上）" if g >= 8 else "显存太小（不到 8GB），大概率跑不动"
    return g >= 8 and bool(dv), f"显卡：{p.name}，显存 {g:.1f} GB；PyTorch {torch.__version__}；diffusers {dv or '没装（运行 install_local_video.bat）'}。{tip}"


def to_english(s, key):
    """LTX 的文字编码器只懂英文：用 Gemini 把提示词翻成英文的画面描述（缓存，提示词不变不再花钱）。"""
    zh = s.get("prompt") or s.get("describe") or ""; h = hashlib.md5(zh.encode("utf-8")).hexdigest()[:12]
    cp = os.path.join(DRAFT, "prompts_en.json")
    try: cache = json.load(open(cp, encoding="utf-8"))
    except Exception: cache = {}
    if cache.get(s["id"], {}).get("h") == h: return cache[s["id"]]["en"]
    if not key: return zh
    import gen_images as gi
    body = {"contents": [{"parts": [{"text": "Translate this Chinese image-to-video prompt into one fluent English paragraph for the LTX-Video model: describe the motion in order, the camera movement, and who speaks (mouth moving). No style words. Output JSON {\"en\": \"...\"}.\n\n" + zh}]}],
            "generationConfig": {"responseMimeType": "application/json", "temperature": 0.2}}
    st, js = gi.http(f"{gi.G}/models/{MODEL}:generateContent", body, {"x-goog-api-key": key}, timeout=120)
    r = gi.json_reply(js) if st == 200 else None; en = (r or {}).get("en") if isinstance(r, dict) else None
    if not en: return zh
    cache[s["id"]] = {"h": h, "en": en}; os.makedirs(DRAFT, exist_ok=True); json.dump(cache, open(cp, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    return en


def local_draft(s, kf, dur, audio, out, key):
    global PIPE
    ok, rep = gpu_report()
    if not ok: return rep
    import torch
    from diffusers import LTXImageToVideoPipeline
    from diffusers.utils import export_to_video
    if PIPE is None:
        model = os.environ.get("LTX_MODEL", "Lightricks/LTX-Video")
        print(f"  载入本地模型 {model}（第一次会下载，约 20GB；下载慢可以先设 HF_ENDPOINT=https://hf-mirror.com）…", flush=True)
        PIPE = LTXImageToVideoPipeline.from_pretrained(model, torch_dtype=torch.bfloat16)
        if torch.cuda.get_device_properties(0).total_memory / 2 ** 30 < 20: PIPE.enable_model_cpu_offload()
        else: PIPE.to("cuda")
        try: PIPE.vae.enable_tiling()
        except Exception: pass
    en = to_english(s, key); print("  英文提示词：" + en[:160], flush=True)
    fps = 24; nf = min(161, max(25, int(dur * fps) // 8 * 8 + 1))
    img = fit(kf).resize((736, 416), Image.LANCZOS)
    t0 = time.time()
    frames = PIPE(image=img, prompt=en, negative_prompt="worst quality, inconsistent motion, blurry, jittery, distorted, deformed hands, text, watermark",
                  width=736, height=416, num_frames=nf, num_inference_steps=int(os.environ.get("LTX_STEPS", "30")), guidance_scale=3.0,
                  generator=torch.Generator("cpu").manual_seed(int(os.environ.get("LTX_SEED", "42")))).frames[0]
    raw = out[:-4] + "_raw.mp4"; export_to_video(frames, raw, fps=fps)
    cmd = [ffmpeg(), "-y", "-v", "error", "-i", raw] + (["-i", audio, "-c:a", "aac", "-b:a", "96k", "-shortest"] if audio else []) + ["-c:v", "libx264", "-preset", "veryfast", "-crf", "24", "-pix_fmt", "yuv420p", out]
    subprocess.run(cmd, check=True)
    try: os.remove(raw)
    except Exception: pass
    print(f"  本地模型用时 {time.time() - t0:.0f} 秒", flush=True)
    return ""


# ---------------- 主流程 ----------------
def targets(ids, d, N, vot, limg):
    import durations as DU
    out = []
    for s in d["shots"]:
        if ids and s["id"] not in ids: continue
        if s.get("novideo") and not ids: continue
        sec, why = DU.need(s, N, vot, limg)
        if sec is None and not ids: continue              # 游戏里用不上的场景视频
        out.append(s)
    return out


def main(argv):
    if "--gpu" in argv:
        ok, rep = gpu_report(); print(rep, flush=True); print("RESULT:" + ("可以跑本地模型" if ok else "不能跑本地模型"), flush=True); return 0
    ids = [a for a in argv if not a.startswith("--")]
    if not ids and "--all" not in argv: print(__doc__); return 2
    if "--b25d" in argv:                                  # 2.5D 预演（motion_ref/scene25d.py + Blender）：参数在 motion_ref/scenes/<镜头>.json
        import scene25d as S25; bad = 0
        for sid in ids:
            try: S25.render(sid, to_draft=True)
            except SystemExit as e: print(f"ERROR:{sid}：{e}", flush=True); bad += 1
            except Exception as e:
                import traceback; traceback.print_exc(); print(f"ERROR:{sid}：{e}", flush=True); bad += 1
        print("RESULT:vid_draft", flush=True); return 1 if bad == len(ids) else 0
    import video_shots as VS, write_vprompts as W_, durations as DU
    d, _ = VS.load(); N = W_.load_script(); vot = DU.vo_map(); limg = DU.limg_set()
    todo = targets(ids, d, N, vot, limg)
    if not todo: print("ERROR:视频分镜表里没有这些镜头：" + " ".join(ids)); return 1
    key = os.environ.get("GEMINI_API_KEY", "").strip(); want_end, want_local = "--end" in argv, "--local" in argv
    if want_end and not key: print("ERROR:画尾帧要 GEMINI_API_KEY"); return 1
    if want_local:
        ok, rep = gpu_report(); print(rep, flush=True)
        if not ok: print("ERROR:这台电脑现在跑不了本地模型（见上一行）；代码草稿不受影响，去掉「本地模型」再试"); return 1
    print(f"出草稿：{len(todo)} 条" + ("，先让 AI 画尾帧（每张约 $0.14）" if want_end else "") + ("，用本地模型" if want_local else "，代码草稿（免费）"), flush=True)
    rec = load_rec(); os.makedirs(DRAFT, exist_ok=True); bad = 0
    for k, s in enumerate(todo, 1):
        sid = s["id"]; kf = os.path.join(GAME, *(s.get("keyframe") or f"img/{sid}.jpg").split("/"))
        if s.get("key") and os.path.exists(os.path.join(HERE, s["key"])): kf = os.path.join(HERE, s["key"])
        if not os.path.exists(kf): print(f"[{k}/{len(todo)}] {sid}：首帧图不存在，跳过", flush=True); bad += 1; continue
        dur = float(s.get("duration") or 6); audio, info = None, None
        if s.get("kind") == "line":                       # 台词页：带这句配音，时长按配音
            nid, i, l = DU.find_line(sid, N, limg)
            if l:
                key_vo = vot.get(re.sub(r"（[^）]*）", "", str(l[1])).strip()); ap = os.path.join(GAME, "vo", f"{key_vo}.mp3") if key_vo else None
                audio = ap if ap and os.path.exists(ap) else None
                sp = DU.speech(s, N, vot, limg); info = {"who": str(l[0]), "t1": sp[0]["t1"] if sp else dur, "mouth": bool(s.get("need_mouth"))}
                sec, _ = DU.need(s, N, vot, limg); dur = max(2.0, float(sec or s.get("duration_need") or dur))   # 台词页停到配音放完
        r = rec.setdefault(sid, {})
        try:
            if want_end:
                print(f"[{k}/{len(todo)}] {sid}：AI 画尾帧…", flush=True)
                p, err = ai_end_frame(s, kf, dur, key)
                if err: print("  尾帧失败：" + err, flush=True)
                else: r["end"] = {"file": os.path.relpath(p, HERE).replace("\\", "/"), "at": time.strftime("%m-%d %H:%M")}; print("  尾帧：" + r["end"]["file"], flush=True)
            kind = "ltx" if want_local else "code"; out = os.path.join(DRAFT, f"{sid}_{kind}.mp4")
            if want_local:
                print(f"[{k}/{len(todo)}] {sid}：本地模型出草稿（{dur:g} 秒）…", flush=True)
                err = local_draft(s, kf, dur, audio, out, key)
                if err: print("  " + err, flush=True); bad += 1; continue
                meta = {}
            else:
                meta = code_draft(s, kf, dur, audio, out, info)
                print(f"[{k}/{len(todo)}] {sid}：代码草稿 {dur:g} 秒 · 镜头 {meta['camera']} · {len(meta['beats'])} 个动作" + (f" · 淡入{meta['end']}" if meta["end"] else "") + (" · 画了轨迹" if meta["motion"] else "") + (" · 带配音" if audio else ""), flush=True)
            rel = s.get("video") or f"vid/{sid}.mp4"; dst = os.path.join(GAME, "vid_draft", *rel.split("/")[1:])
            os.makedirs(os.path.dirname(dst), exist_ok=True); shutil.copy2(out, dst)
            r[kind] = {"file": os.path.relpath(out, HERE).replace("\\", "/"), "at": time.strftime("%m-%d %H:%M"), "dur": dur, "prompt": s.get("prompt", ""), **meta}
            r["current"] = kind; r["game"] = "vid_draft/" + "/".join(rel.split("/")[1:])
            save_rec(rec)
        except Exception as e:
            import traceback; traceback.print_exc(); print(f"  {sid} 出错：{e}", flush=True); bad += 1
    print(f"完成：{len(todo) - bad} 条成功" + (f"，{bad} 条没做成" if bad else "") + "。剪辑台预览选「草稿」就能在游戏里看。", flush=True)
    print("RESULT:vid_draft", flush=True)
    return 0 if not bad or bad < len(todo) else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
