const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  invoke: (ch, ...a) => ipcRenderer.invoke(ch, ...a),
  on: (ch, fn) => ipcRenderer.on(ch, (_e, ...a) => fn(...a)),
  pathOf: file => webUtils.getPathForFile(file),
});
