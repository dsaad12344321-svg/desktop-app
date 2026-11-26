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
      showInFolder: (selectedPath: string) => Promise<boolean>;
    };
  }
}
