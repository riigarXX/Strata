const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sqliteSpike', {
  run: () => ipcRenderer.invoke('sqlite:run'),
});
