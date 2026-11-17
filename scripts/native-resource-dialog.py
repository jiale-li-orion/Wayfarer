"""Complete only the isolated acceptance window's native resource save dialog."""

import argparse, ctypes, time, tempfile, os, json
from pathlib import Path
from ctypes import wintypes as W

p = argparse.ArgumentParser()
p.add_argument("--pid", type=int, required=True)
p.add_argument("--path", required=True)
p.add_argument("--dialog-title", default="导出资源记录")
a = p.parse_args()
root = Path(tempfile.gettempdir()) / "wayfarer-resource-acceptance"
try:
    Path(a.path).resolve().relative_to(root.resolve())
except ValueError:
    raise SystemExit("Destination must remain in the acceptance fixture")
u = ctypes.WinDLL("user32", use_last_error=True)
u.GetWindowThreadProcessId.argtypes = [W.HWND, ctypes.POINTER(W.DWORD)]
u.GetClassNameW.argtypes = [W.HWND, W.LPWSTR, ctypes.c_int]
u.GetWindowTextW.argtypes = [W.HWND, W.LPWSTR, ctypes.c_int]
u.GetDlgCtrlID.argtypes = [W.HWND]
u.SendMessageTimeoutW.argtypes = [
    W.HWND,
    W.UINT,
    W.WPARAM,
    W.LPARAM,
    W.UINT,
    W.UINT,
    ctypes.POINTER(ctypes.c_size_t),
]
u.SendMessageTimeoutW.restype = W.LPARAM
callback = ctypes.WINFUNCTYPE(W.BOOL, W.HWND, W.LPARAM)


def describe(h):
    c = ctypes.create_unicode_buffer(120)
    t = ctypes.create_unicode_buffer(300)
    u.GetClassNameW(h, c, len(c))
    u.GetWindowTextW(h, t, len(t))
    return c.value, t.value


print(json.dumps({"ready": True}), flush=True)
start = time.monotonic()
dialog = None
while time.monotonic() - start < 30:
    found = []

    @callback
    def find(h, _):
        pid = W.DWORD()
        u.GetWindowThreadProcessId(h, ctypes.byref(pid))
        c, title = describe(h)
        if (
            pid.value == a.pid
            and c == "#32770"
            and title == a.dialog_title
            and u.IsWindowVisible(h)
        ):
            found.append(h)
        return True

    u.EnumWindows(find, 0)
    if found:
        dialog = found[0]
        break
    time.sleep(0.05)
if not dialog:
    raise SystemExit("Owned native save dialog absent")
controls = []


@callback
def child(h, _):
    c, title = describe(h)
    if c in ("Edit", "Button", "ComboBox", "ComboBoxEx32"):
        controls.append((h, c, u.GetDlgCtrlID(h), title))
    return True


u.EnumChildWindows(dialog, child, 0)
edit = next(
    (x for x in controls if x[1] == "Edit" and x[2] in (1001, 1148, 1152)), None
)
button = next((x for x in controls if x[1] == "Button" and x[2] == 1), None)
if not edit or not button:
    print(json.dumps({"controls": [(x[1], x[2]) for x in controls]}), flush=True)
    raise SystemExit("Filename controls missing")
buf = ctypes.create_unicode_buffer(a.path)
result = ctypes.c_size_t()
if not u.SendMessageTimeoutW(
    edit[0],
    0xC,
    0,
    ctypes.cast(buf, ctypes.c_void_p).value,
    2,
    3000,
    ctypes.byref(result),
):
    raise SystemExit("Filename change rejected")
if not u.SendMessageTimeoutW(button[0], 0xF5, 0, 0, 2, 3000, ctypes.byref(result)):
    raise SystemExit("Save action rejected")
print(json.dumps({"accepted": True, "editId": edit[2]}), flush=True)
