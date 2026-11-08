"""MiniMax 声音复刻/试听；从 stdin 读任务，不打印密钥、不自动重试。"""
import json,os,re,sys,subprocess,shutil,urllib.request,urllib.error,uuid
from pathlib import Path
HOST='https://api.minimax.cn'
# This worker handles one request per process. Use the configured proxy for
# MiniMax even when Windows' bypass list would otherwise force a blocked route.
_system_proxy_bypass=urllib.request.proxy_bypass
def minimax_proxy_bypass(host):
 if host.split(':',1)[0].lower()=='api.minimax.cn' and urllib.request.getproxies().get('https'):
  return False
 return _system_proxy_bypass(host)
urllib.request.proxy_bypass=minimax_proxy_bypass

def validate_audio(file,seconds,size):
 if Path(file).suffix.lower() not in ('.mp3','.m4a','.wav'):raise ValueError('声音复刻需要 MP3、M4A 或 WAV 格式')
 if not 10<=seconds<=300:raise ValueError('参考录音必须为 10 秒到 5 分钟')
 if not 0<size<=20*1024*1024:raise ValueError('参考录音必须非空且不超过 20 MB')
def validate_voice(value):
 if not re.fullmatch(r'[A-Za-z][A-Za-z0-9_-]{6,254}[A-Za-z0-9]',value):raise ValueError('音色 ID 格式不正确（8～256位，字母开头）')
def preview_body(voice,text):
 return dict(model='speech-2.8-hd',text=text,stream=False,language_boost='Chinese',
  voice_setting=dict(voice_id=voice,speed=1,vol=1,pitch=0),
  audio_setting=dict(sample_rate=32000,bitrate=128000,format='mp3',channel=1),subtitle_enable=False)
def api(path,key,body,ctype='application/json'):
 data=json.dumps(body).encode() if isinstance(body,dict) else body
 req=urllib.request.Request(HOST+path,data=data,headers={'Authorization':'Bearer '+key,'Content-Type':ctype})
 try:
  with urllib.request.urlopen(req,timeout=180) as res:reply=json.load(res)
 except urllib.error.HTTPError as e:
  if e.code>=500:raise RuntimeError('平台异常，提交状态待核实')
  try:
   response=json.loads(e.read());msg=(response.get('base_resp') or {}).get('status_msg') or (response.get('error') or {}).get('message') or ''
  except Exception:msg=''
  raise ValueError(f'MiniMax 请求失败（HTTP {e.code}）：{msg}'.replace(key,'[隐藏]'))
 base=reply.get('base_resp') or {}
 if base.get('status_code')!=0:raise ValueError(('MiniMax 返回错误：'+str(base.get('status_msg') or '无有效状态')).replace(key,'[隐藏]'))
 return reply
def duration(file):
 ff=shutil.which('ffmpeg')
 if not ff:
  import imageio_ffmpeg
  ff=imageio_ffmpeg.get_ffmpeg_exe()
 result=subprocess.run([ff,'-hide_banner','-i',str(file)],capture_output=True,encoding='utf-8',errors='replace',stdin=subprocess.DEVNULL,timeout=30)
 match=re.search(r'Duration: (\d+):(\d+):([\d.]+)',result.stderr)
 if not match:raise ValueError('无法读取参考录音时长，请换一个有效的音频文件')
 return int(match[1])*3600+int(match[2])*60+float(match[3])
def run(job):
 key=(os.environ.get('KLING_API_KEY') or os.environ.get('MINIMAX_API_KEY') or '').strip()
 if not key:raise ValueError('缺少 KLING_API_KEY 或 MINIMAX_API_KEY')
 voice=job['voice_id'];validate_voice(voice)
 text=str(job.get('text') or '你好，这是角色的声音试听。').strip()
 if not text or len(text)>300:raise ValueError('试听台词请控制在 1～300 字')
 out=Path(job['output']).resolve();out.parent.mkdir(parents=True,exist_ok=True)
 if job['action']=='clone':
  file=Path(job['source']);validate_audio(file,duration(file),file.stat().st_size)
  boundary='Studio'+uuid.uuid4().hex
  payload=(f'--{boundary}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\nvoice_clone\r\n--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="reference{file.suffix.lower()}"\r\nContent-Type: application/octet-stream\r\n\r\n').encode()+file.read_bytes()+f'\r\n--{boundary}--\r\n'.encode()
  uploaded=api('/v1/files/upload',key,payload,'multipart/form-data; boundary='+boundary)
  fid=(uploaded.get('file') or {}).get('file_id')
  if not fid:raise ValueError('上传录音未返回文件编号')
  # 复刻本身不附带试听，避免一次点击隐含多次付费操作。
  cloned=api('/v1/voice_clone',key,dict(file_id=fid,voice_id=voice,need_noise_reduction=True,need_volume_normalization=True))
  if cloned.get('input_sensitive') is True or cloned.get('input_sensitive_type',0):raise ValueError('参考录音未通过平台检查，请更换录音')
  return dict(ok=True,voice_id=voice)
 if job['action']!='preview':raise ValueError('不支持的声音操作')
 reply=api('/v1/t2a_v2',key,preview_body(voice,text));audio=(reply.get('data') or {}).get('audio')
 if not isinstance(audio,str) or not re.fullmatch(r'[0-9a-fA-F]+',audio) or len(audio)%2:raise ValueError('试听没有返回有效音频')
 out.write_bytes(bytes.fromhex(audio));return dict(ok=True,voice_id=voice,output=str(out))
if __name__=='__main__':
 try:result=run(json.load(sys.stdin))
 except ValueError as e:result=dict(ok=False,error=str(e),uncertain=False)
 except Exception:result=dict(ok=False,error='网络或本地处理异常；请先核对平台任务，避免重复复刻',uncertain=True)
 print(json.dumps(result,ensure_ascii=False))
