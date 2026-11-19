#!/usr/bin/env python3
"""Short, direct IPv4 checks between explicitly selected machines."""
import ipaddress
import json
import socket
import subprocess
import sys
import threading
import time

PRIVATE = tuple(ipaddress.IPv4Network(net) for net in (
    "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"
))
LISTENER = None
THREAD = None
RESULT = None
LIMIT = 128 * 1024 * 1024


def ip(*args):
    return subprocess.check_output(("ip",) + args, timeout=2).decode("utf-8")


def interfaces():
    rows = []
    for line in ip("-o", "-4", "address", "show", "up", "scope", "global").splitlines():
        fields = line.split()
        address, _, prefix = fields[3].partition("/")
        if any(ipaddress.IPv4Address(address) in network for network in PRIVATE):
            rows.append(dict(device=fields[1].split("@")[0], address=address, prefix=int(prefix)))
    return rows[:64]


def describe(local, peer):
    if not any(row["address"] == local for row in interfaces()):
        raise ValueError("所选地址不在本机的活动私网接口上")
    if not any(ipaddress.IPv4Address(peer) in network for network in PRIVATE):
        raise ValueError("目标需要使用私网 IPv4")
    fields = ip("-4", "route", "get", peer, "from", local).splitlines()[0].split()
    device = fields[fields.index("dev") + 1]
    try:
        with open("/sys/class/net/{}/mtu".format(device)) as f:
            mtu = int(f.read())
    except (OSError, ValueError):
        mtu = None
    try:
        import os
        rdma = sorted(os.listdir("/sys/class/infiniband"))
    except FileNotFoundError:
        rdma = []
    return dict(device=device, mtu=mtu, address=local, peer=peer,
                gateway=fields[fields.index("via") + 1] if "via" in fields else None,
                rdma=rdma)


def connect(local, peer, port, deadline):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind((local, 0))
        s.settimeout(min(2.5, remaining(deadline)))
        start = time.monotonic()
        s.connect((peer, port))
        return s, (time.monotonic() - start) * 1000
    except BaseException:
        s.close()
        raise


def remaining(deadline):
    seconds = deadline - time.monotonic()
    if seconds <= 0:
        raise TimeoutError("测试超过时限")
    return seconds


def expect(s, expected, deadline):
    received = b""
    while len(received) < len(expected):
        s.settimeout(remaining(deadline))
        part = s.recv(len(expected) - len(received))
        if not part:
            raise EOFError("连接已关闭")
        received += part
    if received != expected:
        raise ValueError("测速握手失败")


def receive(s, count, deadline):
    data = bytearray(min(256 * 1024, count))
    s.sendall(b"R")
    while count:
        s.settimeout(remaining(deadline))
        got = s.recv_into(data, min(count, len(data)))
        if not got:
            raise EOFError("传输提前结束")
        count -= got
    s.sendall(b"A")


def send(s, count, deadline):
    expect(s, b"R", deadline)
    data = memoryview(bytearray(min(256 * 1024, count)))
    start = time.monotonic()
    left = count
    while left:
        part = data[:min(left, len(data))]
        s.settimeout(remaining(deadline))
        s.sendall(part)
        left -= len(part)
    expect(s, b"A", deadline)
    elapsed = time.monotonic() - start
    return dict(bytes=count, elapsedMs=elapsed * 1000, bitsPerSecond=count * 8 / elapsed)


def listen(local, peer, count, token):
    global LISTENER, THREAD
    if LISTENER is not None:
        raise ValueError("已有测速连接")
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        listener.bind((local, 0))
        listener.settimeout(5)
        listener.listen(1)
    except BaseException:
        listener.close()
        raise
    LISTENER = listener

    def worker():
        global RESULT
        try:
            deadline = time.monotonic() + 8
            s, address = listener.accept()
            with s:
                if address[0] != peer:
                    raise ValueError("测速来源与所选机器不符")
                expect(s, token, deadline)
                receive(s, count, deadline)
                RESULT = send(s, count, deadline)
        except Exception as error:
            RESULT = {"error": str(error)}
        finally:
            listener.close()

    THREAD = threading.Thread(target=worker, daemon=True)
    THREAD.start()
    return listener.getsockname()[1]


def dispatch(method, a):
    if method == "interfaces":
        return interfaces()
    if method == "result":
        if THREAD is None:
            raise ValueError("测速尚未开始")
        THREAD.join(1)
        if RESULT is None:
            raise TimeoutError("测速结果尚未就绪")
        if "error" in RESULT:
            raise OSError(RESULT["error"])
        return RESULT
    local, peer = a["local"], a["peer"]
    route = describe(local, peer)
    if method == "route":
        try:
            s, elapsed = connect(local, peer, a["port"], time.monotonic() + 3)
            s.close()
            route.update(tcp="reachable", connectMs=elapsed)
        except OSError as error:
            route.update(tcp="unreachable", tcpError=str(error))
        return route
    count = a["bytes"]
    if type(count) is not int or not 1 <= count <= LIMIT:
        raise ValueError("测速数据量超出范围")
    token = a["token"].encode("ascii")
    if len(token) != 32:
        raise ValueError("测速令牌无效")
    if method == "listen":
        return listen(local, peer, count, token)
    if method == "measure":
        deadline = time.monotonic() + 8
        s, elapsed = connect(local, peer, a["port"], deadline)
        with s:
            s.sendall(token)
            result = send(s, count, deadline)
            receive(s, count, deadline)
        return dict(connectMs=elapsed, direction=result)
    raise ValueError("未知链路操作")


for line in sys.stdin:
    message = json.loads(line)
    try:
        output = dict(id=message["id"], result=dispatch(message["method"], message.get("args", {})))
    except Exception as error:
        output = dict(id=message["id"], error=dict(message=str(error), type=type(error).__name__))
    print(json.dumps(output, ensure_ascii=True), flush=True)
