const { contextBridge, ipcRenderer } = require('electron');
const call = (ch, ...a) => ipcRenderer.invoke(ch, ...a);
contextBridge.exposeInMainWorld('api', {
  listWindows: () => call('windows:list'),
  displays: () => call('displays:list'),
  getConfig: () => call('config:get'),
  saveConfig: (c) => call('config:save', c),
  pin: (hwnd, rule) => call('pin', hwnd, rule),
  unpin: (hwnd) => call('unpin', hwnd),
});
