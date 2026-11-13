const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('talksketch', {
  line: (line) => ipcRenderer.send('caption', line),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
});
