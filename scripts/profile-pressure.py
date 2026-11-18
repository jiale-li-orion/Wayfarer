"""Bounded, read-only daily-window sampler; output contains roles, never command lines."""
import argparse,json,os,runpy,time,ctypes

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--helper',required=True);p.add_argument('--output',required=True)
    p.add_argument('--seconds',type=int,default=600);p.add_argument('--interval',type=int,default=10)
    a=p.parse_args();m=runpy.run_path(a.helper);started=time.monotonic();limit=20*1024*1024
    os.makedirs(os.path.dirname(os.path.abspath(a.output)),exist_ok=True)
    with open(a.output,'x',encoding='utf8') as out:
        while True:
            now=time.time();cpu=time.process_time();t=time.monotonic()
            system=m['windows_summary'](now) if os.name=='nt' else m['linux_summary'](now)
            rows=m['windows_processes'](now) if os.name=='nt' else m['linux_processes'](now)
            for r in rows:
                # Inspect arguments only to classify a role; arguments are discarded.
                if os.name!='nt':
                    try:
                        raw=open('/proc/%s/cmdline'%r['pid'],'rb').read(16384).decode('utf8','replace')
                        r['role']=next((label for token,label in [('extensionHost','extension-host'),('app-server','agent-server'),('GradleDaemon','gradle'),('KotlinCompileDaemon','kotlin'),('workspace-map','wayfarer-helper'),('chrome','browser'),('celery','business-worker'),('uvicorn','business-api')] if token in raw),r['name'])
                        raw=None
                    except OSError:pass
            rows.sort(key=lambda r:(r.get('rss') or 0),reverse=True)
            if os.name!='nt':
                for r in rows[:15]:
                    try:
                        with open('/proc/%s/smaps_rollup'%r['pid']) as f:
                            vals=dict((v[0].rstrip(':'),int(v[1])*1024) for v in (l.split() for l in f) if len(v)==3 and v[1].isdigit())
                        r['pss']=vals.get('Pss');r['swapPss']=vals.get('SwapPss')
                    except OSError:pass
            sample=dict(stamp=int(now*1000),platform=os.name,system=system,processes=rows[:200],elapsedMs=(time.monotonic()-t)*1000,collectorCpuMs=(time.process_time()-cpu)*1000)
            line=json.dumps(sample,ensure_ascii=True,separators=(',',':'))+'\n'
            if out.tell()+len(line.encode('utf8'))>limit:break
            out.write(line);out.flush()
            if time.monotonic()-started>=a.seconds:break
            time.sleep(min(max(1,a.interval-(time.monotonic()-t)),max(0,a.seconds-(time.monotonic()-started))))
if __name__=='__main__':main()
