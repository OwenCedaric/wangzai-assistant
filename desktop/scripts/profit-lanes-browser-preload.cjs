const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('profitFixture', {
  progress: value => ipcRenderer.send('profit-fixture-progress', value),
  finish: value => ipcRenderer.send('profit-fixture-finished', value),
});
