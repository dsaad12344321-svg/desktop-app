const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopBridge", Object.freeze({
  getAppInfo: () => ipcRenderer.invoke("desktop:get-app-info"),
  selectFiles: (extensions) => ipcRenderer.invoke("desktop:select-files", { extensions }),
  selectFolder: () => ipcRenderer.invoke("desktop:select-folder"),
  listFolderFiles: (rootPath) => ipcRenderer.invoke("desktop:list-folder-files", rootPath),
  readFile: (rootPath, filePath) => ipcRenderer.invoke("desktop:read-file", rootPath, filePath),
  openPath: (selectedPath) => ipcRenderer.invoke("desktop:open-path", selectedPath),
  showInFolder: (selectedPath) => ipcRenderer.invoke("desktop:show-in-folder", selectedPath)
}));
