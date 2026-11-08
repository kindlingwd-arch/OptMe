"""批量生成入口：默认仅预检，--run 才调用现有 autofix.py。只依赖标准库。"""
import argparse
from collections import Counter
from datetime import datetime
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys

ENGINES = ('hailuo', 'hailuo_fast', 'hailuo02_512', 'h3', 'h3_lite', 'h3_lite480')
LABELS = dict(ready='可生成', exists='已有成片', novideo='不做视频', await_review='提示词待审',
              missing_asset='素材缺失', invalid='配置错误', human='待人工处理')


def video_key():
    return (os.environ.get('KLING_API_KEY', '').strip()
            or os.environ.get('MINIMAX_API_KEY', '').strip())


def pid_alive(pid):
    if pid <= 0:
        return None
    if os.name == 'nt':
        import ctypes
        from ctypes import wintypes
        k = ctypes.WinDLL('kernel32', use_last_error=True)
        k.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        k.OpenProcess.restype = wintypes.HANDLE
        k.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
        k.CloseHandle.argtypes = [wintypes.HANDLE]
        handle = k.OpenProcess(0x1000, False, pid)
        if not handle:
            return False if ctypes.get_last_error() == 87 else None
        try:
            code = wintypes.DWORD()
            return code.value == 259 if k.GetExitCodeProcess(handle, ctypes.byref(code)) else None
        finally:
            k.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return None


def acquire_lock(path):
    for _ in range(3):
        try:
            fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.write(fd, str(os.getpid()).encode('ascii'))
            return fd
        except FileExistsError:
            try:
                before = path.stat()
                pid = int(path.read_text().strip())
                if pid_alive(pid) is not False:
                    raise FileExistsError(f'任务锁对应进程 {pid} 仍在运行或状态无法确认')
                after = path.stat()
                if (before.st_mtime_ns, before.st_ino) != (after.st_mtime_ns, after.st_ino):
                    continue
                path.unlink()
            except FileNotFoundError:
                continue
            except ValueError:
                raise FileExistsError('任务锁格式无效，请先确认旧任务已退出')
    raise FileExistsError('无法取得任务锁，请稍后重试')


def read_json(path, default=None):
    if not path.exists() and default is not None:
        return default
    return json.loads(path.read_text(encoding='utf-8-sig'))


def fingerprint(shot):
    raw = '|'.join(str(shot.get(k) or '') for k in ('prompt', 'mode', 'key', 'last', 'mid'))
    h = 5381
    b = raw.encode('utf-16-le')
    for i in range(0, len(b), 2):
        h = (h * 33 + int.from_bytes(b[i:i+2], 'little')) & 0xFFFFFFFF
    return h


def asset(base, rel):
    p = (base / rel).resolve()
    # 所有素材必须留在项目里；允许 autofix 下的 ../storyboard 路径。
    root = base.parent.resolve()
    if not p.is_relative_to(root):
        raise ValueError('素材路径超出项目：' + str(rel))
    return p


def make_plan(root, shots, review, state, ids=None, regenerate=False):
    known = [s['id'] for s in shots]
    if len(set(known)) != len(known):
        raise ValueError('分镜表存在重复镜头编号')
    if ids and set(ids) - set(known):
        raise ValueError('未知镜头：' + ', '.join(sorted(set(ids) - set(known))))
    rows = []
    for s in shots:
        sid = s['id']
        if ids and sid not in ids:
            continue
        row = dict(id=sid, status='ready', reason='', duration=s.get('duration', 6),
                   mode=s.get('mode') or 'hailuo', placeholder=bool(s.get('placeholder')))
        rows.append(row)
        if s.get('novideo'):
            row.update(status='novideo', reason='分镜表标记不做视频')
            continue
        try:
            if not re.fullmatch(r'[A-Za-z0-9_-]+', sid):
                raise ValueError('镜头编号包含不支持的字符')
            dur = float(s.get('duration') or 6)
            if not math.isfinite(dur) or dur <= 0:
                raise ValueError('时长必须是正数')
            video = asset(root / 'moban_game', s.get('video') or f'vid/{sid}.mp4')
            row['video'] = str(video)
            if video.is_file() and video.stat().st_size and not regenerate:
                row.update(status='exists', reason='保留已有成片；需重拍时加 --regenerate')
                continue
            prev = state.get('shots', {}).get(sid, {})
            if prev.get('status') == 'human' and not regenerate:
                row.update(status='human', reason='上次生成需要人工处理；检查后可 --regenerate')
                continue
            if prev.get('status') in ('installed', 'manual', 'needs_lipsync') and not regenerate:
                row.update(status='invalid', reason='状态显示已完成但成片缺失；检查后可 --regenerate')
                continue
            if not (s.get('prompt') or '').strip():
                raise ValueError('没有视频提示词')
            key = asset(root / 'autofix', s['key']) if s.get('key') else asset(
                root / 'moban_game', s.get('keyframe') or f'img/{sid}.jpg')
            files = [key]
            row['keyframe'] = str(key)
            for field in ('last', 'mid'):
                if s.get(field):
                    files.append(asset(root / 'autofix', s[field]))
            for ref in s.get('refs', []):
                files.append(asset(root / 'autofix', '../' + (ref if isinstance(ref, str) else ref[0])))
            for ref in s.get('gen_refs', []):
                files.append(asset(root / 'autofix', 'refs_gen/' + ref['name'] + '.png'))
            missing = [str(p) for p in files if not p.is_file() or not p.stat().st_size]
            if missing:
                row.update(status='missing_asset', reason='缺失或空文件：' + '; '.join(missing))
                continue
            approved = review.get('vprompt:' + sid) or {}
            if not (approved.get('ok') and approved.get('mtime') == fingerprint(s)):
                row.update(status='await_review', reason='到剪辑台“③ 视频提示词”审核当前提示词')
        except (ValueError, TypeError, KeyError) as exc:
            row.update(status='invalid', reason=str(exc))
    return rows


def execution(root, ids, engine, budget, spent, regenerate):
    cmd = [sys.executable, '-u', str(root / 'autofix/autofix.py'), '--again' if regenerate else '--redo',
           ','.join(ids)]
    if engine:
        cmd.append('--engine=' + engine)
    env = os.environ.copy()
    if video_key():
        env['MINIMAX_API_KEY'] = video_key()
    env.update(PYTHONIOENCODING='utf-8', PYTHONUTF8='1', AUTOFIX_OUT='out',
               AUTOFIX_BUDGET=str(spent + budget))
    return cmd, env


def positive(value):
    n = float(value)
    if not math.isfinite(n) or n <= 0:
        raise argparse.ArgumentTypeError('必须为大于零的有限数字')
    return n


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('shots', nargs='*', help='镜头编号，空格或逗号分隔；默认全表')
    ap.add_argument('--root', type=Path, default=Path(__file__).resolve().parent.parent)
    ap.add_argument('--run', action='store_true', help='执行生成；默认只显示预检')
    ap.add_argument('--budget', type=positive, default=20, help='本次新增生成费用估算上限（元），不含质检费用')
    ap.add_argument('--limit', type=int, help='本次最多处理的可生成镜头数')
    ap.add_argument('--engine', choices=ENGINES, help='覆盖模型；默认沿用每条配置')
    ap.add_argument('--regenerate', action='store_true', help='重新生成指定/全部镜头，已有成片由原流程备份')
    ap.add_argument('--report', type=Path, help='保存 JSON 预检清单')
    args = ap.parse_args(argv)
    if args.limit is not None and args.limit < 1:
        ap.error('--limit 必须大于零')
    root = args.root.resolve()
    try:
        data = read_json(root / 'autofix/video_shots.json')
        state = read_json(root / 'autofix/out/state.json', {'spent': 0, 'shots': {}})
        review = read_json(root / 'storyboard/out/review.json', {})
        ids = [x for a in args.shots for x in a.split(',') if x]
        rows = make_plan(root, data['shots'], review, state, ids, args.regenerate)
        ready = [r['id'] for r in rows if r['status'] == 'ready']
        selected = ready[:args.limit] if args.limit else ready
        print('批量视频预检（本步骤不调用模型）', flush=True)
        for r in rows:
            print(f"{r['id']:18} {LABELS[r['status']]}  {r['reason']}", flush=True)
        print('统计：' + '，'.join(f'{LABELS[k]} {v}' for k, v in Counter(r['status'] for r in rows).items()))
        print(f'本次选中 {len(selected)} 条；新增预算约 ¥{args.budget:g}（沿用项目估价，含自动重拍，不含质检）。')
        if args.report:
            args.report.parent.mkdir(parents=True, exist_ok=True)
            args.report.write_text(json.dumps(dict(root=str(root), rows=rows, selected=selected),
                                              ensure_ascii=False, indent=2), encoding='utf-8')
        if not args.run:
            print('添加 --run 才会开始正式生成。')
            return 0
        if not selected:
            print('没有可生成镜头，请根据预检清单处理。')
            return 2
        if not video_key():
            raise ValueError('缺少环境变量 KLING_API_KEY（也兼容 MINIMAX_API_KEY）')
        if not os.environ.get('GEMINI_API_KEY', '').strip():
            raise ValueError('缺少环境变量 GEMINI_API_KEY')
        cmd, env = execution(root, selected, args.engine, args.budget,
                             float(state.get('spent', 0)), args.regenerate)
        out = root / 'autofix/out'
        out.mkdir(parents=True, exist_ok=True)
        # 防止两个批量入口同时读写同一份状态。不会拦截剪辑台启动的独立任务。
        lock = out / 'batch_generate.lock'
        try:
            fd = acquire_lock(lock)
        except FileExistsError:
            raise ValueError('已有批量入口运行；如上次异常退出，确认没有任务后删除 autofix/out/batch_generate.lock')
        try:
            os.close(fd)
            log = out / ('batch_' + datetime.now().strftime('%Y%m%d_%H%M%S') + '.log')
            print('开始生成；日志：' + str(log), flush=True)
            with log.open('w', encoding='utf-8') as f:
                result = subprocess.run(cmd, cwd=root, env=env, stdout=f, stderr=subprocess.STDOUT)
            updated = read_json(out / 'state.json')
            done = 0
            for sid in selected:
                status = updated.get('shots', {}).get(sid, {}).get('status', 'todo')
                print(f'{sid}: {status}')
                video = Path(next(r['video'] for r in rows if r['id'] == sid))
                done += (status in ('installed', 'manual', 'needs_lipsync')
                         and video.is_file() and video.stat().st_size > 0)
            print(f'已完成 {done}/{len(selected)}；详细结果见 {log} 和 autofix/out/autofix.html')
            return 0 if result.returncode == 0 and done == len(selected) else 1
        finally:
            lock.unlink(missing_ok=True)
    except (OSError, ValueError, KeyError, TypeError) as exc:
        print('无法执行：' + str(exc), file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
