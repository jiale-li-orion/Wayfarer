"""Read-only Linux VS Code / Agent resource samples. No command-line payloads are stored."""
import argparse,json,time,os
from pathlib import Path

def read_sample():
    items=[]
    for p in Path("/proc").iterdir():
        if not p.name.isdigit():continue
        try:
            if p.stat().st_uid!=os.getuid():continue
            cmd=(p/"cmdline").read_bytes().decode(errors="replace").replace("\0"," ")
            if not any(k in cmd for k in [".vscode-server/","workspace-map/client/","<workspace-map>"]):continue
            stat=(p/"stat").read_text().split(") ",1)[1].split();status=(p/"status").read_text();mem={}
            for line in status.splitlines():
                if line.startswith(("VmRSS:","VmSwap:")):mem[line.split(":")[0]]=int(line.split()[1])*1024
            role="vscode-other"
            for key,value in [("app-server","codex-app-server"),("extensionHost","extension-host"),("agentHost","agent-host"),("copilot-runtime","copilot-runtime"),("tsserver","tsserver"),("serverWorkerMain","markdown-server"),("jsonServerMain","json-server"),("fileWatcher","file-watcher"),("mcp.py","map-mcp"),("base64.b64decode","map-helper")]:
                if key in cmd:role=value;break
            row=dict(pid=int(p.name),ppid=int(stat[1]),role=role,cpuSeconds=(int(stat[11])+int(stat[12]))/os.sysconf("SC_CLK_TCK"),threads=int(stat[17]),rss=mem.get("VmRSS",0),swapBytes=mem.get("VmSwap",0))
            try:
                row["fds"]=len(list((p/"fd").iterdir()))
                for line in (p/"smaps_rollup").read_text().splitlines():
                    if line.startswith("Pss:"):row["pss"]=int(line.split()[1])*1024;break
            except (OSError,PermissionError):pass
            items.append(row)
        except (OSError,ValueError,IndexError):pass
    return items

def main():
    p=argparse.ArgumentParser();p.add_argument("--output",required=True);p.add_argument("--seconds",type=float,default=120);p.add_argument("--interval",type=float,default=5);a=p.parse_args();start=time.monotonic()
    with open(a.output,"w") as f:
        while True:
            f.write(json.dumps(dict(at=time.time(),elapsed=time.monotonic()-start,processes=read_sample()))+"\n");f.flush()
            if time.monotonic()-start>=a.seconds:break
            time.sleep(min(a.interval,max(0,a.seconds-(time.monotonic()-start))))
if __name__=="__main__":main()
