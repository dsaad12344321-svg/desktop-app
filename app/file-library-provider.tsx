"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

export type SharedFolderKind = "reservations" | "registration";
export type SharedFolderEntry = {
  path: string;
  relativePath: string;
  name: string;
  size: number;
  mtimeMs: number;
};

type FolderState = {
  path: string;
  entries: SharedFolderEntry[];
  loading: boolean;
  loaded: boolean;
  error: string;
};

type FileLibraryContextValue = {
  reservations: FolderState;
  registrations: FolderState;
  refreshFolder: (kind: SharedFolderKind, rootPath?: string) => Promise<SharedFolderEntry[]>;
  setFolderPath: (kind: SharedFolderKind, rootPath: string) => Promise<SharedFolderEntry[]>;
  readBytes: (kind: SharedFolderKind, entry: SharedFolderEntry) => Promise<Uint8Array>;
  getFile: (kind: SharedFolderKind, entry: SharedFolderEntry) => Promise<File>;
};

const emptyFolder: FolderState = { path: "", entries: [], loading: false, loaded: false, error: "" };
const FileLibraryContext = createContext<FileLibraryContextValue | null>(null);

export function FileLibraryProvider({ children }: { children: ReactNode }) {
  const [reservations, setReservations] = useState<FolderState>(emptyFolder);
  const [registrations, setRegistrations] = useState<FolderState>(emptyFolder);
  const byteCache = useRef(new Map<string, Uint8Array>());

  const updateFolder = useCallback((kind: SharedFolderKind, updater: (current: FolderState) => FolderState) => {
    const setter = kind === "reservations" ? setReservations : setRegistrations;
    setter(updater);
  }, []);

  const refreshFolder = useCallback(async (kind: SharedFolderKind, requestedPath?: string) => {
    if (!window.desktopBridge) {
      updateFolder(kind, current => ({ ...current, loading: false, loaded: true, error: "مكتبة الملفات متاحة من تطبيق سطح المكتب." }));
      return [];
    }
    updateFolder(kind, current => ({ ...current, loading: true, error: "" }));
    try {
      const rootPath = requestedPath || (kind === "reservations"
        ? await window.desktopBridge.getSavedFolderPath()
        : await window.desktopBridge.getSavedRCExtractorFolderPath());
      if (!rootPath) {
        updateFolder(kind, () => ({ ...emptyFolder, loaded: true }));
        return [];
      }
      const entries = await window.desktopBridge.listFolderFiles(rootPath);
      const liveKeys = new Set(entries.map(entry => entry.path + "|" + entry.size + "|" + entry.mtimeMs));
      for (const key of byteCache.current.keys()) {
        if (key.startsWith(kind + "|") && !liveKeys.has(key.slice(kind.length + 1))) byteCache.current.delete(key);
      }
      updateFolder(kind, () => ({ path: rootPath, entries, loading: false, loaded: true, error: "" }));
      return entries;
    } catch (error) {
      const message = error instanceof Error ? error.message : "تعذر فحص المجلد.";
      updateFolder(kind, current => ({ ...current, loading: false, loaded: true, error: message }));
      throw error;
    } finally {
      updateFolder(kind, current => ({ ...current, loading: false }));
    }
  }, [updateFolder]);

  const setFolderPath = useCallback(async (kind: SharedFolderKind, rootPath: string) => {
    if (!window.desktopBridge) throw new Error("ربط المجلدات متاح من تطبيق سطح المكتب فقط.");
    if (kind === "reservations") await window.desktopBridge.saveFolderPath(rootPath);
    else await window.desktopBridge.saveRCExtractorFolderPath(rootPath);
    return refreshFolder(kind, rootPath);
  }, [refreshFolder]);

  const readBytes = useCallback(async (kind: SharedFolderKind, entry: SharedFolderEntry) => {
    const folder = kind === "reservations" ? reservations : registrations;
    const rootPath = folder.path;
    if (!rootPath || !window.desktopBridge) throw new Error("المجلد غير متاح حاليًا.");
    const key = kind + "|" + entry.path + "|" + entry.size + "|" + entry.mtimeMs;
    const cached = byteCache.current.get(key);
    if (cached) return cached.slice();
    const bytes = await window.desktopBridge.readFile(rootPath, entry.path);
    const stored = new Uint8Array(bytes);
    byteCache.current.set(key, stored);
    return stored.slice();
  }, [reservations, registrations]);

  const getFile = useCallback(async (kind: SharedFolderKind, entry: SharedFolderEntry) => {
    const bytes = await readBytes(kind, entry);
    return new File([bytes.buffer as ArrayBuffer], entry.name, { lastModified: entry.mtimeMs });
  }, [readBytes]);

  useEffect(() => {
    if (!window.desktopBridge) return;
    let active = true;
    void Promise.all([
      refreshFolder("reservations").catch(() => []),
      refreshFolder("registration").catch(() => []),
    ]).then(() => {
      if (!active) return;
    });
    return () => { active = false; };
  }, [refreshFolder]);

  const value = useMemo(() => ({
    reservations, registrations, refreshFolder, setFolderPath, readBytes, getFile,
  }), [reservations, registrations, refreshFolder, setFolderPath, readBytes, getFile]);

  return <FileLibraryContext.Provider value={value}>{children}</FileLibraryContext.Provider>;
}

export function useFileLibrary() {
  const value = useContext(FileLibraryContext);
  if (!value) throw new Error("useFileLibrary must be used inside FileLibraryProvider");
  return value;
}
