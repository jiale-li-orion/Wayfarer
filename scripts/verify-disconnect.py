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
tag='workspace-map-disconnect-'+uuid.uuid4().hex[:8]
local=pathlib.Path(tempfile.mkdtemp(prefix=tag));remote='/tmp/'+tag
config=str(pathlib.Path.home()/'intern/守忆科技/研究/GPU-serving-lab/ssh/config.local')
job=None
try:
    rpc('addEndpoint',dict(id='fault-train',kind='ssh',name='SSH 断连验收',host='gpu-lab',root='/home/lijiale',sshConfig=config,distro='Ubuntu',python='python3'))
    mkdir('fault-train',remote)
    source=local/'payload.bin';block=b'Q'*1048576;expected=hashlib.sha256()
    with source.open('wb') as f:
        for _ in range(64):f.write(block);expected.update(block)
    job=rpc('transfer',dict(sources=[dict(endpoint='wsl-ubuntu',path=str(source))],target=dict(endpoint='fault-train',path=remote),mode='move',conflict='rename'))
    for _ in range(200):
        state=rpc('job',dict(id=job['id']))
        if state['bytes']>0:break
        time.sleep(.02)
    rpc('endpointControl',dict(endpoint='fault-train',action='disconnect'))
    for _ in range(200):
        state=rpc('job',dict(id=job['id']))
        if state['state']=='failed':break
        time.sleep(.02)
    assert state['state']=='failed',state['state']
    assert source.exists()
    page=rpc('list',dict(ref=dict(endpoint='wsl-ubuntu',path=str(local)),refresh=True))
    assert page['entries']
    results.append(dict(stage='disconnect',state=state['state'],bytes=state['bytes'],sourceRetained=True,otherEndpointResponsive=True,error=state.get('error')))
    rpc('endpointControl',dict(endpoint='fault-train',action='connect'))
    rpc('jobControl',dict(id=job['id'],action='resume'))
    done=finish(job);assert not source.exists()
    actual=subprocess.check_output(['ssh','-F',config,'gpu-lab','sha256sum '+remote+'/payload.bin'],text=True).split()[0]
    assert actual==expected.hexdigest()
    results.append(dict(stage='resume',state=done['state'],bytes=done['bytes'],sha256=actual))
    # Case-only rename on the Windows endpoint, and Windows/WSL alias collision.
    win='C:\\Users\\29461\\AppData\\Local\\Temp\\'+tag
    mkdir('windows-c',win);write('windows-c',win+'\\case.txt','case-sensitive test')
    finish(rpc('rename',dict(ref=dict(endpoint='windows-c',path=win+'\\case.txt'),name='CASE.txt')))
    assert read('windows-c',win+'\\CASE.txt')==b'case-sensitive test'
    same='/mnt/c/Users/29461/AppData/Local/Temp/'+tag
    duplicate=rpc('transfer',dict(sources=[dict(endpoint='windows-c',path=win+'\\CASE.txt')],target=dict(endpoint='wsl-ubuntu',path=same),mode='move',conflict='overwrite'))
    for _ in range(100):
        state=rpc('job',dict(id=duplicate['id']))
        if state['state']=='failed':break
        time.sleep(.02)
    assert state['state']=='failed';assert read('windows-c',win+'\\CASE.txt')==b'case-sensitive test'
    results.append(dict(stage='windows_case_and_alias',caseRename=True,selfMoveRejected=True))
    finish(rpc('delete',dict(refs=[dict(endpoint='windows-c',path=win)])))
finally:
    try:
        rpc('endpointControl',dict(endpoint='fault-train',action='connect'))
        finish(rpc('delete',dict(refs=[dict(endpoint='fault-train',path=remote)])))
    except Exception as e:results.append(dict(cleanupError=str(e)))
    shutil.rmtree(local,ignore_errors=True)
    out=pathlib.Path(__file__).parent/'fault-acceptance.json';out.write_text(json.dumps(results,ensure_ascii=False,indent=2));print(out)
