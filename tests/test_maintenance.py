import importlib.util
import os
import pathlib
import tempfile
import unittest
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("maintenance", str(ROOT / "scripts/windows-wsl-maintenance.py"))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
profile_spec=importlib.util.spec_from_file_location('profile',str(ROOT/'scripts/profile-pressure.py'))
profile=importlib.util.module_from_spec(profile_spec);profile_spec.loader.exec_module(profile)


class Wsl:
    def __init__(self, after=None):
        self.calls = 0
        self.after = after
    def running(self):
        self.calls += 1
        return ["Ubuntu"] if self.after and self.calls >= self.after else []


class Handle:
    """Portable fixture backend exercises the real maintenance selection and lifecycle."""
    closed = 0
    def __init__(self, path):
        self.path = path
    def __enter__(self):
        return self
    def __exit__(self, *unused):
        type(self).closed += 1
    def snapshot(self):
        s = self.path.stat()
        return dict(identity=str(s.st_ino), size=s.st_size, allocated=s.st_size,
                    lastWrite=str(s.st_mtime_ns), finalPath=str(self.path))
    def delete(self):
        self.path.unlink()


class MaintenanceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name)
        self.scope = m.Scope(self.root, self.root / "current.vhdx")
    def tearDown(self):
        self.tmp.cleanup()
    def file(self):
        folder = self.root / str(uuid.uuid4());folder.mkdir()
        path = folder / "swap.vhdx";path.write_bytes(b"fixture")
        return path
    def plan(self, paths, opener=Handle):
        return m.preview([dict(path=str(p)) for p in paths], self.scope, opener)
    def test_preview_and_reentry_preserve_config_and_source(self):
        text = '\ufeff[wsl2]\r\nmemory=10GB\r\nswapFile=F:\\\\WSL\\\\swap.vhdx\r\n[experimental]\r\n# existing\r\n'
        self.assertEqual(m.config_update(text, r'F:\WSL\swap.vhdx'), (text, True))
        changed, matches = m.config_update('[wsl2]\nmemory=10GB\n[experimental]\nfoo=bar\n', r'F:\WSL\swap.vhdx')
        self.assertFalse(matches);self.assertIn('memory=10GB\n', changed)
        self.assertTrue(changed.index('swapFile=') < changed.index('[experimental]'))
        p = self.file();plan = self.plan([p]);self.assertTrue(p.exists())
        self.assertEqual(plan['candidates'][0]['state'], 'ready')
        report = m.execute(plan, self.scope, Wsl(), Handle)
        self.assertEqual(report['outcome'], 'completed');self.assertFalse(p.exists())
        self.assertEqual(m.execute(plan, self.scope, Wsl(), Handle)['files'][0]['state'], 'already-absent')
    def test_identity_replacement_retains_new_file(self):
        p = self.file();plan = self.plan([p]);p.rename(p.with_name('old.bin'));p.write_bytes(b'fixture')
        report = m.execute(plan, self.scope, Wsl(), Handle)
        self.assertEqual(report['outcome'], 'partial');self.assertTrue(p.exists())
        self.assertIn('changed', report['files'][0]['error']['message'])
    def test_partial_failure_continues_and_marks_unprocessed_on_wsl_restart(self):
        a, b = self.file(), self.file();plan = self.plan([a, b])
        class Denied(Handle):
            def __init__(self, path):
                if path == a:raise PermissionError('fixture denied')
                super().__init__(path)
        report = m.execute(plan, self.scope, Wsl(), Denied)
        self.assertEqual(report['outcome'], 'partial');self.assertTrue(a.exists());self.assertFalse(b.exists())
        a, b = self.file(), self.file();plan = self.plan([a, b]);saved=[]
        report = m.execute(plan, self.scope, Wsl(after=3), Handle, lambda r: saved.append(dict(r)))
        self.assertEqual(report['outcome'], 'blocked');self.assertEqual(report['stopReason'], 'wsl-restarted')
        self.assertEqual(report['runningDistributions'], ['Ubuntu'])
        self.assertFalse(a.exists());self.assertTrue(b.exists());self.assertEqual(report['files'][1]['state'], 'not-processed')
        self.assertTrue(saved)
    def test_running_wsl_blocks_before_deletion(self):
        p=self.file();report=m.execute(self.plan([p]), self.scope, Wsl(after=1), Handle)
        self.assertEqual(report['outcome'], 'blocked');self.assertTrue(p.exists())
    def test_changed_contents_and_appeared_file_are_retained(self):
        p=self.file();plan=self.plan([p]);p.write_bytes(b'changed length')
        self.assertEqual(m.execute(plan,self.scope,Wsl(),Handle)['outcome'],'partial');self.assertTrue(p.exists())
        absent=p.parent/'swap.vhdx';p.unlink();plan=self.plan([absent]);absent.write_bytes(b'new')
        self.assertEqual(m.execute(plan,self.scope,Wsl(),Handle)['outcome'],'partial');self.assertTrue(absent.exists())
    def test_wsl_status_decoding_and_failed_probe_details(self):
        from unittest import mock
        import subprocess
        control=m.Wsl.__new__(m.Wsl);control.names={'Ubuntu'}
        for raw, expected in [(b'',[]),('Ubuntu\r\n'.encode('utf-16-le'),['Ubuntu']),('Ubuntu\r\n'.encode('utf-16'),['Ubuntu'])]:
            with mock.patch.object(m.subprocess,'run',return_value=mock.Mock(stdout=raw)):
                self.assertEqual(control.running(),expected)
        with mock.patch.object(m.subprocess,'run',return_value=mock.Mock(stdout=b'unknown status')):
            with self.assertRaises(RuntimeError):control.running()
        detail=m.error_detail(subprocess.CalledProcessError(2,['probe'],output=b'detail',stderr=b'access denied'))
        self.assertEqual(detail['exitCode'],2);self.assertEqual(detail['stderr'],'access denied')

    def test_scope_and_reparse_reject_other_data(self):
        other=self.root/'ext4.vhdx';other.write_bytes(b'preserve')
        self.assertEqual(self.plan([other])['candidates'][0]['state'],'retained')
        with self.assertRaises(ValueError):self.scope.check(self.scope.fixed_swap)
        if os.name!='nt':
            p=self.file();p.unlink();p.symlink_to(other)
            self.assertEqual(self.plan([p])['candidates'][0]['state'],'retained');self.assertTrue(other.exists())
    @unittest.skipUnless(os.name=='nt','Native Windows file handle contract')
    def test_native_exclusive_handle_delete_and_busy_file(self):
        p=self.file();plan=self.plan([p],m.WinFile)
        self.assertEqual(plan['candidates'][0]['state'],'ready',str(plan))
        with m.WinFile(p):
            busy=self.plan([p],m.WinFile)
            self.assertEqual(busy['candidates'][0]['state'],'retained')
        import ctypes
        buf=ctypes.create_unicode_buffer(32768)
        short=ctypes.windll.kernel32.GetShortPathNameW
        short.argtypes=[ctypes.c_wchar_p,ctypes.c_wchar_p,ctypes.c_ulong]
        if short(str(self.root),buf,len(buf)) and buf.value!=str(self.root):
            short_root=pathlib.Path(buf.value)
            short_path=short_root/p.parent.name/p.name
            short_scope=m.Scope(short_root,self.scope.fixed_swap)
            short_plan=m.preview([dict(path=str(short_path))],short_scope,m.WinFile)
            self.assertEqual(short_plan['candidates'][0]['state'],'ready',str(short_plan))
        report=m.execute(plan,self.scope,Wsl(),m.WinFile)
        self.assertEqual(report['outcome'],'completed');self.assertFalse(p.exists())
    @unittest.skipUnless(os.name=='nt','Native Windows reparse and shared-file contract')
    def test_native_shared_file_and_parent_junction_are_retained(self):
        import subprocess
        p=self.file();os.link(str(p),str(p.with_name('other.bin')))
        self.assertEqual(self.plan([p],m.WinFile)['candidates'][0]['state'],'retained');self.assertTrue(p.exists())
        target=self.root/'target';target.mkdir();(target/'swap.vhdx').write_bytes(b'preserve')
        link=self.root/str(uuid.uuid4())
        subprocess.run(['cmd.exe','/d','/c','mklink','/J',str(link),str(target)],check=True,capture_output=True)
        try:self.assertEqual(self.plan([link/'swap.vhdx'],m.WinFile)['candidates'][0]['state'],'retained')
        finally:os.rmdir(str(link))

    @unittest.skipUnless(os.name=='nt','Native Windows execute and launcher contract')
    def test_main_reentry_and_powershell_exit_propagation(self):
        from unittest import mock
        import json
        import shutil
        import subprocess
        p=self.file();target=self.scope.fixed_swap;target.write_bytes(b'current preserved')
        plan=self.plan([p],m.WinFile);manifest=self.root/'manifest.json';manifest.write_text(json.dumps(plan),encoding='utf8')
        text='[wsl2]\r\nmemory=10GB\r\nswapFile='+str(target).replace('\\','\\\\')+'\r\n'
        (self.root/'.wslconfig').write_bytes(text.encode('utf8'))
        control=Wsl();control.shutdown=lambda:None
        real_scope=m.Scope
        with mock.patch.dict(os.environ,{'USERPROFILE':str(self.root)}), mock.patch.object(m,'Scope',lambda temp,swap:real_scope(self.root,swap)), mock.patch.object(m,'Wsl',lambda:control), mock.patch.object(m.ctypes.windll.shell32,'IsUserAnAdmin',return_value=1):
            code=m.main(['--manifest',str(manifest),'--swap-file',str(target),'--execute'])
        self.assertEqual(code,0,(self.root/'wsl-maintenance-result.json').read_text(encoding='utf8'));self.assertFalse(p.exists());self.assertEqual(target.read_bytes(),b'current preserved')
        self.assertEqual((self.root/'.wslconfig').read_bytes(),text.encode('utf8'))
        self.assertEqual(json.loads((self.root/'wsl-maintenance-result.json').read_text(encoding='utf8'))['outcome'],'completed')
        bad=self.root/'invalid.json';bad.write_text('{broken',encoding='utf8')
        self.assertEqual(m.main(['--manifest',str(bad),'--swap-file',str(target),'--execute']),3)
        failed=json.loads((self.root/'wsl-maintenance-result.json').read_text(encoding='utf8'))
        self.assertEqual(failed['outcome'],'failed');self.assertEqual(failed['error']['type'],'JSONDecodeError')

        entry=self.root/'windows-wsl-maintenance.py';entry.write_text('import sys;sys.exit(2)',encoding='utf8')
        launcher=self.root/'entry.ps1';shutil.copyfile(ROOT/'scripts/windows-wsl-maintenance.ps1',launcher)
        result=subprocess.run(['powershell.exe','-NoProfile','-ExecutionPolicy','Bypass','-File',str(launcher),'-PythonExe',__import__('sys').executable,'-Manifest',str(manifest)],capture_output=True)
        self.assertEqual(result.returncode,2)
        stub=self.root/'windows-wsl-maintenance.ps1';stub.write_text('param([switch]$Execute);exit 2',encoding='utf8')
        cmd=self.root/'entry.cmd';shutil.copyfile(ROOT/'scripts/windows-wsl-maintenance.cmd',cmd)
        batch=subprocess.run(['cmd.exe','/d','/c',str(cmd)],stdin=subprocess.DEVNULL,capture_output=True)
        self.assertEqual(batch.returncode,2,repr(batch.stdout+batch.stderr))



class ProfileTests(unittest.TestCase):
    def test_ancestry_and_shared_memory_coverage(self):
        rows=[dict(pid=1,ppid=0,name='Code.exe',role='vscode-main',rss=10,privateBytes=15),
              dict(pid=2,ppid=1,name='node.exe',role='extension-host',rss=20,privateBytes=30),
              dict(pid=3,ppid=2,name='python.exe',role='wayfarer-helper',rss=5),
              dict(pid=4,ppid=0,name='vmmemWSL',role='wsl-vm',rss=100)]
        groups=profile.group_processes(rows)
        helper=next(g for g in groups if g['role']=='wayfarer-helper')
        self.assertEqual(helper['application'],'vscode');self.assertEqual(helper['privateUnknown'],1)
        self.assertEqual(helper['pssUnknown'],1)
        self.assertTrue(any(g['application']=='wsl-vm' for g in groups))
        self.assertTrue(profile.same_identity('3:1000001','3:1000000'))
        self.assertFalse(profile.same_identity('3:9000000','3:1000000'))
        self.assertEqual(profile.linux_role('app-server --key=secret','codex'),'agent-server')
        self.assertNotIn('secret',str(groups))
        reused=profile.group_processes([dict(pid=1,ppid=0,name='Code.exe',identity='1:900'),dict(pid=2,ppid=1,name='older.exe',identity='2:100')])
        self.assertTrue(any(g['application']=='older.exe' for g in reused))

class ResourceFallbackTests(unittest.TestCase):
    def test_identity_and_native_counters_take_priority(self):
        import runpy
        monitor=runpy.run_path(str(ROOT/'helpers/monitor.py'))
        merge=monitor['merge_restricted_memory']
        rows=[dict(pid=4,name='vmmemWSL',identity='4:100',rss=None,privateBytes=None,access='restricted')]
        stale=[dict(pid=4,name='vmmemWSL',identity='4:900',rss=100,privateBytes=200)]
        merge(rows,stale,1);self.assertIsNone(rows[0]['rss'])
        live=[dict(pid=4,name='vmmemWSL',identity='4:100',rss=100,privateBytes=200)]
        merge(rows,live,2);self.assertEqual(rows[0]['rss'],100);self.assertEqual(rows[0]['memoryStamp'],2)
        self.assertEqual(rows[0]['memorySource'],'Win32_Process')
        self.assertEqual(rows[0]['access'],'partial')
        live[0]['rss']=999;merge(rows,live,3);self.assertEqual(rows[0]['rss'],100)

class SshSetupTests(unittest.TestCase):
    def test_target_validation_and_public_key_installation(self):
        import runpy
        import subprocess
        from unittest import mock
        module=runpy.run_path(str(ROOT/'helpers/ssh_setup.py'))
        parse=module['parse_target']
        self.assertEqual(parse('alice@host:2222'),('alice','host',2222))
        self.assertEqual(parse('alice@[::1]:22'),('alice','::1',22))
        for value in ['-o@host','user@host;id','user@host:70000','user@host\nother']:
            with self.assertRaises(ValueError):parse(value)
        with tempfile.TemporaryDirectory() as tmp:
            home=pathlib.Path(tmp);key=home/'.ssh/wayfarer/wayfarer-test.ed25519';key.parent.mkdir(parents=True)
            key.write_text('fixture private key');key.with_name(key.name+'.pub').write_text('ssh-ed25519 AAAA fixture')
            calls=[]
            def execute(argv,**kwargs):
                calls.append((argv,kwargs))
                if argv[-1]=='true':
                    return subprocess.CompletedProcess(argv,255)
                return subprocess.CompletedProcess(argv,0,stdout='WAYFARER_SETUP={"home":"/home/alice","python":"/usr/bin/python3"}\n')
            with mock.patch.object(pathlib.Path,'home',return_value=home),mock.patch.object(subprocess,'run',side_effect=execute):
                result=module['setup']('alice@host:2222','wayfarer-test',home/'report.json')
            self.assertEqual(result['status'],'completed')
            self.assertEqual(calls[1][1]['input'],'ssh-ed25519 AAAA fixture\n')
            self.assertIn('PubkeyAuthentication=no',calls[1][0])
            self.assertIn('BatchMode=yes',calls[2][0])
            self.assertIn('IdentityFile',pathlib.Path(result['sshConfig']).read_text())
            self.assertNotIn('password',pathlib.Path(result['sshConfig']).read_text().lower())
            if os.name!='nt':self.assertEqual(key.stat().st_mode & 0o777,0o600)

if __name__=='__main__':
    unittest.main()
