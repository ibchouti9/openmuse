// OpenMuse preload: desktop flag + in-app browser helpers (screenshot/inspect).
"use strict";
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("openmuse", {
  desktop: true,
  captureBrowser: (guestId) => ipcRenderer.invoke("openmuse:browser-capture", guestId),
  openBrowserDevTools: (guestId) => ipcRenderer.invoke("openmuse:browser-devtools", guestId),
  openExternal: (url) => ipcRenderer.invoke("openmuse:open-external", url),
});
