const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopBridge", Object.freeze({
  getAppInfo: () => ipcRenderer.invoke("desktop:get-app-info"),
  selectFiles: (extensions) => ipcRenderer.invoke("desktop:select-files", { extensions }),
  selectFolder: () => ipcRenderer.invoke("desktop:select-folder"),
  showInFolder: (selectedPath) => ipcRenderer.invoke("desktop:show-in-folder", selectedPath)
}));
