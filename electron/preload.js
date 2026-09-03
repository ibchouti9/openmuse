// Minimal preload: no privileged APIs exposed yet.
"use strict";
const { contextBridge } = require("electron");
contextBridge.exposeInMainWorld("openmuse", { desktop: true });
