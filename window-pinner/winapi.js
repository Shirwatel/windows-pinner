// Thin Win32 layer built on koffi. No native compile step needed.
const koffi = require('koffi');
const user32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');
const dwmapi = koffi.load('dwmapi.dll');

const RECT = koffi.struct('RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
const EnumProc = koffi.proto('bool __stdcall EnumProc(intptr hwnd, intptr lparam)');

const EnumWindows = user32.func('bool __stdcall EnumWindows(EnumProc *cb, intptr lparam)');
const IsWindow = user32.func('bool __stdcall IsWindow(intptr hwnd)');
const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(intptr hwnd)');
const IsIconic = user32.func('bool __stdcall IsIconic(intptr hwnd)');
const IsZoomed = user32.func('bool __stdcall IsZoomed(intptr hwnd)');
const GetWindowTextW = user32.func('int __stdcall GetWindowTextW(intptr hwnd, _Out_ uint16_t *buf, int max)');
const GetWindowLongW = user32.func('int32 __stdcall GetWindowLongW(intptr hwnd, int index)');
const GetWindow = user32.func('intptr __stdcall GetWindow(intptr hwnd, uint32 cmd)');
const GetWindowRect = user32.func('bool __stdcall GetWindowRect(intptr hwnd, _Out_ RECT *r)');
const SetWindowPos = user32.func('bool __stdcall SetWindowPos(intptr hwnd, intptr after, int x, int y, int cx, int cy, uint32 flags)');
const ShowWindow = user32.func('bool __stdcall ShowWindow(intptr hwnd, int cmd)');
const GetWindowThreadProcessId = user32.func('uint32 __stdcall GetWindowThreadProcessId(intptr hwnd, _Out_ uint32_t *pid)');
const OpenProcess = kernel32.func('intptr __stdcall OpenProcess(uint32 access, bool inherit, uint32 pid)');
const CloseHandle = kernel32.func('bool __stdcall CloseHandle(intptr h)');
const QueryFullProcessImageNameW = kernel32.func('bool __stdcall QueryFullProcessImageNameW(intptr h, uint32 flags, _Out_ uint16_t *name, _Inout_ uint32_t *size)');
const DwmGetWindowAttribute = dwmapi.func('int __stdcall DwmGetWindowAttribute(intptr hwnd, uint32 attr, _Out_ int32_t *val, uint32 size)');

const HWND_TOPMOST = -1, HWND_NOTOPMOST = -2;
const SWP_NOSIZE = 0x1, SWP_NOMOVE = 0x2, SWP_NOACTIVATE = 0x10;

const str = (arr, len) => String.fromCharCode.apply(null, arr.subarray(0, len));

function title(hwnd) {
  const buf = new Uint16Array(512);
  return str(buf, GetWindowTextW(hwnd, buf, 512));
}

function exeOf(pid) {
  const h = OpenProcess(0x1000, false, pid); // PROCESS_QUERY_LIMITED_INFORMATION
  if (!h) return '';
  try {
    const buf = new Uint16Array(1024), size = new Uint32Array([1024]);
    if (!QueryFullProcessImageNameW(h, 0, buf, size)) return '';
    return str(buf, size[0]).split('\\').pop().toLowerCase();
  } finally { CloseHandle(h); }
}

function cloaked(hwnd) {
  const v = new Int32Array(1);
  return DwmGetWindowAttribute(hwnd, 14, v, 4) === 0 && v[0] !== 0; // DWMWA_CLOAKED
}

// Visible frame rectangle and the invisible border Windows 10/11 adds around it.
function frame(hwnd) {
  const r = {};
  GetWindowRect(hwnd, r);
  const f = new Int32Array(4);
  if (DwmGetWindowAttribute(hwnd, 9, f, 16) !== 0) { // DWMWA_EXTENDED_FRAME_BOUNDS
    return { rect: r, ins: { l: 0, t: 0, r: 0, b: 0 }, w: r.right - r.left, h: r.bottom - r.top };
  }
  const ins = { l: f[0] - r.left, t: f[1] - r.top, r: r.right - f[2], b: r.bottom - f[3] };
  return { rect: r, ins, w: f[2] - f[0], h: f[3] - f[1] };
}

function listWindows() {
  const handles = [];
  const cb = koffi.register((hwnd) => { handles.push(hwnd); return true; }, koffi.pointer(EnumProc));
  try { EnumWindows(cb, 0); } finally { koffi.unregister(cb); }

  const out = [];
  for (const hwnd of handles) {
    if (!IsWindowVisible(hwnd)) continue;
    const t = title(hwnd);
    if (!t) continue;
    const ex = GetWindowLongW(hwnd, -20); // GWL_EXSTYLE
    const appWindow = (ex & 0x40000) !== 0;
    if ((ex & 0x80) && !appWindow) continue;        // tool window
    if (GetWindow(hwnd, 4) && !appWindow) continue; // owned popup
    if (cloaked(hwnd)) continue;
    const pid = new Uint32Array(1);
    GetWindowThreadProcessId(hwnd, pid);
    const f = frame(hwnd);
    out.push({ hwnd, title: t, pid: pid[0], exe: exeOf(pid[0]), topmost: (ex & 0x8) !== 0, size: { w: f.w, h: f.h } });
  }
  return out;
}

// area is in physical pixels: { x, y, width, height }
function pin(hwnd, o, area) {
  if (!IsWindow(hwnd)) return;
  if (IsIconic(hwnd)) ShowWindow(hwnd, 9);  // SW_RESTORE
  else if (IsZoomed(hwnd)) ShowWindow(hwnd, 1); // SW_SHOWNORMAL
  const f = frame(hwnd);
  const m = o.margin || 0;
  const w = Math.min(o.width || f.w, area.width - 2 * m);
  const h = Math.min(o.height || f.h, area.height - 2 * m);
  const x = o.corner.endsWith('left') ? area.x + m : area.x + area.width - w - m;
  const y = o.corner.startsWith('top') ? area.y + m : area.y + area.height - h - m;
  SetWindowPos(hwnd, o.alwaysOnTop ? HWND_TOPMOST : HWND_NOTOPMOST,
    x - f.ins.l, y - f.ins.t, w + f.ins.l + f.ins.r, h + f.ins.t + f.ins.b, SWP_NOACTIVATE);
}

function unpin(hwnd) {
  if (IsWindow(hwnd)) SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
}

module.exports = { listWindows, pin, unpin, frame };
