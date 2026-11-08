"""仅首次生成入口：默认预览；--run 执行，每个镜头只生成一版。"""
import sys
from run_all_videos import main

if __name__ == '__main__':
    raise SystemExit(main(['--first-only'] + sys.argv[1:]))
