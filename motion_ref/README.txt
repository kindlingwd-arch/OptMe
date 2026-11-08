参考视频：用代码生成简单的动态示意（三种方式对比）

先决条件：autofix\test_motion\<镜头>\motion.json 里有轨迹（双击 autofix\test_motion.bat 时 Gemini 会标一条；可以手改坐标）。

双击：
  ref_all.bat       四种都跑一遍，最后打开对比页（默认镜头 ask）
  ref_svg.bat       ① SVG 加关键帧（第一次自动 pip install playwright，用电脑自带的 Edge 截图，不下载浏览器）
  ref_manim.bat     ② Manim（第一次自动 pip install manim）
  ref_three.bat     ④ three.js 3D 预演（简化人体模型，手按轨迹走；只要 playwright）
  ref_remotion.bat  ③ Remotion（要先装 Node.js LTS：https://nodejs.org；第一次自动 npm install 约 200MB）
换镜头：在这个文件夹打开命令行，输入 ref_all.bat 镜头名

结果在 out\ 里：<镜头>_svg.mp4、<镜头>_svg.svg（会动的 SVG，浏览器直接打开）、<镜头>_manim.mp4、<镜头>_remotion.mp4、<镜头>_compare.html（对比页）。
三种方式用同一份逐帧数据（out\<镜头>_track.json），动作完全一样，只比画法和工具好不好用。
