"use strict";
const fs=require('fs'),path=require('path'),{spawn}=require('child_process'),{randomUUID}=require('crypto'),store=require('./voice-refs-store');
const running=new Set();
function worker(job,python){return new Promise((resolve,reject)=>{
 const p=spawn(python,['-u',path.join(__dirname,'voice_clone_worker.py')],{windowsHide:true,env:{...process.env,PYTHONIOENCODING:'utf-8',PYTHONUTF8:'1'},stdio:['pipe','pipe','pipe']});
 let output='';p.stdout.setEncoding('utf8');p.stdout.on('data',x=>{output+=x;});p.stderr.on('data',()=>{});
 p.on('error',()=>reject(new Error('无法启动声音服务，请检查 Python 配置')));
 p.on('close',()=>{try{resolve(JSON.parse(output.trim()));}catch{resolve({ok:false,uncertain:true,error:'声音服务异常结束；请先核实平台记录'});}});
 p.stdin.on('error',()=>{});p.stdin.end(JSON.stringify(job));
});}
async function generate(dir,id,action,text,python,call=worker){
 const key=path.resolve(dir)+':'+id;if(running.has(key))throw new Error('这条声音正在处理，请勿重复点击');
 if(!['clone','preview','dialogue'].includes(action))throw new Error('不支持的声音操作');
 const initial=store.load(dir).voices.find(v=>v.id===id);if(!initial)throw new Error('找不到这条声音参考');
 if(action==='clone'&&initial.voice_id)throw new Error('已经有音色 ID，可直接生成试听；如需重新复刻，请另建一条参考');
 if(action==='clone'&&initial.clone_status==='pending')throw new Error('上次复刻状态待核实，不能自动重复提交；请先到 MiniMax 检查音色记录');
 if(action==='clone'&&!initial.exists)throw new Error('请先导入参考录音');
 if(action!=='clone'&&!initial.voice_id)throw new Error('请先生成音色或填写已有音色 ID');
 const voice=initial.voice_id||('StudioVoice_'+randomUUID().replace(/-/g,''));
 const rel='refs/voices/preview_'+randomUUID()+'.mp3';
 const job={action:action==='dialogue'?'preview':action,voice_id:voice,text,source:initial.file?path.resolve(dir,'..',initial.file):'',output:path.resolve(dir,'..',rel)};
 running.add(key);
 try{
  if(action==='clone')store.generated(dir,id,{clone_status:'pending',pending_voice_id:voice});
  const result=await call(job,python);
  if(!result.ok){
   if(action==='clone'&&!result.uncertain)store.generated(dir,id,{clone_status:'error',clone_error:result.error});
   throw new Error(result.error||'声音处理失败');
  }
  const current=store.load(dir).voices.find(v=>v.id===id);
  if(!current||current.file!==initial.file)throw new Error('参考录音在生成期间已改变；已生成的音色 ID：'+voice+'，请核对后手动保存');
  if(action==='dialogue'){
   if(current.voice_id!==voice)throw new Error('生成期间角色音色已改变，请重新选择');
   const audio=fs.readFileSync(job.output);
   if(!audio.length)throw new Error('语音服务未生成可用的台词音频');
   return new Uint8Array(audio);
  }
  return action==='clone'?store.generated(dir,id,{voice_id:voice,clone_status:'ready',cloned_from:initial.file,clone_error:'',pending_voice_id:''}):store.generated(dir,id,{preview_file:rel,preview_text:job.text||'你好，这是角色的声音试听。'});
 }finally{running.delete(key);if(action==='dialogue')fs.rmSync(job.output,{force:true});}
}
module.exports={generate};
