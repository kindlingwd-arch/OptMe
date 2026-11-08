"""检查 Gemini 连不连得上：密钥、代理、网络、模型列表、一次很便宜的文字调用（不出图，不花出图的钱）。
用法：双击 check_gemini.bat，或 python check_gemini.py。把输出整段发给 Claude 就能判断问题在哪。
"""
import os, sys, json, time, urllib.request
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import gen_images as gi

print("== 1. 密钥")
key = os.environ.get("GEMINI_API_KEY", "").strip()
print("  GEMINI_API_KEY：", f"有（{len(key)} 位，开头 {key[:4]}…）" if key else "没有！程序读不到密钥")

print("== 2. 代理（Python 实际会用的）")
px = urllib.request.getproxies()
print("  ", px or "没有检测到代理（系统代理没开，环境变量里也没有）")
for k in ("HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "https_proxy", "http_proxy"):
    if os.environ.get(k): print(f"   环境变量 {k} = {os.environ[k]}")

import socket
try: print("  DNS 把 Google 解析到：", socket.gethostbyname("generativelanguage.googleapis.com"))
except Exception as e: print("  DNS 解析 Google 失败：", e)
print("  出图脚本实际用的代理（环境变量）：", os.environ.get("HTTPS_PROXY", "（没有）"), "| 不走代理：", os.environ.get("NO_PROXY", "（没有）"))
print("== 3. 能不能连到 Google")
t = time.time(); st, js = gi.http(gi.G + "/models?pageSize=5", headers={"x-goog-api-key": key or "none"}, timeout=20)
print(f"  HTTP {st}，用时 {time.time() - t:.1f} 秒")
if st != 200: print("  返回：", json.dumps(js, ensure_ascii=False)[:400])

if st == 0:
    import socket, urllib.parse, subprocess
    host = "generativelanguage.googleapis.com"
    print("== 3b. 细查：到底是哪一步被拒")
    print("  这个网址会不会绕过代理（直连）：", "会！（被列进了不走代理的名单）" if urllib.request.proxy_bypass(host) else "不会，走代理")
    try:
        import winreg
        k = winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Internet Settings")
        for name in ("ProxyEnable", "ProxyServer", "ProxyOverride", "AutoConfigURL"):
            try: print(f"  注册表 {name} = {winreg.QueryValueEx(k, name)[0]}")
            except OSError: pass
    except Exception as e: print("  读不了注册表：", e)
    pu = urllib.parse.urlparse(px.get("https") or px.get("http") or "")
    if pu.hostname:
        for h in dict.fromkeys([pu.hostname, "127.0.0.1"]):
            t = time.time()
            try: socket.create_connection((h, pu.port or 80), timeout=5).close(); print(f"  直接连 {h}:{pu.port}：通（{time.time() - t:.2f} 秒）")
            except Exception as e: print(f"  直接连 {h}:{pu.port}：不通（{time.time() - t:.2f} 秒）{e}")
        try:
            op = urllib.request.build_opener(urllib.request.ProxyHandler({"https": f"http://127.0.0.1:{pu.port}", "http": f"http://127.0.0.1:{pu.port}"}))
            t = time.time(); r = op.open(urllib.request.Request(gi.G + "/models?pageSize=1", headers={"x-goog-api-key": key or "none"}), timeout=20)
            print(f"  强制走 127.0.0.1:{pu.port} 代理：HTTP {r.status}（{time.time() - t:.1f} 秒）")
        except urllib.error.HTTPError as e: print(f"  强制走 127.0.0.1:{pu.port} 代理：HTTP {e.code}（能连上，Google 返回了错误）", e.read()[:200])
        except Exception as e: print(f"  强制走 127.0.0.1:{pu.port} 代理：失败 {e}")
    try:
        out = subprocess.run(["curl", "-sS", "-o", "NUL", "-w", "%{http_code}", "-x", f"http://127.0.0.1:{pu.port or 7890}", "-m", "20", gi.G + "/models"], capture_output=True, text=True, timeout=30)
        print(f"  用系统自带 curl 走代理：{out.stdout.strip() or '-'} {out.stderr.strip()[:200]}")
    except Exception as e: print("  curl 测试没跑成：", e)

if key and st == 200:
    print("== 4. 可用的图像模型")
    st, js = gi.http(gi.G + "/models?pageSize=300", headers={"x-goog-api-key": key}, timeout=30)
    names = [m["name"].split("/")[-1] for m in js.get("models", []) if "generateContent" in m.get("supportedGenerationMethods", [])]
    img = [n for n in names if "image" in n and "imagen" not in n]
    print("  ", ", ".join(img) or "（一个都没有）")
    print("  GEMINI_IMAGE_MODEL =", os.environ.get("GEMINI_IMAGE_MODEL", "（没设置，自动选）"))
    print("== 5. 一次文字调用（几乎不花钱）")
    txt = next((n for n in names if "flash" in n and "image" not in n and "lite" not in n), names[0] if names else "gemini-2.5-flash")
    st, js = gi.http(f"{gi.G}/models/{txt}:generateContent", {"contents": [{"parts": [{"text": "只回复两个字：收到"}]}]}, {"x-goog-api-key": key}, timeout=60)
    print(f"  {txt}：HTTP {st}", json.dumps(js, ensure_ascii=False)[:300] if st != 200 else "正常")

print("\n判断：")
if not key: print("  程序读不到 GEMINI_API_KEY。检查系统环境变量，改完要重开剪辑台。")
elif st == 0: print("  连不上 Google：代理软件没开、节点断了，或者没开系统代理。打开代理（美国 / 日本节点）后重开剪辑台再试。")
elif st == 400 and "location" in json.dumps(js).lower(): print("  代理节点所在地区不支持 Gemini，换美国 / 日本节点。")
elif st in (401, 403): print("  密钥无效或没有权限，到 AI Studio 检查密钥。")
elif st == 429: print("  请求太频繁或额度用完，到 AI Studio 看用量和账单。")
elif st == 200: print("  网络和密钥都正常。如果出图还失败，看出图日志里「第 N 次失败」后面的原因。")
else: print("  看上面的返回内容。")
