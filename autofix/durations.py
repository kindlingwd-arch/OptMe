"""按剧本内容算每条视频该多长，写进 autofix\\video_shots.json 的 duration（以前一律 6 秒）。

怎么算（和游戏 moban_game/index.html 的播放规则一致）：
  场景视频：进场后一直播到「第一句有自己分镜图的台词」或「插入镜头」为止（之后游戏切走，视频就看不到了），
            这段时间 = 字幕卡每张 2.8 秒 + 台词（有配音按配音长度 + 0.65 秒，没配音按字数：每字 0.24 秒，最少 1.9 秒，再加 0.4 秒）。
            第一句就有自己的图：进场不播场景视频（2026-11-02 起），标「游戏里用不上」。
            结局（没有台词）：等 4.2 秒 + 尾声每行 1.4 秒。
  插入镜头：游戏播到视频结束才往下走（最多等 9.5 秒，有引子的 7 秒），时长看动作要多久：
            有 action_sec（AI 写提示词时估的动作秒数）就用它，没有就按描述里动作的多少估。
然后对到视频模型支持的时长：海螺只有 6 秒和 10 秒；H3 按 4～10 秒的整数（不接受时 autofix 会退回 6 秒）。
人在剪辑台里手改过的（duration_locked）不动。

用法：python durations.py [镜头…] [--dry]
"""
import os, sys, json, re, math, shutil, time, subprocess

HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE); GAME = os.path.join(ROOT, "moban_game")
sys.path.insert(0, HERE)
import write_vprompts as W            # 读剧本（load_script、LEAD）
import video_shots as VS

SHOT_MAX = {"pager": 7.0, "policy": 7.0}  # 有引子视频的插入镜头：游戏最多等 7 秒；其它 9.5 秒
_vo_cache = {}


def vo_map():
    h = open(os.path.join(GAME, "index.html"), encoding="utf-8").read()
    m = re.search(r"const VOT=/\*VO_MAP\*/(\{.*?\});", h)
    try: return json.loads(m.group(1)) if m else {}
    except Exception: return {}


def media_len(p):
    if p in _vo_cache: return _vo_cache[p]
    d = 0.0
    try:
        ff = shutil.which("ffmpeg")
        if not ff:
            import imageio_ffmpeg; ff = imageio_ffmpeg.get_ffmpeg_exe()
        e = subprocess.run([ff, "-hide_banner", "-i", p], capture_output=True, text=True, encoding="utf-8", errors="replace", stdin=subprocess.DEVNULL).stderr
        m = re.search(r"Duration: (\d+):(\d+):([\d.]+)", e); d = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3)) if m else 0.0
    except Exception: pass
    _vo_cache[p] = d; return d


def line_time(l, vot):
    t = str(l[0])
    if t == "@cap": return 2.8, "字幕卡 2.8 秒"
    if t.startswith("@"): return 0.0, ""
    text = str(l[1]); key = vot.get(re.sub(r"（[^）]*）", "", text).strip())
    if key:
        d = media_len(os.path.join(GAME, "vo", key + ".mp3"))
        if d: return d + 0.65, f"配音 {d:.1f} 秒"
    if re.fullmatch(r"[…。.！？!?\s—-]*", text): return 1.4, "无字停顿 1.4 秒"
    return max(1.9, min(15, len(text) * 0.24)) + 0.4, f"按字数 {len(text)} 字"


OFFSCREEN = {"收音机", "旁白", "BP机", "画外音", ""}   # 这些「说话的」不在画面里，画面里的人不该张嘴


def find_line(sid, N, limg=None):
    """台词页视频（kind=line，id 就是这句分镜图的名字，比如 ride_00）对应剧本里哪一句：按钉在台词上的图名找，找不到再按 LIMG 的位置找。"""
    limg = limg if limg is not None else limg_set()
    for nid, n in N.items():
        for i, l in enumerate(n.get("lines", [])):
            if str(l[0]).startswith("@"): continue
            im = l[2].get("img") if len(l) > 2 and isinstance(l[2], dict) else (f"l/{nid}_{i:02d}" if f"{nid}_{i:02d}" in limg else None)
            if im and im.split("/")[-1] == sid: return nid, i, l
    return None, -1, None


def speech(s, N, vot, limg):
    """这条视频播放的同时，游戏里会响起哪些台词（时间从视频开始算）。返回 [{t0, t1, who, text, onscreen}]。
    插入镜头：游戏播插入镜头时不放台词（只有音效），返回空。场景视频：从进场到切走之前的那几句。"""
    sid = s["id"]
    if s.get("kind") == "line":                          # 台词页：这一句的配音从视频一开始就放
        nid, i, l = find_line(sid, N, limg)
        if not l: return []
        d, _ = line_time(l, vot); who = str(l[0])
        return [{"t0": 0.0, "t1": round(max(0.5, d - 0.65), 1), "who": who, "text": str(l[1]), "onscreen": who not in OFFSCREEN and s.get("speaker_in_frame", True) is not False}]
    if sid not in N: return []
    lines = N[sid].get("lines", []); out = []; t = 0.0
    if lines and own_image(sid, 0, lines[0], limg): return []
    for i, l in enumerate(lines):
        if l[0] == "@shot" or own_image(sid, i, l, limg): break
        d, _ = line_time(l, vot)
        if not str(l[0]).startswith("@"):
            who = str(l[0]); out.append({"t0": round(t, 1), "t1": round(t + max(0.5, d - 0.65), 1), "who": who, "text": str(l[1]), "onscreen": who not in OFFSCREEN})
        t += d
    return out


def own_image(nid, i, l, limg):
    return not str(l[0]).startswith("@") and l[0] != "BP机" and bool((len(l) > 2 and isinstance(l[2], dict) and l[2].get("img")) or f"{nid}_{i:02d}" in limg)


def limg_set():
    h = open(os.path.join(GAME, "index.html"), encoding="utf-8").read()
    m = re.search(r"const LIMG=new Set\(/\*LIMG\*/(\[.*?\])\);", h)
    try: return set(json.loads(m.group(1))) if m else set()
    except Exception: return set()


def need(s, N, vot, limg):
    """返回 (需要的秒数 或 None=游戏里用不上, 说明)。"""
    sid = s["id"]
    if s.get("kind") == "line":                          # 台词页：配音多长视频就多长（游戏里这一页停到配音放完）
        nid, i, l = find_line(sid, N, limg)
        if not l: return None, "剧本里找不到这一句"
        d, why = line_time(l, vot); return d, f"台词页：{why}（这一页停到配音放完）"
    if sid in N and s.get("action_sec"):                 # AI 写提示词时按内容估的时长优先；规则算的只作参考
        rule, rwhy = need(dict(s, action_sec=None), N, vot, limg)
        return float(s["action_sec"]), f"AI 按内容估的 {float(s['action_sec']):g} 秒（参考：{rwhy}）"
    if sid in N:
        n = N[sid]; lines = n.get("lines", [])
        if not lines:
            if n.get("end"): k = len(n.get("epi") or []); return 4.2 + 1.4 * k, f"结局：等 4.2 秒 + 尾声 {k} 行 × 1.4 秒"
            return 4.2, "没有台词：等 4.2 秒"
        if own_image(sid, 0, lines[0], limg): return None, "第一句有自己的分镜图，进场不播场景视频（游戏里用不上）"
        tot, parts = 0.0, []
        for i, l in enumerate(lines):
            if l[0] == "@shot" or own_image(sid, i, l, limg): parts.append(f"到第 {i + 1} 行切走"); break
            d, why = line_time(l, vot); tot += d
            if why: parts.append(f"{i + 1}行{why}")
        return tot, "场景视频播到切走为止：" + "，".join(parts)
    # 插入镜头
    name = next((k for k, v in W.LEAD.items() if v == sid), sid[2:] if sid.startswith("s_") else sid)
    cap = SHOT_MAX.get(name, 9.5)
    if s.get("action_sec"): return min(cap, float(s["action_sec"])), f"AI 按内容估的动作时长 {float(s['action_sec']):g} 秒（游戏最多等 {cap:g} 秒）"
    txt = s.get("prompt") or s.get("describe") or ""
    acts = len([x for x in re.split(r"[，。；,;]", txt) if re.search(r"(伸|拿|放|推|拉|走|转|抬|低|看|递|捂|敲|拧|打开|掉|滑|笑|说|喊|跑|站|坐|靠|摸|握)", x)])
    d = min(cap, max(4.0, 2.5 + 1.5 * acts)); return d, f"按描述里的动作估：{acts} 个动作 → {d:g} 秒（游戏最多等 {cap:g} 秒）"


def snap(sec, s):
    h3 = s.get("mode") == "h3"
    if h3: d = int(min(10, max(4, math.ceil(sec - 0.2)))); allowed = "H3 按 4～10 秒"
    else: d = 6 if sec <= 7 else 10; allowed = "海螺只有 6 / 10 秒"
    note = f"；需要 {sec:.1f} 秒，比模型给的 {d} 秒长，动作要做得紧一点" if sec > d + 1 else ""
    if not h3 and d == 10: note += "；海螺 10 秒的价钱比 6 秒贵"
    return d, allowed + note


def plan(ids=None, dry=False, quiet=False):
    d, m = VS.load(); N = W.load_script(); vot = vo_map(); limg = limg_set(); out = []
    for s in d["shots"]:
        if ids and s["id"] not in ids: continue
        sec, why = need(s, N, vot, limg)
        if sec is None: dur, rule = s.get("duration") or 6, "保持原来的"
        else: dur, rule = snap(sec, s)
        locked = bool(s.get("duration_locked"))
        out.append((s["id"], dur if not locked else s.get("duration", dur), sec, why + "；" + rule, locked))
        if not quiet: print(f"{s['id']:12} {('（手改过，不动）' + str(s.get('duration'))) if locked else dur} 秒  ← {why}；{rule}", flush=True)
    if not dry:
        import gen_images as gi
        with gi.file_lock(VS.PATH):
            d2 = json.load(open(VS.PATH, encoding="utf-8")); by = {x["id"]: x for x in d2.get("shots", [])}
            os.makedirs(os.path.join(HERE, "backup"), exist_ok=True)
            shutil.copy2(VS.PATH, os.path.join(HERE, "backup", f"video_shots_{time.strftime('%m%d_%H%M%S')}.json"))
            for sid, dur, sec, why, locked in out:
                x = by.get(sid)
                if not x: continue
                x["duration_need"] = None if sec is None else round(sec, 1); x["duration_why"] = why
                if not locked: x["duration"] = int(dur)
            gi._write_json(VS.PATH, d2)
    return out


if __name__ == "__main__":
    sys.path.insert(0, os.path.join(ROOT, "storyboard"))
    a = sys.argv[1:]; r = plan([x for x in a if not x.startswith("--")] or None, "--dry" in a)
    print(f"{'（--dry：没写文件）' if '--dry' in a else '已写进 video_shots.json'}：{len(r)} 条")
