"""Bounded daily-window profiling. Command lines are used only for role recognition."""
import argparse
import json
import os
import pathlib
import runpy
import subprocess
import time


def linux_role(raw, name):
    return next((label for token, label in [
        ('extensionHost', 'extension-host'), ('app-server', 'agent-server'),
        ('GradleDaemon', 'gradle'), ('KotlinCompileDaemon', 'kotlin'),
        ('workspace-map', 'wayfarer-helper'), ('tsserver', 'language-service'),
        ('jsonServerMain', 'language-service'), ('pyright', 'language-service'),
        ('.vscode-server', 'vscode-server'), ('dsh', 'dsh-agent'),
        ('chrome', 'browser'), ('celery', 'business-worker'), ('uvicorn', 'business-api')
    ] if token in raw), name)


def windows_roles(module):
    # CIM reads arguments inside PowerShell and emits only a role and creation identity.
    command = r"""[Console]::OutputEncoding=[Text.UTF8Encoding]::new();$rows=@(Get-CimInstance Win32_Process -Filter "Name='Code.exe' OR Name='vmmemWSL' OR Name='python.exe' OR Name='node.exe' OR Name='codex.exe' OR Name='dsh.exe' OR Name='wsl.exe' OR Name='java.exe'"|ForEach-Object {$p=$_;$role=$p.Name;if($p.Name -eq 'Code.exe'){$role='vscode-main';if($p.CommandLine -match '--type=renderer'){$role='vscode-renderer'}elseif($p.CommandLine -match '--type=gpu-process'){$role='vscode-gpu'}elseif($p.CommandLine -match 'extensionHost'){$role='extension-host'}elseif($p.CommandLine -match '--type=utility'){$role='vscode-utility'}}elseif($p.Name -eq 'vmmemWSL'){$role='wsl-vm'}elseif($p.CommandLine -match 'app-server'){$role='agent-server'}elseif($p.CommandLine -match 'workspace-map'){$role='wayfarer-helper'}elseif($p.CommandLine -match 'GradleDaemon|KotlinCompileDaemon'){$role='build-daemon'};[pscustomobject]@{pid=$p.ProcessId;identity=([string]$p.ProcessId+':'+[string]$p.CreationDate.ToFileTimeUtc());role=$role;rss=if($p.Name -eq 'vmmemWSL'){[double]$p.WorkingSetSize}else{$null};privateBytes=if($p.Name -eq 'vmmemWSL'){[double]$p.PrivatePageCount}else{$null}}});ConvertTo-Json -InputObject $rows -Compress"""
    process = subprocess.Popen(['powershell.exe', '-NoProfile', '-Command', command], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        stdout, stderr = process.communicate(timeout=12)
        cpu = module['win_cpu'](process._handle)[0] * 1000
        if process.returncode:
            return {}, cpu, 'CIM role query exit ' + str(process.returncode)
        rows = json.loads(stdout.decode('utf8'))
        return {int(r['pid']): {k:r.get(k) for k in ['identity','role','rss','privateBytes']} for r in rows}, cpu, None
    except subprocess.TimeoutExpired:
        process.kill();process.communicate()
        return {}, module['win_cpu'](process._handle)[0] * 1000, 'CIM role query timed out'
    except (ValueError, UnicodeError):
        return {}, module['win_cpu'](process._handle)[0] * 1000, 'CIM role response could not be decoded'


def same_identity(left, right):
    try:
        a, b = left.split(':'), right.split(':')
        # CIM timestamps are rounded to microseconds; native process times use 100ns.
        return a[0] == b[0] and abs(int(a[1]) - int(b[1])) <= 10
    except (AttributeError, ValueError, IndexError):
        return False


def group_processes(rows):
    parents = {p['pid']:p for p in rows}
    groups = {}
    for p in rows:
        role = p.get('role', p['name'])
        root = p
        visited = set()
        vscode = root['name'].lower() in ('code.exe','code')
        while root.get('ppid') in parents and root['pid'] not in visited:
            visited.add(root['pid'])
            parent = parents[root['ppid']]
            try:
                if int(parent['identity'].split(':')[1]) > int(root['identity'].split(':')[1]): break
            except (KeyError, ValueError, IndexError): pass
            root = parent
            vscode = vscode or root['name'].lower() in ('code.exe','code')
        application = 'vscode' if vscode else 'wsl-vm' if role == 'wsl-vm' else 'agent' if role in ('agent-server','dsh-agent') else p['name'].lower()
        key = application + ':' + role
        g = groups.setdefault(key,dict(application=application,role=role,processes=0,rssBytesKnown=0,privateBytesKnown=0,pssBytesKnown=0,cpuOneCorePercentKnown=0,rssUnknown=0,privateUnknown=0,pssUnknown=0))
        g['processes'] += 1
        for field, total, unknown in [('rss','rssBytesKnown','rssUnknown'),('privateBytes','privateBytesKnown','privateUnknown'),('pss','pssBytesKnown','pssUnknown')]:
            if p.get(field) is None:g[unknown] += 1
            else:g[total] += p[field]
        g['cpuOneCorePercentKnown'] += p.get('cpuPercent') or 0
    return sorted(groups.values(),key=lambda g:g['privateBytesKnown'] if os.name=='nt' else g['pssBytesKnown'],reverse=True)


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--helper',required=True);p.add_argument('--output',required=True)
    p.add_argument('--seconds',type=int,default=600);p.add_argument('--interval',type=int,default=10)
    p.add_argument('--phase-file',help='Optional JSON with a label describing the current controlled operation')
    a=p.parse_args();module=runpy.run_path(a.helper);started=time.monotonic();limit=20*1024*1024
    roles={};role_stamp=0;role_error=None
    os.makedirs(os.path.dirname(os.path.abspath(a.output)),exist_ok=True)
    with open(a.output,'x',encoding='utf8') as out:
        while True:
            now=time.time();cpu=time.process_time();step=time.monotonic();child_cpu=0
            system=module['windows_summary'](now) if os.name=='nt' else module['linux_summary'](now)
            rows=module['windows_processes'](now) if os.name=='nt' else module['linux_processes'](now)
            if os.name=='nt' and now-role_stamp>=60:
                roles,child_cpu,role_error=windows_roles(module);role_stamp=now
            for row in rows:
                if os.name=='nt':
                    metadata=roles.get(row['pid'])
                    if metadata and (same_identity(row.get('identity'),metadata.get('identity')) or (row['name'].lower()=='vmmemwsl' and not row.get('identity'))):
                        row['role']=metadata['role'];row['roleSource']='Win32_Process.CommandLine';row['roleStamp']=int(role_stamp*1000)
                        if metadata['role']=='wsl-vm':row.update(rss=metadata['rss'],privateBytes=metadata['privateBytes'])
                else:
                    try:
                        raw=pathlib.Path('/proc/%s/cmdline'%row['pid']).read_bytes()[:16384].decode('utf8','replace')
                        row['role']=linux_role(raw,row['name']);row['roleSource']='proc-cmdline'
                    except OSError:pass
            rows.sort(key=lambda r:(r.get('rss') or 0),reverse=True)
            priority=[r for r in rows if r.get('role')=='wsl-vm']
            selected=(priority+[r for r in rows if r not in priority])[:200]
            if os.name!='nt':
                for row in selected:
                    try:
                        values={v[0].rstrip(':'):int(v[1])*1024 for v in (l.split() for l in pathlib.Path('/proc/%s/smaps_rollup'%row['pid']).read_text().splitlines()) if len(v)==3 and v[1].isdigit()}
                        row['pss']=values.get('Pss');row['swapPss']=values.get('SwapPss')
                        row['cwd']=os.readlink('/proc/%s/cwd'%row['pid'])
                    except OSError:pass
            label='daily-window'
            if a.phase_file:
                try:label=str(json.loads(pathlib.Path(a.phase_file).read_text(encoding='utf8'))['label'])
                except (OSError,ValueError,KeyError):pass
            sample=dict(stamp=int(now*1000),phase=label,platform=os.name,system=system,processes=selected,
                        groups=group_processes(selected),totalProcesses=len(rows),sampledProcesses=len(selected),
                        roleQueryError=role_error,elapsedMs=(time.monotonic()-step)*1000,
                        collectorCpuMs=(time.process_time()-cpu)*1000,collectorChildCpuMs=child_cpu)
            line=json.dumps(sample,ensure_ascii=True,separators=(',',':'))+'\n'
            if out.tell()+len(line.encode('utf8'))>limit:break
            out.write(line);out.flush()
            if time.monotonic()-started>=a.seconds:break
            time.sleep(min(max(1,a.interval-(time.monotonic()-step)),max(0,a.seconds-(time.monotonic()-started))))


if __name__=='__main__':main()
