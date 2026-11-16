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
results=[];tag='workspace-map-acceptance-'+uuid.uuid4().hex[:8]
local=pathlib.Path(tempfile.mkdtemp(prefix=tag));remote='/tmp/'+tag
win='C:\\Users\\29461\\AppData\\Local\\Temp\\'+tag
config=str(pathlib.Path.home()/'intern/守忆科技/研究/GPU-serving-lab/ssh/config.local')
try:
    for ident,host,home in [('accept-train','gpu-lab','/home/lijiale'),('accept-infer','serve-lab','/home/jiale'),('accept-extra','gpu-lab','/tmp')]:
        rpc('addEndpoint',dict(id=ident,kind='ssh',name=ident,host=host,root=home,sshConfig=config,distro='Ubuntu',python='python3'))
    for ident in ['windows-c','wsl-ubuntu','accept-train','accept-infer','accept-extra']:
        endpoint=next(e for e in rpc('endpoints') if e['id']==ident)
        page=measure('list_'+ident,lambda e=endpoint:rpc('list',dict(ref=dict(endpoint=e['id'],path=e['root']),refresh=True)))
        results[-1]['result']=dict(count=len(page['entries']),error=page.get('error'))
        assert not page.get('error'),page.get('error')
    for ep,p in [('windows-c',win),('accept-train',remote),('accept-infer',remote)]:mkdir(ep,p)
    filename='中文 空格.txt';content='Workspace Map 验收\n'*10000
    write('windows-c',win+'\\'+filename,content)
    same='/mnt/c/Users/29461/AppData/Local/Temp/'+tag+'/'+filename
    assert read('wsl-ubuntu',same).decode()==content
    for src,srcp,dst,dstp,mode in [
        ('windows-c',win+'\\'+filename,'accept-train',remote,'copy'),
        ('accept-train',remote+'/'+filename,'accept-infer',remote,'copy'),
        ('accept-infer',remote+'/'+filename,'wsl-ubuntu',str(local),'move')]:
        def transfer():
            j=finish(rpc('transfer',dict(sources=[dict(endpoint=src,path=srcp)],target=dict(endpoint=dst,path=dstp),mode=mode,conflict='rename')))
            return dict(bytes=j['bytes'],files=j['files'],state=j['state'])
        measure(src+'_to_'+dst,transfer)
    assert (local/filename).read_text()==content
    # A selected, isolated Python environment; package operations go through production core.
    venv=local/'venv';subprocess.run(['uv','venv','--seed',str(venv)],check=True,stdout=subprocess.DEVNULL)
    wheel=local/'workspace_map_fixture-1.0.0-py3-none-any.whl'
    files={'workspace_map_fixture.py':'VALUE = 42\n','workspace_map_fixture-1.0.0.dist-info/METADATA':'Metadata-Version: 2.1\nName: workspace-map-fixture\nVersion: 1.0.0\n','workspace_map_fixture-1.0.0.dist-info/WHEEL':'Wheel-Version: 1.0\nGenerator: workspace-map-acceptance\nRoot-Is-Purelib: true\nTag: py3-none-any\n','workspace_map_fixture-1.0.0.dist-info/RECORD':''}
    with zipfile.ZipFile(wheel,'w') as z:
        for n,t in files.items():z.writestr(n,t)
    for action,packages in [('install',[str(wheel)]),('list',[]),('uninstall',['workspace-map-fixture'])]:
        j=measure('pip_'+action,lambda:finish(rpc('package',dict(endpoint='wsl-ubuntu',cwd=str(local),manager='pip',python=str(venv/'bin/python'),action=action,packages=packages))))
        results[-1]['result']=dict(state=j['state'],output=''.join(j['logs'])[-1500:])
    pkg=local/'node-package';pkg.mkdir();(pkg/'package.json').write_text(json.dumps(dict(name='workspace-map-fixture',version='1.0.0')))
    project=local/'node-project';project.mkdir();(project/'package.json').write_text(json.dumps(dict(name='workspace-map-test',version='1.0.0',private=True)))
    (project/'.npmrc').write_text('audit=false\nfund=false\nupdate-notifier=false\n')
    npm=subprocess.check_output(['which','npm'],text=True).strip()
    for action,packages in [('install',[str(pkg)]),('list',[]),('uninstall',['workspace-map-fixture'])]:
        j=measure('npm_'+action,lambda:finish(rpc('package',dict(endpoint='wsl-ubuntu',cwd=str(project),manager='npm',executable=npm,action=action,packages=packages))))
        results[-1]['result']=dict(state=j['state'],output=''.join(j['logs'])[-1500:])
    for ep in ['wsl-ubuntu','accept-train','accept-infer']:measure('resources_'+ep,lambda:rpc('resources',dict(endpoint=ep)))
finally:
    for ep,p in [('windows-c',win),('accept-train',remote),('accept-infer',remote)]:
        try:finish(rpc('delete',dict(refs=[dict(endpoint=ep,path=p)])))
        except Exception as e:results.append(dict(cleanup=ep,error=str(e)))
    shutil.rmtree(local,ignore_errors=True)
    target=pathlib.Path(__file__).parent/'profile-acceptance.json';target.write_text(json.dumps(results,ensure_ascii=False,indent=2))
    print(target)
