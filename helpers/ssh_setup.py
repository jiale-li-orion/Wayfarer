#!/usr/bin/env python3
"""First-login SSH setup in a real terminal. Passwords stay in OpenSSH's TTY."""
import argparse
import json
import os
import pathlib
import re
import shlex
import subprocess
import sys
import uuid


def parse_target(value):
    match = re.fullmatch(r"([A-Za-z0-9_][A-Za-z0-9_.-]*)@(\[[0-9A-Fa-f:]+\]|[A-Za-z0-9][A-Za-z0-9_.-]*)(?::([0-9]+))?", value)
    if not match:
        raise ValueError('Use user@host or user@host:port; IPv6 uses user@[address]:port')
    user, host, port = match.groups()
    port = int(port or 22)
    if not 1 <= port <= 65535: raise ValueError('SSH port must be 1..65535')
    return user, host.strip('[]'), port


def private_dir(path):
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.is_symlink(): raise ValueError('Credential directory must be a real directory')
    os.chmod(str(path), 0o700)


def write_private(path, text):
    temp = path.with_name(path.name + '.' + uuid.uuid4().hex)
    fd = os.open(str(temp), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, 'w', encoding='utf8') as stream:
            stream.write(text);stream.flush();os.fsync(stream.fileno())
        os.replace(str(temp), str(path))
    finally:
        if temp.exists(): temp.unlink()


INSTALL = r'''set -eu
umask 077
if [ -L "$HOME/.ssh" ] || [ -L "$HOME/.ssh/authorized_keys" ]; then
  printf '%s\n' 'SSH key location is a link; inspect it before installation.' >&2
  exit 1
fi
mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"
touch "$HOME/.ssh/authorized_keys"
chmod 600 "$HOME/.ssh/authorized_keys"
IFS= read -r key
if ! grep -qxF -- "$key" "$HOME/.ssh/authorized_keys"; then
  printf '\n%s\n' "$key" >> "$HOME/.ssh/authorized_keys"
fi
'''
VERIFY = "python3 -c " + shlex.quote("import os,sys,json;print('WAYFARER_SETUP='+json.dumps(dict(home=os.path.expanduser('~'),python=sys.executable)))")


def setup(target, alias, result_path):
    user, host, port = parse_target(target)
    if not re.fullmatch(r'wayfarer-[a-z0-9-]+', alias): raise ValueError('Invalid connection identifier')
    base = pathlib.Path.home() / '.ssh' / 'wayfarer'
    private_dir(base)
    if os.name == 'posix':
        import fcntl
        lock_path = base / (alias + '.lock')
        fd = os.open(str(lock_path), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'r+') as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise RuntimeError('This machine is being set up in another window')
            return install_key(target, user, host, port, alias, base)
    return install_key(target, user, host, port, alias, base)


def install_key(target, user, host, port, alias, base):
    key = base / (alias + '.ed25519')
    if key.is_symlink() or key.with_name(key.name + '.pub').is_symlink(): raise ValueError('Key path is a link')
    had_key = key.exists()
    if not had_key:
        subprocess.run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', alias, '-f', str(key)], check=True)
    os.chmod(str(key), 0o600)
    public_path = key.with_name(key.name + '.pub')
    if not public_path.exists():
        derived = subprocess.check_output(['ssh-keygen', '-y', '-f', str(key)], universal_newlines=True).strip()
        write_private(public_path, ' '.join(derived.split()[:2]) + ' ' + alias + '\n')
    public = public_path.read_text().strip()
    if not public.startswith('ssh-ed25519 ') or '\n' in public: raise ValueError('Unexpected public key')
    common = ['ssh', '-F', '/dev/null', '-T', '-p', str(port), '-l', user,
              '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=ask',
              '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2']
    key_only = common + ['-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none',
                         '-o', 'PreferredAuthentications=publickey', '-i', str(key)]
    check = None
    if had_key:
        probe = subprocess.run(key_only + [host, 'true'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if probe.returncode == 0:
            print('Resuming with the existing dedicated key.', flush=True)
            check = subprocess.run(key_only + [host, VERIFY], stdout=subprocess.PIPE, universal_newlines=True, check=True)
    if check is None:
        print('Confirm the host fingerprint, then enter the account password in this terminal.', flush=True)
        print('Installing a dedicated public key for this connection.', flush=True)
        # SSH reads confirmation and password from its TTY; stdin carries only the public key.
        subprocess.run(common + ['-o', 'NumberOfPasswordPrompts=1', '-o', 'PubkeyAuthentication=no',
            '-o', 'PreferredAuthentications=password,keyboard-interactive', host, INSTALL],
            input=public+'\n', universal_newlines=True, check=True)
        print('Checking password-free login and Python...', flush=True)
        check = subprocess.run(key_only + [host, VERIFY], stdout=subprocess.PIPE, universal_newlines=True, check=True)
    info = next((json.loads(line.split('=', 1)[1]) for line in check.stdout.splitlines() if line.startswith('WAYFARER_SETUP=')), None)
    if not info or not str(info.get('home', '')).startswith('/') or not str(info.get('python', '')).startswith('/'):
        raise RuntimeError('Remote login succeeded; a POSIX Python 3 environment is required')
    config = base / (alias + '.conf')
    quoted_key = str(key).replace('\\', '\\\\').replace('"', '\\"')
    write_private(config, 'Host '+alias+'\n  HostName '+host+'\n  User '+user+'\n  Port '+str(port)+
                  '\n  IdentityFile "'+quoted_key+'"\n  IdentitiesOnly yes\n')
    return dict(status='completed', host=alias, sshConfig=str(config), root=info['home'],
                python=info['python'], keyPath=str(key), target=target)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--target', required=True);parser.add_argument('--alias', required=True)
    parser.add_argument('--result', required=True)
    args = parser.parse_args(argv)
    result = pathlib.Path(args.result)
    code = 0
    try:
        value = setup(args.target, args.alias, result)
        print('Connection ready. Return to the directory map.', flush=True)
    except KeyboardInterrupt:
        value, code = dict(status='cancelled', error='SSH setup cancelled'), 130
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as error:
        detail = ('SSH command exited '+str(error.returncode)+'; inspect this terminal') if isinstance(error, subprocess.CalledProcessError) else str(error)
        value, code = dict(status='failed', error='SSH setup failed: '+detail,
                           credentialDirectory=str(pathlib.Path.home()/'.ssh/wayfarer')), 1
        print(value['error'], file=sys.stderr, flush=True)
    write_private(result, json.dumps(value, ensure_ascii=True))
    return code


if __name__ == '__main__': sys.exit(main())
