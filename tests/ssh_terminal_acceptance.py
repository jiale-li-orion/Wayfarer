"""Optional real OpenSSH/TTY acceptance against an isolated in-process SSH fixture.
Run with uv --with paramiko. Uses no real account credentials or remote authorized_keys.
"""
import base64
import fcntl
import json
import os
import pathlib
import pty
import runpy
import select
import shlex
import signal
import socket
import subprocess
import sys
import tempfile
import termios
import threading
import time
import paramiko

ROOT=pathlib.Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix="wm-ssh-terminal-") as directory:
    root=pathlib.Path(directory);local=root/'local';remote=root/'remote';local.mkdir();remote.mkdir()
    hostkey=paramiko.RSAKey.generate(2048)
    listener=socket.socket();listener.bind(('127.0.0.1',0));listener.listen(4);listener.settimeout(.2)
    port=listener.getsockname()[1];closed=threading.Event();auth=[];transports=[]
    class Server(paramiko.ServerInterface):
        def get_allowed_auths(self,user):return 'password,publickey'
        def check_auth_password(self,user,password):
            if user=='fixture' and password=='fixture-only-pass':auth.append('password');return paramiko.AUTH_SUCCESSFUL
            return paramiko.AUTH_FAILED
        def check_auth_publickey(self,user,key):
            file=remote/'.ssh/authorized_keys'
            if file.exists() and any(len(line.split())>=2 and line.split()[1]==key.get_base64() for line in file.read_text().splitlines()):
                auth.append('publickey');return paramiko.AUTH_SUCCESSFUL
            return paramiko.AUTH_FAILED
        def check_channel_request(self,kind,ident):return paramiko.OPEN_SUCCEEDED if kind=='session' else paramiko.OPEN_FAILED_ADMINISTRATIVELY_PROHIBITED
        def check_channel_exec_request(self,channel,command):
            command=command.decode()
            def execute():
                try:
                    if command.startswith('set -eu'):
                        data=b''
                        while True:
                            chunk=channel.recv(8192)
                            if not chunk:break
                            data+=chunk
                        done=subprocess.run(['sh','-c',command.replace('$HOME',str(remote))],input=data,capture_output=True)
                        if done.stdout:channel.sendall(done.stdout)
                        if done.stderr:channel.sendall_stderr(done.stderr)
                        channel.send_exit_status(done.returncode)
                    elif 'WAYFARER_SETUP=' in command:
                        channel.sendall(('WAYFARER_SETUP='+json.dumps({'home':str(remote),'python':sys.executable})+'\n').encode())
                        channel.send_exit_status(0)
                    else:channel.send_exit_status(1)
                finally:channel.close()
            threading.Thread(target=execute,daemon=True).start();return True
    def serve():
        while not closed.is_set():
            try:connection,_=listener.accept()
            except socket.timeout:continue
            except OSError:break
            transport=paramiko.Transport(connection);transports.append(transport);transport.add_server_key(hostkey)
            def handle(transport):
                try:
                    transport.start_server(server=Server())
                    while transport.is_active() and not closed.is_set():time.sleep(.05)
                finally:transport.close()
            threading.Thread(target=handle,args=(transport,),daemon=True).start()
    thread=threading.Thread(target=serve,daemon=True);thread.start()
    # Override only fixture credential placement and known_hosts; OpenSSH itself handles the real terminal.
    code="""import pathlib,runpy,subprocess,sys
from unittest import mock
module=runpy.run_path(sys.argv[1]);home=pathlib.Path(sys.argv[2]);original=subprocess.run

def run(argv,**kwargs):
    if argv[0]=='ssh':argv=argv[:1]+['-o','UserKnownHostsFile='+str(home/'known_hosts'),'-o','GlobalKnownHostsFile=/dev/null']+argv[1:]
    return original(argv,**kwargs)
with mock.patch.object(pathlib.Path,'home',return_value=home),mock.patch.object(subprocess,'run',side_effect=run):
    raise SystemExit(module['main'](sys.argv[3:]))
"""
    master,slave=pty.openpty()
    def terminal():os.setsid();fcntl.ioctl(0,termios.TIOCSCTTY,0)
    result=root/'result.json'
    process=subprocess.Popen([sys.executable,'-c',code,str(ROOT/'helpers/ssh_setup.py'),str(local),'--target','fixture@127.0.0.1:'+str(port),'--alias','wayfarer-fixture','--result',str(result)],stdin=slave,stdout=slave,stderr=slave,preexec_fn=terminal)
    os.close(slave);output=b'';confirmed=False;password=False;deadline=time.monotonic()+30
    try:
        while process.poll() is None and time.monotonic()<deadline:
            ready,_,_=select.select([master],[],[],.1)
            if not ready:continue
            try:chunk=os.read(master,65536)
            except OSError:break
            output+=chunk
            if b'continue connecting' in output and not confirmed:os.write(master,b'yes\n');confirmed=True
            if b'password:' in output.lower() and not password:os.write(master,b'fixture-only-pass\n');password=True
        process.wait(timeout=3)
        assert process.returncode==0,output.decode(errors='replace').replace('fixture-only-pass','[redacted]')
        value=json.loads(result.read_text());assert value['status']=='completed',value
        assert confirmed and password and 'password' in auth and 'publickey' in auth
        assert b'fixture-only-pass' not in output,'Password echoed into terminal output'
        assert pathlib.Path(value['keyPath']).stat().st_mode & 0o777 == 0o600
        print(json.dumps({'status':'passed','hostConfirmation':confirmed,'passwordPrompt':password,'keyAuthentication':True,'passwordEchoed':False,'credentialScope':'isolated temporary directory'}))
    finally:
        if process.poll() is None:os.killpg(process.pid,signal.SIGTERM);process.wait(timeout=3)
        os.close(master);closed.set();listener.close()
        for transport in transports:transport.close()
        thread.join(timeout=1)
