const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('talksketch', {
  line: (line) => ipcRenderer.send('caption', line),
  hasLocalStt: () => ipcRenderer.invoke('local-stt'),
  audioChunk: (payload) => ipcRenderer.send('audio-chunk', payload),
  onTranscript: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('transcript', listener);
    return () => ipcRenderer.removeListener('transcript', listener);
  },
  onPanel: (callback) => {
    const listener = (_event, markdown) => callback(markdown);
    ipcRenderer.on('panel-update', listener);
    return () => ipcRenderer.removeListener('panel-update', listener);
  },
});
