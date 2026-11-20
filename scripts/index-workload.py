"""登记一次实验。Python 3.6+，在实验所在机器执行，可在编辑器关闭时使用。"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import tempfile
from contextlib import contextmanager


@contextmanager
def entry_lock(path):
    with path.open('a+b') as lock:
        if os.name == 'nt':
            import msvcrt
            if lock.tell() == 0:
                lock.write(b'0')
                lock.flush()
            lock.seek(0)
            msvcrt.locking(lock.fileno(), msvcrt.LK_LOCK, 1)
        else:
            import fcntl
            fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            yield
        finally:
            if os.name == 'nt':
                lock.seek(0)
                msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(lock, fcntl.LOCK_UN)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--project', type=Path, required=True)
    p.add_argument('--run-id', required=True)
    p.add_argument('--name')
    p.add_argument('--status-path')
    p.add_argument('--file', nargs=2, action='append', metavar=('KIND','PATH'), default=[])
    a = p.parse_args()
    root = a.project.resolve()
    if not root.is_dir() or not a.run_id.strip() or len(a.run_id)>256:
        p.error('请选择现有项目并提供有效运行编号')
    dest = root/'.wayfarer'/'runs'
    dest.mkdir(parents=True, exist_ok=True)
    stem = hashlib.sha256(a.run_id.encode('utf8')).hexdigest()
    target = dest/(stem+'.json')
    with entry_lock(dest/(stem+'.lock')):
        data = json.loads(target.read_text(encoding='utf8')) if target.exists() else dict(schema='wayfarer.run/1',runId=a.run_id,files=[])
        if data['runId']!=a.run_id or data['schema']!='wayfarer.run/1':
            raise ValueError('索引版本或运行编号发生变化')
        if a.name: data['name']=a.name
        if a.status_path: data['statusPath']=a.status_path
        links={(f['kind'],f['path']):f for f in data['files']}
        for kind,path in a.file:
            if kind not in ('model','profile','log','artifact'):p.error('未知引用类型 '+kind)
            links.setdefault((kind,path),dict(kind=kind,path=path))
        data['files']=list(links.values())
        body=json.dumps(data,ensure_ascii=False,indent=2).encode('utf8')
        if len(body)>65536:raise ValueError('每条索引最多 64 KiB')
        with tempfile.NamedTemporaryFile(dir=str(dest),suffix='.part',delete=False) as f:
            temp=Path(f.name)
            try:
                f.write(body);f.flush();os.fsync(f.fileno());f.close()
                os.replace(str(temp),str(target))
            finally:
                if temp.exists():temp.unlink()
    print(target)


if __name__=='__main__':main()
