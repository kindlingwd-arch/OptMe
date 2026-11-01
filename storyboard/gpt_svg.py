"""让 GPT（Codex）按分镜表和构图草图画精绘 SVG 草图。
用法：python gpt_svg.py [镜头编号 ...]      不写编号 = 默认 11 个问题镜头
输出：sketch/gpt/<镜头>.svg 和 .png（已存在的跳过；想重画就先把旧文件挪走）
"""
import glob, json, os, subprocess, sys, shutil, xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)                      # moban_art
OUT = os.path.join(HERE, "sketch", "gpt")
STYLE = os.path.join(OUT, "style_ref.png")        # 风格样图
DEFAULT = "start_04 stop_00 speed_03 together_00 check_01 check_02 E_late_00 E_half_00 E_truth_00 E_truth_02 E_truth_03".split()


def codex():
    for p in glob.glob(os.path.join(os.environ.get("LOCALAPPDATA", ""), "OpenAI", "Codex", "bin", "*", "codex.exe")):
        return p
    return "codex"


def prompt(shot, bible):
    rules = "\n".join(f"- {k}：{v}" for k, v in bible.items())
    return f"""你是分镜插画师。请为互动电影游戏《末班客》画一张分镜草图，输出为一个手写的 SVG 文件。

【只做一件事】把 SVG 写到这个文件（覆盖也可以），不要改动其他任何文件：
{os.path.join(OUT, shot['id'] + '.svg')}

【镜头 {shot['id']}】
- 景别：{shot['shot']}
- 画面里的人物：{shot['in_frame']}
- 场景：{shot['location']}
- 画面：{shot['desc']}
- 构图要求：{shot.get('layout', '')}
- 备注：{shot.get('note', '')}

【统一设定（必须遵守）】
{rules}

【附图怎么用】
1. 构图草图（简笔色块）和俯视位置图：人物在画面里的左右位置、朝向、视线、机位、车头方向、左舵，必须和它们完全一致。只学位置，不学它的画风。
2. 角色和场景参考图：人物长相、发型、服装、道具照着画。
3. 风格样图（深色夜景插画）：画风、精细程度、配色和光线照它来。

【SVG 技术要求】
- 根元素 <svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900">，16:9。
- 纯矢量手绘：人物、车内结构、道具都用贝塞尔曲线 path 一笔笔勾出来，不要用圆、矩形拼小人。人体比例写实（成年人头身比约 1:7），脸要有眉、眼、鼻、嘴等五官，手套要有手指。
- 要有透视（车内结构、道路往远处收）、前景遮挡（A 柱、座椅、方向盘这类压在画面边缘）、统一光源（车内暗，仪表盘绿光、窗外钠灯橙光或警灯红蓝光照到人物轮廓上）。可以用 linearGradient、radialGradient、clipPath；不要用 filter（模糊、滤镜在部分渲染器里显示不出来）。
- 线条分主次：外轮廓粗（约 3px），五官、衣褶细（1–2px）。
- 画面里绝对不能有任何文字、字母、数字、标注、箭头或标题（车牌、顶灯、证件上也不要字）。保险单只画一条红色抬头色块和一个红色圆章，不写字。
- 不嵌入任何位图（不要 <image>），不引用外部文件或字体。
- 写完后自己检查一遍：XML 能正常解析；人物左右位置和构图草图一致；方向盘在车的左侧（左舵）。
"""


def render(svg, png):
    try:
        import cairosvg
        cairosvg.svg2png(url=svg, write_to=png, output_width=1600, output_height=900)
        return True
    except Exception:
        pass
    for edge in [r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe", r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"]:
        if os.path.exists(edge):
            subprocess.run([edge, "--headless=new", "--disable-gpu", "--hide-scrollbars", f"--screenshot={png}",
                            "--window-size=1600,900", "file:///" + svg.replace("\\", "/")], timeout=60)
            return os.path.exists(png)
    return False


def main():
    sl = json.load(open(os.path.join(HERE, "shotlist.json"), encoding="utf-8"))
    shots = {s["id"]: s for s in sl["shots"]}
    ids = sys.argv[1:] or DEFAULT
    os.makedirs(OUT, exist_ok=True)
    for sid in ids:
        if sid not in shots:
            print("分镜表里没有", sid); continue
        svg = os.path.join(OUT, sid + ".svg"); png = os.path.join(OUT, sid + ".png")
        if os.path.exists(svg) and os.path.exists(png):
            print(sid, "已有，跳过"); continue
        shot = shots[sid]
        imgs = [os.path.join(ROOT, r) for r in shot.get("sketch", [])] + [os.path.join(ROOT, r) for r in shot.get("refs", [])] + [STYLE]
        imgs = [p for p in imgs if os.path.exists(p)]
        ptxt = os.path.join(OUT, sid + "_prompt.txt")
        open(ptxt, "w", encoding="utf-8").write(prompt(shot, sl.get("bible", {})))
        print(f"== {sid}：交给 Codex 画（带 {len(imgs)} 张附图），通常要几分钟 ...", flush=True)
        cmd = [codex(), "exec"] + sum([["-i", p] for p in imgs], []) + [
            "--skip-git-repo-check", "-c", 'model_reasoning_effort="medium"', "-s", "workspace-write",
            "-C", HERE, "-"]
        with open(ptxt, encoding="utf-8") as f, open(os.path.join(OUT, sid + "_log.txt"), "w", encoding="utf-8") as log:
            subprocess.run(cmd, stdin=f, stdout=log, stderr=subprocess.STDOUT)
        if not os.path.exists(svg):
            print("  × 没写出 SVG，看", sid + "_log.txt"); continue
        try:
            ET.parse(svg)
        except Exception as e:
            print("  × SVG 格式有错：", e); continue
        print("  ✓ SVG 好了；转 PNG", "成功" if render(svg, png) else "失败（SVG 仍可用浏览器打开看）")
    print("全部完成。结果在 storyboard\\sketch\\gpt\\")


if __name__ == "__main__":
    main()
