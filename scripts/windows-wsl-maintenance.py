"""Explicit Windows maintenance entry. Preview by default; run after WSL work ends."""
import argparse,ctypes,json,os,pathlib,re,shutil,subprocess,time

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest',required=True)
    parser.add_argument('--swap-file',required=True)
    parser.add_argument('--execute',action='store_true')
    args=parser.parse_args()
    if os.name!='nt':parser.error('Run this entry from Windows after ending WSL sessions')
    manifest=pathlib.Path(args.manifest);rows=json.loads(manifest.read_text(encoding='utf8'))
    temp=pathlib.Path(os.environ['LOCALAPPDATA'])/'Temp';swap=pathlib.Path(args.swap_file)
    candidates=[]
    for item in rows:
        p=pathlib.Path(item['path'])
        if p.name.lower()!='swap.vhdx' or p.parent.parent!=temp or not re.fullmatch(r'[A-Fa-f0-9-]{36}',p.parent.name):
            raise ValueError('Manifest path outside approved WSL swap scope: '+str(p))
        candidates.append(p)
    report={'started':time.time(),'execute':args.execute,'targetSwap':str(swap),'before':{drive:shutil.disk_usage(drive)._asdict() for drive in [str(temp.anchor),str(swap.anchor)]},'files':[]}
    log=manifest.with_name('wsl-maintenance-result.json')
    def save():log.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
    if not args.execute:
        report['candidates']=[str(p) for p in candidates];save();print('Preview saved:',log);return
    if not ctypes.windll.shell32.IsUserAnAdmin():raise RuntimeError('Use an elevated Windows terminal for mounted-disk checks')
    if swap.exists():raise RuntimeError('Target swap path already exists; inspect its ownership before running maintenance')
    subprocess.run(['wsl.exe','--shutdown'],check=True)
    # GUI/Agent clients must stay closed; a restarted distribution stops this maintenance.
    def running():
        r=subprocess.run(['wsl.exe','--list','--running','--quiet'],capture_output=True,check=True)
        return r.stdout.decode('utf-16-le' if b'\0' in r.stdout else 'utf8',errors='replace').replace('\0','').strip()
    time.sleep(1)
    if running():raise RuntimeError('WSL restarted; close its clients and run maintenance again')
    swap.parent.mkdir(parents=True,exist_ok=True)
    config=pathlib.Path(os.environ['USERPROFILE'])/'.wslconfig'
    original=config.read_text(encoding='utf-8-sig') if config.exists() else ''
    lines=original.splitlines();section=None;found=False;written=False;replacement='swapFile='+str(swap).replace('\\','\\\\')
    for i,line in enumerate(lines):
        if re.match(r'\s*\[.*\]\s*$',line):
            if section=='wsl2' and not written:lines.insert(i,replacement);written=True;break
            section=line.strip()[1:-1].lower();found|=section=='wsl2'
        elif section=='wsl2' and re.match(r'\s*swapfile\s*=',line,re.I):lines[i]=replacement;written=True;break
    if not written:
        if not found:lines+=['','[wsl2]']
        lines.append(replacement)
    updated='\n'.join(lines)+'\n'
    partial=config.with_name('.wslconfig.workspace-map.tmp')
    partial.write_text(updated,encoding='utf8');os.replace(str(partial),str(config))
    report['configuration']={'path':str(config),'changedSetting':replacement};save()
    for p in candidates:
        item={'path':str(p),'state':'retained'};report['files'].append(item)
        try:
            if running():raise RuntimeError('WSL is running; maintenance stopped')
            if not p.exists():item['state']='already absent';save();continue
            if p.parent.lstat().st_file_attributes&0x400 or p.lstat().st_file_attributes&0x400:raise RuntimeError('Reparse path retained')
            command="$p=[Console]::In.ReadToEnd(); try {$d=Get-DiskImage -ImagePath $p -ErrorAction Stop; @{attached=[bool]$d.Attached}|ConvertTo-Json -Compress} catch { Write-Error $_; exit 2 }"
            q=subprocess.run(['powershell.exe','-NoProfile','-Command',command],input=str(p),capture_output=True,text=True,errors='replace',check=True)
            if json.loads(q.stdout)['attached']:raise RuntimeError('Disk still attached')
            item['bytes']=p.stat().st_size;p.unlink();item['state']='removed'
        except Exception as e:
            item['error']=str(e)
            if running():save();break
        save()
    report['after']={drive:shutil.disk_usage(drive)._asdict() for drive in report['before']};report['finished']=time.time();save()
    print('Maintenance saved:',log)
    print('Reopen Ubuntu, VS Code and your Agent after reviewing this result.')

if __name__=='__main__':main()
