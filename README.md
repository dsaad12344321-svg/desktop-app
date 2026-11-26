# Long Beach Hotel Assistant

Windows desktop application for hotel operations, built with Electron and the existing Next.js tools from `dsaad12344321-svg/nationality`.

## Project status

Initial desktop foundation is being prepared. The first milestone is running the Nationality Report locally inside Electron without depending on Vercel. Outlook Classic and native Windows file operations will be added through explicit, restricted desktop APIs.

## Planned architecture

- Next.js / React: application interface and existing hotel tools.
- Electron: Windows desktop shell.
- Electron preload + IPC: allowlisted local capabilities; no unrestricted Node.js access in the renderer.
- Local Next.js production server: keeps API routes working offline.
- Outlook Classic bridge: a separate Windows helper, introduced after the local app is stable.

## Development

The detailed setup and Windows packaging instructions will be added with the first working prototype.

## Privacy

Guest and reservation files should be processed locally by default. Never commit hotel data, credentials, Outlook content, or generated reports to this repository.