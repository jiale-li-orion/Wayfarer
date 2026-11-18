#!/usr/bin/env python3
"""Read-only system snapshots. Python 3.6+, standard library, dedicated stdio channel."""
import os, sys, json, time, platform, subprocess, shutil, csv, io, signal, ctypes, re

WIN = sys.platform == "win32"
PREV = {}
PROCESSES = []
CHILD_CPU = 0.0
CHILD = None
if not WIN:
    import resource, pwd


def number(v, scale=1):
    try:
        return float(str(v).split()[0]) * scale
    except (ValueError, TypeError, IndexError):
        return None


def rate(key, value, now):
    old = PREV.get(key)
    PREV[key] = (now, value)
    return (
        max(0, (value - old[1]) / (now - old[0]))
        if old and now > old[0] and now - old[0] <= 30 and value >= old[1]
        else None
    )


def run(argv):
    global CHILD, CHILD_CPU
    try:
        CHILD = subprocess.Popen(
            argv,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            **({"creationflags": 0x08000000} if WIN else {}),
        )
        try:
            out, err = CHILD.communicate(timeout=8)
        except subprocess.TimeoutExpired:
            CHILD.kill()
            CHILD.communicate()
            raise RuntimeError("Device query timed out")
        if WIN:
            CHILD_CPU += win_cpu(CHILD._handle)[0]
        if CHILD.returncode:
            raise RuntimeError(err.decode(errors="replace").strip()[:300])
        return out.decode("utf-8", errors="replace")
    finally:
        if CHILD and CHILD.poll() is None:
            CHILD.terminate()
        CHILD = None


if WIN:
    from ctypes import wintypes as W

    K = ctypes.WinDLL("kernel32", use_last_error=True)
    PS = ctypes.WinDLL("psapi", use_last_error=True)
    A = ctypes.WinDLL("advapi32", use_last_error=True)

    class Memory(ctypes.Structure):
        _fields_ = [("length", W.DWORD), ("load", W.DWORD)] + [
            (k, ctypes.c_ulonglong)
            for k in [
                "total",
                "available",
                "pageTotal",
                "pageFree",
                "virtualTotal",
                "virtualFree",
                "extended",
            ]
        ]

    class PerformanceInfo(ctypes.Structure):
        _fields_ = [("cb",W.DWORD)] + [(k,ctypes.c_size_t) for k in ["commit","limit","peak","physical","available","cache","kernel","paged","nonpaged","pageSize"]] + [(k,W.DWORD) for k in ["handles","processes","threads"]]

    PS.GetPerformanceInfo.argtypes = [ctypes.POINTER(PerformanceInfo),W.DWORD]
    PS.GetPerformanceInfo.restype = W.BOOL

    class ProcessEntry(ctypes.Structure):
        _fields_ = [
            ("size", W.DWORD),
            ("usage", W.DWORD),
            ("pid", W.DWORD),
            ("heap", ctypes.c_size_t),
            ("module", W.DWORD),
            ("threads", W.DWORD),
            ("ppid", W.DWORD),
            ("priority", W.LONG),
            ("flags", W.DWORD),
            ("name", W.WCHAR * 260),
        ]

    class Counters(ctypes.Structure):
        _fields_ = [("size", W.DWORD), ("faults", W.DWORD)] + [
            (k, ctypes.c_size_t)
            for k in [
                "peak",
                "rss",
                "quotaPeakPaged",
                "quotaPaged",
                "quotaPeakNonPaged",
                "quotaNonPaged",
                "pagefile",
                "peakPagefile",
                "private",
            ]
        ]

    K.OpenProcess.argtypes = [W.DWORD, W.BOOL, W.DWORD]
    K.OpenProcess.restype = W.HANDLE
    K.CloseHandle.argtypes = [W.HANDLE]
    K.CreateToolhelp32Snapshot.argtypes = [W.DWORD, W.DWORD]
    K.CreateToolhelp32Snapshot.restype = W.HANDLE
    K.Process32FirstW.argtypes = [W.HANDLE, ctypes.POINTER(ProcessEntry)]
    K.Process32NextW.argtypes = K.Process32FirstW.argtypes
    K.GetProcessHandleCount.argtypes = [W.HANDLE, ctypes.POINTER(W.DWORD)]
    K.GetProcessTimes.argtypes = [W.HANDLE] + [ctypes.POINTER(W.FILETIME)] * 4
    PS.GetProcessMemoryInfo.argtypes = [W.HANDLE, ctypes.POINTER(Counters), W.DWORD]
    K.QueryFullProcessImageNameW.argtypes = [
        W.HANDLE,
        W.DWORD,
        W.LPWSTR,
        ctypes.POINTER(W.DWORD),
    ]
    A.OpenProcessToken.argtypes = [W.HANDLE, W.DWORD, ctypes.POINTER(W.HANDLE)]
    A.GetTokenInformation.argtypes = [
        W.HANDLE,
        ctypes.c_int,
        ctypes.c_void_p,
        W.DWORD,
        ctypes.POINTER(W.DWORD),
    ]
    A.LookupAccountSidW.argtypes = [
        W.LPCWSTR,
        ctypes.c_void_p,
        W.LPWSTR,
        ctypes.POINTER(W.DWORD),
        W.LPWSTR,
        ctypes.POINTER(W.DWORD),
        ctypes.POINTER(W.DWORD),
    ]
    USERS = {}

    def ft(v):
        return (v.dwHighDateTime << 32) | v.dwLowDateTime

    def win_cpu(h):
        c, e, k, u = W.FILETIME(), W.FILETIME(), W.FILETIME(), W.FILETIME()
        if K.GetProcessTimes(
            h, ctypes.byref(c), ctypes.byref(e), ctypes.byref(k), ctypes.byref(u)
        ):
            return ((ft(k) + ft(u)) / 1e7, ft(c))
        return (0, 0)

    def win_owner(h):
        token = W.HANDLE()
        size = W.DWORD()
        if not A.OpenProcessToken(h, 8, ctypes.byref(token)):
            return None
        try:
            A.GetTokenInformation(token, 1, None, 0, ctypes.byref(size))
            buf = ctypes.create_string_buffer(size.value)
            if not A.GetTokenInformation(token, 1, buf, size, ctypes.byref(size)):
                return None
            sid = ctypes.cast(buf, ctypes.POINTER(ctypes.c_void_p))[0]
            # Cache by SID bytes, rather than a token's temporary address.
            A.GetLengthSid.argtypes = [ctypes.c_void_p]
            n = A.GetLengthSid(sid)
            key = ctypes.string_at(sid, n)
            if key not in USERS:
                user = ctypes.create_unicode_buffer(256)
                domain = ctypes.create_unicode_buffer(256)
                un = W.DWORD(256)
                dn = W.DWORD(256)
                typ = W.DWORD()
                USERS[key] = (
                    (domain.value + "\\" + user.value)
                    if A.LookupAccountSidW(
                        None,
                        sid,
                        user,
                        ctypes.byref(un),
                        domain,
                        ctypes.byref(dn),
                        ctypes.byref(typ),
                    )
                    else None
                )
                if user.value:
                    USERS[key] = (
                        domain.value + "\\" if domain.value else ""
                    ) + user.value
            return USERS[key]
        finally:
            K.CloseHandle(token)

    def windows_processes(now):
        rows = []
        snapshot = K.CreateToolhelp32Snapshot(2, 0)
        entry = ProcessEntry()
        entry.size = ctypes.sizeof(entry)
        try:
            ok = K.Process32FirstW(snapshot, ctypes.byref(entry))
            while ok:
                p = dict(
                    pid=entry.pid,
                    ppid=entry.ppid,
                    name=entry.name,
                    threads=entry.threads,
                    user=None,
                    rss=None,
                    privateBytes=None,
                    cpuPercent=None,
                )
                h = K.OpenProcess(0x1010, False, entry.pid) or K.OpenProcess(
                    0x1000, False, entry.pid
                )
                if h:
                    try:
                        cpu, start = win_cpu(h)
                        p["identity"] = "%s:%s" % (entry.pid, start)
                        p["cpuPercent"] = rate("p" + p["identity"], cpu, now)
                        if p["cpuPercent"] is not None:
                            p["cpuPercent"] *= 100
                        m = Counters()
                        m.size = ctypes.sizeof(m)
                        if PS.GetProcessMemoryInfo(h, ctypes.byref(m), m.size):
                            p.update(rss=m.rss, privateBytes=m.private)
                        p["user"] = win_owner(h)
                    finally:
                        K.CloseHandle(h)
                else:
                    p["access"] = "restricted"
                rows.append(p)
                ok = K.Process32NextW(snapshot, ctypes.byref(entry))
        finally:
            K.CloseHandle(snapshot)
        return rows

    WSL_BACKING = None

    def windows_capacity():
        global WSL_BACKING
        volumes = []
        mask = K.GetLogicalDrives()
        for i in range(26):
            if mask & (1 << i):
                root = chr(65+i) + ":\\"
                # Removable/network media can block; inspect fixed disks only.
                if K.GetDriveTypeW(ctypes.c_wchar_p(root)) != 3:
                    continue
                try:
                    d = shutil.disk_usage(root)
                    page = os.path.join(root, "pagefile.sys")
                    try:
                        pagebytes=os.stat(page).st_size
                    except FileNotFoundError:
                        pagebytes=0
                    except OSError:
                        pagebytes=None
                    volumes.append(dict(path=root,total=d.total,available=d.free,pagefileBytes=pagebytes))
                except OSError:
                    pass
        if WSL_BACKING is None:
            WSL_BACKING = []
            try:
                import winreg
                with winreg.OpenKey(winreg.HKEY_CURRENT_USER,r"Software\Microsoft\Windows\CurrentVersion\Lxss") as k:
                    for i in range(winreg.QueryInfoKey(k)[0]):
                        with winreg.OpenKey(k,winreg.EnumKey(k,i)) as sub:
                            WSL_BACKING.append((winreg.QueryValueEx(sub,"DistributionName")[0],winreg.QueryValueEx(sub,"BasePath")[0]))
            except OSError:
                pass
        wsl = []
        for name, base in WSL_BACKING:
            try:
                d = shutil.disk_usage(base)
                wsl.append(dict(distribution=name,total=d.total,available=d.free,
                    mount=os.path.splitdrive(base)[0]+"\\"))
            except OSError:
                pass
        return dict(volumes=volumes,wsl=wsl)

    def windows_summary(now):
        m = Memory()
        m.length = ctypes.sizeof(m)
        K.GlobalMemoryStatusEx(ctypes.byref(m))
        idle, kernel, user = W.FILETIME(), W.FILETIME(), W.FILETIME()
        K.GetSystemTimes(ctypes.byref(idle), ctypes.byref(kernel), ctypes.byref(user))
        busy = ft(kernel) + ft(user) - ft(idle)
        total = ft(kernel) + ft(user)
        old = PREV.get("system")
        PREV["system"] = (total, busy, now)
        cpu = (
            100 * (busy - old[1]) / (total - old[0])
            if old and len(old) > 2 and now - old[2] <= 30 and total > old[0]
            else None
        )
        capacity = windows_capacity()
        perf = PerformanceInfo(); perf.cb=ctypes.sizeof(perf)
        have_perf = PS.GetPerformanceInfo(ctypes.byref(perf),perf.cb)
        return dict(
            storage=capacity,
            cpuPercent=cpu,
            logicalCpus=os.cpu_count(),
            memory=dict(
                total=m.total,
                available=m.available,
                used=m.total - m.available,
                commitUsed=perf.commit*perf.pageSize if have_perf else None,
                commitLimit=perf.limit*perf.pageSize if have_perf else None,
                pagefileBytes=sum(v["pagefileBytes"] for v in capacity["volumes"]) if all(v["pagefileBytes"] is not None for v in capacity["volumes"]) else None,
                scope="windows-system",
            ),
        )

    class Luid(ctypes.Structure):
        _fields_ = [("low", W.DWORD), ("high", W.LONG)]

    class AdapterDesc(ctypes.Structure):
        _fields_ = (
            [("name", W.WCHAR * 128)]
            + [(x, W.UINT) for x in ["vendor", "device", "subsystem", "revision"]]
            + [(x, ctypes.c_size_t) for x in ["dedicated", "system", "shared"]]
            + [("luid", Luid), ("flags", W.UINT)]
        )

    def com(obj, index, restype, *types):
        table = ctypes.cast(
            obj, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))
        ).contents
        return ctypes.WINFUNCTYPE(restype, ctypes.c_void_p, *types)(table[index])

    def adapters():
        import uuid

        dx = ctypes.WinDLL("dxgi")
        factory = ctypes.c_void_p()
        guid = ctypes.create_string_buffer(
            uuid.UUID("770aae78-f26f-4dba-a829-253c83d1b387").bytes_le
        )
        if dx.CreateDXGIFactory1(guid, ctypes.byref(factory)):
            return []
        out = []
        try:
            for index in range(32):
                adapter = ctypes.c_void_p()
                if com(
                    factory, 12, ctypes.c_long, W.UINT, ctypes.POINTER(ctypes.c_void_p)
                )(factory, index, ctypes.byref(adapter)):
                    break
                try:
                    d = AdapterDesc()
                    if (
                        not com(
                            adapter, 10, ctypes.c_long, ctypes.POINTER(AdapterDesc)
                        )(adapter, ctypes.byref(d))
                        and not d.flags & 2
                    ):
                        out.append(
                            dict(
                                id="luid_0x%08X_0x%08X"
                                % (d.luid.high & 0xFFFFFFFF, d.luid.low),
                                name=d.name,
                                vendor=d.vendor,
                                memoryTotal=d.dedicated,
                                sharedMemoryTotal=d.shared,
                                source="DXGI",
                            )
                        )
                finally:
                    com(adapter, 2, W.ULONG)(adapter)
        finally:
            com(factory, 2, W.ULONG)(factory)
        return out

    class PdhValue(ctypes.Union):
        _fields_ = [
            ("long", W.LONG),
            ("double", ctypes.c_double),
            ("large", ctypes.c_longlong),
            ("string", W.LPWSTR),
        ]

    class PdhFormatted(ctypes.Structure):
        _fields_ = [("status", W.DWORD), ("value", PdhValue)]

    class PdhItem(ctypes.Structure):
        _fields_ = [("name", W.LPWSTR), ("formatted", PdhFormatted)]

    class Pdh:
        def __init__(self):
            self.lib = ctypes.WinDLL("pdh")
            self.query = ctypes.c_void_p()
            self.handles = {}
            self.groups = {}
            self.lib.PdhAddEnglishCounterW.argtypes = [
                ctypes.c_void_p,
                W.LPCWSTR,
                ctypes.c_size_t,
                ctypes.POINTER(ctypes.c_void_p),
            ]
            self.lib.PdhCollectQueryData.argtypes = [ctypes.c_void_p]
            self.lib.PdhGetFormattedCounterArrayW.argtypes = [
                ctypes.c_void_p,
                W.DWORD,
                ctypes.POINTER(W.DWORD),
                ctypes.POINTER(W.DWORD),
                ctypes.c_void_p,
            ]
            self.lib.PdhCloseQuery.argtypes = [ctypes.c_void_p]

        def read(self, paths):
            key = tuple(paths)
            now = time.monotonic()
            group = self.groups.get(key)
            if group and now - group[2] > 30:
                self.lib.PdhCloseQuery(group[0])
                del self.groups[key]
                group = None
            if group is None:
                query = ctypes.c_void_p()
                if self.lib.PdhOpenQueryW(None, 0, ctypes.byref(query)):
                    return {}
                group = (query, {}, now)
            self.query, self.handles = group[:2]
            self.groups[key] = (self.query, self.handles, now)
            for path in paths:
                if path not in self.handles:
                    h = ctypes.c_void_p()
                    self.handles[path] = (
                        h
                        if not self.lib.PdhAddEnglishCounterW(
                            self.query, path, 0, ctypes.byref(h)
                        )
                        else None
                    )
            self.lib.PdhCollectQueryData(self.query)
            out = {}
            for path in paths:
                h = self.handles[path]
                if not h:
                    continue
                size, count = W.DWORD(), W.DWORD()
                self.lib.PdhGetFormattedCounterArrayW(
                    h, 0x200, ctypes.byref(size), ctypes.byref(count), None
                )
                if not size.value:
                    continue
                buf = ctypes.create_string_buffer(size.value)
                if not self.lib.PdhGetFormattedCounterArrayW(
                    h, 0x200, ctypes.byref(size), ctypes.byref(count), buf
                ):
                    a = ctypes.cast(buf, ctypes.POINTER(PdhItem))
                    out[path] = {
                        a[i].name: a[i].formatted.value.double
                        for i in range(count.value)
                        if a[i].formatted.status in (0, 1)
                    }
            return out

        def close(self):
            for query, _, _ in self.groups.values():
                self.lib.PdhCloseQuery(query)
            self.groups.clear()

    PDH = Pdh()
    try:
        ADAPTERS = adapters()
    except (OSError, AttributeError):
        ADAPTERS = []
else:
    HZ = os.sysconf("SC_CLK_TCK")
    PAGE = os.sysconf("SC_PAGE_SIZE")
    USERS = {}

    def text(p):
        with open(p) as f:
            return f.read()

    def linux_processes(now):
        rows = []
        for pid in os.listdir("/proc"):
            if not pid.isdigit():
                continue
            try:
                p = "/proc/" + pid
                s = text(p + "/stat")
                name = s[s.index("(") + 1 : s.rindex(")")]
                v = s[s.rindex(")") + 2 :].split()
                uid = os.stat(p).st_uid
                if uid not in USERS:
                    try:
                        USERS[uid] = pwd.getpwuid(uid).pw_name
                    except KeyError:
                        USERS[uid] = str(uid)
                identity = pid + ":" + v[19]
                cpu = (int(v[11]) + int(v[12])) / float(HZ)
                delta = rate("p" + identity, cpu, now)
                rows.append(
                    dict(
                        pid=int(pid),
                        ppid=int(v[1]),
                        name=name,
                        user=USERS[uid],
                        identity=identity,
                        threads=int(v[17]),
                        rss=int(v[21]) * PAGE,
                        cpuPercent=delta * 100 if delta is not None else None,
                    )
                )
            except (OSError, ValueError, IndexError):
                pass
        return rows

    def linux_pressure(now):
        psi = None
        try:
            psi = {}
            for line in text("/proc/pressure/memory").splitlines():
                words=line.split()
                psi[words[0]]={k:float(v) for k,v in (w.split("=") for w in words[1:])}
        except (OSError, ValueError):
            psi = None
        paging = None
        try:
            vm = dict((v[0],int(v[1])) for v in (l.split() for l in text("/proc/vmstat").splitlines()) if len(v)==2)
            paging = dict(swapInPages=vm.get("pswpin"),swapOutPages=vm.get("pswpout"),majorFaults=vm.get("pgmajfault"),oomKills=vm.get("oom_kill"),scope="kernel-since-boot")
            for source,target in [("pswpin","swapInPagesPerSecond"),("pswpout","swapOutPagesPerSecond"),("pgmajfault","majorFaultsPerSecond")]:
                paging[target]=rate("vm:"+source,vm[source],now) if source in vm else None
        except (OSError, ValueError):
            pass
        cg = None
        try:
            relative = next(l.split(":",2)[2] for l in text("/proc/self/cgroup").splitlines() if l.startswith("0::"))
            root = os.path.normpath("/sys/fs/cgroup/"+relative.lstrip("/"))
            if os.path.commonpath([root,"/sys/fs/cgroup"]) != "/sys/fs/cgroup":
                raise ValueError("Cgroup path outside mount")
            cg=dict(path=relative,scope="collector-cgroup",events=dict((v[0],int(v[1])) for v in (l.split() for l in text(root+"/memory.events").splitlines()) if len(v)==2))
            for name in ["memory.current","memory.max"]:
                val=text(root+"/"+name).strip()
                cg[name]=None if val=="max" else int(val)
        except (OSError, ValueError, StopIteration):
            pass
        return dict(memory=psi,paging=paging,cgroup=cg)

    def linux_summary(now):
        v = [int(x) for x in text("/proc/stat").splitlines()[0].split()[1:9]]
        total = sum(v)
        busy = total - v[3] - v[4]
        old = PREV.get("system")
        PREV["system"] = (total, busy, now)
        mem = {
            l.split(":")[0]: int(l.split()[1]) * 1024
            for l in text("/proc/meminfo").splitlines()
            if len(l.split()) >= 3
        }
        available = mem.get(
            "MemAvailable",
            mem.get("MemFree", 0) + mem.get("Buffers", 0) + mem.get("Cached", 0),
        )
        return dict(
            cpuPercent=(
                100 * (busy - old[1]) / (total - old[0])
                if old and len(old) > 2 and now - old[2] <= 30 and total > old[0]
                else None
            ),
            logicalCpus=os.cpu_count(),
            load=os.getloadavg(),
            pressure=linux_pressure(now),
            memory=dict(
                total=mem["MemTotal"],
                available=available,
                used=mem["MemTotal"] - available,
                scope="linux-system",
                swapTotal=mem.get("SwapTotal"),
                swapUsed=mem.get("SwapTotal", 0) - mem.get("SwapFree", 0),
            ),
        )


class Nvml:
    """Stable NVML v2 process ABI from NVIDIA/go-nvml/pkg/nvml/nvml.h."""

    class Mem(ctypes.Structure):
        _fields_ = [
            ("total", ctypes.c_ulonglong),
            ("free", ctypes.c_ulonglong),
            ("used", ctypes.c_ulonglong),
        ]

    class Util(ctypes.Structure):
        _fields_ = [("gpu", ctypes.c_uint), ("memory", ctypes.c_uint)]

    class Pci(ctypes.Structure):
        _fields_ = (
            [("legacy", ctypes.c_char * 16)]
            + [
                (x, ctypes.c_uint)
                for x in ["domain", "bus", "device", "deviceId", "subsystem"]
            ]
            + [("id", ctypes.c_char * 32)]
        )

    class Proc(ctypes.Structure):
        _fields_ = [
            ("pid", ctypes.c_uint),
            ("used", ctypes.c_ulonglong),
            ("gpuInstance", ctypes.c_uint),
            ("computeInstance", ctypes.c_uint),
        ]

    def __init__(self):
        self.lib = ctypes.CDLL("nvml.dll" if WIN else "libnvidia-ml.so.1")
        if self.lib.nvmlInit_v2():
            raise OSError("NVML initialization unavailable")
        self.driver = ctypes.create_string_buffer(96)
        self.lib.nvmlSystemGetDriverVersion(self.driver, 96)

    def call(self, name, *args):
        try:
            return getattr(self.lib, name)(*args) == 0
        except AttributeError:
            return False

    def uint(self, name, handle, *args):
        v = ctypes.c_uint()
        return v.value if self.call(name, handle, *args, ctypes.byref(v)) else None

    def string(self, name, handle):
        v = ctypes.create_string_buffer(128)
        return (
            v.value.decode(errors="replace") if self.call(name, handle, v, 128) else ""
        )

    def query(self, apps):
        count = ctypes.c_uint()
        self.lib.nvmlDeviceGetCount_v2(ctypes.byref(count))
        gpus = []
        processes = {}
        for i in range(count.value):
            h = ctypes.c_void_p()
            if not self.call("nvmlDeviceGetHandleByIndex_v2", i, ctypes.byref(h)):
                continue
            mem = self.Mem()
            util = self.Util()
            pci = self.Pci()
            have_mem = self.call("nvmlDeviceGetMemoryInfo", h, ctypes.byref(mem))
            have_util = self.call(
                "nvmlDeviceGetUtilizationRates", h, ctypes.byref(util)
            )
            have_pci = self.call("nvmlDeviceGetPciInfo_v3", h, ctypes.byref(pci))
            gpu = dict(
                index=i,
                id=self.string("nvmlDeviceGetUUID", h),
                name=self.string("nvmlDeviceGetName", h),
                driver=self.driver.value.decode(),
                source="NVML",
                memoryTotal=mem.total if have_mem else None,
                memoryUsed=mem.used if have_mem else None,
                utilization=util.gpu if have_util else None,
                memoryUtilization=util.memory if have_util else None,
                bus=pci.id.decode() if have_pci else None,
            )
            for key, name, args in [
                ("temperature", "nvmlDeviceGetTemperature", (0,)),
                ("powerWatts", "nvmlDeviceGetPowerUsage", ()),
                ("powerLimitWatts", "nvmlDeviceGetEnforcedPowerLimit", ()),
                ("smClockMHz", "nvmlDeviceGetClockInfo", (1,)),
                ("memoryClockMHz", "nvmlDeviceGetClockInfo", (2,)),
                ("pcieGeneration", "nvmlDeviceGetCurrPcieLinkGeneration", ()),
                ("pcieWidth", "nvmlDeviceGetCurrPcieLinkWidth", ()),
            ]:
                value = self.uint(name, h, *args)
                gpu[key] = (
                    value / 1000.0
                    if key.startswith("power") and value is not None
                    else value
                )
            major, minor = ctypes.c_int(), ctypes.c_int()
            if self.call(
                "nvmlDeviceGetCudaComputeCapability",
                h,
                ctypes.byref(major),
                ctypes.byref(minor),
            ):
                gpu["computeCapability"] = "%s.%s" % (major.value, minor.value)
            cuda = ctypes.c_int()
            if self.call("nvmlSystemGetCudaDriverVersion_v2", ctypes.byref(cuda)):
                gpu["driverCudaCompatibility"] = "%s.%s" % (
                    cuda.value // 1000,
                    cuda.value % 1000 // 10,
                )
            gpus.append(gpu)
            if apps:
                for kind, fn in [
                    ("compute", "nvmlDeviceGetComputeRunningProcesses_v2"),
                    ("graphics", "nvmlDeviceGetGraphicsRunningProcesses_v2"),
                ]:
                    try:
                        method = getattr(self.lib, fn)
                    except AttributeError:
                        continue
                    n = ctypes.c_uint()
                    rc = method(h, ctypes.byref(n), None)
                    if rc not in (0, 7) or not n.value:
                        continue
                    capacity = n.value + 16
                    buf = (self.Proc * capacity)()
                    n.value = capacity
                    if method(h, ctypes.byref(n), buf):
                        continue
                    for p in buf[: n.value]:
                        key = (gpu["id"], p.pid)
                        row = processes.setdefault(
                            key,
                            dict(gpu=gpu["id"], pid=p.pid, memoryUsed=None, kinds=[]),
                        )
                        row["kinds"].append(kind)
                        if p.used != 2**64 - 1:
                            row["memoryUsed"] = p.used
        return gpus, list(processes.values()), []

    def close(self):
        self.lib.nvmlShutdown()


try:
    NVML = Nvml()
except (OSError, AttributeError):
    NVML = None


def gpu_query(apps=False):
    exe = shutil.which("nvidia-smi")
    out = []
    errors = []
    processes = []
    if NVML:
        out, processes, errors = NVML.query(apps)
    elif exe:
        fields = "index,uuid,name,driver_version,pci.bus_id,memory.total,memory.used,utilization.gpu,utilization.memory,temperature.gpu,power.draw,power.limit,clocks.current.sm,clocks.current.memory,pcie.link.gen.current,pcie.link.width.current"
        try:
            for row in csv.reader(
                io.StringIO(
                    run([exe, "--query-gpu=" + fields, "--format=csv,noheader,nounits"])
                )
            ):
                if len(row) < 16:
                    continue
                r = [x.strip() for x in row]
                out.append(
                    dict(
                        index=number(r[0]),
                        id=r[1],
                        name=r[2],
                        driver=r[3],
                        bus=r[4],
                        memoryTotal=number(r[5], 1048576),
                        memoryUsed=number(r[6], 1048576),
                        utilization=number(r[7]),
                        memoryUtilization=number(r[8]),
                        temperature=number(r[9]),
                        powerWatts=number(r[10]),
                        powerLimitWatts=number(r[11]),
                        smClockMHz=number(r[12]),
                        memoryClockMHz=number(r[13]),
                        pcieGeneration=number(r[14]),
                        pcieWidth=number(r[15]),
                        source="nvidia-smi",
                    )
                )
            if apps:
                for r in csv.reader(
                    io.StringIO(
                        run(
                            [
                                exe,
                                "--query-compute-apps=gpu_uuid,pid,used_gpu_memory",
                                "--format=csv,noheader,nounits",
                            ]
                        )
                    )
                ):
                    if len(r) >= 3:
                        processes.append(
                            dict(
                                gpu=r[0].strip(),
                                pid=number(r[1]),
                                memoryUsed=number(r[2], 1048576),
                                kind="compute",
                            )
                        )
        except (OSError, RuntimeError) as e:
            errors.append(str(e))
    if WIN:
        paths = [
            r"\GPU Engine(*)\Utilization Percentage",
            r"\GPU Adapter Memory(*)\Dedicated Usage",
            r"\GPU Adapter Memory(*)\Shared Usage",
        ]
        if apps:
            paths.extend(
                [
                    r"\GPU Process Memory(*)\Dedicated Usage",
                    r"\GPU Process Memory(*)\Shared Usage",
                ]
            )
        values = PDH.read(paths)
        for adapter in ADAPTERS:
            matches = [g for g in out if g["name"] == adapter["name"]]
            g = matches[0] if len(matches) == 1 else dict(adapter)
            if not matches:
                out.append(g)
            luid = adapter["id"].lower()
            g["adapterId"] = adapter["id"]
            engines = {}
            for name, value in values.get(paths[0], {}).items():
                if luid not in name.lower():
                    continue
                k = re.sub(r"^pid_\d+_", "", name)
                engines[k] = engines.get(k, 0) + value
            if engines:
                g["engineUtilization"] = max(engines.values())
            for path, key in [(paths[1], "dedicatedUsed"), (paths[2], "sharedUsed")]:
                vs = [v for n, v in values.get(path, {}).items() if luid in n.lower()]
                if vs:
                    g[key] = sum(vs)
            if g.get("utilization") is None:
                g["utilization"] = g.get("engineUtilization")
            g["sharedMemoryTotal"] = adapter["sharedMemoryTotal"]
            if apps:
                dedicated = values.get(paths[3], {})
                shared = values.get(paths[4], {})
                for name in set(dedicated) | set(shared):
                    match = re.match(r"pid_(\d+)_", name)
                    if (
                        not match
                        or luid not in name.lower()
                        or max(dedicated.get(name, 0), shared.get(name, 0)) <= 0
                    ):
                        continue
                    pid = int(match.group(1))
                    row = next(
                        (
                            p
                            for p in processes
                            if p["gpu"] == g["id"] and p["pid"] == pid
                        ),
                        None,
                    )
                    if not row:
                        row = dict(
                            gpu=g["id"], pid=pid, memoryUsed=None, kinds=["WDDM"]
                        )
                        processes.append(row)
                    if name in dedicated:
                        row["memoryUsed"] = dedicated[name]
                    if name in shared:
                        row["sharedMemoryUsed"] = shared[name]
    return out, processes, errors


def io_snapshot(now):
    if WIN:
        paths = [
            r"\Network Interface(*)\Bytes Received/sec",
            r"\Network Interface(*)\Bytes Sent/sec",
            r"\PhysicalDisk(*)\Disk Read Bytes/sec",
            r"\PhysicalDisk(*)\Disk Write Bytes/sec",
        ]
        values = PDH.read(paths)
        network = {}
        disks = {}
        for path, key in zip(
            paths,
            [
                "receiveBytesPerSecond",
                "sendBytesPerSecond",
                "readBytesPerSecond",
                "writeBytesPerSecond",
            ],
        ):
            target = network if path in paths[:2] else disks
            for name, v in values.get(path, {}).items():
                if name != "_Total":
                    target.setdefault(name, dict(name=name))[key] = v
        volumes = []
        for letter in "ABCDEFGHIJKLMNOPQRSTUVWXYZ":
            root = letter + ":\\"
            available, total, free = (
                ctypes.c_ulonglong(),
                ctypes.c_ulonglong(),
                ctypes.c_ulonglong(),
            )
            if K.GetDriveTypeW(ctypes.c_wchar_p(root)) in (
                2,
                3,
                4,
                6,
            ) and K.GetDiskFreeSpaceExW(
                ctypes.c_wchar_p(root),
                ctypes.byref(available),
                ctypes.byref(total),
                ctypes.byref(free),
            ):
                volumes.append(
                    dict(path=root, total=total.value, available=available.value)
                )
        return dict(
            network=list(network.values()), disks=list(disks.values()), volumes=volumes
        )
    network = []
    disks = []
    volumes = []
    for line in text("/proc/net/dev").splitlines()[2:]:
        name, rest = line.split(":", 1)
        v = rest.split()
        name = name.strip()
        network.append(
            dict(
                name=name,
                receiveBytesPerSecond=rate("rx" + name, int(v[0]), now),
                sendBytesPerSecond=rate("tx" + name, int(v[8]), now),
            )
        )
    for line in text("/proc/diskstats").splitlines():
        v = line.split()
        name = v[2]
        if name.startswith(("loop", "ram")):
            continue
        disks.append(
            dict(
                name=name,
                readBytesPerSecond=rate("rd" + name, int(v[5]) * 512, now),
                writeBytesPerSecond=rate("wr" + name, int(v[9]) * 512, now),
            )
        )
    seen = set()
    for line in text("/proc/self/mounts").splitlines():
        v = line.split()
        mount = v[1].replace("\\040", " ")
        if v[0].startswith("/dev/") and mount not in seen:
            try:
                st = os.statvfs(mount)
                volumes.append(
                    dict(
                        path=mount,
                        total=st.f_blocks * st.f_frsize,
                        available=st.f_bavail * st.f_frsize,
                    )
                )
                seen.add(mount)
            except OSError:
                pass
    return dict(network=network, disks=disks, volumes=volumes)


def process_detail(a, rows):
    pid = int(a["pid"])
    p = next((x for x in rows if x["pid"] == pid), None)
    if not p:
        raise ValueError("Process exited; refresh the list")
    if a.get("identity") and a["identity"] != p.get("identity"):
        raise ValueError("Process identity changed; refresh the list")
    p = dict(p)
    if WIN:
        h = K.OpenProcess(0x1000, False, pid)
        if h:
            try:
                if p.get("identity") != "%s:%s" % (pid, win_cpu(h)[1]):
                    raise ValueError("Process identity changed")
                b = ctypes.create_unicode_buffer(32768)
                size = W.DWORD(len(b))
                count = W.DWORD()
                if K.QueryFullProcessImageNameW(h, 0, b, ctypes.byref(size)):
                    p["executable"] = b.value
                if K.GetProcessHandleCount(h, ctypes.byref(count)):
                    p["handles"] = count.value
            finally:
                K.CloseHandle(h)
    else:
        for key, name in [("cwd", "cwd"), ("executable", "exe")]:
            try:
                p[key] = os.readlink("/proc/%s/%s" % (pid, name))
            except OSError:
                p["access"] = "partial"
        try:
            for line in text("/proc/%s/smaps_rollup" % pid).splitlines():
                if line.startswith("Pss:"):
                    p["pss"] = int(line.split()[1]) * 1024
        except OSError:
            pass
        try:
            # Fixed launch markers identify tools; raw arguments stay inside the collector.
            with open("/proc/%s/cmdline" % pid, "rb") as f:
                command = f.read(65536).decode(errors="replace")
            argv = command.split("\0")
            exe = os.path.basename(p.get("executable", p["name"]))
            role = None
            if exe == "java":
                if "org.gradle.launcher.daemon.bootstrap.GradleDaemon" in argv:
                    role = "Gradle 构建"
                elif "org.jetbrains.kotlin.daemon.KotlinCompileDaemon" in argv:
                    role = "Kotlin 编译"
            elif exe == "node":
                if any(os.path.basename(v) == "tsserver.js" for v in argv[1:]):
                    role = "TypeScript 语言服务"
                elif "--type=extensionHost" in argv:
                    role = "VS Code 扩展宿主"
            elif exe == "codex" and "app-server" in argv[1:]:
                role = "Codex app-server"
            elif exe == "gopls":
                role = "Go 语言服务"
            elif exe == "rust-analyzer":
                role = "Rust 语言服务"
            if role:
                p["role"] = role
                p["roleSource"] = "executable-and-launch-marker"
        except OSError:
            pass
        try:
            p["handles"] = len(os.listdir("/proc/%s/fd" % pid))
        except OSError:
            pass
        try:
            m = re.search(
                r"(?:docker[-/]|cri-containerd-)([a-f0-9]{64})",
                text("/proc/%s/cgroup" % pid),
            )
            if m:
                p["container"] = dict(id=m.group(1), source="proc-cgroup")
        except OSError:
            pass
    if not WIN:
        try:
            stat = text("/proc/%s/stat" % pid).rsplit(")", 1)[1].split()
            if p["identity"] != "%s:%s" % (pid, stat[19]):
                raise ValueError("Process identity changed")
        except OSError:
            raise ValueError("Process exited")
    return p


def snapshot(a):
    global PROCESSES
    if a.get("_baseline"):
        PREV.update(a["_baseline"])
    start = time.perf_counter()
    now = time.time()
    section = a.get("section", "summary")
    result = dict(
        stamp=int(now * 1000),
        platform=sys.platform,
        hostname=platform.node(),
        cpuUnit="one-logical-core-percent",
        errors=[],
    )
    result["system"] = windows_summary(now) if WIN else linux_summary(now)
    result["capabilities"] = dict(
        gpu=(
            "available"
            if NVML or shutil.which("nvidia-smi") or (WIN and ADAPTERS)
            else "unavailable"
        ),
        pss=not WIN,
    )
    if section in ("summary", "gpus", "gpu", "processes", "process"):
        try:
            g, apps, errors = gpu_query(section != "summary")
        except (OSError, RuntimeError, AttributeError) as error:
            g, apps, errors = [], [], [str(error)]
        result["gpus"] = g
        result["gpuStamp"] = int(now * 1000)
        result["gpuProcesses"] = apps
        result["errors"] += errors
    if section in ("processes", "process", "gpu"):
        PROCESSES = windows_processes(now) if WIN else linux_processes(now)
        alive = set("p" + p.get("identity", "") for p in PROCESSES)
        for key in list(PREV):
            if key.startswith("p") and key not in alive:
                PREV.pop(key, None)
        gpu_mem = {}
        shared_mem = {}
        for row in result.get("gpuProcesses", []):
            if row.get("memoryUsed") is not None:
                gpu_mem[row["pid"]] = gpu_mem.get(row["pid"], 0) + row["memoryUsed"]
            if row.get("sharedMemoryUsed") is not None:
                shared_mem[row["pid"]] = (
                    shared_mem.get(row["pid"], 0) + row["sharedMemoryUsed"]
                )
        for p in PROCESSES:
            p["gpuMemory"] = gpu_mem.get(p["pid"])
            p["gpuSharedMemory"] = shared_mem.get(p["pid"])
        if section == "process":
            try:
                result["detail"] = process_detail(a, PROCESSES)
                result["detailStatus"] = result["detail"].get("access", "available")
            except ValueError as error:
                result["detail"] = None
                result["detailStatus"] = (
                    "changed" if "identity" in str(error).lower() else "exited"
                )
                result["detailError"] = str(error)
        elif section == "gpu":
            result["detail"] = next(
                (g for g in result["gpus"] if g["id"] == a.get("gpu")), None
            )
            pids = set(
                p["pid"]
                for p in result.get("gpuProcesses", [])
                if p["gpu"] == a.get("gpu")
            )
            specific = {}
            specific_shared = {}
            for row in result.get("gpuProcesses", []):
                if row["gpu"] == a.get("gpu") and row.get("memoryUsed") is not None:
                    specific[row["pid"]] = (
                        specific.get(row["pid"], 0) + row["memoryUsed"]
                    )
                if (
                    row["gpu"] == a.get("gpu")
                    and row.get("sharedMemoryUsed") is not None
                ):
                    specific_shared[row["pid"]] = (
                        specific_shared.get(row["pid"], 0) + row["sharedMemoryUsed"]
                    )
            result["processes"] = [
                dict(
                    p,
                    gpuMemory=specific.get(p["pid"]),
                    gpuSharedMemory=specific_shared.get(p["pid"]),
                )
                for p in PROCESSES
                if p["pid"] in pids
            ]
        else:
            search = str(a.get("search", "")).lower()
            sort = a.get("sort", "rss")
            sort = (
                sort
                if sort in ("rss", "cpuPercent", "gpuMemory", "pid", "name")
                else "rss"
            )
            rows = [
                p
                for p in PROCESSES
                if search
                in (
                    p["name"] + " " + str(p["pid"]) + " " + str(p.get("user", ""))
                ).lower()
            ]
            rows.sort(
                key=lambda p: (p.get(sort) or ("" if sort == "name" else 0)),
                reverse=sort != "name",
            )
            offset = max(0, int(a.get("offset", 0)))
            limit = max(1, min(200, int(a.get("limit", 50))))
            result.update(
                processes=rows[offset : offset + limit],
                total=len(rows),
                offset=offset,
                limit=limit,
            )
    if section == "io":
        try:
            result["io"] = io_snapshot(now)
        except (OSError, ValueError, IndexError) as error:
            result["io"] = {}
            result["errors"].append("IO: " + str(error))
    cpu = (
        win_cpu(K.GetCurrentProcess())[0] + CHILD_CPU
        if WIN
        else resource.getrusage(resource.RUSAGE_SELF).ru_utime
        + resource.getrusage(resource.RUSAGE_SELF).ru_stime
        + resource.getrusage(resource.RUSAGE_CHILDREN).ru_utime
        + resource.getrusage(resource.RUSAGE_CHILDREN).ru_stime
    )
    if a.get("_checkpoint"):
        result["_baseline"] = PREV.copy()
    result["collector"] = dict(
        pid=os.getpid(),
        cpuSeconds=cpu,
        elapsedMs=round((time.perf_counter() - start) * 1000, 2),
    )
    if not WIN:
        result["collector"]["peakRss"] = (
            resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024
        )
        result["collector"]["rss"] = int(text("/proc/self/statm").split()[1]) * PAGE
    else:
        own = Counters()
        own.size = ctypes.sizeof(own)
        if PS.GetProcessMemoryInfo(K.GetCurrentProcess(), ctypes.byref(own), own.size):
            result["collector"].update(
                rss=own.rss, peakRss=own.peak, privateBytes=own.private
            )

    return result


def stop(*args):
    if CHILD and CHILD.poll() is None:
        CHILD.terminate()
    raise SystemExit(0)


def main():
    signal.signal(signal.SIGTERM, stop)
    try:
        for raw in sys.stdin.buffer:
            line = raw.decode("utf-8")
            msg = {}
            try:
                msg = json.loads(line)
                if msg.get("method") != "snapshot":
                    raise ValueError("Read-only snapshot method required")
                response = dict(id=msg["id"], result=snapshot(msg.get("args", {})))
            except Exception as e:
                response = dict(
                    id=msg.get("id"), error=dict(message=str(e), type=type(e).__name__)
                )
            sys.stdout.write(
                json.dumps(response, ensure_ascii=True, separators=(",", ":")) + "\n"
            )
            sys.stdout.flush()
    finally:
        if WIN:
            PDH.close()
        if NVML:
            NVML.close()
        if CHILD and CHILD.poll() is None:
            CHILD.terminate()


if __name__ == "__main__":
    main()
