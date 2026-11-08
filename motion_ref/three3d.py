"""three.js 版完整 3D 预演（和 blender3d.py 的 start 场景同一个布景，用来对比两种工具）。
浏览器（优先电脑自带的 Edge）逐帧截图，ffmpeg 合成。不用装 Blender，几十秒出片；画质比 Blender（Cycles）粗：没有真实的光线反弹，阴影和灯光是近似的。
用法：python three3d.py [start]   输出 out\\start_three3d.mp4
"""
import os, sys, subprocess, time, shutil

HERE = os.path.dirname(os.path.abspath(__file__)); OUT = os.path.join(HERE, "out")
W, H, FPS, DUR = 640, 360, 15, 6.0

HTML = r"""<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#000;overflow:hidden}</style></head><body>
<script>__THREE__</script><script>
const W=__W__,H=__H__,FPS=__FPS__,DUR=__DUR__,NF=Math.round(FPS*DUR);
const R=new THREE.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});R.setSize(W,H);R.setPixelRatio(1);R.shadowMap.enabled=true;R.shadowMap.type=THREE.PCFSoftShadowMap;
R.outputEncoding=THREE.sRGBEncoding;R.toneMapping=THREE.ACESFilmicToneMapping;R.toneMappingExposure=.9;document.body.appendChild(R.domElement);
const S=new THREE.Scene();S.background=new THREE.Color(0x070a14);S.fog=new THREE.FogExp2(0x0b0f1c,0.018);
// Z 朝上（和 Blender 一致）
const cam=new THREE.PerspectiveCamera(42,W/H,0.05,300);cam.up.set(0,0,1);
const std=(c,o={})=>new THREE.MeshStandardMaterial(Object.assign({color:c,roughness:.7},o));
const M={snow:std(0xd2d8e6,{roughness:.8}),red:std(0x8c0808,{roughness:.35,metalness:.1}),white:std(0xdddddd),tire:std(0x080808,{roughness:.9}),glass:std(0x0d0f14,{roughness:.05,metalness:.3}),
 concrete:std(0x5a5752,{roughness:.9}),fur:std(0x2e1a0f,{roughness:.95}),skin:std(0xc08c72),boot:std(0x080808,{roughness:.4}),hair:std(0x050403),case:std(0x080808,{roughness:.35}),
 pine:std(0x0a140c),trunk:std(0x2e2419),birch:std(0xcccbc2),pole:std(0x262626,{metalness:.6}),
 winL:new THREE.MeshBasicMaterial({color:0xffcf8a}),lampL:new THREE.MeshBasicMaterial({color:0xffb060}),head:new THREE.MeshBasicMaterial({color:0xfff4d8}),tail:new THREE.MeshBasicMaterial({color:0xff1a0a}),sign:new THREE.MeshBasicMaterial({color:0xffc020})};
function mesh(g,m,p,cast=true){const o=new THREE.Mesh(g,m);if(p)o.position.set(...p);o.castShadow=cast;o.receiveShadow=true;S.add(o);return o;}
const box=(s,p,m)=>mesh(new THREE.BoxGeometry(...s),m,p);
function cylZ(r,h,p,m,seg=20){const g=new THREE.CylinderGeometry(r,r,h,seg);g.rotateX(Math.PI/2);return mesh(g,m,p);}
function prism(profile,width,m,y0=0){const sh=new THREE.Shape(profile.map(([x,z])=>new THREE.Vector2(x,z)));const g=new THREE.ExtrudeGeometry(sh,{depth:width,bevelEnabled:false});g.rotateX(Math.PI/2);g.translate(0,y0+width/2,0);return mesh(g,m);}
// 地面、站房、路灯、树
mesh(new THREE.PlaneGeometry(120,120),M.snow,[0,0,0],false);
box([40,8,9],[-6,22,4.5],M.concrete);box([40,4,.4],[-6,17,3.6],M.concrete);
for(let i=0;i<14;i++){box([2,.1,1.6],[-24+i*2.8,17.95,5.6],M.winL);box([2,.1,1.4],[-24+i*2.8,17.95,1.8],M.winL);}
const fill=new THREE.RectAreaLight?null:null;
const amb=new THREE.HemisphereLight(0x2a3550,0x1a1612,.22);S.add(amb);
function lamp(x,y,h=6.5,I=2.2){cylZ(.06,h,[x,y,h/2],M.pole,8);mesh(new THREE.SphereGeometry(.18,12,8),M.lampL,[x,y,h+.1],false);const l=new THREE.PointLight(0xff9e48,I,35,1.6);l.position.set(x,y,h-.1);l.castShadow=true;l.shadow.mapSize.set(1024,1024);S.add(l);}
lamp(4.5,9);lamp(-9,9);lamp(14,8);
const sf=new THREE.PointLight(0xffc080,1.2,26,1.5);sf.position.set(-6,15,3);S.add(sf);
function tree(x,y,h=7){cylZ(.15,h*.4,[x,y,h*.2],M.trunk,8);[[1.6,.45],[1.25,.65],[.85,.82]].forEach(([r,z])=>{const g=new THREE.ConeGeometry(r*h/7,h*.35,10);g.rotateX(Math.PI/2);mesh(g,M.pine,[x,y,h*z]);});}
[[9,14],[11,17],[16,12],[-14,15]].forEach(([x,y])=>tree(x,y));cylZ(.13,9,[7.2,3.5,4.5],M.birch,10);cylZ(.13,9,[7.8,5.5,4.5],M.birch,10);
// 出租车（五门两厢，车头 +X，左舵）
const car=new THREE.Group();
{const add=o=>{S.remove(o);car.add(o);};
 add(prism([[-1.95,.28],[1.95,.28],[1.98,.55],[1.95,.78],[1.1,.86],[-1.95,.92]],1.6,M.red));
 add(prism([[1.08,.86],[.5,1.36],[-1.45,1.4],[-1.92,.96],[-1.95,.92]],1.48,M.red));
 add(prism([[1.0,.9],[.52,1.3],[-1.42,1.34],[-1.85,.98],[-1.85,.9]],1.5,M.glass));
 add(box([3.7,1.62,.05],[0,0,.62],M.white));add(box([.32,.14,.12],[-.45,0,1.47],M.sign));
 for(const x of [1.25,-1.25])for(const y of [.72,-.72]){const g=new THREE.CylinderGeometry(.29,.29,.2,20);add(mesh(g,M.tire,[x,y,.29]));}
 for(const y of [.55,-.55]){add(box([.04,.25,.1],[1.98,y,.66],M.head));add(box([.04,.22,.12],[-1.97,y,.74],M.tail));}
 for(const y of [.55,-.55]){const l=new THREE.SpotLight(0xffeecc,2.5,25,Math.PI/8,.4,1.5);l.position.set(2,y,.66);l.target.position.set(10,y,0);car.add(l);car.add(l.target);}
 const tl=new THREE.PointLight(0xff2010,.6,4,2);tl.position.set(-2.2,0,.75);car.add(tl);}
car.position.set(2,4,0);car.rotation.z=-8*Math.PI/180;S.add(car);
// 人偶
function Person(top,legs,coat){
 const P={};const cyl=(r,m)=>{const g=new THREE.CylinderGeometry(r,r,1,12);return mesh(g,m);};
 P.torso=cyl(.17,top);P.neck=cyl(.05,M.skin);P.head=mesh(new THREE.SphereGeometry(.11,20,12),M.skin);P.hair=mesh(new THREE.SphereGeometry(.118,20,12),M.hair);
 if(coat){P.coat=mesh(new THREE.CylinderGeometry(.18,.3,1,24),top);}
 P.seg={};for(const k of ["ua_l","fa_l","ua_r","fa_r"])P.seg[k]=cyl(.05,top);for(const k of ["th_l","sh_l","th_r","sh_r"])P.seg[k]=cyl(.065,legs);
 P.hand={l:mesh(new THREE.SphereGeometry(.045,12,8),M.skin),r:mesh(new THREE.SphereGeometry(.045,12,8),M.skin)};P.foot={l:box([.24,.1,.08],[0,0,0],M.boot),r:box([.24,.1,.08],[0,0,0],M.boot)};
 const Y=new THREE.Vector3(0,1,0);
 P.place=(o,a,b)=>{const d=b.clone().sub(a);o.position.copy(a).add(b).multiplyScalar(.5);o.scale.set(1,Math.max(1e-3,d.length()),1);o.quaternion.setFromUnitVectors(Y,d.normalize());};
 P.pose=(root,yaw,walk)=>{const up=new THREE.Vector3(0,0,1),f=new THREE.Vector3(Math.cos(yaw),Math.sin(yaw),0),r=new THREE.Vector3(Math.sin(yaw),-Math.cos(yaw),0);
  const pel=root.clone().add(up.clone().multiplyScalar(.92)),ch=pel.clone().add(up.clone().multiplyScalar(.5)),hc=ch.clone().add(up.clone().multiplyScalar(.21)).add(f.clone().multiplyScalar(.02));
  P.place(P.torso,pel,ch);P.place(P.neck,ch.clone().sub(up.clone().multiplyScalar(.03)),hc.clone().sub(up.clone().multiplyScalar(.06)));P.head.position.copy(hc);P.hair.position.copy(hc).add(up.clone().multiplyScalar(.02)).sub(f.clone().multiplyScalar(.025));
  if(P.coat)P.place(P.coat,pel.clone().sub(up.clone().multiplyScalar(.55)),pel.clone().add(up.clone().multiplyScalar(.32)));
  for(const [side,sg] of [["l",1],["r",-1]]){
   const ph=walk==null?null:walk+(side=="l"?0:Math.PI);const a=ph==null?0:Math.sin(ph)*24*Math.PI/180,bend=ph==null?0:Math.max(0,Math.sin(ph+1.2))*35*Math.PI/180;
   const hip=pel.clone().add(r.clone().multiplyScalar(-sg*.1)),sh=ch.clone().sub(up.clone().multiplyScalar(.04)).add(r.clone().multiplyScalar(-sg*.2));
   const dth=up.clone().multiplyScalar(-Math.cos(a)).add(f.clone().multiplyScalar(Math.sin(a))),kn=hip.clone().add(dth.multiplyScalar(.45));
   const dsh=up.clone().multiplyScalar(-Math.cos(a-bend)).add(f.clone().multiplyScalar(Math.sin(a-bend))),an=kn.clone().add(dsh.multiplyScalar(.45));
   P.place(P.seg["th_"+side],hip,kn);P.place(P.seg["sh_"+side],kn,an);P.foot[side].position.copy(an).add(f.clone().multiplyScalar(.06));P.foot[side].rotation.z=yaw;
   const aa=ph==null?8*Math.PI/180:Math.sin(ph+Math.PI)*18*Math.PI/180;
   const E=sh.clone().add(up.clone().multiplyScalar(-Math.cos(aa)).add(f.clone().multiplyScalar(Math.sin(aa))).multiplyScalar(.3));
   const T=E.clone().add(up.clone().multiplyScalar(-Math.cos(aa+.25)).add(f.clone().multiplyScalar(Math.sin(aa+.25))).multiplyScalar(.28));
   P.place(P.seg["ua_"+side],sh,E);P.place(P.seg["fa_"+side],E,T);P.hand[side].position.copy(T);}
  return P.hand.r.position.clone();};
 return P;}
const woman=Person(M.fur,M.boot,true);const kase=box([.45,.12,.32],[0,0,0],M.case);
// 雪
const N=2200,pos=new Float32Array(N*3),seed=[];let s0=3;const rnd=()=>{s0=(s0*16807)%2147483647;return s0/2147483647;};
for(let i=0;i<N;i++){seed.push([rnd()*28-14,rnd()*24-10,rnd()*17,rnd()*1.2-.6,rnd()*.6-.3]);}
const sg=new THREE.BufferGeometry();sg.setAttribute("position",new THREE.BufferAttribute(pos,3));
const snow=new THREE.Points(sg,new THREE.PointsMaterial({color:0xffffff,size:.05,sizeAttenuation:true,transparent:true,opacity:.9}));S.add(snow);
const ease=x=>{x=Math.min(1,Math.max(0,x));return x*x*(3-2*x);};const V=(a,b,c)=>new THREE.Vector3(a,b,c);
const p0=V(-2.6,-1.4,0),p1=V(1.6-2.3,2.9-1.2,0);
window.setFrame=i=>{const t=i/FPS,k=ease(Math.min(1,t/5)),p=p0.clone().lerp(p1,k),yaw=Math.atan2(p1.y-p0.y,p1.x-p0.x),walking=t<5;
 const hr=woman.pose(p,yaw,walking?t*2*Math.PI*.9:null);kase.position.copy(hr).sub(V(0,0,.18));kase.rotation.z=yaw;
 for(let n=0;n<N;n++){const [x,y,z,wx,wy]=seed[n],f=t/DUR,fall=7.2;pos[n*3]=x+wx*f;pos[n*3+1]=y+wy*f;pos[n*3+2]=z-fall*f;}sg.attributes.position.needsUpdate=true;
 const f=ease(t/DUR);cam.position.copy(V(-3.4,-6.5,1.7).lerp(V(-2.4,-4.4,1.6),f));cam.lookAt(V(.4,3,1.1).lerp(V(.8,2.6,1.0),f));
 R.render(S,cam);};
setFrame(0);window.__ok=1;
</script></body></html>"""


def main():
    os.makedirs(OUT, exist_ok=True)
    three = open(os.path.join(HERE, "three", "three.min.js"), encoding="utf-8").read()
    page = HTML.replace("__THREE__", three).replace("__W__", str(W)).replace("__H__", str(H)).replace("__FPS__", str(FPS)).replace("__DUR__", str(DUR))
    hp = os.path.join(OUT, "start_three3d.html"); open(hp, "w", encoding="utf-8").write(page)
    from playwright.sync_api import sync_playwright
    ffm = shutil.which("ffmpeg")
    if not ffm:
        import imageio_ffmpeg; ffm = imageio_ffmpeg.get_ffmpeg_exe()
    out = os.path.join(OUT, "start_three3d.mp4"); n = int(FPS * DUR); t0 = time.time()
    ff = subprocess.Popen([ffm, "-y", "-v", "error", "-f", "image2pipe", "-framerate", str(FPS), "-i", "-", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", out], stdin=subprocess.PIPE)
    with sync_playwright() as p:
        b = None
        for kw in ({"channel": "msedge"}, {"channel": "chrome"}, {}):
            try: b = p.chromium.launch(args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"], **kw); break
            except Exception: continue
        pg = b.new_page(viewport={"width": W, "height": H}); errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.goto("file:///" + hp.replace("\\", "/")); pg.wait_for_function("window.__ok === 1", timeout=30000)
        if errs: sys.exit("页面出错：" + errs[0])
        for i in range(n):
            pg.evaluate(f"setFrame({i})"); ff.stdin.write(pg.screenshot(type="png"))
        b.close()
    ff.stdin.close(); ff.wait(); print(f"视频：{out}（{time.time() - t0:.0f} 秒）", flush=True)


if __name__ == "__main__":
    main()
