"""把三种方式的结果放到一个网页里对比：out\\<镜头>_compare.html（自动打开）。"""
import os, json, html
import common as C

sid = C.sid_arg()
try: tm = json.load(open(os.path.join(C.OUT, f"{sid}_timing.json"), encoding="utf-8"))
except Exception: tm = {}
items = [("svg", "① SVG 加关键帧", "Python 算位置 → 浏览器（Edge）逐帧截图 → ffmpeg。另有会动的 SVG 文件可以直接在浏览器里看。只要 pip install playwright。"),
         ("manim", "② Manim", "Python 动画库，按时间驱动的场景。要 pip install manim。"),
         ("remotion", "③ Remotion", "React 写画面、按帧号渲染。要装 Node.js，第一次 npm install。个人和 3 人以内公司免费，更大的公司要授权。"),
         ("three", "④ three.js 3D 预演", "简化的 3D 人体模型，手按轨迹走（IK：肘、肩自己跟着转），镜头推拉摇。three.js 文件已带在 three\\ 里，只要 playwright。")]
cards = ""
for k, name, note in items:
    v = f"{sid}_{k}.mp4"; ok = os.path.exists(os.path.join(C.OUT, v))
    cards += f"<section><h2>{name}</h2><p class=n>{html.escape(note)}</p>" + (f'<video src="{v}" controls muted loop autoplay></video><p>渲染用时：{tm.get(k, "?")} 秒</p>' if ok else "<p class=e>还没生成（双击对应的 .bat）</p>") + "</section>"
svg = f"{sid}_svg.svg"
page = f"""<!doctype html><meta charset=utf-8><title>参考视频三种方式对比 {sid}</title><style>body{{background:#16171b;color:#e8e4dc;font:14px/1.6 "Microsoft YaHei",sans-serif;margin:20px}}
.g{{display:grid;grid-template-columns:repeat(2,1fr);gap:16px}}video,img{{width:100%;border-radius:6px}}.n{{color:#999;min-height:3em}}.e{{color:#ff6b6b}}</style>
<h1>参考视频三种方式对比：{sid}</h1><p>三种方式用的是同一份逐帧数据（out\\{sid}_track.json，来自 autofix\\test_motion\\{sid}\\motion.json），动作完全一样，只比画法和工具好不好用。</p>
<div class=g>{cards}</div>{f'<h2>会动的 SVG（不用渲染，浏览器直接播）</h2><img src="{svg}" style="max-width:640px">' if os.path.exists(os.path.join(C.OUT, svg)) else ''}"""
p = os.path.join(C.OUT, f"{sid}_compare.html"); open(p, "w", encoding="utf-8").write(page); print("对比页：" + p)
try: os.startfile(p)
except Exception: pass
