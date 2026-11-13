const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('talksketch', {
  line: (line) => ipcRenderer.send('caption', line),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  sessionStart: () => ipcRenderer.invoke('session-start'),
  sessionAppend: (id, entry) => ipcRenderer.send('session-append', { id, entry }),
  sessionNotes: (id, notes) => ipcRenderer.send('session-notes', { id, notes }),
  openSessions: () => ipcRenderer.invoke('open-sessions'),
});
