import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Core} from '../src/core/core';
import {Profiler} from '../src/core/log';
async function main(){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'workspace-map-small-ssh-')),source=path.join(root,'source'),remote='/tmp/'+path.basename(root);
 await fs.mkdir(source);for(let n=0;n<200;n++)await fs.writeFile(path.join(source,`文件 ${n}.txt`),'fixture');
 const core=new Core(path.join(root,'state'),process.env.WM_HELPER_PATH!,new Profiler(()=>{}));
 await core.init([{id:'source',kind:'local',root:source,name:'source'},{id:'target',kind:'ssh',root:remote,name:'train',host:'gpu-lab',sshConfig:process.env.WM_SSH_CONFIG,python:'python3'}]);
 const target=core.endpoints.get('target');
 try{
  await target.call('mkdir',{path:remote});const cpu=process.cpuUsage(),start=performance.now();
  const job=await core.dispatch('transfer',{sources:[{endpoint:'source',path:source}],target:{endpoint:'target',path:remote},mode:'copy',conflict:'overwrite'});
  while(['running','queued'].includes(core.jobs.get(job.id).state))await new Promise(r=>setTimeout(r,20));
  const done=await core.dispatch('job',{id:job.id});if(done.state!=='completed')throw Error(done.error);
  const d=process.cpuUsage(cpu),result={ms:performance.now()-start,cpuMs:(d.user+d.system)/1000,files:done.files,bytes:done.bytes,memory:process.memoryUsage(),resources:await target.call('resources')};
  await fs.writeFile(process.argv[2],JSON.stringify(result,null,2));console.log(JSON.stringify({ms:result.ms,cpuMs:result.cpuMs,files:result.files}));
 }finally{await target.call('remove',{path:remote,recursive:true}).catch(()=>{});await core.dispose();await fs.rm(root,{recursive:true,force:true})}
}
void main();
