const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('talksketch', {
  line: (line) => ipcRenderer.send('caption', line),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  hasLocalStt: () => ipcRenderer.invoke('local-stt'),
  audioChunk: (payload) => ipcRenderer.send('audio-chunk', payload),
  onTranscript: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('transcript', listener);
    return () => ipcRenderer.removeListener('transcript', listener);
  },
});
