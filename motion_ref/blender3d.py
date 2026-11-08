"""完整 3D 预演（灰模）：用代码在 Blender 里搭场景——出租车（五门两厢夏利、左舵）、警车、人偶（会走、会坐、手会伸）、
站前建筑、路灯、树、雪——按参数做动作和运镜，渲染成参考视频。看的是空间关系：车头朝向、谁坐哪、机位、走位、灯光方向。

  blender.exe -b --factory-startup -P blender3d.py -- <场景名> <输出文件夹> [--fast]
  也能在装了 bpy 模块的普通 Python 里跑：python blender3d.py -- <场景名> <输出文件夹>
场景：start（女人提箱走向出租车，镜头推近）  ask（车内：女人放下合十的手、伸手按腿上的皮箱）  check（检查站：警灯闪，民警走到司机窗边打手电）
坐标：米，Z 朝上。出租车车头朝 +X，左舵：司机坐在 +Y 一侧（车头朝前看是左边）。
"""
import sys, os, math, random
import bpy
from mathutils import Vector, Matrix, Quaternion

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:]
SCENE = argv[0] if argv else "start"; OUTD = argv[1] if len(argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "out", SCENE + "_3d_frames")
FAST = "--fast" in argv
W, H, FPS, DUR = int(os.environ.get("B3D_W", 640)), int(os.environ.get("B3D_H", 360)), int(os.environ.get("B3D_FPS", 15)), 6.0
NF = int(DUR * FPS)

bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
sc.render.resolution_x, sc.render.resolution_y, sc.render.resolution_percentage = W, H, 100
sc.render.fps = FPS; sc.frame_start, sc.frame_end = 1, NF
ENGINE = os.environ.get("B3D_ENGINE", "cycles").lower()        # eevee：用显卡，快；cycles：CPU 也能跑，慢一些但光影更真
sc.render.engine = "CYCLES"
if ENGINE == "eevee":
    for eid in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE"):
        try: sc.render.engine = eid; break
        except Exception: pass
    try: sc.eevee.taa_render_samples = 32
    except Exception: pass
    for k in ("use_shadows", "use_raytracing"):
        try: setattr(sc.eevee, k, True)
        except Exception: pass
print("BLENDER3D: engine " + sc.render.engine, flush=True)
try: sc.cycles.device = "CPU"
except Exception: pass
sc.cycles.samples = 8 if FAST else int(os.environ.get("B3D_SAMPLES", "24")); sc.cycles.use_denoising = True
try: sc.cycles.denoiser = "OPENIMAGEDENOISE"
except Exception: pass
sc.cycles.max_bounces = 3; sc.cycles.diffuse_bounces = 2; sc.cycles.glossy_bounces = 1; sc.cycles.transmission_bounces = 3; sc.cycles.transparent_max_bounces = 8
sc.render.use_persistent_data = True
sc.view_settings.view_transform = "AgX" if "AgX" in [i.identifier for i in sc.view_settings.bl_rna.properties["view_transform"].enum_items] else "Filmic"
sc.view_settings.exposure = 0.0
sc.render.image_settings.file_format = "PNG"; os.makedirs(OUTD, exist_ok=True); sc.render.filepath = os.path.join(OUTD, "f_")
world = bpy.data.worlds.new("night"); sc.world = world; world.use_nodes = True
world.node_tree.nodes["Background"].inputs[0].default_value = (0.012, 0.016, 0.03, 1); world.node_tree.nodes["Background"].inputs[1].default_value = 1.0


# ---------------- 材质 ----------------
def mat(name, color, rough=.6, metal=0, emit=None, estr=0, alpha=1.0, glass=False):
    m = bpy.data.materials.get(name)
    if m: return m
    m = bpy.data.materials.new(name); m.use_nodes = True; b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*color, 1); b.inputs["Roughness"].default_value = rough; b.inputs["Metallic"].default_value = metal
    if emit is not None:
        k = "Emission Color" if "Emission Color" in b.inputs else "Emission"; b.inputs[k].default_value = (*emit, 1); b.inputs["Emission Strength"].default_value = estr
    if glass:
        b.inputs["Transmission Weight" if "Transmission Weight" in b.inputs else "Transmission"].default_value = 1.0; b.inputs["Roughness"].default_value = .05; b.inputs["IOR"].default_value = 1.2
    if alpha < 1: b.inputs["Alpha"].default_value = alpha
    return m


M = {k: mat(k, *v) for k, v in {
    "snow": ((.82, .85, .9), .7), "red": ((.55, .03, .03), .35, .1), "white": ((.85, .85, .85), .4), "black": ((.02, .02, .02), .8),
    "tire": ((.015, .015, .015), .9), "glassd": ((.05, .06, .08), .05, .3), "concrete": ((.35, .34, .32), .9), "skin": ((.75, .55, .45), .55),
    "fur": ((.18, .1, .06), .95), "boot": ((.03, .03, .03), .4), "coat_g": ((.18, .22, .12), .9), "uniform": ((.05, .07, .1), .8), "denim": ((.08, .12, .25), .8),
    "case": ((.03, .03, .03), .35, .2), "dash": ((.04, .04, .04), .7), "seat": ((.25, .17, .09), .8), "trunk": ((.18, .14, .1), .9), "pole": ((.15, .15, .15), .5, .6),
    "hair": ((.02, .015, .01), .7)}.items()}
M["glass"] = mat("glass", (.7, .8, .9), glass=True)
M["head_l"] = mat("head_l", (1, 1, .9), emit=(1, .95, .8), estr=12); M["tail_l"] = mat("tail_l", (1, .1, .05), emit=(1, .05, .02), estr=6)
M["sign"] = mat("sign", (1, .8, .1), emit=(1, .75, .1), estr=5); M["win_l"] = mat("win_l", (1, .8, .5), emit=(1, .7, .4), estr=3)
M["lamp_l"] = mat("lamp_l", (1, .7, .4), emit=(1, .65, .3), estr=30); M["dash_l"] = mat("dash_l", (.2, 1, .4), emit=(.2, 1, .4), estr=2)


def obj_from(o, name, m):
    o.name = name
    if m: o.data.materials.clear(); o.data.materials.append(m)
    return o


def box(name, size, loc, m, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc, rotation=rot); o = bpy.context.active_object; o.scale = size; return obj_from(o, name, m)


def cyl(name, r, depth, loc, m, rot=(0, 0, 0), v=20):
    bpy.ops.mesh.primitive_cylinder_add(radius=r, depth=depth, location=loc, rotation=rot, vertices=v); return obj_from(bpy.context.active_object, name, m)


def sph(name, r, loc, m, seg=20):
    bpy.ops.mesh.primitive_uv_sphere_add(radius=r, location=loc, segments=seg, ring_count=seg // 2); o = obj_from(bpy.context.active_object, name, m); bpy.ops.object.shade_smooth(); return o


def prism(name, profile, width, m, y0=0.0):
    """侧面轮廓（x, z 点列）沿 Y 拉伸成实体，中心在 y0。"""
    me = bpy.data.meshes.new(name); n = len(profile); vs = [(x, y0 - width / 2, z) for x, z in profile] + [(x, y0 + width / 2, z) for x, z in profile]
    fs = [list(range(n))[::-1], list(range(n, 2 * n))] + [(i, (i + 1) % n, n + (i + 1) % n, n + i) for i in range(n)]
    me.from_pydata(vs, [], fs); me.update(); o = bpy.data.objects.new(name, me); sc.collection.objects.link(o); o.data.materials.append(m); return o


def parent(children, p):
    for c in children: c.parent = p; c.matrix_parent_inverse = p.matrix_world.inverted()


def empty(name, loc=(0, 0, 0)):
    e = bpy.data.objects.new(name, None); sc.collection.objects.link(e); e.location = loc; return e


def light(name, kind, loc, energy, color=(1, 1, 1), size=.2, rot=None, spot=None):
    ld = bpy.data.lights.new(name, kind); ld.energy = energy; ld.color = color
    try: ld.shadow_soft_size = size
    except Exception: pass
    if spot and kind == "SPOT": ld.spot_size = math.radians(spot); ld.spot_blend = .4
    o = bpy.data.objects.new(name, ld); sc.collection.objects.link(o); o.location = loc
    if rot: o.rotation_euler = rot
    return o


def aim(o, target):
    d = Vector(target) - o.location; o.rotation_mode = "QUATERNION"; o.rotation_quaternion = d.to_track_quat("-Z", "Y")


# ---------------- 车 ----------------
def taxi(name="taxi", interior=False):
    """红色夏利出租车（五门两厢掀背）。车头朝 +X，原点在车身中心地面上。interior=True：拆掉车顶外壳，换成座椅、仪表台、方向盘、立柱、挡风玻璃，相机可以放进车里。"""
    root = empty(name); parts = []
    body = [(-1.95, .28), (1.95, .28), (1.98, .55), (1.95, .78), (1.1, .86), (-1.95, .92)]
    if not interior: parts.append(prism(name + "_body", body, 1.6, M["red"]))
    else:                                                       # 车内景：车身做成空壳（两侧车门、地板、前后围），人坐在里面看得见
        for y in (.77, -.77): parts.append(prism(f"{name}_door{y}", body, .06, M["red"], y0=y))
        parts.append(box(name + "_floor", (3.8, 1.5, .06), (0, 0, .3), M["dash"])); parts.append(box(name + "_rear", (.06, 1.5, .6), (-1.92, 0, .62), M["red"]))
    parts.append(box(name + "_stripe", (3.7, 1.62, .05), (0, 0, .62), M["white"]))
    if not interior:
        cab = [(1.08, .86), (.5, 1.36), (-1.45, 1.4), (-1.92, .96), (-1.95, .92)]
        parts.append(prism(name + "_cab", cab, 1.48, M["red"]))
        win = [(1.0, .9), (.52, 1.3), (-1.42, 1.34), (-1.85, .98), (-1.85, .9)]
        parts.append(prism(name + "_win", win, 1.5, M["glassd"]))
        parts.append(box(name + "_sign", (.32, .14, .12), (-.45, 0, 1.47), M["sign"]))
    else:
        for x, z0, z1, lean in ((1.06, .86, 1.34, .55), (-.15, .9, 1.38, 0), (-1.85, .92, 1.36, -.45)):   # A / B / C 柱（两侧）
            for y in (.74, -.74): parts.append(box(f"{name}_pil{x}{y}", (.06, .06, z1 - z0), (x - lean * .25, y, (z0 + z1) / 2), M["red"], rot=(0, lean * .7, 0)))
        parts.append(box(name + "_roof", (2.0, 1.5, .05), (-.45, 0, 1.4), M["red"]))
        ws = box(name + "_ws", (.62, 1.44, .01), (.8, 0, 1.1), M["glass"], rot=(0, math.radians(-50), 0)); parts.append(ws)
        parts.append(box(name + "_dash", (.45, 1.46, .22), (.78, 0, .92), M["dash"]))
        parts.append(box(name + "_dashlight", (.02, .3, .05), (.555, .38, .96), M["dash_l"]))
        for y in (.38, -.38):                                     # 前排座椅
            parts.append(box(f"{name}_seat{y}", (.5, .5, .12), (-.15, y, .48), M["seat"])); parts.append(box(f"{name}_back{y}", (.12, .5, .65), (-.42, y, .82), M["seat"], rot=(0, math.radians(-12), 0)))
        bpy.ops.mesh.primitive_torus_add(major_radius=.19, minor_radius=.02, location=(.42, .38, 1.0), rotation=(0, math.radians(-65), 0))
        parts.append(obj_from(bpy.context.active_object, name + "_wheel", M["black"]))
        parts.append(box(name + "_tassel", (.02, .02, .18), (.5, 0, 1.22), mat("tassel", (.7, .02, .02), .8)))
    for x in (1.25, -1.25):
        for y in (.72, -.72): parts.append(cyl(f"{name}_w{x}{y}", .29, .2, (x, y, .29), M["tire"], rot=(math.pi / 2, 0, 0)))
    for y in (.55, -.55):
        parts.append(box(f"{name}_hl{y}", (.04, .25, .1), (1.98, y, .66), M["head_l"])); parts.append(box(f"{name}_tl{y}", (.04, .22, .12), (-1.97, y, .74), M["tail_l"]))
    parent(parts, root)
    for y in (.55, -.55):
        l = light(f"{name}_beam{y}", "SPOT", (2.0, y, .66), 300, (1, .93, .8), .05, spot=45); l.parent = root; l.rotation_euler = (0, math.radians(95), 0)
    return root


def police(name="police"):
    root = empty(name); parts = []
    parts.append(prism(name + "_body", [(-2.1, .35), (2.1, .35), (2.15, .95), (1.5, 1.05), (1.0, 1.75), (-2.1, 1.8)], 1.8, M["white"]))
    parts.append(prism(name + "_win", [(1.45, 1.1), (.98, 1.7), (-1.9, 1.74), (-1.9, 1.1)], 1.82, M["glassd"]))
    parts.append(box(name + "_stripe", (4.0, 1.83, .12), (0, 0, .8), mat("pblue", (.05, .1, .45), .5)))
    for x in (1.35, -1.35):
        for y in (.82, -.82): parts.append(cyl(f"{name}_w{x}{y}", .34, .25, (x, y, .34), M["tire"], rot=(math.pi / 2, 0, 0)))
    mr = mat(name + "_lr", (1, .05, .05), emit=(1, .05, .05), estr=0); mb = mat(name + "_lb", (.1, .2, 1), emit=(.1, .25, 1), estr=0)
    parts.append(box(name + "_barR", (.25, .55, .12), (.2, .3, 1.86), mr)); parts.append(box(name + "_barB", (.25, .55, .12), (.2, -.3, 1.86), mb))
    parent(parts, root)
    lr = light(name + "_LR", "POINT", (.2, .3, 2.1), 0, (1, .1, .1), .1); lb = light(name + "_LB", "POINT", (.2, -.3, 2.1), 0, (.2, .3, 1), .1)
    lr.parent = root; lb.parent = root
    return root, mr, mb, lr, lb


# ---------------- 人偶 ----------------
class Person:
    """用简单几何体拼的人：躯干、头、头发、四肢（每一节是一个圆柱，关节是球），每帧按骨架算出关节的位置再摆放，手可以用两节 IK 伸到指定点。"""
    def __init__(self, name, top, legs=None, coat=False, hat=None, h=1.0):
        self.n = name; self.h = h; s = h
        self.torso = cyl(name + "_torso", .17 * s, 1, (0, 0, 0), top); self.head = sph(name + "_head", .11 * s, (0, 0, 0), M["skin"])
        self.neck = cyl(name + "_neck", .05 * s, 1, (0, 0, 0), M["skin"], v=12); self.neck.rotation_mode = "QUATERNION"
        self.hair = sph(name + "_hair", .118 * s, (0, 0, 0), M["hair"]) if not hat else None
        self.hat = (cyl(name + "_hat", .13 * s, .12 * s, (0, 0, 0), hat) if hat else None)
        self.coat = None
        if coat:
            bpy.ops.mesh.primitive_cone_add(radius1=.3 * s, radius2=.18 * s, depth=1, vertices=24); self.coat = obj_from(bpy.context.active_object, name + "_coat", top)
        self.seg = {}
        for k, r, m in (("ua_l", .05, top), ("fa_l", .045, top), ("ua_r", .05, top), ("fa_r", .045, top), ("th_l", .07, legs or top), ("sh_l", .055, legs or top), ("th_r", .07, legs or top), ("sh_r", .055, legs or top)):
            self.seg[k] = cyl(f"{name}_{k}", r * s, 1, (0, 0, 0), m, v=12); self.seg[k].rotation_mode = "QUATERNION"
        self.hand = {k: sph(f"{name}_hand_{k}", .045 * s, (0, 0, 0), M["skin"], 12) for k in "lr"}
        self.foot = {k: box(f"{name}_foot_{k}", (.24 * s, .1 * s, .08 * s), (0, 0, 0), M["boot"]) for k in "lr"}
        self.torso.rotation_mode = "QUATERNION"
        if self.coat: self.coat.rotation_mode = "QUATERNION"
        for f in self.foot.values(): f.rotation_mode = "XYZ"

    @staticmethod
    def place(o, a, b):
        d = b - a; o.location = (a + b) / 2; o.scale = (1, 1, max(1e-3, d.length)); o.rotation_quaternion = Vector((0, 0, 1)).rotation_difference(d.normalized())

    @staticmethod
    def ik(S, T, la, lb, pole):
        d = T - S; L = min(d.length, (la + lb) * .999); d.normalize(); Tn = S + d * L
        x = (la * la - lb * lb + L * L) / (2 * L); hh = math.sqrt(max(0, la * la - x * x)); p = (pole - d * pole.dot(d)).normalized()
        return S + d * x + p * hh, Tn

    def pose(self, fr, root, yaw, sit=False, walk=None, hands=None, lean=0.0, head_turn=0.0):
        """root：脚底中心（坐着时是座面中心）；yaw：面朝方向（弧度，0 = +X）；walk：走路相位（弧度）或 None；hands：{"l"/"r": 世界坐标目标}；lean：上身前倾（弧度）。"""
        s = self.h; root = Vector(root); f = Vector((math.cos(yaw), math.sin(yaw), 0)); r = Vector((math.sin(yaw), -math.cos(yaw), 0)); up = Vector((0, 0, 1)); hands = hands or {}
        pelvis = root + up * (.02 if sit else .92 * s)
        spine = (up * math.cos(lean) + f * math.sin(lean)).normalized()
        chest = pelvis + spine * .5 * s; neck = chest + spine * .08 * s; headc = neck + spine * .13 * s + f * .02
        self.place(self.torso, pelvis, chest); self.torso.scale = (1, 1, (chest - pelvis).length)
        hr = Quaternion(up, head_turn); self.head.location = headc
        self.place(self.neck, chest - spine * .03, headc - spine * .06)
        if self.hair: self.hair.location = headc + spine * .02 - (hr @ f) * .025
        if self.hat: self.hat.location = headc + spine * .1
        if self.coat:
            hem = pelvis - up * (.1 if sit else .55) * s + (f * .25 * s if sit else Vector())
            self.place(self.coat, hem, pelvis + spine * .32 * s)
        for side, sg in (("l", 1), ("r", -1)):
            hip = pelvis + r * (-sg) * .1 * s; sh = chest - spine * .04 * s + r * (-sg) * .2 * s
            if sit:
                knee = hip + f * .44 * s + up * .02; ank = knee - up * .42 * s
            else:
                a = (math.sin(walk + (0 if side == "l" else math.pi)) * math.radians(24)) if walk is not None else 0
                dth = (-up * math.cos(a) + f * math.sin(a)); knee = hip + dth * .45 * s
                bend = max(0, math.sin(walk + (0 if side == "l" else math.pi) + 1.2)) * math.radians(35) if walk is not None else 0
                dsh = (-up * math.cos(a - bend) + f * math.sin(a - bend)); ank = knee + dsh * .45 * s
            self.place(self.seg["th_" + side], hip, knee); self.place(self.seg["sh_" + side], knee, ank)
            ft = self.foot[side]; ft.location = ank + f * .06 * s - up * .03 * s; ft.rotation_euler = (0, 0, yaw)
            if side in hands:
                T = Vector(hands[side]); E, Tn = self.ik(sh, T, .3 * s, .28 * s, (-up * .6 + r * (-sg) * .7))
            else:
                a = (math.sin(walk + (math.pi if side == "l" else 0)) * math.radians(18)) if walk is not None else math.radians(8)
                E = sh + (-up * math.cos(a) + f * math.sin(a)) * .3 * s; Tn = E + (-up * math.cos(a + .25) + f * math.sin(a + .25)) * .28 * s
            self.place(self.seg["ua_" + side], sh, E); self.place(self.seg["fa_" + side], E, Tn); self.hand[side].location = Tn
        objs = [self.torso, self.neck, self.head] + ([self.hair] if self.hair else []) + ([self.hat] if self.hat else []) + ([self.coat] if self.coat else []) + list(self.seg.values()) + list(self.hand.values()) + list(self.foot.values())
        for o in objs:
            o.keyframe_insert("location", frame=fr)
            if o.rotation_mode == "QUATERNION": o.keyframe_insert("rotation_quaternion", frame=fr)
            else: o.keyframe_insert("rotation_euler", frame=fr)
            o.keyframe_insert("scale", frame=fr)
        return {"hand_l": self.hand["l"].location.copy(), "hand_r": self.hand["r"].location.copy(), "head": headc}


# ---------------- 环境 ----------------
def ground(size=120):
    bpy.ops.mesh.primitive_plane_add(size=size, location=(0, 0, 0)); obj_from(bpy.context.active_object, "ground", M["snow"])


def street_lamp(x, y, h=6.5, energy=900):
    cyl(f"lamp{x}{y}", .06, h, (x, y, h / 2), M["pole"]); sph(f"lampbulb{x}{y}", .18, (x, y, h + .1), M["lamp_l"], 12)
    light(f"lampL{x}{y}", "POINT", (x, y, h - .1), energy, (1, .62, .28), .3)


def tree(x, y, h=7):
    cyl(f"tr{x}{y}", .15, h * .4, (x, y, h * .2), M["trunk"])
    for k, (r, z) in enumerate(((1.6, .45), (1.25, .65), (.85, .82))):
        bpy.ops.mesh.primitive_cone_add(radius1=r * h / 7, depth=h * .35, location=(x, y, h * z), vertices=10); obj_from(bpy.context.active_object, f"tc{x}{y}{k}", mat("pine", (.04, .08, .05), .9))


def birch(x, y, h=9):
    cyl(f"bi{x}{y}", .13, h, (x, y, h / 2), mat("birch", (.8, .8, .76), .8))


def station(x0=-6, y0=22):
    box("station", (40, 8, 9), (x0, y0, 4.5), M["concrete"]); box("canopy", (40, 4, .4), (x0, y0 - 5, 3.6), M["concrete"])
    for i in range(14):
        box(f"swin{i}", (2.0, .1, 1.6), (x0 - 18 + i * 2.8, y0 - 4.05, 5.6), M["win_l"]); box(f"swinl{i}", (2.0, .1, 1.4), (x0 - 18 + i * 2.8, y0 - 4.05, 1.8), M["win_l"])
    light("stationfill", "AREA", (x0, y0 - 7, 3), 600, (1, .75, .5), 8, rot=(math.radians(90), 0, 0))


def snowfall(center, size=(30, 30), count=1500, top=10):
    """雪：一群小白点从上往下匀速落（每片两个关键帧、线性插值），位置随机但固定，每次渲染一样。"""
    rnd = random.Random(3); bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1, radius=1, location=(0, 0, -50)); proto = bpy.context.active_object
    fm = proto.data; fm.materials.append(mat("flakem", (1, 1, 1), .5, emit=(1, 1, 1), estr=1.5)); bpy.data.objects.remove(proto)
    fall = 1.2 * DUR
    for n in range(count):
        o = bpy.data.objects.new(f"fl{n}", fm); sc.collection.objects.link(o); r = rnd.uniform(.012, .028); o.scale = (r, r, r)
        x, y, z = center[0] + rnd.uniform(-size[0] / 2, size[0] / 2), center[1] + rnd.uniform(-size[1] / 2, size[1] / 2), rnd.uniform(0, top + fall)
        wx, wy = rnd.uniform(-.6, .6), rnd.uniform(-.3, .3)
        o.location = (x, y, z); o.keyframe_insert("location", frame=1); o.location = (x + wx, y + wy, z - fall); o.keyframe_insert("location", frame=NF)
    for a in bpy.data.actions:
        try:
            for fc in a.fcurves:
                for kp in fc.keyframe_points: kp.interpolation = "LINEAR"
        except Exception:
            pass


def camera(loc, target, lens=35):
    cd = bpy.data.cameras.new("cam"); cd.lens = lens; cd.clip_start = .05; cd.clip_end = 300; c = bpy.data.objects.new("cam", cd); sc.collection.objects.link(c); sc.camera = c
    c.location = loc; aim(c, target); return c


def key_cam(c, fr, loc, target, lens=None):
    c.location = loc; aim(c, target); c.keyframe_insert("location", frame=fr); c.keyframe_insert("rotation_quaternion", frame=fr)
    if lens: c.data.lens = lens; c.data.keyframe_insert("lens", frame=fr)


def ease(x): x = min(1, max(0, x)); return x * x * (3 - 2 * x)


def lerp(a, b, t): return Vector(a).lerp(Vector(b), t)


# ---------------- 场景 ----------------
def scene_start():
    """客运站门口：出租车停在路边（车头朝右，车尾对着镜头一侧），女人提着皮箱从左下往车门走，走到副驾驶门前五步停下；镜头缓慢推近；下雪。"""
    ground(); station(); street_lamp(4.5, 9); street_lamp(-9, 9); street_lamp(14, 8)
    for i, (x, y) in enumerate(((9, 14), (11, 17), (16, 12), (-14, 15))): tree(x, y)
    birch(7.2, 3.5); birch(7.8, 5.5)
    car = taxi(); car.location = (2.0, 4.0, 0); car.rotation_euler = (0, 0, math.radians(-8))
    w = Person("woman", M["fur"], M["boot"], coat=True); case = box("case", (.45, .12, .32), (0, 0, 0), M["case"])
    cam = camera((-3.4, -6.5, 1.7), (0.6, 3.0, 1.1), 32)
    snowfall((0, 2), (28, 24), 2200 if not FAST else 900)
    door = Vector((1.6, 2.9, 0))                                     # 副驾驶车门（车右侧，朝向镜头一侧）前五步
    p0, p1 = Vector((-2.6, -1.4, 0)), door + Vector((-2.3, -1.2, 0))
    for fr in range(1, NF + 1):
        t = (fr - 1) / FPS; k = ease(min(1, t / 5.0)); pos = p0.lerp(p1, k); yaw = math.atan2(p1.y - p0.y, p1.x - p0.x)
        walking = t < 5.0; ph = t * 2 * math.pi * 0.9
        j = w.pose(fr, pos, yaw, walk=ph if walking else None)
        case.location = j["hand_r"] - Vector((0, 0, .18)); case.rotation_euler = (0, 0, yaw); case.keyframe_insert("location", frame=fr); case.keyframe_insert("rotation_euler", frame=fr)
        f = ease(t / DUR); key_cam(cam, fr, lerp((-3.4, -6.5, 1.7), (-2.4, -4.4, 1.6), f), lerp((0.4, 3.0, 1.1), (0.8, 2.6, 1.0), f))


def scene_ask():
    """车内：从司机的位置看向副驾驶（左舵，女人坐在右边 -Y 侧），她先双手合十取暖，然后放下手、身体前探，伸手按住腿上的皮箱把手；挡风玻璃外是夜里的路灯和雪。"""
    ground(); street_lamp(14, 3, energy=1500); street_lamp(30, -4, energy=1500)
    for i in range(10): tree(18 + i * 4, (-9 if i % 2 else 9), 7 + (i % 3))
    car = taxi(interior=True)
    w = Person("woman", M["fur"], M["boot"], coat=True)
    case = box("case", (.42, .14, .3), (.18, -.38, .78), M["case"]); case.rotation_euler = (0, math.radians(-15), 0)
    handle = Vector((.42, -.38, .9))
    snowfall((15, 0), (40, 20), 2000 if not FAST else 800, 8)
    light("dashfill", "AREA", (.6, 0, 1.05), 8, (.3, 1, .5), .4, rot=(0, math.radians(-100), 0))
    light("cabin", "POINT", (-.3, 0, 1.3), 4, (1, .8, .6), .3)
    cam = camera((-.45, .48, 1.22), (.3, -.42, .98), 20)
    seat = Vector((-.1, -.38, .54))
    for fr in range(1, NF + 1):
        t = (fr - 1) / FPS
        pray = Vector((.18, -.38, 1.15)) + Vector((0, 0, .02 * math.sin(t * 6)))
        k = ease((t - 1.2) / 2.6); tgt = pray.lerp(handle, k); lean = math.radians(4 + 18 * k)
        w.pose(fr, seat, 0.0, sit=True, hands={"l": tgt + Vector((0, .05, 0)), "r": tgt + Vector((0, -.05, 0))}, lean=lean)
        f = ease(t / DUR); key_cam(cam, fr, lerp((-.45, .48, 1.22), (-.3, .4, 1.18), f), lerp((.3, -.42, .98), (.32, -.42, .95), f))


def scene_check():
    """林间公路检查站：出租车停着（车头朝 +X），警车停在前方斜对着，红蓝警灯交替；民警从警车走到司机窗边（车左侧 +Y），弯腰打手电往车里照。镜头在左前方，缓慢推近。"""
    ground(); street_lamp(6, 7, energy=700)
    for i in range(16): tree(-20 + i * 3.2, 11 + (i % 3) * 2.5, 7 + (i % 4)); tree(-20 + i * 3.4, -12 - (i % 2) * 3, 8)
    box("barrier", (.12, 4.5, .12), (6.5, -1.5, 1.0), mat("barr", (.8, .1, .1), .5)); box("booth", (2, 2, 2.6), (8.5, 4.5, 1.3), M["concrete"]); box("boothwin", (.05, 1.2, .8), (7.48, 4.5, 1.6), M["win_l"])
    car = taxi(); car.location = (0, 0, 0)
    pc, mr, mb, lr, lb = police(); pc.location = (6.5, 3.6, 0); pc.rotation_euler = (0, 0, math.radians(-150))
    cop = Person("cop", M["uniform"], M["uniform"], hat=M["uniform"], h=1.03)
    torch = light("torch", "SPOT", (0, 0, 0), 60, (1, .95, .85), .02, spot=25)
    snowfall((2, 1), (30, 24), 2000 if not FAST else 800)
    cam = camera((-4.5, 6.5, 1.6), (1.0, .8, 1.0), 30)
    win = Vector((.2, .82, 1.15)); p0, p1 = Vector((4.6, 2.6, 0)), Vector((.15, 1.45, 0))
    for fr in range(1, NF + 1):
        t = (fr - 1) / FPS; k = ease(t / 3.6); pos = p0.lerp(p1, k); walking = t < 3.6
        yaw = math.atan2(p1.y - p0.y, p1.x - p0.x) if walking else math.radians(-95)
        lean = math.radians(25) * ease((t - 3.6) / .8)
        j = cop.pose(fr, pos, yaw, walk=t * 2 * math.pi * 1.0 if walking else None, hands={"r": win + Vector((.25, .12, .05))} if not walking else None, lean=lean)
        torch.location = j["hand_r"]; aim(torch, (j["hand_r"] + Vector((-.15, -1.4, -.35))) if not walking else (j["hand_r"] + Vector((math.cos(yaw), math.sin(yaw), -.4)) * 2))
        torch.keyframe_insert("location", frame=fr); torch.keyframe_insert("rotation_quaternion", frame=fr)
        on = (int(t * 3) % 2 == 0); mr.node_tree.nodes["Principled BSDF"].inputs["Emission Strength"].default_value = 25 if on else .5
        mb.node_tree.nodes["Principled BSDF"].inputs["Emission Strength"].default_value = .5 if on else 25
        for m in (mr, mb): m.node_tree.nodes["Principled BSDF"].inputs["Emission Strength"].keyframe_insert("default_value", frame=fr)
        lr.data.energy = 900 if on else 0; lb.data.energy = 0 if on else 1100; lr.data.keyframe_insert("energy", frame=fr); lb.data.keyframe_insert("energy", frame=fr)
        f = ease(t / DUR); key_cam(cam, fr, lerp((-4.5, 6.5, 1.6), (-3.2, 4.8, 1.5), f), lerp((1.0, .8, 1.0), (.6, .9, 1.05), f))
    # 关键帧插值改成常量，警灯不渐变
    for m in (mr, mb):
        ad = m.node_tree.animation_data
        if ad and ad.action:
            try:
                for fc in ad.action.fcurves:
                    for kp in fc.keyframe_points: kp.interpolation = "CONSTANT"
            except Exception: pass


{"start": scene_start, "ask": scene_ask, "check": scene_check}[SCENE]()
print(f"BLENDER3D: {SCENE} ready, rendering {NF} frames", flush=True)
if os.environ.get("B3D_END"): sc.frame_end = int(os.environ["B3D_END"])
ONLY = os.environ.get("B3D_ONLY")                      # 调试：只渲染几帧，比如 B3D_ONLY=1,45,90
if ONLY:
    for f in [int(x) for x in ONLY.split(",")]:
        sc.frame_set(f); sc.render.filepath = os.path.join(OUTD, f"f_{f:04d}"); bpy.ops.render.render(write_still=True)
else:
    bpy.ops.render.render(animation=True)
print("BLENDER3D: done", flush=True)
