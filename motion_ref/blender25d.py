"""在 Blender 里搭 2.5D 场景并渲染（由 scene25d.py 调用，不用直接运行）。
  blender.exe -b --factory-startup -P blender25d.py -- <job.json>
也能在装了 bpy 模块的普通 Python 里跑：python blender25d.py -- <job.json>

场景（世界坐标：相机在原点，看向 +Y，上方是 +Z）：
  背景：一张按深度起伏的网格，每个顶点放在「首帧那个像素的视线」上、离相机 d 米，所以从初始机位看过去和首帧一模一样；机位一动就有前后景错位。
  卡片：从首帧抠出来的人 / 车（带透明通道），竖着立在地上，脚底按关键帧在地面上走，走远了自然变小。
  手臂：灰色的上臂、前臂、手，两节骨骼 IK，手按轨迹走。
  方块：灰模道具，按关键帧移动、转向。
  雪：一群小白点往下飘。
  颜色：背景亮度（exposure）、偏色（tint）、警灯红蓝交替（flash）都是参数，逐帧写关键帧。
全部用自发光材质，Cycles 每像素 1 次采样就没有噪点，CPU 也快。颜色管理用 Standard，首帧颜色不被改。
"""
import sys, os, json, math, random

import bpy
from mathutils import Vector, Quaternion

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:]
JOB = json.load(open(argv[0], encoding="utf-8"))
W, H = JOB["size"]; FPS = JOB["fps"]; NF = JOB["frames"]; DUR = NF / FPS
HFOV = math.radians(JOB.get("hfov", 50.0)); TX = math.tan(HFOV / 2); TY = TX * H / W


def ray(u, v, d):
    """首帧上 (u, v)（0～1，左上为原点）那个像素的视线上、离相机 d 米（沿 +Y 量）的点。"""
    return Vector(((2 * u - 1) * TX * d, d, (1 - 2 * v) * TY * d))


def ease(f):
    f = min(1.0, max(0.0, f)); return f * f * (3 - 2 * f)


def interp(keys, t):
    """keys: [[t, a, b, ...], ...] 线性插值 + 缓入缓出。"""
    if t <= keys[0][0]: return keys[0][1:]
    if t >= keys[-1][0]: return keys[-1][1:]
    for i in range(len(keys) - 1):
        a, b = keys[i], keys[i + 1]
        if a[0] <= t <= b[0]:
            f = ease((t - a[0]) / max(1e-6, b[0] - a[0]))
            return [x + (y - x) * f for x, y in zip(a[1:], b[1:])]


# ---------------- 场景基础 ----------------
bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
sc.render.engine = "CYCLES"
try: sc.cycles.device = "CPU"
except Exception: pass
sc.cycles.samples = 1; sc.cycles.use_denoising = False
for k, v in (("max_bounces", 0), ("diffuse_bounces", 0), ("glossy_bounces", 0), ("transmission_bounces", 0), ("transparent_max_bounces", 16)):
    try: setattr(sc.cycles, k, v)
    except Exception: pass
sc.render.resolution_x, sc.render.resolution_y, sc.render.resolution_percentage = W, H, 100
sc.render.fps = FPS; sc.frame_start, sc.frame_end = 1, NF
sc.render.use_persistent_data = True
sc.view_settings.view_transform = "Standard"; sc.view_settings.look = "None"
sc.render.image_settings.file_format = "PNG"
sc.render.filepath = os.path.join(JOB["frames_dir"], "f_")
world = bpy.data.worlds.new("W"); sc.world = world; world.use_nodes = True
world.node_tree.nodes["Background"].inputs[0].default_value = (0, 0, 0, 1)


def emit_material(name, image=None, color=(1, 1, 1), alpha=False, shade=False, strength=1.0):
    """自发光材质：image（带不带透明）或纯色；shade=True 用朝向做一点明暗（灰模看得出体积）。"""
    m = bpy.data.materials.new(name); m.use_nodes = True; nt = m.node_tree; N = nt.nodes; L = nt.links
    for n in list(N): N.remove(n)
    out = N.new("ShaderNodeOutputMaterial"); em = N.new("ShaderNodeEmission"); em.inputs["Strength"].default_value = strength
    tint = N.new("ShaderNodeMixRGB"); tint.blend_type = "MULTIPLY"; tint.inputs[0].default_value = 1.0; tint.inputs[2].default_value = (1, 1, 1, 1); tint.name = "TINT"
    if image:
        tex = N.new("ShaderNodeTexImage"); tex.image = bpy.data.images.load(image); tex.interpolation = "Linear"; tex.extension = "EXTEND"
        L.new(tex.outputs["Color"], tint.inputs[1])
    else:
        rgb = N.new("ShaderNodeRGB"); rgb.outputs[0].default_value = (*color, 1)
        if shade:                                            # 正对相机亮，侧面暗
            lw = N.new("ShaderNodeLayerWeight"); lw.inputs["Blend"].default_value = 0.45
            mix = N.new("ShaderNodeMixRGB"); mix.blend_type = "MULTIPLY"; mix.inputs[0].default_value = 1.0
            inv = N.new("ShaderNodeInvert"); L.new(lw.outputs["Facing"], inv.inputs["Color"])
            ramp = N.new("ShaderNodeMapRange"); ramp.inputs["To Min"].default_value = 0.35; L.new(inv.outputs["Color"], ramp.inputs["Value"])
            L.new(rgb.outputs[0], mix.inputs[1]); L.new(ramp.outputs["Result"], mix.inputs[2]); L.new(mix.outputs[0], tint.inputs[1])
        else: L.new(rgb.outputs[0], tint.inputs[1])
    L.new(tint.outputs[0], em.inputs["Color"])
    if alpha and image:
        tr = N.new("ShaderNodeBsdfTransparent"); mx = N.new("ShaderNodeMixShader")
        L.new(tex.outputs["Alpha"], mx.inputs[0]); L.new(tr.outputs[0], mx.inputs[1]); L.new(em.outputs[0], mx.inputs[2]); L.new(mx.outputs[0], out.inputs["Surface"])
    else: L.new(em.outputs[0], out.inputs["Surface"])
    return m


def add_obj(name, mesh, mat=None):
    o = bpy.data.objects.new(name, mesh); sc.collection.objects.link(o)
    if mat: o.data.materials.append(mat)
    return o


# ---------------- 背景：深度网格 ----------------
dep = JOB["depth"]; GW, GH = dep["gw"], dep["gh"]; DG = dep["grid"]          # DG：GH 行 × GW 列，每格是这个点离相机的距离（米）
verts, uvs, faces = [], [], []
for j in range(GH):
    for i in range(GW):
        u, v = i / (GW - 1), j / (GH - 1); verts.append(tuple(ray(u, v, DG[j][i])))
for j in range(GH - 1):
    for i in range(GW - 1):
        a = j * GW + i; faces.append((a, a + GW, a + GW + 1, a + 1))
me = bpy.data.meshes.new("bg"); me.from_pydata(verts, [], faces); me.update()
uvl = me.uv_layers.new(name="UV")
for poly in me.polygons:
    for li in poly.loop_indices:
        vi = me.loops[li].vertex_index; i, j = vi % GW, vi // GW; uvl.data[li].uv = (i / (GW - 1), 1 - j / (GH - 1))
bg_mat = emit_material("bg", JOB["bg"]); bg = add_obj("bg", me, bg_mat)
TINTS = [bg_mat]

# ---------------- 卡片（人 / 车） ----------------
def ground_depth(u, v):
    i = min(GW - 1, max(0, round(u * (GW - 1)))); j = min(GH - 1, max(0, round(v * (GH - 1)))); return DG[j][i]


cards = []
for k, c in enumerate(JOB.get("cards", [])):
    x0, y0, x1, y1 = c["box"]; d0 = c.get("depth") or ground_depth((x0 + x1) / 2, min(.999, y1 + .005))
    wm, hm = (x1 - x0) * 2 * TX * d0, (y1 - y0) * 2 * TY * d0            # 在 d0 处正好盖住原来那块像素的大小（米）
    m = bpy.data.meshes.new(f"card{k}")
    m.from_pydata([(-wm / 2, 0, 0), (wm / 2, 0, 0), (wm / 2, 0, hm), (-wm / 2, 0, hm)], [], [(0, 1, 2, 3)]); m.update()
    ul = m.uv_layers.new(name="UV")
    for li, uv in zip(range(4), ((0, 0), (1, 0), (1, 1), (0, 1))): ul.data[li].uv = uv
    mat = emit_material(f"card{k}", c["image"], alpha=True); TINTS.append(mat)
    o = add_obj(f"card{k}_{c.get('label', '')}", m, mat)
    keys = c.get("keys") or [[0, (x0 + x1) / 2, y1]]
    cards.append((o, keys, c, d0))

# ---------------- 灰模方块 ----------------
boxes = []
for k, b in enumerate(JOB.get("boxes", [])):
    bpy.ops.mesh.primitive_cube_add(size=1)
    o = bpy.context.active_object; o.name = f"box{k}_{b.get('label', '')}"; o.scale = b.get("size", [1, 1, 1])
    col = b.get("color", [.75, .75, .78]); o.data.materials.append(emit_material(f"boxm{k}", color=col, shade=True)); boxes.append((o, b))

# ---------------- 手臂（两节骨骼 IK） ----------------
def cyl(name, r, col):
    bpy.ops.mesh.primitive_cylinder_add(radius=r, depth=1, vertices=16); o = bpy.context.active_object; o.name = name
    o.data.materials.append(emit_material(name + "m", color=col, shade=True)); o.rotation_mode = "QUATERNION"; return o


def ball(name, r, col):
    bpy.ops.mesh.primitive_uv_sphere_add(radius=r, segments=16, ring_count=10); o = bpy.context.active_object; o.name = name
    o.data.materials.append(emit_material(name + "m", color=col, shade=True)); return o


def place(o, a, b):
    d = b - a; L = max(1e-4, d.length); o.location = (a + b) / 2; o.scale = (1, 1, L)
    o.rotation_quaternion = Vector((0, 0, 1)).rotation_difference(d.normalized())


def ik(S, T, la, lb, pole):
    d = T - S; L = min(d.length, (la + lb) * .999); d.normalize(); Tn = S + d * L
    x = (la * la - lb * lb + L * L) / (2 * L); h = math.sqrt(max(0, la * la - x * x))
    p = (pole - d * pole.dot(d)).normalized()
    return S + d * x + p * h, Tn


arms = []
for k, a in enumerate(JOB.get("arms", [])):
    col = a.get("color", [.85, .82, .78]); dd = a["depth"]; s = a.get("scale", 1.0)
    S = ray(a["shoulder"][0], a["shoulder"][1], min(dd + .08 * s, ground_depth(*a["shoulder"]) * .93))   # 肩膀不能藏到背景后面
    arms.append({"S": S, "keys": a["keys"], "d": dd, "la": .3 * s, "lb": .28 * s, "side": a.get("side", 1),
                 "up": cyl(f"arm{k}u", .045 * s, col), "fo": cyl(f"arm{k}f", .04 * s, col), "el": ball(f"arm{k}e", .05 * s, col), "hd": ball(f"arm{k}h", .055 * s, col)})

# ---------------- 雪 ----------------
snow = JOB.get("snow") or {}
flakes = []
if snow.get("count"):
    rnd = random.Random(7); fm = bpy.data.meshes.new("flake"); bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1, radius=1)
    proto = bpy.context.active_object; fm = proto.data; proto.data.materials.append(emit_material("flake", color=(1, 1, 1), strength=float(snow.get("bright", .9)))); bpy.data.objects.remove(proto)
    far = min(dep["far"], 12.0)
    for n in range(int(snow["count"])):
        d = rnd.uniform(1.5, far); u, v = rnd.uniform(-.1, 1.1), rnd.uniform(-1.0, 1.0)
        o = bpy.data.objects.new(f"s{n}", fm); sc.collection.objects.link(o); r = .0035 * d ** .9 * float(snow.get("size", 1)); o.scale = (r, r, r)
        flakes.append((o, u, v, d, rnd.uniform(.7, 1.3)))

# ---------------- 相机 ----------------
cam_d = bpy.data.cameras.new("cam"); cam = bpy.data.objects.new("cam", cam_d); sc.collection.objects.link(cam); sc.camera = cam
CJ = JOB.get("camera") or {}; MOVE = CJ.get("move", "static"); AMT = float(CJ.get("amount", .3)); C0, C1 = float(CJ.get("start", 0)), float(CJ.get("end", DUR))
DM = dep["median"]; margin = 1.0 if MOVE in ("static", "push_in", "pull_out") else 1.0 + .5 * AMT * 0.25 + .03
cam_d.sensor_fit = "HORIZONTAL"; cam_d.sensor_width = 36; cam_d.clip_start = .05; cam_d.clip_end = 500
cam.rotation_mode = "QUATERNION"
BASE_Q = Vector((0, 1, 0)).to_track_quat("-Z", "Z")          # 相机 -Z 朝 +Y，上方 +Z


def cam_at(t):
    f = ease((t - C0) / max(1e-6, C1 - C0)); pos = Vector((0, 0, 0)); q = BASE_Q.copy(); zoom = margin
    if MOVE == "push_in": pos.y = .15 * AMT * DM * f
    elif MOVE == "pull_out": pos.y = .15 * AMT * DM * (1 - f)
    elif MOVE in ("orbit_left", "orbit_right"):
        ang = math.radians(12 * AMT) * f * (1 if MOVE == "orbit_left" else -1); P = Vector((0, DM, 0))
        pos = P + Quaternion((0, 0, 1), ang) @ (Vector((0, 0, 0)) - P); q = (P - pos).to_track_quat("-Z", "Z")
    elif MOVE in ("pan_left", "pan_right"): q = Quaternion((0, 0, 1), math.radians(6 * AMT) * f * (1 if MOVE == "pan_left" else -1)) @ BASE_Q
    elif MOVE in ("tilt_up", "tilt_down"): q = Quaternion((1, 0, 0), math.radians(5 * AMT) * f * (1 if MOVE == "tilt_up" else -1)) @ BASE_Q
    elif MOVE in ("crane_up", "crane_down"): pos.z = .12 * AMT * DM * f * (1 if MOVE == "crane_up" else -1); zoom = 1.06
    elif MOVE == "breath": pos.y = .025 * DM * f
    return pos, q, zoom


LOOK = JOB.get("look") or {}; EXPO = float(LOOK.get("exposure", 1.0)); TIN = LOOK.get("tint", [1, 1, 1]); FL = LOOK.get("flash")

for fr in range(1, NF + 1):
    t = (fr - 1) / FPS; sc.frame_set(fr)
    pos, q, zoom = cam_at(t); cam.location = pos; cam.rotation_quaternion = q
    cam_d.lens = 18 / (TX / zoom); cam.keyframe_insert("location", frame=fr); cam.keyframe_insert("rotation_quaternion", frame=fr); cam_d.keyframe_insert("lens", frame=fr)
    col = [EXPO * c for c in TIN]
    if FL:                                                   # 警灯：两种颜色按频率交替，叠在画面上
        cs = FL.get("colors", [[1, .35, .35], [.4, .5, 1]]); ph = (t * float(FL.get("hz", 1.5))) % 1.0; a = float(FL.get("amount", .25)) * (.5 + .5 * math.sin(ph * 2 * math.pi * 2)) ** 2
        cc = cs[0] if ph < .5 else cs[1]; col = [c * (1 - a + a * x * 1.6) for c, x in zip(col, cc)]
    for m in TINTS:
        nd = m.node_tree.nodes["TINT"]; nd.inputs[2].default_value = (*col, 1); nd.inputs[2].keyframe_insert("default_value", frame=fr)
    for o, keys, c, d0 in cards:
        fx, fy, *rest = interp(keys, t); dd = (rest[0] if rest and rest[0] else None) or (c.get("depth") or ground_depth(fx, min(.999, fy + .005)))
        o.location = ray(fx, fy, dd); o.keyframe_insert("location", frame=fr)
    for o, b in boxes:
        x, y, dd, yaw = (interp(b["keys"], t) + [0, 0])[:4]; o.location = ray(x, y, dd); o.rotation_euler = (0, 0, math.radians(yaw))
        o.keyframe_insert("location", frame=fr); o.keyframe_insert("rotation_euler", frame=fr)
    for a in arms:
        hx, hy = interp(a["keys"], t)[:2]; T = ray(hx, hy, min(a["d"], ground_depth(hx, hy) * .93)); reach = (T - a["S"]).length; lean = max(0, min(.2, (reach - .45) * .6))   # 手贴在它够到的那个东西前面
        dv = (T - a["S"]); dv.z = 0; Sh = a["S"] + (dv.normalized() * lean if dv.length > 1e-4 else Vector())
        E, Tn = ik(Sh, T, a["la"], a["lb"], Vector((a["side"] * .7, .2, -.6)))
        place(a["up"], Sh, E); place(a["fo"], E, Tn); a["el"].location = E; a["hd"].location = Tn
        for o in (a["up"], a["fo"]): o.keyframe_insert("location", frame=fr); o.keyframe_insert("rotation_quaternion", frame=fr); o.keyframe_insert("scale", frame=fr)
        for o in (a["el"], a["hd"]): o.keyframe_insert("location", frame=fr)
    if flakes:
        sp, wind = float(snow.get("speed", .6)), float(snow.get("wind", .1))
        for o, u, v, d, k in flakes:
            vv = (v + sp * k * t / 3.0) % 2.0 - 1.0 + .5          # 落到底就回到顶上（2 个画面高循环）
            uu = u + wind * k * t / 3.0 + .01 * math.sin(t * 2 + d)
            o.location = ray(uu, vv, d); o.keyframe_insert("location", frame=fr)

# 关键帧都用线性插值（每帧都有关键帧，插值方式无所谓；这样也不会有过冲）
print("BLENDER25D: scene ready, rendering %d frames" % NF, flush=True)
bpy.ops.render.render(animation=True)
print("BLENDER25D: done", flush=True)
