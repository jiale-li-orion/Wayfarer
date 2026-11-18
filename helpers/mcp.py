#!/usr/bin/env python3
"""Resumable MCP client, Python 3.6+. One connection/recovery loop per process."""
import sys, os, json, socket, argparse, uuid, threading, time, select, ctypes, resource
from concurrent.futures import ThreadPoolExecutor
parser = argparse.ArgumentParser()
parser.add_argument('--session')
parser.add_argument('--map', dest='map_id')
opts = parser.parse_args()
ROOT = os.path.expanduser('~/.local/share/workspace-map/sessions')
os.makedirs(ROOT, mode=0o700, exist_ok=True)
with open(os.path.join(os.path.dirname(__file__), 'tools.json')) as f: TOOLS = json.load(f)
BACKGROUND = {'write', 'transfer', 'mkdir', 'mkdirPath', 'rename', 'renamePath', 'delete', 'package', 'inventory', 'size', 'search', 'storageScan'}
output_lock = threading.Lock()
initialized = threading.Event()
def emit(value):
    with output_lock:
        sys.stdout.write(json.dumps(value, ensure_ascii=True) + '\n')
        sys.stdout.flush()
def notice(data):
    if not initialized.is_set(): return
    emit(dict(jsonrpc='2.0', method='notifications/message', params=dict(level='info', logger='workspace-map', data=data)))
def sessions():
    result = []
    for name in os.listdir(ROOT):
        if not name.endswith('.json'): continue
        try:
            file = os.path.join(ROOT, name)
            if os.stat(file).st_uid != os.getuid(): continue
            with open(file) as f: value = json.load(f)
            os.kill(value['pid'], 0)
            if os.path.exists(value['socket']): result.append(value)
        except (OSError, ValueError, KeyError): pass
    return result
class Client:
    def __init__(self):
        self.lock = threading.Condition(threading.RLock())
        self.send_lock = threading.Lock()
        self.map_id, self.session = opts.map_id, opts.session
        self.conn, self.current = None, None
        self.pending = {}
        self.state, self.generation, self.stopped = 'waiting', 0, False
        self.snapshot = None
        self.wake_read, self.wake_write = socket.socketpair()
        self.watch = -1
        try:
            libc = ctypes.CDLL(None, use_errno=True)
            fd = libc.inotify_init1(os.O_NONBLOCK | os.O_CLOEXEC)
            if fd >= 0:
                if libc.inotify_add_watch(fd, ROOT.encode(), 0x00000fcc) >= 0: self.watch = fd
                else: os.close(fd)
        except (AttributeError, OSError): pass
        self.thread = threading.Thread(target=self.supervise, daemon=True)
        self.thread.start()
    def status(self):
        with self.lock:
            return dict(mapId=self.map_id, id=self.current.get('id') if self.current else None,
                        state=self.state, bindingGeneration=self.generation,
                        pendingRequests=len(self.pending), subscriptions=int(self.state == 'connected'),
                        registryWatch=self.watch >= 0, waitingPoll=self.watch < 0 and self.state == 'waiting',
                        recoveryFlows=int(not self.stopped), snapshot=self.snapshot,
                        resources=self.resources())
    def resources(self):
        usage = resource.getrusage(resource.RUSAGE_SELF)
        rss = usage.ru_maxrss * 1024
        try:
            with open('/proc/self/statm') as f: rss = int(f.read().split()[1]) * os.sysconf('SC_PAGE_SIZE')
        except (OSError, ValueError, IndexError): pass
        return dict(pid=os.getpid(), rss=rss, peakRss=usage.ru_maxrss * 1024,
                    cpuUserMs=usage.ru_utime * 1000, cpuSystemMs=usage.ru_stime * 1000,
                    threads=threading.active_count())
    def wake(self):
        try: self.wake_write.send(b'x')
        except OSError: pass
    def disconnect(self, conn):
        if conn:
            try: conn.shutdown(socket.SHUT_RDWR)
            except OSError: pass
            conn.close()
    def bind(self, map_id=None, session=None):
        with self.lock:
            self.generation += 1
            self.map_id, self.session = map_id, session
            self.state, self.snapshot = 'waiting', None
            self.current = None
            self.disconnect(self.conn)
            self.lock.notify_all()
        self.wake()
        return self.status()
    def choose(self):
        values = [s for s in sessions() if s.get('state', 'running') == 'running']
        with self.lock:
            if self.map_id: matches = [s for s in values if s.get('mapId', s['id']) == self.map_id]
            elif self.session: matches = [s for s in values if s['id'] == self.session]
            else: return None
            if len(matches) > 1:
                self.state = 'ambiguous'
                return None
            if not matches: return None
            # Legacy runtime binding is promoted after its first successful lookup.
            current = matches[0]
            self.map_id = current.get('mapId', current['id'])
            return current
    def fail_pending(self, message):
        for value in self.pending.values():
            value['error'] = ConnectionError(message)
            value['done'].set()
        self.pending.clear()
    def supervise(self):
        while not self.stopped:
            conn = None
            current = self.choose()
            if current:
                with self.lock: generation = self.generation
                try:
                    conn = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                    conn.connect(current['socket'])
                    attach = uuid.uuid4().hex
                    with self.lock:
                        if generation != self.generation or self.stopped: continue
                        self.conn, self.current, self.state = conn, current, 'restoring'
                    conn.sendall((json.dumps(dict(id=attach, method='clientAttach')) + '\n').encode())
                    with conn.makefile('rb') as stream:
                        while not self.stopped:
                            line = stream.readline(8 * 1024 * 1024 + 1)
                            if not line or len(line) > 8 * 1024 * 1024: break
                            msg = json.loads(line)
                            with self.lock:
                                if generation != self.generation or conn is not self.conn: break
                                if msg.get('id') == attach:
                                    if 'error' in msg: raise RuntimeError(msg['error'])
                                    self.snapshot = msg.get('result')
                                    # Snapshot is published before enabling new requests/events.
                                    notice(dict(type='resumed', mapId=self.map_id, id=current['id'], snapshot=self.snapshot))
                                    self.state = 'connected'
                                    self.lock.notify_all()
                                elif 'id' in msg:
                                    waiter = self.pending.pop(msg['id'], None)
                                    if waiter:
                                        waiter.update(msg)
                                        waiter['done'].set()
                                elif 'event' in msg and self.state == 'connected': notice(msg['event'])
                except (OSError, ValueError, RuntimeError): pass
                finally:
                    self.disconnect(conn)
                    with self.lock:
                        if self.conn is conn:
                            self.conn, self.current = None, None
                            self.fail_pending('Map instance disconnected; operation receipt will be checked on resume')
                            if not self.stopped: self.state = 'waiting'
                            self.lock.notify_all()
                if self.stopped: break
                # Inspect registry immediately after EOF; its closing record may already be replaced.
                next_current = self.choose()
                if next_current and next_current['id'] != current['id']: continue
            if self.stopped: break
            # inotify has no idle poll; fallback polls only while waiting for a map.
            try:
                readers = [self.wake_read] + ([self.watch] if self.watch >= 0 else [])
                ready, _, _ = select.select(readers, [], [], None if self.watch >= 0 else 5)
                if self.wake_read in ready: self.wake_read.recv(4096)
                if self.watch in ready: os.read(self.watch, 65536)
            except (OSError, ValueError):
                if not self.stopped: time.sleep(0.1)
    def request(self, method, args, binding):
        rid = uuid.uuid4().hex
        frame = (json.dumps(dict(id=rid, method=method, args=args)) + '\n').encode()
        if len(frame) > 8 * 1024 * 1024:
            raise ValueError('IPC request exceeds 8 MiB; use file transfer for large content')
        with self.lock:
            while self.state != 'connected' and not self.stopped:
                if binding != self.generation: raise RuntimeError('Map binding changed')
                self.lock.wait()
            if self.stopped: raise RuntimeError('MCP client closed')
            if binding != self.generation: raise RuntimeError('Map binding changed')
            conn = self.conn
            waiter = dict(done=threading.Event())
            self.pending[rid] = waiter
        try:
            with self.send_lock: conn.sendall(frame)
            waiter['done'].wait()
            with self.lock:
                if binding != self.generation: raise RuntimeError('Map binding changed')
            if 'error' in waiter:
                error = waiter['error']
                if isinstance(error, Exception): raise error
                raise RuntimeError(error)
            return waiter.get('result')
        except OSError as error:
            self.disconnect(conn)
            raise ConnectionError(str(error))
        finally:
            with self.lock: self.pending.pop(rid, None)
    def rpc(self, method, args):
        args = dict(args)
        if method in BACKGROUND: args.setdefault('operationId', uuid.uuid4().hex)
        with self.lock:
            binding = self.generation
            if not self.map_id and not self.session: raise ValueError('Select a mapId with map_bind')
        interrupted = False
        while True:
            try:
                if interrupted:
                    original = self.request('operation', dict(operationId=args['operationId']), binding)
                    if original: return original
                return self.request(method, args, binding)
            except ConnectionError:
                if method not in BACKGROUND: raise
                interrupted = True
    def close(self):
        with self.lock:
            self.stopped, self.state = True, 'closed'
            self.fail_pending('MCP client closed')
            self.disconnect(self.conn)
            self.lock.notify_all()
        self.wake()
        self.thread.join()
        if self.watch >= 0: os.close(self.watch)
        self.wake_read.close()
        self.wake_write.close()
client = Client()
def handle(message):
    mid, method, params = message.get('id'), message.get('method'), message.get('params', {})
    if mid is None:
        if method == 'notifications/initialized': initialized.set()
        return
    try:
        if method == 'initialize':
            target = opts.map_id or opts.session
            result = dict(protocolVersion=params.get('protocolVersion') if params.get('protocolVersion') in ('2024-11-05', '2025-03-26', '2025-06-18') else '2025-06-18', capabilities=dict(tools=dict(listChanged=False), logging={}), serverInfo=dict(name='workspace-map', version='0.6.1'), instructions=('Bound to map ' + target + '. Switch maps only on explicit user request. ' if target else 'Select a mapId with map_sessions and map_bind. ') + 'Long operations return a durable job and operationId. Resume queries the original receipt before submitting again. Paths and permissions belong to each endpoint. Windows delete uses recycle bin; Linux/WSL deletion is permanent.')
        elif method in ('ping', 'logging/setLevel'): result = {}
        elif method == 'tools/list': result = dict(tools=TOOLS)
        elif method == 'tools/call':
            name, args = params['name'], params.get('arguments', {})
            if name == 'map_sessions': value = sessions()
            elif name == 'map_connection': value = client.status()
            elif name == 'map_bind':
                if not args.get('mapId') and not args.get('session'): raise ValueError('Provide mapId or session')
                value = client.bind(args.get('mapId'), args.get('session'))
            else:
                if not any(t['name'] == name for t in TOOLS): raise ValueError('Unknown tool')
                value = client.rpc(name[len('map_'):], args)
            result = dict(content=[dict(type='text', text=json.dumps(value, ensure_ascii=False))], isError=False)
        else:
            emit(dict(jsonrpc='2.0', id=mid, error=dict(code=-32601, message='Method not found')))
            return
        emit(dict(jsonrpc='2.0', id=mid, result=result))
    except Exception as error:
        if method == 'tools/call': emit(dict(jsonrpc='2.0', id=mid, result=dict(content=[dict(type='text', text=str(error))], isError=True)))
        else: emit(dict(jsonrpc='2.0', id=mid, error=dict(code=-32603, message=str(error))))
slots = threading.BoundedSemaphore(8)
pool = ThreadPoolExecutor(max_workers=4)
def run(message):
    try: handle(message)
    finally: slots.release()
try:
    for line in sys.stdin:
        try:
            message = json.loads(line)
            if message.get('method') == 'tools/call' and message.get('params', {}).get('name') not in ('map_bind', 'map_sessions', 'map_connection'):
                if slots.acquire(False): pool.submit(run, message)
                else: emit(dict(jsonrpc='2.0', id=message.get('id'), error=dict(code=-32000, message='Client request queue full')))
            else: handle(message)
        except ValueError: emit(dict(jsonrpc='2.0', id=None, error=dict(code=-32700, message='Invalid JSON')))
finally:
    client.close()
    pool.shutdown(wait=True)
