"""方案一：SVG 加关键帧 → 视频。
同一份逐帧数据做成两样东西：
  out\\<镜头>_svg.svg   会动的 SVG（SMIL 动画），双击用浏览器打开就能看
  out\\<镜头>_svg.mp4   用浏览器（优先电脑自带的 Edge）逐帧截图，再用 ffmpeg 合成的视频
用法：python svg_ref.py [镜头]   默认 ask。第一次用要 pip install playwright（不用下载浏览器，用 Edge）。"""
import os, sys, json, base64, subprocess, time
import common as C


def svg_doc(track, animate):
    W, H = track["w"], track["h"]; fr = track["frames"]; n = len(fr); dur = n / track["fps"]
    key = base64.b64encode(open(os.path.join(C.OUT, track["key"]), "rb").read()).decode()
    kt = ";".join(f"{i / (n - 1):.4f}" for i in range(n))
    def cam_tf(c): s, dx, dy = c; return f"translate({W / 2 + dx * W:.1f} {H / 2 + dy * H:.1f}) scale({s:.4f}) translate({-W / 2:.1f} {-H / 2:.1f})"
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" font-family="Microsoft YaHei,sans-serif">',
             f'<g id="cam" transform="{cam_tf(fr[0]["cam"])}">']
    if animate:
        parts.append(f'<animateTransform attributeName="transform" type="matrix" dur="{dur}s" repeatCount="indefinite" calcMode="discrete" keyTimes="{kt}" values="' +
                     ";".join(f'{c[0]:.4f} 0 0 {c[0]:.4f} {W / 2 + c[1] * W - c[0] * W / 2:.1f} {H / 2 + c[2] * H - c[0] * H / 2:.1f}' for c in (f["cam"] for f in fr)) + '"/>')
    parts += [f'<image href="data:image/jpeg;base64,{key}" width="{W}" height="{H}"/>', f'<rect width="{W}" height="{H}" fill="#000" opacity="0.45"/>']
    for k, sb in enumerate(track["subjects"]):
        c = sb["color"]; path = " ".join(f"{x * W:.1f},{y * H:.1f}" for x, y in sb["path"])
        x0, y0 = fr[0]["pos"][k]
        parts.append(f'<polyline points="{path}" fill="none" stroke="{c}" stroke-width="2" stroke-dasharray="8 6" opacity="0.55"/>')
        parts.append(f'<polyline id="trail{k}" points="{x0 * W:.1f},{y0 * H:.1f}" fill="none" stroke="{c}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>')
        parts.append(f'<g id="dot{k}" transform="translate({x0 * W:.1f} {y0 * H:.1f})">')
        if animate:
            parts.append(f'<animateTransform attributeName="transform" type="translate" dur="{dur}s" repeatCount="indefinite" keyTimes="{kt}" values="' +
                         ";".join(f'{f["pos"][k][0] * W:.1f} {f["pos"][k][1] * H:.1f}' for f in fr) + '"/>')
        parts.append(f'<circle r="{W * .028:.1f}" fill="{c}" fill-opacity="0.85" stroke="#fff" stroke-width="3"/><text y="{-W * .04:.1f}" text-anchor="middle" fill="#fff" font-size="22" stroke="#000" stroke-width="4" paint-order="stroke">{sb["label"]}</text></g>')
    parts.append('</g>')
    cam = {"push_in": "镜头推近", "pull_out": "镜头拉远", "pan_left": "镜头左摇", "pan_right": "镜头右摇", "tilt_up": "镜头上摇", "tilt_down": "镜头下摇"}.get(track["camera"], "")
    parts.append(f'<text id="tc" x="16" y="{H - 16}" fill="#ffd23c" font-size="22" stroke="#000" stroke-width="4" paint-order="stroke">0.0s {cam}</text>')
    if animate:  # 秒数只在逐帧渲染时更新；会动的 SVG 里写一句说明
        parts[-1] = f'<text x="16" y="{H - 16}" fill="#ffd23c" font-size="22" stroke="#000" stroke-width="4" paint-order="stroke">{dur:g} 秒循环 · {cam}</text>'
    parts.append('</svg>')
    return "\n".join(parts)


def main():
    sid = C.sid_arg(); track, tp = C.build(sid)
    svg_anim = os.path.join(C.OUT, f"{sid}_svg.svg"); open(svg_anim, "w", encoding="utf-8").write(svg_doc(track, True))
    print("会动的 SVG：" + svg_anim, flush=True)
    try: from playwright.sync_api import sync_playwright
    except ImportError: sys.exit("要出视频还需要：pip install playwright （不用再下载浏览器，会用电脑自带的 Edge）")
    W, H = track["w"], track["h"]; fr = track["frames"]
    page_html = "<html><body style='margin:0;background:#000'>" + svg_doc(track, False) + """<script>
const F=%s, W=%d, H=%d, S=%s;
function setFrame(i){const f=F[i]; const [s,dx,dy]=f.cam;
 document.getElementById('cam').setAttribute('transform',`translate(${W/2+dx*W} ${H/2+dy*H}) scale(${s}) translate(${-W/2} ${-H/2})`);
 f.pos.forEach((p,k)=>{document.getElementById('dot'+k).setAttribute('transform',`translate(${p[0]*W} ${p[1]*H})`);
   document.getElementById('trail'+k).setAttribute('points',F.slice(0,i+1).map(g=>`${g.pos[k][0]*W},${g.pos[k][1]*H}`).join(' '));});
 document.getElementById('tc').textContent=f.t.toFixed(1)+'s '+S;}
</script></body></html>""" % (json.dumps(fr), W, H, json.dumps({"push_in": "镜头推近", "pull_out": "镜头拉远", "pan_left": "镜头左摇", "pan_right": "镜头右摇", "tilt_up": "镜头上摇", "tilt_down": "镜头下摇"}.get(track["camera"], ""), ensure_ascii=False))
    hp = os.path.join(C.OUT, f"{sid}_svg_frames.html"); open(hp, "w", encoding="utf-8").write(page_html)
    out = os.path.join(C.OUT, f"{sid}_svg.mp4"); t0 = time.time()
    ff = subprocess.Popen([C.ffmpeg(), "-y", "-v", "error", "-f", "image2pipe", "-framerate", str(track["fps"]), "-i", "-", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", out], stdin=subprocess.PIPE)
    with sync_playwright() as p:
        b = None
        for kw in ({"channel": "msedge"}, {"channel": "chrome"}, {}):
            try: b = p.chromium.launch(**kw); break
            except Exception: continue
        if not b: sys.exit("没能启动浏览器：电脑上要有 Edge 或 Chrome（或者运行 playwright install chromium）")
        pg = b.new_page(viewport={"width": W, "height": H}); pg.goto("file:///" + hp.replace("\\", "/"))
        for i in range(len(fr)):
            pg.evaluate(f"setFrame({i})"); ff.stdin.write(pg.screenshot(type="png"))
            if i % 24 == 0: print(f"  渲染 {i}/{len(fr)} 帧", flush=True)
        b.close()
    ff.stdin.close(); ff.wait()
    C.timing(sid, "svg", time.time() - t0); print(f"视频：{out}（{time.time() - t0:.0f} 秒）", flush=True)


if __name__ == "__main__":
    main()
