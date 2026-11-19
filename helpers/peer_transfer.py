#!/usr/bin/env python3
"""One task-owned IPv4 TLS file transfer between registered endpoints."""
import errno
import fcntl
import hashlib
import hmac
import ipaddress
import json
import os
import re
import socket
import ssl
import stat
import subprocess
import sys
import tempfile
import threading
import time

PRIVATE = tuple(ipaddress.IPv4Network(value) for value in (
    "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16",
))
CHUNK = 1024 * 1024
CHECKPOINT = 16 * CHUNK
PARTIAL = re.compile(r"^\.workspace-map-[a-zA-Z0-9_-]+-[a-fA-F0-9]{16}\.partial$")


def private(value):
    address = ipaddress.IPv4Address(value)
    if not any(address in block for block in PRIVATE):
        raise ValueError("直传需要私网 IPv4")
    return str(address)


def identity(fd):
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode):
        raise ValueError("直传文件必须是普通文件")
    return info, "{}:{}".format(info.st_dev, info.st_ino)


def open_file(path, writable):
    if not os.path.isabs(path):
        raise ValueError("文件需要绝对路径")
    if writable and not PARTIAL.fullmatch(os.path.basename(path)):
        raise ValueError("目标需要是任务暂存文件")
    return os.open(path, (os.O_RDWR if writable else os.O_RDONLY) |
                   os.O_NOFOLLOW | os.O_NONBLOCK)


def lock_file(fd):
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError as error:
        if error.errno in (errno.EACCES, errno.EAGAIN):
            raise BlockingIOError("暂存仍由上一次直传持有")
        raise


def tls_context(server):
    mode = ssl.PROTOCOL_TLS_SERVER if server else ssl.PROTOCOL_TLS_CLIENT
    context = ssl.SSLContext(mode)
    if hasattr(ssl, "TLSVersion"):
        context.minimum_version = ssl.TLSVersion.TLSv1_2
    else:
        context.options |= ssl.OP_NO_TLSv1 | ssl.OP_NO_TLSv1_1
    if not server:
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE
    return context


def read_exact(stream, size):
    buf = bytearray()
    while len(buf) < size:
        got = stream.recv(size - len(buf))
        if not got:
            raise EOFError("连接提前结束")
        buf.extend(got)
    return bytes(buf)


class Transfer:
    def __init__(self, offset):
        self.state = dict(offset=offset, complete=False, done=False, readMs=0,
                          writeMs=0, syncMs=0, cpuMs=0)
        self.cancelled = threading.Event()
        self.sockets = set()
        self.lock = threading.Lock()
        self.thread = None

    def keep(self, sock):
        with self.lock:
            if self.cancelled.is_set():
                sock.close()
                raise OSError("直传已停止")
            self.sockets.add(sock)
        return sock

    def start(self, worker):
        def run():
            started = time.process_time()
            try:
                worker()
            except Exception as error:
                self.state["error"] = str(error)[:400]
            finally:
                self.state["cpuMs"] = (time.process_time() - started) * 1000
                self.state["done"] = True
        self.thread = threading.Thread(target=run, daemon=True)
        self.thread.start()

    def stop(self):
        self.cancelled.set()
        with self.lock:
            sockets = list(self.sockets)
        for sock in sockets:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            sock.close()
        if self.thread:
            self.thread.join(3)
        return dict(self.state)


def bounds(a):
    offset, size = a["offset"], a["size"]
    if type(offset) is not int or type(size) is not int or not 0 <= offset < size:
        raise ValueError("直传文件区间无效")
    token = bytes.fromhex(a["token"])
    if len(token) != 32:
        raise ValueError("直传令牌无效")
    return offset, size, token


def listen(op, a):
    local, peer = private(a["local"]), private(a["peer"])
    offset, size, token = bounds(a)
    fd = open_file(a["path"], True)
    owned = None
    try:
        info, key = identity(fd)
        lock_file(fd)
        if key != a["identity"] or not offset <= info.st_size <= size:
            raise ValueError("暂存身份或长度变化")
        filesystem = subprocess.check_output(
            ["findmnt", "-n", "-o", "FSTYPE", "--target", a["path"]],
            timeout=3, stderr=subprocess.DEVNULL,
        ).decode().strip()
        if filesystem not in ("xfs", "ext4", "ext3", "ext2", "btrfs", "tmpfs", "zfs"):
            raise ValueError("目标挂载使用 SSH 中转")
        owned = tempfile.TemporaryDirectory(prefix="wayfarer-peer-")
        cert, keyfile = (os.path.join(owned.name, v) for v in ("cert.pem", "key.pem"))
        subprocess.check_call(["openssl", "req", "-x509", "-newkey", "rsa:2048",
                               "-sha256", "-nodes", "-days", "1", "-subj", "/CN=Wayfarer",
                               "-out", cert, "-keyout", keyfile],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=7)
        context = tls_context(True)
        context.load_cert_chain(cert, keyfile)
        with open(cert) as source:
            fingerprint = hashlib.sha256(ssl.PEM_cert_to_DER_cert(source.read())).hexdigest()
        owned.cleanup()
        owned = None
        listener = op.keep(socket.socket(socket.AF_INET, socket.SOCK_STREAM))
        listener.settimeout(10)
        listener.bind((local, 0))
        listener.listen(1)
        port = listener.getsockname()[1]
    except BaseException:
        if owned:
            owned.cleanup()
        os.close(fd)
        op.stop()
        raise

    def worker():
        try:
            raw, connection = listener.accept()
            op.keep(raw)
            with listener, raw:
                if connection[0] != peer:
                    raise ValueError("来源与所选私网地址不匹配")
                raw.settimeout(10)
                encrypted = op.keep(context.wrap_socket(raw, server_side=True))
                with encrypted:
                    if not hmac.compare_digest(read_exact(encrypted, len(token)), token):
                        raise ValueError("直传令牌校验失败")
                    encrypted.settimeout(30)
                    encrypted.sendall(b"R")
                    pos = offset
                    while pos < size:
                        data = encrypted.recv(min(CHUNK, size - pos))
                        if not data:
                            raise EOFError("源端在文件结束前断开")
                        start = time.perf_counter()
                        remaining = memoryview(data)
                        while remaining:
                            written = os.pwrite(fd, remaining, pos)
                            if not written:
                                raise OSError("目标盘写入失败")
                            remaining = remaining[written:]
                            pos += written
                        op.state["writeMs"] += (time.perf_counter() - start) * 1000
                        if pos - op.state["offset"] >= CHECKPOINT or pos == size:
                            sync = time.perf_counter()
                            os.fsync(fd)
                            op.state["syncMs"] += (time.perf_counter() - sync) * 1000
                            op.state["offset"] = pos
                    encrypted.sendall(b"A")
                    op.state["complete"] = True
        finally:
            os.close(fd)
            listener.close()

    op.start(worker)
    return dict(port=port, fingerprint=fingerprint)


def send(op, a):
    local, peer = private(a["local"]), private(a["peer"])
    offset, size, token = bounds(a)
    source = a["source"]
    def worker():
        fd = open_file(a["path"], False)
        try:
            info, ident = identity(fd)
            if (info.st_size != size or ident != source["identity"] or
                info.st_mtime_ns / 1000000 != source["mtime"] or
                info.st_ctime_ns / 1000000 != source["ctime"]):
                raise ValueError("源文件已变化")
            raw = op.keep(socket.socket(socket.AF_INET, socket.SOCK_STREAM))
            with raw:
                raw.settimeout(10)
                raw.bind((local, 0))
                raw.connect((peer, a["port"]))
                wrapped = op.keep(tls_context(False).wrap_socket(raw, server_hostname="Wayfarer"))
                with wrapped:
                    fingerprint = hashlib.sha256(wrapped.getpeercert(binary_form=True)).hexdigest()
                    if not hmac.compare_digest(fingerprint, a["fingerprint"]):
                        raise ValueError("目标证书指纹不匹配")
                    wrapped.sendall(token)
                    if read_exact(wrapped, 1) != b"R":
                        raise ValueError("目标尚未准备就绪")
                    wrapped.settimeout(30)
                    pos = offset
                    while pos < size:
                        start = time.perf_counter()
                        data = os.pread(fd, min(CHUNK, size - pos), pos)
                        op.state["readMs"] += (time.perf_counter() - start) * 1000
                        if not data:
                            raise EOFError("源文件缩短")
                        wrapped.sendall(data)
                        pos += len(data)
                    if read_exact(wrapped, 1) != b"A":
                        raise EOFError("缺少接收确认")
                    op.state.update(offset=pos, complete=True)
        finally:
            os.close(fd)

    op.start(worker)
    return True


def dispatch(method, a):
    global active
    if method == "fence":
        fd = open_file(a["path"], True)
        try:
            _, found = identity(fd)
            if a["identity"] != found:
                raise ValueError("暂存身份变化")
            lock_file(fd)
        finally:
            os.close(fd)
        return True
    if method == "status":
        return dict(active.state)
    if method == "stop":
        return active.stop() if active else None
    if active:
        raise ValueError("每个助手只处理一次直传")
    op = Transfer(a["offset"])
    result = listen(op, a) if method == "listen" else send(op, a)
    active = op
    return result


active = None
try:
    for line in sys.stdin:
        request = json.loads(line)
        try:
            method = request["method"]
            if method not in ("listen", "send", "status", "stop", "fence"):
                raise ValueError("未知直传操作")
            result = dict(id=request["id"], result=dispatch(method, request.get("args", {})))
        except Exception as error:
            result = dict(id=request.get("id"), error=dict(
                message=str(error), type=type(error).__name__, code=getattr(error, "errno", None)))
        print(json.dumps(result, ensure_ascii=True), flush=True)
finally:
    if active:
        active.stop()
