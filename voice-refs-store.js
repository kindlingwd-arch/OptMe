"use strict";
const fs=require('fs'),path=require('path'),{randomUUID}=require('crypto');
const folder=dir=>path.resolve(dir,'..','refs');
const registry=dir=>path.join(folder(dir),'voice_refs.json');
function validate(id){if(!/^[a-z][a-z0-9_]{1,60}$/.test(id||''))throw new Error('音色编号格式不正确');}
function audioPath(dir,rel){
 if(!/^refs\/voices\/[a-z0-9_-]+\.(mp3|wav|m4a|ogg)$/i.test(rel||''))throw new Error('声音文件路径不正确');
 return path.join(folder(dir),...rel.split('/').slice(1));
}
function read(dir){
 const f=registry(dir);if(!fs.existsSync(f))return [];
 const data=JSON.parse(fs.readFileSync(f,'utf8'));if(!Array.isArray(data.voices))throw new Error('声音登记文件格式错误');
 return data.voices;
}
function load(dir){return {voices:read(dir).map(v=>{
 validate(v.id);const p=v.file?audioPath(dir,v.file):null,exists=!!(p&&fs.existsSync(p)&&fs.statSync(p).size);
 const preview=v.preview_file?audioPath(dir,v.preview_file):null;
 return {...v,exists,mtime:exists?fs.statSync(p).mtimeMs:0,preview_exists:!!(preview&&fs.existsSync(preview)&&fs.statSync(preview).size)};
})};}
function write(dir,voices){
 const root=folder(dir),f=registry(dir);fs.mkdirSync(root,{recursive:true});
 if(fs.existsSync(f)){const old=path.join(root,'voices','_old');fs.mkdirSync(old,{recursive:true});fs.copyFileSync(f,path.join(old,Date.now()+'_'+randomUUID()+'_voice_refs.json'));}
 const tmp=f+'.'+randomUUID()+'.tmp';fs.writeFileSync(tmp,JSON.stringify({voices},null,2),'utf8');fs.renameSync(tmp,f);
 return load(dir);
}
function save(dir,entry){
 validate(entry.id);const voices=read(dir),i=voices.findIndex(v=>v.id===entry.id);
 if(entry._delete)return write(dir,voices.filter(v=>v.id!==entry.id));
 const v=i>=0?{...voices[i]}:{id:entry.id,name:'新音色',role:'',notes:'',voice_id:'',file:''};
 for(const key of ['name','role','notes','voice_id'])if(entry[key]!==undefined)v[key]=String(entry[key]).trim();
 if(entry.voice_id!==undefined&&String(entry.voice_id).trim()!==(voices[i]||{}).voice_id){v.preview_file='';v.clone_status=v.voice_id?'ready':'';v.pending_voice_id='';}
 if(!v.name)throw new Error('请填写音色名称');
 if(i>=0)voices[i]=v;else voices.push(v);return write(dir,voices);
}
function importAudio(dir,id,src){
 validate(id);const voices=read(dir),v=voices.find(v=>v.id===id);if(!v)throw new Error('请先保存音色资料');
 const ext=path.extname(src).toLowerCase();if(!['.mp3','.wav','.m4a','.ogg'].includes(ext))throw new Error('请选择 MP3、WAV、M4A 或 OGG 声音文件');
 const st=fs.statSync(src);if(!st.isFile()||!st.size)throw new Error('声音文件为空或不可读取');
 if(st.size>20*1024*1024)throw new Error('参考录音请控制在 20 MB 以内');
 const name=id+'_'+randomUUID()+ext,dst=path.join(folder(dir),'voices',name);fs.mkdirSync(path.dirname(dst),{recursive:true});
 fs.copyFileSync(src,dst);v.file='refs/voices/'+name;return write(dir,voices);
}
function generated(dir,id,patch){
 validate(id);const voices=read(dir),v=voices.find(v=>v.id===id);if(!v)throw new Error('声音参考已被移除');
 for(const key of ['voice_id','clone_status','pending_voice_id','cloned_from','clone_error','preview_file','preview_text'])if(patch[key]!==undefined)v[key]=String(patch[key]);
 if(v.preview_file)audioPath(dir,v.preview_file);return write(dir,voices);
}
module.exports={load,save,importAudio,generated};
