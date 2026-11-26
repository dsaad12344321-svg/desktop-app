export {};

declare global {
  interface Window {
    desktopBridge?: {
      getAppInfo: () => Promise<{
        name: string;
        version: string;
        packaged: boolean;
        platform: string;
      }>;
      selectFiles: (extensions?: string[]) => Promise<string[]>;
      selectFolder: () => Promise<string | null>;
      listFolderFiles: (rootPath: string) => Promise<Array<{ path: string; relativePath: string; name: string; size: number; mtimeMs: number }>>;
      readFile: (rootPath: string, filePath: string) => Promise<Uint8Array>;
      openPath: (selectedPath: string) => Promise<boolean>;
      showInFolder: (selectedPath: string) => Promise<boolean>;
    };
  }
}
