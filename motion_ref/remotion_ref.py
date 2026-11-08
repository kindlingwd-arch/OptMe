"""方案三：Remotion（用写网页 / React 的方式做视频）→ 视频。
用法：python remotion_ref.py [镜头]   默认 ask，输出 out\\<镜头>_remotion.mp4。
要先装 Node.js（https://nodejs.org，选 LTS 版）。第一次运行会自动 npm install（下载约 200MB），并让 Remotion 下载它用的无界面浏览器。
Remotion 的许可：个人和 3 人以内的公司免费，更大的公司要买授权。"""
import os, sys, json, shutil, subprocess, time
import common as C
try:                                   # 和出图脚本一样，把系统代理写进环境变量，npm 和 Remotion 下载浏览器时会用
    sys.path.insert(0, os.path.join(C.ROOT, "storyboard")); import gen_images  # noqa: F401
except Exception: pass

R = os.path.join(C.HERE, "remotion")


def run(cmd, **kw):
    print("> " + " ".join(cmd), flush=True)
    return subprocess.run(cmd, cwd=R, shell=(os.name == "nt"), **kw).returncode


def main():
    sid = C.sid_arg(); track, tp = C.build(sid)
    if not shutil.which("npx"): sys.exit("没找到 Node.js：先从 https://nodejs.org 装 LTS 版，装完重新打开这个窗口再试")
    if not os.path.exists(os.path.join(R, "node_modules", "remotion")):
        print("第一次用：安装 Remotion（几分钟）…", flush=True)
        if run(["npm", "install", "--no-audit", "--no-fund"]) != 0: sys.exit("npm install 失败，看上面的报错")
    os.makedirs(os.path.join(R, "public"), exist_ok=True); shutil.copy2(os.path.join(C.OUT, track["key"]), os.path.join(R, "public", track["key"]))
    props = os.path.join(C.OUT, f"{sid}_remotion_props.json"); json.dump({"track": track}, open(props, "w", encoding="utf-8"), ensure_ascii=False)
    out = os.path.join(C.OUT, f"{sid}_remotion.mp4")
    cmd = ["npx", "remotion", "render", "src/index.ts", "Ref", out, f"--props={props}", "--log=warn"]
    be = os.environ.get("REMOTION_BROWSER")            # 可选：指定浏览器（例如测试环境里没法下载时）
    t0 = time.time(); rc = run(cmd + ([f"--browser-executable={be}"] if be else []))
    if rc != 0 and os.name == "nt" and not be:         # Remotion 自己的浏览器下载不下来：改用电脑自带的 Edge 再试一次
        for edge in (r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe", r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"):
            if os.path.exists(edge):
                print("改用电脑自带的 Edge 再试一次…", flush=True); rc = run(cmd + [f"--browser-executable={edge}", "--chrome-mode=chrome-for-testing"]); break
    if rc != 0: sys.exit("Remotion 渲染失败，看上面的报错（把它发给 Claude）")
    C.timing(sid, "remotion", time.time() - t0); print("视频：" + out, flush=True)


if __name__ == "__main__":
    main()
