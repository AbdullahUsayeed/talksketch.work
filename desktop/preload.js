const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('talksketch', {
  line: (line) => ipcRenderer.send('caption', line),
  onPanel: (callback) => {
    const listener = (_event, markdown) => callback(markdown);
    ipcRenderer.on('panel-update', listener);
    return () => ipcRenderer.removeListener('panel-update', listener);
  },
});
