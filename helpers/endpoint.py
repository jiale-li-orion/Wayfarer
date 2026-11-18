#!/usr/bin/env python3
"""Workspace Map JSON-lines stdio endpoint. Python 3.6+, stdlib only."""
from __future__ import print_function
import os, sys, json, stat, time, uuid, base64, hashlib, threading, subprocess, signal, shutil, resource, glob, shlex, ctypes, struct
from concurrent.futures import ThreadPoolExecutor
OUT = threading.Lock()
STATE = threading.Lock()
SCANS = {}
PROCS = {}
WATCHES = {}
WATCH_FD = -1
LIBC = None
if sys.platform.startswith('linux'):
    try:
        LIBC=ctypes.CDLL(None,use_errno=True)
        WATCH_FD=LIBC.inotify_init1(os.O_NONBLOCK|os.O_CLOEXEC)
    except (AttributeError,OSError):pass
def emit(obj):
    with OUT:
        sys.stdout.write(json.dumps(obj, ensure_ascii=True, separators=(',', ':')) + '\n')
        sys.stdout.flush()
def entry(p):
    name = os.path.basename(p) or p
    try:
        s = os.lstat(p)
        kind = 'symlink' if stat.S_ISLNK(s.st_mode) else 'directory' if stat.S_ISDIR(s.st_mode) else 'file' if stat.S_ISREG(s.st_mode) else 'special'
        e = dict(name=name,path=p,kind=kind,size=s.st_size,mtime=s.st_mtime_ns/1000000,ctime=s.st_ctime_ns/1000000,mode=stat.S_IMODE(s.st_mode),identity='%s:%s'%(s.st_dev,s.st_ino))
        if kind == 'symlink':
            e.update(target=os.readlink(p), resolved=os.path.realpath(p))
            try:
                t=os.stat(p);e['targetKind']='directory' if stat.S_ISDIR(t.st_mode) else 'file'
            except OSError: e['targetKind']='missing'
        tags = []
        if name in ('.cache','__pycache__','node_modules','.gradle','.m2'): tags.append('cache')
        if name in ('Android','android-sdk','flutter','miniforge3','.rustup'): tags.append('SDK')
        if name == '.git': tags.append('Git')
        e['tags']=tags
        return e
    except PermissionError as e:
        return dict(name=name,path=p,kind='denied',size=0,mtime=0,ctime=0,mode=0,identity=p,error=str(e))
def getpath(a,key='path'):
    p=a[key]
    if not isinstance(p,str) or not os.path.isabs(p): raise ValueError('Absolute path required')
    return os.path.normpath(p)
def scan_close(token):
    token=token.split(":",1)[0]
    with STATE: scan=SCANS.pop(token,None)
    if scan:
        for it in scan.get('stack',[]): it.close()
def scan_begin(p,kind):
    token=uuid.uuid4().hex
    with STATE:
        expired=[k for k,v in SCANS.items() if time.monotonic()-v['time']>120]
    for k in expired: scan_close(k)
    with STATE:
        if len(SCANS)>=128: raise RuntimeError('Close or finish existing directory cursors')
        SCANS[token]=dict(sequence=0,last_sequence=None,last_page=None,path=p,kind=kind,stack=[os.scandir(p)],time=time.monotonic(),lock=threading.Lock(),bytes=0,files=0)
    return token
def scan_page(a):
    p=getpath(a);kind=a.get('kind','list')
    cursor=a.get('cursor');token=cursor.split(':',1)[0] if cursor else scan_begin(p,kind)
    sequence=int(cursor.split(':',1)[1]) if cursor and ':' in cursor else 0
    with STATE: s=SCANS.get(token)
    if s is None: raise ValueError('Cursor expired; refresh directory')
    if s['path']!=p or s['kind']!=kind: raise ValueError('Cursor belongs to another directory')
    limit=max(1,min(1000,int(a.get('limit',200))));items=[];errors=[];done=False
    end=time.monotonic()+0.04
    with s['lock']:
        if sequence!=s['sequence']:
            if sequence==s['last_sequence']:return s['last_page']
            raise ValueError('Cursor has advanced; refresh directory')
        while s['stack'] and len(items)<limit:
            try: item=next(s['stack'][-1])
            except StopIteration:
                s['stack'].pop().close();continue
            q=item.path
            if kind=='list':
                items.append(entry(q))
            else:
                try:
                    if item.is_dir(follow_symlinks=False): s['stack'].append(os.scandir(q))
                    elif kind=='size':
                        st=item.stat(follow_symlinks=False);s['bytes']+=st.st_size;s['files']+=1
                    if kind=='search' and a.get('query','').casefold() in item.name.casefold(): items.append(entry(q))
                except OSError as e: errors.append(dict(path=q,error=str(e)))
            if kind!='list' and time.monotonic()>end: break
        s['time']=time.monotonic();done=not s['stack']
        if kind=='list':
            resolved=os.path.realpath(p)
            for e in items:e.setdefault('resolved',os.path.join(resolved,e['name']))
        result=dict(entries=items,stamp=time.time()*1000,bytes=s['bytes'],files=s['files'],errors=errors)
        if done: scan_close(token)
        else: result['cursor']=token+':'+str(sequence+1)
        s['sequence']=sequence+1;s['last_sequence']=sequence;s['last_page']=result
        return result
def run(method,a):
    if method=='whichMany':
        return [run('which',dict(name=name)) for name in a['names'][:32]]
    if method=='info': return dict(home=os.path.expanduser('~'),platform=sys.platform,python=sys.version.split()[0],pid=os.getpid(),paths={k:os.environ[k] for k in ('ANDROID_HOME','ANDROID_SDK_ROOT','JAVA_HOME','FLUTTER_ROOT','VIRTUAL_ENV','CONDA_PREFIX','CARGO_HOME','RUSTUP_HOME') if os.environ.get(k)})
    if method=='watchSet':
        if WATCH_FD<0:return False
        wanted=set(a['paths'])
        with STATE:
            for wd,p in list(WATCHES.items()):
                if p not in wanted:LIBC.inotify_rm_watch(WATCH_FD,wd);WATCHES.pop(wd,None)
            for p in wanted-set(WATCHES.values()):
                wd=LIBC.inotify_add_watch(WATCH_FD,os.fsencode(p),0x00000FCE)
                if wd>=0:WATCHES[wd]=p
        return True
    if method=='watchPoll':
        if WATCH_FD<0:return dict(supported=False,paths=[])
        changed=set();overflow=False
        for _ in range(4):
            try:data=os.read(WATCH_FD,65536)
            except BlockingIOError:break
            offset=0
            while offset+16<=len(data):
                wd,mask,cookie,length=struct.unpack_from('iIII',data,offset)
                name=data[offset+16:offset+16+length].split(b'\0',1)[0]
                offset+=16+length
                if mask&0x00004000:overflow=True
                p=WATCHES.get(wd)
                if p:changed.add(os.path.join(p,os.fsdecode(name)) if name else p)
        return dict(supported=True,paths=list(changed),overflow=overflow)
    if method=='resources':
        for token,scan in list(SCANS.items()):
            if time.monotonic()-scan['time']>120:scan_close(token)
        ru=resource.getrusage(resource.RUSAGE_SELF)
        rss=ru.ru_maxrss*1024
        try:
            with open('/proc/self/statm') as f:rss=int(f.read().split()[1])*os.sysconf('SC_PAGE_SIZE')
        except OSError:pass
        children=[]
        with STATE: processes=list(PROCS.values())
        for rec in processes:
            child=dict(pid=rec['p'].pid,exitCode=rec['p'].poll())
            try:
                with open('/proc/%s/stat'%child['pid']) as f: fields=f.read().rsplit(')',1)[1].split()
                child.update(cpuMs=(int(fields[11])+int(fields[12]))*1000/os.sysconf('SC_CLK_TCK'),rss=int(fields[21])*os.sysconf('SC_PAGE_SIZE'))
            except (OSError,ValueError,IndexError):pass
            children.append(child)
        return dict(pid=os.getpid(),rss=rss,peakRss=ru.ru_maxrss*1024,cpuUserMs=ru.ru_utime*1000,cpuSystemMs=ru.ru_stime*1000,cursors=len(SCANS),processes=len(PROCS),watches=len(WATCHES),children=children)
    if method=='statMany':
        values=[]
        for p in a['paths'][:64]:
            try:values.append(entry(p))
            except OSError as e:values.append(dict(error=str(e)))
        return values
    if method=='sshHosts':
        hosts=[];seen=set()
        def read_config(p,depth=0):
            if depth>12 or p in seen:return
            seen.add(p)
            with open(p) as f:
                for line in f:
                    words=shlex.split(line,comments=True)
                    if not words:continue
                    if words[0].lower()=='host':
                        hosts.extend(x for x in words[1:] if not any(c in x for c in '*?!'))
                    elif words[0].lower()=='include':
                        for pat in words[1:]:
                            pat=os.path.expanduser(pat)
                            if not os.path.isabs(pat):pat=os.path.join(os.path.expanduser('~/.ssh'),pat)
                            for include in glob.glob(pat):read_config(include,depth+1)
        read_config(getpath(a))
        return sorted(set(hosts))
    if method=='stat':
        e=entry(getpath(a));e.setdefault('resolved',os.path.realpath(getpath(a)));return e
    if method=='realpath': return os.path.realpath(getpath(a))
    if method=='list': return scan_page(a)
    if method=='scanClose': scan_close(a['cursor']);return True
    if method=='mkdir': os.makedirs(getpath(a),exist_ok=True);return True
    if method=='read':
        with open(getpath(a),'rb') as f:
            f.seek(int(a.get('offset',0)));data=f.read(min(1048576,int(a.get('length',1048576))))
        return base64.b64encode(data).decode('ascii')
    if method=='write':
        p=getpath(a);data=base64.b64decode(a['data'])
        if len(data)>1048576: raise ValueError('Chunk exceeds 1 MiB')
        flags=os.O_WRONLY|os.O_CREAT
        if a.get('exclusive'): flags|=os.O_EXCL
        if hasattr(os,'O_NOFOLLOW'): flags|=os.O_NOFOLLOW
        fd=os.open(p,flags,0o600)
        with os.fdopen(fd,'r+b') as f:
            f.seek(int(a.get('offset',0)));f.write(data)
            if a.get('truncate'): f.truncate(int(a.get('offset',0))+len(data))
        return len(data)
    if method=='hash':
        h=hashlib.sha256()
        with open(getpath(a),'rb') as f:
            for chunk in iter(lambda:f.read(max(4096,min(1048576,a.get('size',1048576)))),b''): h.update(chunk)
        return h.hexdigest()
    if method=='metadata':
        p=getpath(a);os.chmod(p,int(a['mode']));os.utime(p,(a['mtime']/1000,a['mtime']/1000));return True
    if method=='rename':
        p=getpath(a);dest=getpath(a,'dest')
        if not a.get('overwrite') and os.path.lexists(dest): raise FileExistsError(dest)
        os.rename(p,dest);return True
    if method=='remove':
        p=getpath(a)
        if a.get('expected') and entry(p)!=a['expected']:
            current=entry(p)
            if any(current.get(k)!=a['expected'].get(k) for k in ('identity','size','mtime','ctime')): raise RuntimeError('Source changed; retained')
        if os.path.islink(p) or not os.path.isdir(p): os.unlink(p)
        elif a.get('recursive'): shutil.rmtree(p)
        else: os.rmdir(p)
        return True
    if method=='symlink':
        os.symlink(a['target'],getpath(a));return True
    if method=='which':
        found=shutil.which(a['name'])
        if found:return found
        for root in ('~/.local/bin','~/.npm-global/bin','~/.cargo/bin'):
            p=os.path.join(os.path.expanduser(root),a['name'])
            if os.path.isfile(p) and os.access(p,os.X_OK):return p
        return None
    if method=='execStart':
        argv=a['argv']
        if not isinstance(argv,list) or not argv or not all(isinstance(v,str) for v in argv): raise ValueError('argv required')
        env=os.environ.copy()
        env.update({k:v for k,v in a.get('env',{}).items() if k in ('UV_PROJECT_ENVIRONMENT','UV_PYTHON_DOWNLOADS') and isinstance(v,str)})
        if os.path.isabs(argv[0]):env['PATH']=os.path.dirname(argv[0])+os.pathsep+env.get('PATH','')
        if a.get('runtime'):env['PATH']=os.path.dirname(a['runtime'])+os.pathsep+env.get('PATH','')
        p=subprocess.Popen(argv,env=env,cwd=getpath(a,'cwd'),stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,start_new_session=True,bufsize=0)
        ident=uuid.uuid4().hex;rec=dict(p=p,chunks=[],bytes=0,lock=threading.Lock(),truncated=False,done=False)
        with STATE: PROCS[ident]=rec
        def pump():
            try:
                while True:
                    b=p.stdout.read(8192)
                    if not b: break
                    with rec['lock']:
                        rec['chunks'].append(b);rec['bytes']+=len(b)
                        while rec['bytes']>1048576 and rec['chunks']:
                            rec['bytes']-=len(rec['chunks'].pop(0));rec['truncated']=True
            finally:
                p.stdout.close()
                with rec['lock']: rec['done']=True
        rec['reader']=threading.Thread(target=pump,daemon=True);rec['reader'].start()
        return dict(id=ident,pid=p.pid)
    if method in ('execPoll','execCancel'):
        with STATE: rec=PROCS.get(a['id'])
        if rec is None: raise ValueError('Process not found')
        if method=='execCancel' and rec['p'].poll() is None:
            try: os.killpg(rec['p'].pid,signal.SIGTERM)
            except ProcessLookupError: pass
            try:rec['p'].wait(timeout=0.75)
            except subprocess.TimeoutExpired:
                try:os.killpg(rec['p'].pid,signal.SIGKILL)
                except ProcessLookupError:pass
                try:rec['p'].wait(timeout=0.25)
                except subprocess.TimeoutExpired:pass
            rec['reader'].join(timeout=0.25)
        with rec['lock']:
            output=b''.join(rec['chunks']).decode('utf-8','replace');rec['chunks']=[];rec['bytes']=0
            code=rec['p'].poll();done=rec['done']
            result=dict(output=output,code=code if done else None,truncated=rec['truncated'])
        if done and code is not None:
            with STATE: PROCS.pop(a['id'],None)
        return result
    raise ValueError('Unknown method: '+method)
def request(msg):
    try: emit(dict(id=msg['id'],result=run(msg['method'],msg.get('args',{}))))
    except Exception as e: emit(dict(id=msg.get('id'),error=dict(code=getattr(e,'errno',None),type=type(e).__name__,message=str(e))))
def main():
    control=ThreadPoolExecutor(max_workers=4)
    bulk=ThreadPoolExecutor(max_workers=4)
    try:
        for line in sys.stdin:
            try:
                msg=json.loads(line)
                (bulk if msg.get('method') in ('read','write','hash','remove') else control).submit(request,msg)
            except Exception as e: emit(dict(error=dict(message=str(e))))
    finally:
        for rec in list(PROCS.values()):
            if rec['p'].poll() is None:
                try:os.killpg(rec['p'].pid,signal.SIGKILL)
                except OSError:pass
        for token in list(SCANS): scan_close(token)
        if WATCH_FD>=0:os.close(WATCH_FD)
        control.shutdown(wait=False);bulk.shutdown(wait=False)
        # stdin EOF ends this helper's ownership. A worker blocked in an OS call
        # must not keep the remote process alive after its controlling socket left.
        try:sys.stdout.flush()
        except (OSError, ValueError):pass
        os._exit(0)
if __name__=='__main__': main()
