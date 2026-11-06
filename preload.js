const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('deck', {
  bootstrap: () => ipcRenderer.invoke('get-bootstrap'),
  saveConfig: (patch) => ipcRenderer.invoke('save-config', patch),
  toggleAuto: () => ipcRenderer.invoke('toggle-auto'),
  shoot: (mode, count) => ipcRenderer.invoke('shoot', mode, count),
  gameMode: (action) => ipcRenderer.invoke('game-mode', action),
  openUserData: () => ipcRenderer.invoke('open-userdata'),
  onState: (cb) => ipcRenderer.on('state', (_e, data) => cb(data)),
  onMotion: (cb) => ipcRenderer.on('motion', (_e, data) => cb(data)),
  onSheet: (cb) => ipcRenderer.on('sheet', (_e, data) => cb(data)),
  onLog: (cb) => ipcRenderer.on('log', (_e, line) => cb(line))
});
