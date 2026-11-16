#!/usr/bin/env python3
"""Run from WSL against the installed Windows UI extension. Creates only temporary fixtures."""
import os,sys,socket,json,time,uuid,base64,pathlib,tempfile,subprocess,hashlib,zipfile,shutil
root=pathlib.Path.home()/'.local/share/workspace-map/sessions'
records=[json.loads(p.read_text()) for p in root.glob('*.json') if p.with_suffix('.sock').exists()]
session=next((r for r in records if r['id']==sys.argv[1]),None) if len(sys.argv)>1 else records[-1]
if not session:raise SystemExit('No live map session')
def rpc(method,args=None):
    rid=uuid.uuid4().hex
    with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as c:
        c.settimeout(60);c.connect(session['socket']);c.sendall((json.dumps(dict(id=rid,method=method,args=args or {}))+'\n').encode())
        f=c.makefile()
        for line in f:
            m=json.loads(line)
            if m.get('id')==rid:
                if m.get('error'):raise RuntimeError(m['error'])
                return m.get('result')
    raise RuntimeError('Connection closed')
def finish(job):
    if not isinstance(job,dict) or 'id' not in job:return job
    while True:
        j=rpc('job',dict(id=job['id']))
        if j['state']=='completed':return j
        if j['state'] in ('failed','cancelled','paused'):raise RuntimeError(json.dumps(j,ensure_ascii=False))
        time.sleep(.1)
def mkdir(ep,p):return finish(rpc('mkdirPath',dict(ref=dict(endpoint=ep,path=p))))
def write(ep,p,text):return finish(rpc('write',dict(ref=dict(endpoint=ep,path=p),content=text)))
def read(ep,p):return base64.b64decode(rpc('read',dict(ref=dict(endpoint=ep,path=p)))['data'])
def measure(label,func):
    start=time.monotonic();value=func();results.append(dict(label=label,seconds=round(time.monotonic()-start,4),result=value));return value
results=[]
tag='workspace-map-junction-'+uuid.uuid4().hex[:8]
win='C:\\Users\\29461\\AppData\\Local\\Temp\\'+tag
local=pathlib.Path('/mnt/c/Users/29461/AppData/Local/Temp')/tag
local.mkdir();(local/'target').mkdir();(local/'copy').mkdir();(local/'target'/'keep.txt').write_text('junction target')
link=win+'\\junction'
command="$ProgressPreference='SilentlyContinue'; New-Item -ItemType Junction -Path '"+link+"' -Target '"+win+"\\target' | Out-Null"
subprocess.run(['/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe','-NoProfile','-EncodedCommand',base64.b64encode(command.encode('utf-16-le')).decode()],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
posix=pathlib.Path(tempfile.mkdtemp(prefix=tag))
try:
    src=rpc('stat',dict(ref=dict(endpoint='windows-c',path=link)))
    assert src['linkType']=='junction',src
    job=finish(rpc('transfer',dict(sources=[dict(endpoint='windows-c',path=link)],target=dict(endpoint='windows-c',path=win+'\\copy'),mode='copy',conflict='rename')))
    dst=rpc('stat',dict(ref=dict(endpoint='windows-c',path=win+'\\copy\\junction')))
    assert dst['linkType']=='junction',dst
    failed=rpc('transfer',dict(sources=[dict(endpoint='windows-c',path=link)],target=dict(endpoint='wsl-ubuntu',path=str(posix)),mode='move',conflict='rename'))
    for _ in range(100):
        state=rpc('job',dict(id=failed['id']))
        if state['state']=='failed':break
        time.sleep(.05)
    assert state['state']=='failed'
    assert rpc('stat',dict(ref=dict(endpoint='windows-c',path=link)))['linkType']=='junction'
    results.append(dict(windowsJunctionPreserved=True,unsupportedPosixTargetRejected=True,sourceRetained=True,targetContent=(local/'target'/'keep.txt').read_text()))
finally:
    finish(rpc('delete',dict(refs=[dict(endpoint='windows-c',path=win)])))
    shutil.rmtree(posix)
    out=pathlib.Path(__file__).parent/'junction-acceptance.json';out.write_text(json.dumps(results,ensure_ascii=False,indent=2));print(out)
