"""Windows-only, explicit offline swap maintenance. Default operation is a preview."""
import argparse
import ctypes
import json
import ntpath
import os
import pathlib
import re
import shutil
import subprocess
import sys
import time
import uuid

GUID = re.compile(r"[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}")
EXIT = {"preview": 0, "completed": 0, "partial": 1, "blocked": 2, "failed": 3}


def atomic_json(file, value):
    file = pathlib.Path(file)
    partial = file.with_name(file.name + "." + uuid.uuid4().hex + ".partial")
    try:
        with partial.open("x", encoding="utf8") as out:
            json.dump(value, out, ensure_ascii=False, indent=2)
            out.flush()
            os.fsync(out.fileno())
        os.replace(str(partial), str(file))
    finally:
        if partial.exists():
            partial.unlink()


def error_detail(error):
    result = dict(type=type(error).__name__, message=str(error), winError=getattr(error, "winerror", None))
    if isinstance(error, subprocess.CalledProcessError):
        result.update(exitCode=error.returncode)
        for key in ["stdout", "stderr"]:
            raw = getattr(error, key, None)
            result[key] = (raw.decode("utf8", errors="replace") if isinstance(raw, bytes) else raw or "")[-4000:]
    return result


def canonical(path):
    text = str(path)
    if text.startswith("\\\\?\\"):
        text = text[4:]
    return os.path.normcase(os.path.abspath(text))


class Scope:
    def __init__(self, temp, fixed_swap):
        self.temp = pathlib.Path(temp)
        self.fixed_swap = pathlib.Path(fixed_swap)
        self.protected = {canonical(self.fixed_swap), canonical(os.path.realpath(str(self.fixed_swap)))}

    def check(self, path):
        path = pathlib.Path(path)
        if canonical(path) in self.protected:
            raise ValueError("The configured swap file is protected")
        if (path.name.lower() != "swap.vhdx" or
                canonical(path.parent.parent) != canonical(self.temp) or
                not GUID.fullmatch(path.parent.name)):
            raise ValueError("Candidate outside approved Temp/GUID/swap.vhdx scope")
        for p in (self.temp, path.parent, path):
            info = p.lstat()
            if p.is_symlink() or getattr(info, "st_file_attributes", 0) & 0x400:
                raise ValueError("Reparse path retained")
        return path


def config_update(text, target):
    """Preserve all other INI lines, comments, BOM and newline style."""
    lines = text.splitlines(keepends=True)
    newline = "\r\n" if "\r\n" in text else "\n"
    section = None
    sections, values = [], []
    end = len(lines)
    for i, line in enumerate(lines):
        header = re.fullmatch(r"\s*\[([^]]+)\]\s*(?:[#;].*)?", line.strip().lstrip("\ufeff"))
        if header:
            if section == "wsl2":
                end = i
            section = header[1].lower()
            if section == "wsl2":
                sections.append(i)
        elif section == "wsl2":
            match = re.match(r"\s*swapfile\s*=\s*(.*?)\s*$", line, re.I)
            if match:
                values.append((i, match[1].replace("\\\\", "\\")))
    if len(sections) > 1 or len(values) > 1:
        raise ValueError("Ambiguous wsl2/swapFile entries; review configuration")
    current = values[0][1] if values else None
    if current and ntpath.normcase(ntpath.normpath(current)) == ntpath.normcase(ntpath.normpath(str(target))):
        return text, True
    replacement = "swapFile=" + str(target).replace("\\", "\\\\") + newline
    if values:
        lines[values[0][0]] = replacement
    elif sections:
        if end and not lines[end - 1].endswith(("\n", "\r")):
            lines[end - 1] += newline
        lines.insert(end, replacement)
    else:
        if lines and not lines[-1].endswith(("\n", "\r")):
            lines[-1] += newline
        lines += ["[wsl2]" + newline, replacement]
    return "".join(lines), False


class WinFile:
    def __init__(self, path):
        if os.name != "nt":
            raise RuntimeError("Native file handles require Windows")
        from ctypes import wintypes as W
        self.k = ctypes.WinDLL("kernel32", use_last_error=True)
        self.k.CreateFileW.argtypes = [W.LPCWSTR, W.DWORD, W.DWORD, ctypes.c_void_p, W.DWORD, W.DWORD, W.HANDLE]
        self.k.CreateFileW.restype = W.HANDLE
        self.k.CloseHandle.argtypes = [W.HANDLE]
        self.k.GetFileInformationByHandleEx.argtypes = [W.HANDLE, ctypes.c_int, ctypes.c_void_p, W.DWORD]
        self.k.GetFinalPathNameByHandleW.argtypes = [W.HANDLE, W.LPWSTR, W.DWORD, W.DWORD]
        self.k.SetFileInformationByHandle.argtypes = [W.HANDLE, ctypes.c_int, ctypes.c_void_p, W.DWORD]
        self.handle = self.k.CreateFileW(str(path), 0x10000 | 0x80, 0, None, 3, 0x200000, None)
        if self.handle == ctypes.c_void_p(-1).value:
            self.handle = None
            raise ctypes.WinError(ctypes.get_last_error())

    def snapshot(self):
        class Id(ctypes.Structure):
            _fields_ = [("volume", ctypes.c_ulonglong), ("file", ctypes.c_ubyte * 16)]
        class Basic(ctypes.Structure):
            _fields_ = [(k, ctypes.c_longlong) for k in ["creation", "access", "write", "change"]] + [("attributes", ctypes.c_ulong)]
        class Standard(ctypes.Structure):
            _fields_ = [("allocated", ctypes.c_longlong), ("size", ctypes.c_longlong),
                        ("links", ctypes.c_ulong), ("deletePending", ctypes.c_ubyte), ("directory", ctypes.c_ubyte)]
        identity, basic, standard = Id(), Basic(), Standard()
        for cls, value in [(18, identity), (0, basic), (1, standard)]:
            if not self.k.GetFileInformationByHandleEx(self.handle, cls, ctypes.byref(value), ctypes.sizeof(value)):
                raise ctypes.WinError(ctypes.get_last_error())
        if basic.attributes & 0x400 or standard.directory or standard.links != 1:
            raise ValueError("Reparse, directory or shared file retained")
        size = self.k.GetFinalPathNameByHandleW(self.handle, None, 0, 0)
        if not size:
            raise ctypes.WinError(ctypes.get_last_error())
        buf = ctypes.create_unicode_buffer(size + 1)
        if not self.k.GetFinalPathNameByHandleW(self.handle, buf, len(buf), 0):
            raise ctypes.WinError(ctypes.get_last_error())
        return dict(identity=str(identity.volume) + ":" + bytes(identity.file).hex(),
                    size=standard.size, allocated=standard.allocated,
                    lastWrite=str(basic.write), finalPath=buf.value)

    def delete(self):
        flag = ctypes.c_ubyte(1)  # FILE_DISPOSITION_INFO.DeleteFile
        if not self.k.SetFileInformationByHandle(self.handle, 4, ctypes.byref(flag), ctypes.sizeof(flag)):
            raise ctypes.WinError(ctypes.get_last_error())

    def close(self):
        if self.handle is not None:
            self.k.CloseHandle(self.handle)
            self.handle = None

    def __enter__(self):
        return self

    def __exit__(self, *unused):
        self.close()


class Wsl:
    def __init__(self):
        import winreg
        self.names = set()
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Lxss") as key:
            for i in range(winreg.QueryInfoKey(key)[0]):
                with winreg.OpenKey(key, winreg.EnumKey(key, i)) as sub:
                    self.names.add(winreg.QueryValueEx(sub, "DistributionName")[0])

    def running(self):
        result = subprocess.run(["wsl.exe", "--list", "--running", "--quiet"], capture_output=True, check=True)
        raw = result.stdout
        text = raw.decode("utf-16" if raw.startswith((b"\xff\xfe", b"\xfe\xff")) else "utf-16-le" if b"\0" in raw else "utf8").replace("\0", "")
        lines = [line.strip() for line in text.splitlines() if line.strip()]
        if any(line not in self.names for line in lines):
            raise RuntimeError("Unrecognized WSL status: " + text[:1000])
        return lines

    def shutdown(self):
        subprocess.run(["wsl.exe", "--shutdown"], check=True)
        time.sleep(1)


def disk_diagnostics(paths):
    """One PowerShell process; diagnostic failure never authorizes deletion."""
    command = r"""[Console]::InputEncoding=[Text.UTF8Encoding]::new();[Console]::OutputEncoding=[Text.UTF8Encoding]::new();$paths=[Console]::In.ReadToEnd()|ConvertFrom-Json;$rows=@(foreach($p in $paths){try{$d=Get-DiskImage -ImagePath $p -ErrorAction Stop;[pscustomobject]@{path=$p;attached=[bool]$d.Attached}}catch{[pscustomobject]@{path=$p;attached=$null;message=$_.Exception.Message;type=$_.Exception.GetType().FullName;hresult=$_.Exception.HResult;errorId=$_.FullyQualifiedErrorId}}});ConvertTo-Json -InputObject $rows -Compress -Depth 5"""
    try:
        result = subprocess.run(["powershell.exe", "-NoProfile", "-Command", command],
                                input=json.dumps([str(p) for p in paths]), capture_output=True,
                                text=True, encoding="utf8", timeout=30)
        if result.returncode:
            return dict(exitCode=result.returncode, stdout=result.stdout[-4000:], stderr=result.stderr[-4000:])
        return json.loads(result.stdout)
    except Exception as error:
        return error_detail(error)


def preview(entries, scope, opener=WinFile):
    candidates = []
    for source in entries:
        row = dict(path=source["path"], state="retained")
        try:
            path = scope.check(source["path"])
            with opener(path) as handle:
                value = handle.snapshot()
                if canonical(value["finalPath"]) != canonical(path):
                    raise ValueError("Resolved path differs from approved path")
                row.update(state="ready", expected=value)
        except FileNotFoundError:
            row["state"] = "already-absent"
        except Exception as error:
            row["error"] = error_detail(error)
        candidates.append(row)
    return dict(schemaVersion=2, preparedAt=time.time(), fixedSwap=str(scope.fixed_swap), pythonExecutable=sys.executable, candidates=candidates)


def execute(prepared, scope, wsl, opener=WinFile, save=lambda report: None):
    report = dict(outcome="partial", files=[dict(path=r["path"], state="not-processed") for r in prepared["candidates"]], removedBytes=0)
    save(report)
    for original, row in zip(prepared["candidates"], report["files"]):
        running = wsl.running()
        if running:
            report.update(outcome="blocked", stopReason="wsl-restarted", runningDistributions=running)
            save(report)
            return report
        try:
            if original.get("state") == "already-absent":
                # A replacement appearing after an absent preview remains outside this plan.
                if pathlib.Path(original["path"]).exists():
                    raise ValueError("A file appeared after the absent preview")
                row["state"] = "already-absent"
                continue
            if original.get("state") != "ready" or not original.get("expected"):
                raise ValueError("Candidate requires a successful identity preview")
            path = scope.check(original["path"])
            with opener(path) as handle:
                value = handle.snapshot()
                expected = original["expected"]
                if (canonical(value["finalPath"]) != canonical(path) or
                        any(value[k] != expected[k] for k in ["identity", "size", "lastWrite"])):
                    raise ValueError("File identity or contents changed since preview")
                running = wsl.running()
                if running:
                    report.update(outcome="blocked", stopReason="wsl-restarted", runningDistributions=running)
                    return report
                handle.delete()
                row.update(state="removed", identity=value["identity"], bytes=value["size"], allocatedBytes=value["allocated"])
                report["removedBytes"] += value["size"]
        except FileNotFoundError:
            row["state"] = "already-absent"
        except Exception as error:
            row.update(state="retained", error=error_detail(error))
        finally:
            save(report)
    report["outcome"] = "completed" if all(r["state"] in ("removed", "already-absent") for r in report["files"]) else "partial"
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--swap-file", required=True)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--prepare", help="Save an identity-bound manifest for the later offline execution")
    args = parser.parse_args(argv)
    if os.name != "nt":
        parser.error("Run from Windows; execution follows ending WSL tasks and Agent sessions")
    manifest, swap = pathlib.Path(args.manifest), pathlib.Path(args.swap_file)
    report = dict(started=time.time(), execute=args.execute, outcome="preview", targetSwap=str(swap), files=[])
    run = manifest.with_name("wsl-maintenance-" + str(time.time_ns()) + ".json")
    latest = manifest.with_name("wsl-maintenance-result.json")

    def save(fields=None):
        if fields:
            report.update(fields)
        atomic_json(run, report)
        atomic_json(latest, dict(report, reportPath=str(run)))

    try:
        source = json.loads(manifest.read_text(encoding="utf-8-sig"))
        scope = Scope(pathlib.Path(os.environ["LOCALAPPDATA"]) / "Temp", swap)
        report["before"] = {d: shutil.disk_usage(d)._asdict() for d in set([str(scope.temp.anchor), str(swap.anchor)])}
        if not args.execute:
            entries = source if isinstance(source, list) else source["candidates"]
            plan = preview(entries, scope)
            report.update(plan, files=plan["candidates"])
            report["diskDiagnostics"] = disk_diagnostics([r["path"] for r in plan["candidates"]])
            config = pathlib.Path(os.environ["USERPROFILE"]) / ".wslconfig"
            original = config.read_bytes().decode("utf8") if config.exists() else ""
            _, matches = config_update(original, swap)
            report["configuration"] = dict(path=str(config), matches=matches, targetExists=swap.exists())
            if args.prepare:
                atomic_json(args.prepare, plan)
                report["preparedManifest"] = args.prepare
        else:
            if args.prepare:
                raise ValueError("Prepare a preview separately before offline execution")
            if not isinstance(source, dict) or source.get("schemaVersion") != 2:
                raise ValueError("Run preview with --prepare to bind candidate identities first")
            if canonical(source.get("fixedSwap", "")) != canonical(swap):
                raise ValueError("Prepared manifest belongs to another swap target")
            if not ctypes.windll.shell32.IsUserAnAdmin():
                report.update(outcome="blocked", stopReason="administrator-required")
                return EXIT[report["outcome"]]
            config = pathlib.Path(os.environ["USERPROFILE"]) / ".wslconfig"
            original = config.read_bytes().decode("utf8") if config.exists() else ""
            updated, matches = config_update(original, swap)
            if swap.exists() and not swap.is_file():
                raise ValueError("Configured swap target is not a file")
            if swap.exists() and not matches:
                raise ValueError("Existing target swap has a different configuration; inspect ownership")
            wsl = Wsl()
            wsl.shutdown()
            running = wsl.running()
            if running:
                report.update(outcome="blocked", stopReason="wsl-restarted", runningDistributions=running)
                return EXIT[report["outcome"]]
            if updated != original:
                swap.parent.mkdir(parents=True, exist_ok=True)
                partial = config.with_name(config.name + "." + uuid.uuid4().hex + ".partial")
                try:
                    partial.write_bytes(updated.encode("utf8"))
                    if config.exists() and config.read_bytes().decode("utf8") != original:
                        raise ValueError("WSL configuration changed during maintenance")
                    os.replace(str(partial), str(config))
                finally:
                    if partial.exists():
                        partial.unlink()
            report["configuration"] = dict(path=str(config), changed=updated != original)
            report.update(execute(source, scope, wsl, save=save))
    except Exception as error:
        report.update(outcome="failed", error=error_detail(error))
    finally:
        report["finished"] = time.time()
        report["after"] = {d: shutil.disk_usage(d)._asdict() for d in report.get("before", {})}
        report["exitCode"] = EXIT[report["outcome"]]
        save()
        print(json.dumps(dict(outcome=report["outcome"], exitCode=report["exitCode"], report=str(run),
                              states={s: sum(r.get("state") == s for r in report.get("files", [])) for s in set(r.get("state") for r in report.get("files", []))}), ensure_ascii=True))
    return EXIT[report["outcome"]]


if __name__ == "__main__":
    sys.exit(main())
