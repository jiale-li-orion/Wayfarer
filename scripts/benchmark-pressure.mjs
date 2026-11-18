import fs from "node:fs/promises";
import path from "node:path";
import {createRequire} from "node:module";
const require=createRequire(import.meta.url);
const {SystemMonitor}=require(path.resolve(process.argv[2]));
const root=path.resolve(process.argv[3]),helper=path.resolve(process.argv[4]),python=process.argv[5];
const state=await fs.mkdtemp(path.join(root,"bench-state-"));
const m=new SystemMonitor(()=>[{id:"c",kind:process.platform==="win32"?"windows":"local",name:"Local",root:process.platform==="win32"?"C:/":"/"}],helper,state,{record(){}},python);
const samples=[];const cpu=process.cpuUsage(),start=performance.now();
try{
 for(let i=0;i<8;i++){
  const t=performance.now();const s=await m.snapshot({endpoint:"c",section:"summary"});
  if(s.status!=="online")throw Error(s.error);
  samples.push({elapsedMs:performance.now()-t,collector:s.collector,host:process.memoryUsage(),memory:s.system?.memory});
  if(i<7)await new Promise(r=>setTimeout(r,2100));
 }
 await new Promise(r=>setTimeout(r,100));
 console.log(JSON.stringify({samples,cpu:process.cpuUsage(cpu),wallMs:performance.now()-start,stats:m.stats()}));
}finally{await m.dispose();await fs.rm(state,{recursive:true,force:true});}
