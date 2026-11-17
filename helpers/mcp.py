#!/usr/bin/env python3
"""MCP stdio client of a running Workspace Map window, Python 3.6+."""
import sys,os,json,socket,argparse,uuid,threading,time
parser=argparse.ArgumentParser()
parser.add_argument('--session')
opts=parser.parse_args()
root=os.path.expanduser('~/.local/share/workspace-map/sessions')
selected=opts.session
subscription=None
output_lock=threading.Lock()
with open(os.path.join(os.path.dirname(__file__),'tools.json')) as f:TOOLS=json.load(f)
def emit(v):
    with output_lock:sys.stdout.write(json.dumps(v,ensure_ascii=True)+'\n');sys.stdout.flush()
def sessions():
    result=[]
    if not os.path.isdir(root):return result
    for name in os.listdir(root):
        if name.endswith('.json'):
            try:
                with open(os.path.join(root,name)) as f:r=json.load(f)
                if os.stat(os.path.join(root,name)).st_uid!=os.getuid():continue
                os.kill(r['pid'],0)
                if os.path.exists(r['socket']):result.append(r)
            except (OSError,ValueError,KeyError):pass
    return result
def subscribe():
    global subscription
    if subscription:
        try:subscription.shutdown(socket.SHUT_RDWR);subscription.close()
        except OSError:pass
        subscription=None
    current=next((s for s in sessions() if s['id']==selected),None)
    if not current:return
    conn=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
    try:conn.connect(current['socket'])
    except OSError:return
    subscription=conn
    def listen():
        try:
            for line in conn.makefile('rb'):
                msg=json.loads(line)
                if 'event' in msg:emit(dict(jsonrpc='2.0',method='notifications/message',params=dict(level='info',logger='workspace-map.task',data=msg['event'])))
        except (OSError,ValueError):pass
    threading.Thread(target=listen,daemon=True).start()
def rpc(method,args):
    current=next((s for s in sessions() if s['id']==selected),None)
    if not current:raise ValueError('Select a live map session using map_sessions and map_bind')
    rid=uuid.uuid4().hex
    conn=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
    try:
        conn.connect(current['socket']);conn.sendall((json.dumps(dict(id=rid,method=method,args=args))+'\n').encode())
        for line in conn.makefile('rb'):
            msg=json.loads(line)
            if msg.get('id')==rid:
                if 'error' in msg:raise RuntimeError(msg['error'])
                return msg.get('result')
    finally:conn.close()
    raise RuntimeError('VS Code map session closed')
def handle(m):
    global selected
    mid=m.get('id');method=m.get('method');p=m.get('params',{})
    if mid is None:
        if method=='notifications/initialized':subscribe()
        return
    try:
        if method=='initialize':r=dict(protocolVersion=p.get('protocolVersion') if p.get('protocolVersion') in ('2024-11-05','2025-03-26','2025-06-18') else '2025-06-18',capabilities=dict(tools=dict(listChanged=False),logging={}),serverInfo=dict(name='workspace-map',version='0.2.0'),instructions=('Already bound to session '+selected+'. Keep this session; map_bind switches sessions only on an explicit user request. ' if selected else 'Choose a session with map_sessions and map_bind. ')+'Paths are endpoint-specific. File and package tools act with the endpoint user permissions. Windows delete uses recycle bin; WSL/Linux SSH delete is permanent. Long tasks return a job id; query or control jobs.')
        elif method in ('ping','logging/setLevel'):r={}
        elif method=='tools/list':r=dict(tools=TOOLS)
        elif method=='tools/call':
            name=p['name'];a=p.get('arguments',{})
            if name=='map_sessions':value=sessions()
            elif name=='map_bind':
                if not any(s['id']==a['session'] for s in sessions()):raise ValueError('Session not found')
                selected=a['session'];subscribe();value=dict(session=selected)
            else:
                tool=next((t for t in TOOLS if t['name']==name),None)
                if tool is None:raise ValueError('Unknown tool')
                value=rpc(name[len('map_'):],a)
            r=dict(content=[dict(type='text',text=json.dumps(value,ensure_ascii=False))],isError=False)
        else:
            emit(dict(jsonrpc='2.0',id=mid,error=dict(code=-32601,message='Method not found')));return
        emit(dict(jsonrpc='2.0',id=mid,result=r))
    except Exception as e:
        if method=='tools/call':emit(dict(jsonrpc='2.0',id=mid,result=dict(content=[dict(type='text',text=str(e))],isError=True)))
        else:emit(dict(jsonrpc='2.0',id=mid,error=dict(code=-32603,message=str(e))))
for line in sys.stdin:
    try:handle(json.loads(line))
    except ValueError:emit(dict(jsonrpc='2.0',id=None,error=dict(code=-32700,message='Invalid JSON')))
