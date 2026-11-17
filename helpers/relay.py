#!/usr/bin/env python3
"""Per-instance private IPC. Each socket owns its Core directory cursors."""
import os, sys, json, socket, threading, uuid, time, queue
ROOT = os.path.expanduser('~/.local/share/workspace-map/sessions')
os.makedirs(ROOT, mode=0o700, exist_ok=True)
os.chmod(ROOT, 0o700)
session, name = sys.argv[1:3]
map_id = sys.argv[3] if len(sys.argv) > 3 else session
token = uuid.uuid4().hex
socket_path = os.path.join(ROOT, session + '.sock')
if len(socket_path.encode()) > 100:
    socket_root = os.path.join('/tmp', 'workspace-map-' + str(os.getuid()))
    os.makedirs(socket_root, mode=0o700, exist_ok=True)
    if os.path.islink(socket_root) or os.stat(socket_root).st_uid != os.getuid():
        raise RuntimeError('IPC directory ownership mismatch')
    os.chmod(socket_root, 0o700)
    socket_path = os.path.join(socket_root, session + '.sock')
record_path = os.path.join(ROOT, session + '.json')
record = dict(id=session, mapId=map_id, state='running', token=token, socket=socket_path,
              pid=os.getpid(), name=name, created=time.time())
server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
server.bind(socket_path)
os.chmod(socket_path, 0o600)
server.listen(16)
clients, lock, out = {}, threading.Lock(), threading.Lock()
closed = threading.Event()
def publish():
    temp = record_path + '.' + token
    with open(temp, 'w') as f: json.dump(record, f)
    os.chmod(temp, 0o600)
    os.replace(temp, record_path)
publish()
def emit(value):
    with out:
        sys.stdout.write(json.dumps(value) + '\n')
        sys.stdout.flush()
class Client:
    def __init__(self, conn):
        self.conn, self.ident = conn, uuid.uuid4().hex
        self.messages, self.done = queue.Queue(maxsize=256), threading.Event()
        self.subscribed = True
        self.snapshot_id = None
        self.deferred = {}
        self.state_lock = threading.Lock()
        self.writer = threading.Thread(target=self.write, daemon=True)
    def close(self):
        if self.done.is_set(): return
        self.done.set()
        try: self.conn.shutdown(socket.SHUT_RDWR)
        except OSError: pass
        self.conn.close()
        try: self.messages.put_nowait(None)
        except queue.Full: pass
    def send(self, value):
        if self.done.is_set(): return
        try: self.messages.put_nowait((json.dumps(value) + '\n').encode())
        except queue.Full: self.close()  # Slow clients reconnect and obtain a fresh snapshot.
    def event(self, value):
        with self.state_lock:
            if self.snapshot_id:
                key = value.get('event', {}).get('id', 'status')
                self.deferred[key] = value
                if len(self.deferred) > 256: self.close()
            elif self.subscribed: self.send(value)
    def reply(self, value):
        with self.state_lock:
            self.send(value)
            if value.get('id') == self.snapshot_id:
                for event in self.deferred.values(): self.send(event)
                self.deferred.clear()
                self.snapshot_id = None
                self.subscribed = True
    def write(self):
        try:
            while not self.done.is_set():
                value = self.messages.get()
                if value is None: break
                self.conn.sendall(value)
        except OSError: pass
        finally: self.close()
    def read(self):
        with lock: clients[self.ident] = self
        emit(dict(clientOpen=self.ident))
        self.writer.start()
        try:
            with self.conn.makefile('rb') as stream:
                while not closed.is_set():
                    line = stream.readline(8 * 1024 * 1024 + 1)
                    if not line or len(line) > 8 * 1024 * 1024: break
                    msg = json.loads(line)
                    if msg.get('method') == 'clientAttach':
                        with self.state_lock:
                            self.snapshot_id = str(msg['id'])
                            self.subscribed = False
                    emit(dict(id=self.ident + ':' + str(msg['id']), client=self.ident,
                              method=msg['method'], args=msg.get('args', {})))
        except (OSError, ValueError, KeyError): pass
        finally:
            with lock: clients.pop(self.ident, None)
            self.close()
            self.writer.join()
            emit(dict(clientClose=self.ident))
def accept():
    while not closed.is_set():
        try: conn, _ = server.accept()
        except OSError: break
        threading.Thread(target=Client(conn).read, daemon=True).start()
threading.Thread(target=accept, daemon=True).start()
emit(dict(ready=True, session=session, mapId=map_id, socket=socket_path, registry=ROOT))
try:
    for line in sys.stdin:
        msg = json.loads(line)
        if msg.get('shutdown'):
            record['state'] = 'closing'
            publish()
            closed.set()
            server.close()
            continue
        if 'id' in msg:
            ident, rid = msg['id'].split(':', 1)
            msg['id'] = rid
            with lock: targets = [clients[ident]] if ident in clients else []
        else:
            with lock: targets = list(clients.values())
        for client in targets:
            if 'id' in msg: client.reply(msg)
            else: client.event(msg)
finally:
    closed.set()
    server.close()
    with lock: remaining = list(clients.values())
    for client in remaining: client.close()
    for client in remaining: client.writer.join()
    try:
        with open(record_path) as f: owned = json.load(f).get('token') == token
        if owned:
            os.unlink(record_path)
            os.unlink(socket_path)
    except (OSError, ValueError): pass
