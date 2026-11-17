"""Bounded process sampling; command lines remain in memory and are reduced to roles."""
import argparse, json, time, os, sys
from pathlib import Path
import psutil

def role(p):
    try:
        args=p.cmdline(); command=" ".join(args); name=p.name()
        if "extensionHost" in command or "extension-host" in command:return "extension-host"
        if "copilot-runtime" in command:return "copilot-runtime"
        if "app-server" in args:return "codex-app-server"
        if "mcp.py" in command:return "map-mcp"
        if "base64.b64decode" in command:return "map-helper"
        if "tsserver" in command:return "tsserver"
        if "serverWorkerMain" in command:return "markdown-server"
        if "jsonServerMain" in command:return "json-server"
        if "--type=renderer" in args:return "renderer"
        if "--type=gpu-process" in args:return "gpu"
        if "fileWatcher" in command or "file-watcher" in command:return "file-watcher"
        if "agentHost" in command:return "agent-host"
        if name.lower()=="code.exe":return "code"
        return name
    except (psutil.NoSuchProcess,psutil.AccessDenied):return "unknown"

def sample(p):
    try:
        mem=p.memory_info();cpu=p.cpu_times()
        row=dict(pid=p.pid,ppid=p.ppid(),role=role(p),rss=mem.rss,cpuSeconds=cpu.user+cpu.system,threads=p.num_threads())
        if hasattr(mem,"private"):row["privateBytes"]=mem.private
        if hasattr(p,"num_fds"):row["fds"]=p.num_fds()
        if hasattr(p,"num_handles"):row["handles"]=p.num_handles()
        if sys.platform.startswith("linux"):
            try:row["pss"]=p.memory_full_info().pss
            except (psutil.AccessDenied,AttributeError,psutil.NoSuchProcess):pass
            try:
                with open("/proc/%s/status"%p.pid) as f:
                    for line in f:
                        if line.startswith("VmSwap:"):row["swapBytes"]=int(line.split()[1])*1024
            except OSError:pass
        return row
    except (psutil.NoSuchProcess,psutil.AccessDenied):return None

def main():
    a=argparse.ArgumentParser();a.add_argument("--output",required=True);a.add_argument("--seconds",type=float,default=120);a.add_argument("--root",type=int);a.add_argument("--marker");a.add_argument("--interval",type=float,default=5);args=a.parse_args()
    start=time.monotonic()
    with open(args.output,"w",encoding="utf-8") as f:
        while True:
            rows=list(psutil.process_iter());roots=[]
            for p in rows:
                try:
                    if args.root and p.pid==args.root:roots.append(p)
                    elif args.marker and args.marker in " ".join(p.cmdline()) and "sample.py" not in " ".join(p.cmdline()) and "--type=" not in " ".join(p.cmdline()):roots.append(p)
                except (psutil.NoSuchProcess,psutil.AccessDenied):pass
            owned={}
            for root in roots:
                try:
                    for p in [root]+root.children(recursive=True):owned[p.pid]=p
                except psutil.NoSuchProcess:pass
            entries=[row for p in owned.values() if (row:=sample(p))]
            f.write(json.dumps(dict(at=time.time(),elapsed=time.monotonic()-start,processes=entries))+"\n");f.flush()
            if time.monotonic()-start>=args.seconds:break
            time.sleep(min(args.interval,max(0,args.seconds-(time.monotonic()-start))))
if __name__=="__main__":main()
