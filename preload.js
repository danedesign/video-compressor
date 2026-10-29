const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('videoCompressor', {
  chooseFiles: () => ipcRenderer.invoke('compressor:choose-files'),
  chooseFolder: () => ipcRenderer.invoke('compressor:choose-folder'),
  inspect: paths => ipcRenderer.invoke('compressor:inspect', paths),
  start: options => ipcRenderer.invoke('compressor:start', options),
  cancel: () => ipcRenderer.invoke('compressor:cancel'),
  getPathForFile: file => webUtils.getPathForFile(file),
  onEvent: callback => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('compressor:event', listener);
    return () => ipcRenderer.removeListener('compressor:event', listener);
  }
});
