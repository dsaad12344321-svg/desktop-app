# Long Beach Hotel Assistant

A standalone Windows desktop application for hotel operations, based on Electron and the existing Next.js tools from [dsaad12344321-svg/nationality](https://github.com/dsaad12344321-svg/nationality).

This repository is independent. The original `nationality` repository and its Vercel deployment are not modified by this project.

## First milestone

The initial desktop prototype packages the existing Next.js application and its API routes inside Electron. The Next.js server runs locally on the user's computer and the desktop window connects only to `127.0.0.1`. The first milestone is to validate the existing Nationality Report and local application startup before adding more Windows integrations.

## Included application features

The initial codebase carries over the current nationality project, including:

- Nationality report generation from `nat.xml` and `man.xml`.
- Guest Name Extractor.
- Journal Detector API.
- Journal Fixed Charges API.
- Missing Profile API.
- Missing Towels API.
- Nationality Missing API.
- RC Missing API.

The transferred tools need to be regression-tested in the desktop environment before being considered production-ready.

## Desktop architecture

- **Next.js / React:** existing hotel tools and interface.
- **Electron:** Windows desktop shell.
- **Preload + IPC:** small allowlisted bridge for native file/folder dialogs.
- **Local Next.js server:** preserves API routes and supports offline use after installation.
- **Outlook Classic:** planned as a separate Windows integration; not yet connected in this first prototype.

The renderer has context isolation enabled and Node integration disabled. Do not expose arbitrary shell commands, unrestricted filesystem access, or raw Node.js APIs to the renderer.

## Requirements for development

- Windows 10/11 x64 recommended.
- Node.js 22 LTS.
- npm.

## Run in development

```bash
npm install
npm run desktop:dev
```

Electron starts the Next.js development server locally and opens the desktop window.

## Build the Windows installer

```bash
npm install
npm run desktop:dist
```

The installer is written to `release/`.

A Windows installer can also be built from GitHub Actions using **Actions → Build Windows Installer → Run workflow**. The resulting EXE is available as a workflow artifact.

## Privacy and safety

- The desktop app runs the Next.js server on the loopback interface (`127.0.0.1`).
- Hotel files should be processed locally by default.
- Do not commit guest files, reservation exports, Outlook messages, credentials, or generated reports.
- Native file operations must be introduced through narrow, explicit IPC methods.
- Destructive file operations must require confirmation and be logged.
- Outlook read/search/attachment features will be implemented and tested separately for Outlook Classic.

## Roadmap

1. Validate the local Electron + Next.js prototype and Nationality Report.
2. Add safe native file reading, writing, copy, move, and rename workflows.
3. Add Outlook Classic integration for searching messages and exporting attachments.
4. Bring the remaining hotel tools into the unified desktop navigation.
5. Add signed releases and a controlled update mechanism.
