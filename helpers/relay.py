#!/usr/bin/env python3
"""Private per-window Unix socket bridge, owned by the VS Code child process."""
import os,sys,json,socket,threading,uuid,time,signal
ROOT=os.path.expanduser('~/.local/share/workspace-map/sessions')
os.makedirs(ROOT,mode=0o700,exist_ok=True)
os.chmod(ROOT,0o700)
session=sys.argv[1]
socket_path=os.path.join(ROOT,session+'.sock')
record_path=os.path.join(ROOT,session+'.json')
server=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
server.bind(socket_path);os.chmod(socket_path,0o600);server.listen(16)
clients={};lock=threading.Lock();out=threading.Lock();closed=threading.Event()
with open(record_path,'w') as f:json.dump(dict(id=session,socket=socket_path,pid=os.getpid(),name=sys.argv[2] if len(sys.argv)>2 else session,created=time.time()),f)
os.chmod(record_path,0o600)
def emit(v):
    with out:sys.stdout.write(json.dumps(v)+'\n');sys.stdout.flush()
def client(conn):
    ident=uuid.uuid4().hex
    with lock:clients[ident]=(conn,threading.Lock())
    try:
        for line in conn.makefile('rb'):
            if len(line)>8*1024*1024:break
            msg=json.loads(line);emit(dict(id=ident+':'+str(msg['id']),method=msg['method'],args=msg.get('args',{}),actor='agent'))
    except (OSError,ValueError,KeyError):pass
    finally:
        with lock:clients.pop(ident,None)
        conn.close()
def accept():
    while not closed.is_set():
        try:conn,_=server.accept()
        except OSError:break
        threading.Thread(target=client,args=(conn,),daemon=True).start()
threading.Thread(target=accept,daemon=True).start()
emit(dict(ready=True,session=session,socket=socket_path,registry=ROOT))
try:
    for line in sys.stdin:
        msg=json.loads(line)
        if 'id' in msg:
            ident,rid=msg['id'].split(':',1);msg['id']=rid
            with lock:targets=[clients[ident]] if ident in clients else []
        else:
            with lock:targets=list(clients.values())
        data=(json.dumps(msg)+'\n').encode()
        for conn,write_lock in targets:
            try:
                with write_lock:conn.sendall(data)
            except OSError:pass
finally:
    closed.set();server.close()
    with lock:
        for conn,_ in clients.values():conn.close()
    for p in (socket_path,record_path):
        try:os.unlink(p)
        except FileNotFoundError:pass
