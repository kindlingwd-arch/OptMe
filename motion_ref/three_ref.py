"""方案四：three.js 3D 预演 → 参考视频。
在首帧上叠一个简单的 3D 人体模型（躯干、头、两条手臂，关节会弯），手按轨迹走（用两节骨骼的 IK：手到哪，肘和肩自己跟着转，身体会往目标那边倾），
镜头按轨迹里的推拉摇移动。三维的位置是把轨迹在首帧上的位置投到人的深度上算出来的，所以从镜头看过去，手走的路线和你画的 / AI 标的一样。
用法：python three_ref.py [镜头] [--plain]   默认 ask，输出 out\\<镜头>_three.mp4。--plain：背景用纯灰色，不叠首帧。
用浏览器（优先电脑自带的 Edge）逐帧截图，再用 ffmpeg 合成。three.js 文件已经放在 three\\ 文件夹里，不用联网。第一次用要 pip install playwright（已经装过就不用）。
"""
import os, sys, json, base64, subprocess, time
import common as C

HTML = r"""<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#000;overflow:hidden}canvas{display:block}
#tc{position:absolute;left:16px;bottom:12px;color:#ffd23c;font:22px "Microsoft YaHei",sans-serif;text-shadow:0 0 4px #000,0 0 4px #000}</style></head><body><div id="tc"></div>
<script>__THREE__</script><script>
const TR = __TRACK__, KEY = "__KEY__", PLAIN = __PLAIN__, W = TR.w, H = TR.h;
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true }); renderer.setSize(W, H); renderer.setPixelRatio(1); document.body.appendChild(renderer.domElement);
renderer.outputEncoding = THREE.sRGBEncoding;
const scene = new THREE.Scene(); scene.background = new THREE.Color(0x3a3d44);
const cam = new THREE.PerspectiveCamera(45, W / H, 0.05, 100); cam.position.set(0, 0, 0); cam.lookAt(0, 0, -1);
scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x30281f, 0.75)); const dl = new THREE.DirectionalLight(0xffffff, 0.9); dl.position.set(-2, 3, 2); scene.add(dl);
const D = 3.2;                                   // 人离镜头的距离（米）；手的轨迹投到这个深度附近
function ray(x, y, depth) { const v = new THREE.Vector3(x * 2 - 1, 1 - y * 2, 0.5).unproject(cam).sub(cam.position).normalize(); return cam.position.clone().add(v.multiplyScalar(depth / -v.z)); }
// 背景：首帧图（压暗）铺在远处，正好填满画面
if (!PLAIN && KEY) {
  const far = 30, hgt = 2 * far * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2)), img = new Image();
  const tex = new THREE.Texture(img); img.onload = () => { tex.needsUpdate = true; window.__bg = 1; }; img.src = KEY; tex.encoding = THREE.sRGBEncoding;
  const bg = new THREE.Mesh(new THREE.PlaneGeometry(hgt * W / H, hgt), new THREE.MeshBasicMaterial({ map: tex, color: 0x6a6a6a, depthWrite: false }));
  bg.position.set(0, 0, -far); scene.add(bg);
} else window.__bg = 1;
const skin = new THREE.MeshStandardMaterial({ color: 0xd9d2c8, roughness: 0.65, metalness: 0.05 });
const cloth = new THREE.MeshStandardMaterial({ color: 0x8a6f5a, roughness: 0.9 });
const body = new THREE.MeshStandardMaterial({ color: 0x8a6f5a, roughness: 0.9, transparent: true, opacity: 0.55, depthWrite: false });   // 躯干半透明：不挡住首帧里的人和手的路线
function limb(r, mat) { const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 0.9, 1, 16), mat); scene.add(m); return m; }
function ball(r, mat) { const m = new THREE.Mesh(new THREE.SphereGeometry(r, 20, 14), mat); scene.add(m); return m; }
function place(m, a, b) { const d = b.clone().sub(a), L = d.length(); m.position.copy(a).add(b).multiplyScalar(0.5); m.scale.set(1, L, m.scale.z || 1); m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()); }
function ik(S, T, a, b, pole) {                  // 两节骨骼 IK：肩 S、手目标 T、上臂 a、前臂 b，肘往 pole 方向弯
  let d = T.clone().sub(S), L = Math.min(d.length(), (a + b) * 0.999); d.normalize(); const Tn = S.clone().add(d.clone().multiplyScalar(L));
  const x = (a * a - b * b + L * L) / (2 * L), h = Math.sqrt(Math.max(0, a * a - x * x));
  const p = pole.clone().sub(d.clone().multiplyScalar(pole.dot(d))).normalize();
  return { E: S.clone().add(d.multiplyScalar(x)).add(p.multiplyScalar(h)), T: Tn };
}
// 每个对象：名字里有「手」的当成人的手（给它配一个坐着的人），其它的当成一个物体（方块）跟着走
const actors = TR.subjects.map((s, k) => {
  const p0 = TR.frames[0].pos[k];
  if (!/手/.test(s.label)) { const box = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.22, 0.12), new THREE.MeshStandardMaterial({ color: s.color })); scene.add(box); return { kind: "obj", box }; }
  // 肩膀放在起点手的上方（画面里往上约 1/5）；按这条路线最远要伸多远，定人离镜头多远（手臂 0.58 米刚好够得着），人的大小就和画面对得上
  const S2 = [p0[0] + 0.02, p0[1] - 0.2], ar = W / H, reach = Math.max(0.12, ...TR.frames.map(f => Math.hypot(f.pos[k][0] - S2[0], (f.pos[k][1] - S2[1]) / ar)));
  const depth = Math.min(6, Math.max(0.6, 0.58 / (reach * 1.08 * 2 * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2)) * ar)));
  const sh = ray(S2[0], S2[1], depth + 0.12);
  const torso = limb(0.11, body), pelvis = sh.clone().add(new THREE.Vector3(0, -0.5, -0.06)), neck = ball(0.05, skin), head = ball(0.095, skin);
  torso.renderOrder = -1; torso.scale.z = 0.7;
  const arms = [-1, 1].map(side => ({ side, up: limb(0.045, cloth), fo: limb(0.04, skin), el: ball(0.05, cloth), hd: ball(0.055, skin) }));
  return { kind: "person", sh, pelvis, torso, neck, head, arms, color: s.color, depth };
});
function setFrame(i) {
  const f = TR.frames[Math.min(i, TR.frames.length - 1)], [s, dx, dy] = f.cam;
  cam.zoom = s; cam.position.set(-dx * 1.2, dy * 0.7, 0); cam.updateProjectionMatrix();
  TR.subjects.forEach((sb, k) => {
    const A = actors[k], p = f.pos[k];
    if (A.kind === "obj") { A.box.position.copy(ray(p[0], p[1], D - 0.2)); return; }
    const T = ray(p[0], p[1], A.depth), reach = T.distanceTo(A.sh), lean = Math.max(0, Math.min(0.25, (reach - 0.45) * 0.6));
    const dir = T.clone().sub(A.sh).setY(0).normalize(), sh = A.sh.clone().add(dir.multiplyScalar(lean)).add(new THREE.Vector3(0, -lean * 0.4, 0));
    place(A.torso, A.pelvis, sh); A.neck.position.copy(sh).add(new THREE.Vector3(0, 0.06, -0.02)); A.head.position.copy(sh).add(new THREE.Vector3(0, 0.19, -0.04));
    A.arms.forEach(a => {
      const S = sh.clone().add(new THREE.Vector3(a.side * 0.16, -0.02, 0)), Tg = T.clone().add(new THREE.Vector3(a.side * 0.045, 0, 0));
      const r = ik(S, Tg, 0.3, 0.28, new THREE.Vector3(a.side * 0.7, -0.6, 0.2));
      place(a.up, S, r.E); place(a.fo, r.E, r.T); a.el.position.copy(r.E); a.hd.position.copy(r.T);
    });
  });
  renderer.render(scene, cam);
  document.getElementById("tc").textContent = f.t.toFixed(1) + "s " + (TR.camText || "");
}
setFrame(0);
</script></body></html>"""


def main():
    sid = C.sid_arg(); track, tp = C.build(sid); plain = "--plain" in sys.argv
    track["camText"] = {"push_in": "镜头推近", "pull_out": "镜头拉远", "pan_left": "镜头左摇", "pan_right": "镜头右摇", "tilt_up": "镜头上摇", "tilt_down": "镜头下摇"}.get(track["camera"], "")
    three = open(os.path.join(C.HERE, "three", "three.min.js"), encoding="utf-8").read()
    key = "data:image/jpeg;base64," + base64.b64encode(open(os.path.join(C.OUT, track["key"]), "rb").read()).decode()
    page = HTML.replace("__THREE__", three).replace("__TRACK__", json.dumps(track, ensure_ascii=False)).replace("__KEY__", key).replace("__PLAIN__", "true" if plain else "false")
    hp = os.path.join(C.OUT, f"{sid}_three.html"); open(hp, "w", encoding="utf-8").write(page)
    print("3D 预演网页（浏览器打开能看第一帧）：" + hp, flush=True)
    try: from playwright.sync_api import sync_playwright
    except ImportError: sys.exit("要出视频还需要：pip install playwright （不用再下载浏览器，会用电脑自带的 Edge）")
    W, H, n = track["w"], track["h"], len(track["frames"]); out = os.path.join(C.OUT, f"{sid}_three.mp4"); t0 = time.time()
    ff = subprocess.Popen([C.ffmpeg(), "-y", "-v", "error", "-f", "image2pipe", "-framerate", str(track["fps"]), "-i", "-", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", out], stdin=subprocess.PIPE)
    with sync_playwright() as p:
        b = None
        for kw in ({"channel": "msedge"}, {"channel": "chrome"}, {}):
            try: b = p.chromium.launch(args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"], **kw); break
            except Exception: continue
        if not b: sys.exit("没能启动浏览器：电脑上要有 Edge 或 Chrome")
        pg = b.new_page(viewport={"width": W, "height": H}); errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.goto("file:///" + hp.replace("\\", "/")); pg.wait_for_function("window.__bg === 1", timeout=20000)
        if errs: sys.exit("3D 页面出错：" + errs[0])
        for i in range(n):
            pg.evaluate(f"setFrame({i})"); ff.stdin.write(pg.screenshot(type="png"))
            if i % 24 == 0: print(f"  渲染 {i}/{n} 帧", flush=True)
        b.close()
    ff.stdin.close(); ff.wait()
    C.timing(sid, "three", time.time() - t0); print(f"视频：{out}（{time.time() - t0:.0f} 秒）", flush=True)


if __name__ == "__main__":
    main()
