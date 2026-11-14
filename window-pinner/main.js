const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const W = require('./winapi');

const DEFAULTS = { settings: { autoPin: true, startWithWindows: false, tray: true }, rules: [] };
const cfgPath = () => path.join(app.getPath('userData'), 'config.json');
const applied = new Map(); // hwnd -> true, windows already placed this session
let cfg = structuredClone(DEFAULTS), win, tray, quitting = false;

function loadCfg() {
  try {
    const c = JSON.parse(fs.readFileSync(cfgPath(), 'utf8'));
    cfg = { settings: { ...DEFAULTS.settings, ...c.settings }, rules: c.rules || [] };
  } catch { cfg = structuredClone(DEFAULTS); }
}
const saveCfg = () => fs.writeFileSync(cfgPath(), JSON.stringify(cfg, null, 2));
const keyOf = (w) => (w.exe === 'applicationframehost.exe' ? `${w.exe}|${w.title}` : w.exe);

function makeIcon() {
  const s = 32, buf = Buffer.alloc(s * s * 4);
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    const d = Math.hypot(x - 15.5, y - 15.5), i = (y * s + x) * 4;
    if (d > 15) continue;
    const inner = d <= 6; // BGRA
    buf[i] = inner ? 255 : 226; buf[i + 1] = inner ? 255 : 130; buf[i + 2] = inner ? 255 : 30; buf[i + 3] = 255;
  }
  return nativeImage.createFromBitmap(buf, { width: s, height: s });
}

function areaFor(hwnd, displayId) {
  let d;
  if (displayId && displayId !== 'current') d = screen.getAllDisplays().find((x) => String(x.id) === String(displayId));
  if (!d) {
    const { rect } = W.frame(hwnd);
    d = screen.getDisplayMatching(screen.screenToDipRect(null,
      { x: rect.left, y: rect.top, width: rect.right - rect.left, height: rect.bottom - rect.top }));
  }
  return screen.dipToScreenRect(null, d.workArea);
}

function applyRule(hwnd, rule) {
  try { W.pin(hwnd, rule, areaFor(hwnd, rule.display)); applied.set(hwnd, true); } catch (e) { console.error(e); }
}

function tick() {
  if (!cfg.settings.autoPin || !cfg.rules.some((r) => r.auto)) return;
  const wins = W.listWindows();
  const live = new Set(wins.map((w) => w.hwnd));
  for (const h of applied.keys()) if (!live.has(h)) applied.delete(h);
  for (const w of wins) {
    if (w.pid === process.pid || applied.has(w.hwnd)) continue;
    const rule = cfg.rules.find((r) => r.auto && r.key === keyOf(w));
    if (!rule) continue;
    applyRule(w.hwnd, rule);
    // Some apps restore their own position a moment after opening, so place them again.
    setTimeout(() => applyRule(w.hwnd, rule), 1500);
  }
}

function applyLoginItem() {
  app.setLoginItemSettings({ openAtLogin: cfg.settings.startWithWindows, args: ['--hidden'] });
}

function createWindow() {
  win = new BrowserWindow({
    width: 980, height: 640, minWidth: 820, minHeight: 520, show: !process.argv.includes('--hidden'),
    backgroundColor: '#14161a', icon: makeIcon(), autoHideMenuBar: true, title: 'Window Pinner',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('close', (e) => { if (!quitting && cfg.settings.tray) { e.preventDefault(); win.hide(); } });
}

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { win.show(); win.focus(); });
app.on('before-quit', () => { quitting = true; });

app.whenReady().then(() => {
  loadCfg();
  applyLoginItem();
  createWindow();
  tray = new Tray(makeIcon().resize({ width: 16, height: 16 }));
  tray.setToolTip('Window Pinner');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open', click: () => { win.show(); win.focus(); } },
    { label: 'Quit', click: () => app.quit() },
  ]));
  tray.on('click', () => { win.show(); win.focus(); });
  setInterval(tick, 2000);
  tick();
});

ipcMain.handle('windows:list', () =>
  W.listWindows().filter((w) => w.pid !== process.pid)
    .map((w) => ({ ...w, key: keyOf(w), pinned: applied.has(w.hwnd) })));

ipcMain.handle('displays:list', () => screen.getAllDisplays().map((d, i) => ({
  id: String(d.id), label: `Display ${i + 1} (${d.size.width}x${d.size.height})${d.id === screen.getPrimaryDisplay().id ? ' primary' : ''}`,
})));

ipcMain.handle('config:get', () => cfg);
ipcMain.handle('config:save', (_e, c) => { cfg = c; saveCfg(); applyLoginItem(); return cfg; });

ipcMain.handle('pin', (_e, hwnd, rule) => {
  const i = cfg.rules.findIndex((r) => r.key === rule.key);
  if (i >= 0) cfg.rules[i] = rule; else cfg.rules.push(rule);
  saveCfg();
  applyRule(hwnd, rule);
  return cfg;
});

ipcMain.handle('unpin', (_e, hwnd) => { W.unpin(hwnd); applied.delete(hwnd); });
