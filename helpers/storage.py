# Storage scanner and snapshot index. Python 3.6+, standard library only.
import os, sys, json, time, stat, sqlite3, tempfile, shutil, hashlib, heapq, ctypes, glob

def key(path):
    return hashlib.sha256(os.path.normcase(os.path.abspath(path)).encode('utf-8', 'surrogatepass')).hexdigest()

def dbopen(path):
    db = sqlite3.connect(path)
    db.execute('PRAGMA cache_size=-2048')
    db.execute('PRAGMA temp_store=FILE')
    db.execute('CREATE TABLE IF NOT EXISTS dirs(id TEXT PRIMARY KEY,parent TEXT,path TEXT,logical INTEGER,allocated INTEGER,data TEXT)')
    db.execute('CREATE INDEX IF NOT EXISTS children ON dirs(parent,allocated DESC,path)')
    db.execute('CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY,v TEXT)')
    return db

def put(db, rows):
    db.executemany('INSERT OR REPLACE INTO dirs VALUES(?,?,?,?,?,?)', [
        (r['id'],r['parent'],r['path'],r['logicalBytes'],r['allocatedBytesKnown'],json.dumps(r,ensure_ascii=True)) for r in rows])
    db.commit()

def metadata(db, value):
    db.execute('INSERT OR REPLACE INTO meta VALUES(?,?)', ('snapshot',json.dumps(value,ensure_ascii=True)))
    db.commit()

def allocated(path, s):
    if os.name != 'nt':
        blocks = getattr(s, 'st_blocks', None)
        return None if blocks is None else blocks * 512
    hi = ctypes.c_ulong()
    ctypes.set_last_error(0)
    lo = kernel.GetCompressedFileSizeW(path,ctypes.byref(hi))
    if lo == 0xffffffff and ctypes.get_last_error():
        return None
    return (hi.value << 32) + lo

kernel = None
if os.name == 'nt':
    kernel = ctypes.WinDLL('kernel32',use_last_error=True)
    kernel.GetCompressedFileSizeW.argtypes = [ctypes.c_wchar_p,ctypes.POINTER(ctypes.c_ulong)]
    kernel.GetCompressedFileSizeW.restype = ctypes.c_ulong

def probe(path):
    path = os.path.abspath(path)
    s = os.stat(path)
    if not stat.S_ISDIR(s.st_mode):
        raise ValueError('Select a directory')
    root = path
    while os.path.dirname(root) != root:
        parent = os.path.dirname(root)
        try:
            if os.stat(parent).st_dev != s.st_dev: break
        except OSError: break
        root = parent
    disk = shutil.disk_usage(path)
    value = {'path':path,'volume':str(s.st_dev),'mount':root,'total':disk.total,'available':disk.free,'platform':sys.platform,'stamp':int(time.time()*1000)}
    if os.name == 'nt':
        value['resolved'] = os.path.realpath(path)
        value['drive'] = os.path.splitdrive(value['resolved'])[0].upper()
        value['wsl'] = []
        try:
            import winreg
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER,r'Software\Microsoft\Windows\CurrentVersion\Lxss') as k:
                for i in range(winreg.QueryInfoKey(k)[0]):
                    with winreg.OpenKey(k,winreg.EnumKey(k,i)) as sub:
                        name = winreg.QueryValueEx(sub,'DistributionName')[0]
                        base = winreg.QueryValueEx(sub,'BasePath')[0]
                        hostdisk=shutil.disk_usage(base)
                        value['wsl'].append({'distribution':name,'basePath':base,'hostVolume':{'stamp':int(time.time()*1000),'volume':str(os.stat(base).st_dev),'mount':os.path.splitdrive(os.path.realpath(base))[0]+'\\','total':hostdisk.total,'available':hostdisk.free},'disks':[{'path':p,'logicalBytes':os.stat(p).st_size,'allocatedBytes':allocated(p,os.stat(p))} for p in glob.glob(os.path.join(base,'*.vhdx'))]})
        except OSError as e: value['wslError'] = str(e)
        value['swapFiles'] = []
        for p in glob.glob(os.path.join(os.environ.get('TEMP',tempfile.gettempdir()),'*','swap.vhdx')):
            try:
                st = os.stat(p)
                value['swapFiles'].append({'path':p,'logicalBytes':st.st_size,'allocatedBytes':allocated(p,st),'mtime':int(st.st_mtime*1000),'activity':'unknown'})
            except OSError: pass
    elif path.startswith('/mnt/') and len(path)>=6 and path[5].isalpha() and (len(path)==6 or path[6]=='/'):
        value['windowsDrive'] = path[5].upper()+':'
    return value

def resources():
    if os.name != 'nt':
        import resource
        return {'peakRss':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss*(1 if sys.platform=='darwin' else 1024)}
    from ctypes import wintypes
    class Counters(ctypes.Structure):
        _fields_=[('cb',wintypes.DWORD),('PageFaultCount',wintypes.DWORD)]+[(n,ctypes.c_size_t) for n in ['PeakWorkingSetSize','WorkingSetSize','QuotaPeakPagedPoolUsage','QuotaPagedPoolUsage','QuotaPeakNonPagedPoolUsage','QuotaNonPagedPoolUsage','PagefileUsage','PeakPagefileUsage']]
    counters=Counters();counters.cb=ctypes.sizeof(counters)
    kernel.GetCurrentProcess.restype=wintypes.HANDLE
    psapi=ctypes.WinDLL('psapi',use_last_error=True)
    psapi.GetProcessMemoryInfo.argtypes=[wintypes.HANDLE,ctypes.POINTER(Counters),wintypes.DWORD]
    process=kernel.GetCurrentProcess();psapi.GetProcessMemoryInfo(process,ctypes.byref(counters),counters.cb)
    return {'rss':counters.WorkingSetSize,'peakRss':counters.PeakWorkingSetSize}

class Scan:
    def __init__(self, path, store=None, volume=None):
        self.probe = probe(path)
        for field in ['backing','physicalBudget','volumeKey','volumeCapacityKind']:
            if volume and field in volume:self.probe[field]=volume[field]
        self.root = self.probe['path']
        self.temp = None
        if not store:
            self.temp = tempfile.mkdtemp(prefix='workspace-map-storage-')
            os.chmod(self.temp,0o700)
            store = os.path.join(self.temp,'scan.sqlite')
        self.store = store
        self.db = dbopen(store)
        self.db.execute('CREATE TABLE seen(dev TEXT,ino TEXT,links INTEGER,observed INTEGER,bytes INTEGER,PRIMARY KEY(dev,ino))')
        self.started = time.time()
        self.cpu = time.process_time()
        self.files = 0
        self.directories = 0
        self.errors = []
        self.error_count = 0
        self.skipped = 0
        self.biggest = []
        self.done = False
        self.result = None
        self.iterator = self.walk(self.root,None)
        metadata(self.db,self.summary())
    def error(self,path,e):
        self.error_count += 1
        if len(self.errors)<100: self.errors.append({'path':path,'error':str(e)})
    def summary(self):
        return {'root':self.root,'rootId':key(self.root),'started':int(self.started*1000),'stamp':int(time.time()*1000),'files':self.files,'directories':self.directories,'errorCount':self.error_count,'errors':self.errors,'skippedLinks':self.skipped,'incomplete':not self.done or self.error_count>0,'finished':self.done,'volume':self.probe,'elapsedMs':(time.time()-self.started)*1000,'cpuMs':(time.process_time()-self.cpu)*1000,'resources':resources(),'accounting':'allocated bytes attributed once per file identity inside this scan; hardlinks may also exist outside the selected tree','topFiles':[x[2] for x in sorted(self.biggest,reverse=True)],'rootStats':self.result}
    def walk(self,path,parent):
        row={'id':key(path),'parent':parent,'path':path,'logicalBytes':0,'allocatedBytesKnown':0,'allocationUnknownFiles':0,'hardlinkBytes':0,'files':0,'directories':0,'errors':0,'ownFiles':0,'directoryBytesKnown':0,'directoryAllocationAvailable':os.name!='nt'}
        started_stat = None
        try:
            started_stat = os.stat(path,follow_symlinks=False)
            if os.name!='nt' and hasattr(started_stat,'st_blocks'):
                row['directoryBytesKnown']=started_stat.st_blocks*512
                row['allocatedBytesKnown']+=row['directoryBytesKnown']
            with os.scandir(path) as entries:
                for e in entries:
                    try:
                        s=os.stat(e.path,follow_symlinks=False) if os.name=='nt' else e.stat(follow_symlinks=False)
                        if stat.S_ISLNK(s.st_mode) or getattr(s,'st_file_attributes',0)&0x400:
                            self.skipped+=1
                            continue
                        if s.st_dev != self.rootdev:
                            self.skipped+=1
                            continue
                        if stat.S_ISDIR(s.st_mode):
                            child = None
                            for item in self.walk(e.path,row['id']):
                                if item is not None:
                                    child=item
                                yield item
                            if child:
                                for f in ['logicalBytes','allocatedBytesKnown','allocationUnknownFiles','hardlinkBytes','files','errors','directoryBytesKnown']:
                                    row[f]+=child[f]
                                row['directories']+=1+child['directories']
                        elif stat.S_ISREG(s.st_mode):
                            n=allocated(e.path,s)
                            unique=True
                            if s.st_nlink>1:
                                identity=(str(s.st_dev),str(s.st_ino))
                                old=self.db.execute('SELECT observed FROM seen WHERE dev=? AND ino=?',identity).fetchone()
                                if old:
                                    self.db.execute('UPDATE seen SET observed=observed+1 WHERE dev=? AND ino=?',identity)
                                    unique=False
                                else:
                                    self.db.execute('INSERT INTO seen VALUES(?,?,?,?,?)',identity+(s.st_nlink,1,n or 0))
                                row['hardlinkBytes']+=n or 0
                            row['logicalBytes']+=s.st_size
                            row['allocatedBytesKnown']+=(n or 0) if unique else 0
                            row['allocationUnknownFiles']+=int(n is None)
                            row['files']+=1;row['ownFiles']+=1;self.files+=1
                            file={'path':e.path,'logicalBytes':s.st_size,'allocatedBytes':n,'links':s.st_nlink,'mtime':int(s.st_mtime*1000)}
                            item=(s.st_size,e.path,file)
                            if len(self.biggest)<100:heapq.heappush(self.biggest,item)
                            elif item[:2]>self.biggest[0][:2]:heapq.heapreplace(self.biggest,item)
                        # Give the RPC driver a scheduling/cancellation boundary for large flat directories.
                        yield None
                    except OSError as ex:
                        self.error(e.path,ex);row['errors']+=1
        except OSError as ex:
            self.error(path,ex);row['errors']+=1
        try:
            if started_stat and os.stat(path,follow_symlinks=False).st_mtime_ns != started_stat.st_mtime_ns:
                self.error(path,'directory changed during scan');row['errors']+=1
        except OSError as ex:self.error(path,ex);row['errors']+=1
        self.directories+=1
        if parent is None:
            shared=self.db.execute('SELECT COALESCE(SUM(bytes),0) FROM seen WHERE observed<links').fetchone()[0]
            row['externallySharedBytesKnown']=shared
            row['reclaimableUpperBoundBytes']=None if row['allocationUnknownFiles'] or row['errors'] else max(0,row['allocatedBytesKnown']-shared)
            row['reclaimableBasis']='upper bound for known file and directory blocks when removing this complete tree; excludes external hardlinks; compressed/shared extents and live changes may reduce the result'
            self.result=row
        yield row
    @property
    def rootdev(self):
        return int(self.probe['volume'])
    def page(self):
        rows=[];end=time.monotonic()+0.04
        while len(rows)<100 and time.monotonic()<end and not self.done:
            try:
                row=next(self.iterator)
                if row is not None:rows.append(row)
            except StopIteration:self.done=True
        if rows:put(self.db,rows)
        info=self.summary()
        metadata(self.db,info)
        if self.done:
            # File identities are working data; snapshots keep only aggregates.
            self.db.execute('DROP TABLE IF EXISTS seen');self.db.commit();self.db.execute('VACUUM')
        return {'rows':rows,'snapshot':info,'done':self.done}
    def close(self):
        try:self.iterator.close()
        finally:
            self.db.close()
            if self.temp:shutil.rmtree(self.temp,ignore_errors=True)

scan=None

def dispatch(method,a):
    global scan
    if method=='probe':return probe(a['path'])
    if method=='begin':
        if scan:scan.close()
        scan=Scan(a['path'],a.get('store'),a.get('volume'))
        return scan.summary()
    if method=='page':return scan.page()
    if method=='close':
        if scan:scan.close();scan=None
        return True
    if method=='import':
        db=dbopen(a['store'])
        try:
            put(db,a.get('rows',[]))
            if 'snapshot' in a:metadata(db,a['snapshot'])
        finally:db.close()
        return True
    if method=='compare':
        db=sqlite3.connect('file:'+a['afterStore'].replace('\\','/')+'?mode=ro',uri=True)
        try:
            db.execute('PRAGMA cache_size=-2048')
            db.execute('PRAGMA temp_store=FILE')
            db.execute('ATTACH DATABASE ? AS beforedb',('file:'+a['beforeStore'].replace('\\','/')+'?mode=ro',))
            before=json.loads(db.execute("SELECT v FROM beforedb.meta WHERE k='snapshot'").fetchone()[0])
            after=json.loads(db.execute("SELECT v FROM main.meta WHERE k='snapshot'").fetchone()[0])
            if before['rootId']!=after['rootId']:raise ValueError('Select snapshots with the same root')
            parent=a.get('directory') or after['rootId']
            if '/' in parent or '\\' in parent:parent=key(parent)
            offset=max(0,int(a.get('offset',0)));limit=max(1,min(200,int(a.get('limit',50))))
            sql="""SELECT b.data,a.data,COALESCE(a.allocated,0)-COALESCE(b.allocated,0)
              FROM (SELECT id FROM main.dirs WHERE parent=? UNION SELECT id FROM beforedb.dirs WHERE parent=?) ids
              LEFT JOIN beforedb.dirs b ON b.id=ids.id LEFT JOIN main.dirs a ON a.id=ids.id
              ORDER BY abs(COALESCE(a.allocated,0)-COALESCE(b.allocated,0)) DESC,COALESCE(a.path,b.path) LIMIT ? OFFSET ?"""
            rows=[]
            for old,new,delta in db.execute(sql,(parent,parent,limit+1,offset)):
                b=json.loads(old) if old else None;n=json.loads(new) if new else None
                rows.append(dict(id=(n or b)['id'],path=(n or b)['path'],before=b,after=n,allocatedDelta=delta,logicalDelta=(n or {}).get('logicalBytes',0)-(b or {}).get('logicalBytes',0),state='added' if b is None else 'removed' if n is None else 'present'))
            def volume(v):return v.get('physicalBudget') or v
            bv=volume(before.get('volume',{}));av=volume(after.get('volume',{}))
            same=bv.get('volume') is not None and bv.get('volume')==av.get('volume')
            return dict(before=before,after=after,rows=rows[:limit],offset=offset,hasMore=len(rows)>limit,
                coverageChanged=any(before.get(k)!=after.get(k) for k in ['incomplete','errorCount','skippedLinks','finished']),
                incomplete=bool(before.get('incomplete') or after.get('incomplete')),
                volumeAvailableDelta=av['available']-bv['available'] if same and 'available' in av and 'available' in bv else None,
                volumeBefore=bv,volumeAfter=av)
        finally:db.close()
    if method=='query':
        db=sqlite3.connect('file:'+a['store'].replace('\\','/')+'?mode=ro',uri=True)
        try:
            snapshot=json.loads(db.execute('SELECT v FROM meta WHERE k=?',('snapshot',)).fetchone()[0])
            parent=a.get('directory') or snapshot['rootId']
            if '/' in parent or '\\' in parent:parent=key(parent)
            found=db.execute('SELECT data FROM dirs WHERE id=?',(parent,)).fetchone()
            offset=max(0,int(a.get('offset',0)));limit=max(1,min(200,int(a.get('limit',50))))
            rows=[json.loads(r[0]) for r in (db.execute('SELECT data FROM dirs ORDER BY id LIMIT ? OFFSET ?',(limit+1,offset)) if parent=='*' else db.execute('SELECT data FROM dirs WHERE parent=? ORDER BY allocated DESC,path LIMIT ? OFFSET ?',(parent,limit+1,offset)))]
            snapshot['topFiles']=snapshot.get('topFiles',[])[:100]
            return {'snapshot':snapshot,'directory':json.loads(found[0]) if found else None,'rows':rows[:limit],'offset':offset,'hasMore':len(rows)>limit}
        finally:db.close()
    raise ValueError('Unknown storage method')

if __name__=='__main__':
    try:
        for raw in sys.stdin.buffer:
            try:
                line = raw.decode('utf-8')
                r=json.loads(line)
                value=dispatch(r['method'],r.get('args',{}))
                response={'id':r['id'],'result':value}
            except Exception as e:
                response={'id':r.get('id'),'error':{'message':str(e),'type':type(e).__name__}}
            sys.stdout.write(json.dumps(response,ensure_ascii=True,separators=(',',':'))+'\n');sys.stdout.flush()
    finally:
        if scan:scan.close()
