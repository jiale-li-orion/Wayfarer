// Profile only an explicitly identified development Extension Host.
import fs from "node:fs/promises";
const [port,pid,seconds,out]=process.argv.slice(2);
if(!port||!pid||!out)throw Error("Usage: node profile-inspector.mjs <port> <expected-pid> <seconds> <output>");
const targets=await(await fetch("http://127.0.0.1:"+Number(port)+"/json/list")).json();
const socket=new WebSocket(targets[0].webSocketDebuggerUrl);let serial=0;const pending=new Map();
socket.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p?.reject(Error(JSON.stringify(m.error))):p?.resolve(m.result);}};
await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++serial;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});
try{
  const actual=(await call("Runtime.evaluate",{expression:"process.pid",returnByValue:true})).result.value;
  if(actual!==Number(pid))throw Error("Unexpected inspector process "+actual);
  await call("Profiler.enable");await call("Profiler.start");
  await new Promise(r=>setTimeout(r,Number(seconds)*1000));
  const result=await call("Profiler.stop");await fs.writeFile(out,JSON.stringify(result.profile));
  console.log(JSON.stringify({pid:actual,seconds:Number(seconds),samples:result.profile.samples?.length,output:out}));
}finally{socket.close();}
