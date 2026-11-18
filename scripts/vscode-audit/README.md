# VS Code audit probes

Development-only probes used for the extension cleanup and shared-environment review. `scripts/**` is excluded from the VSIX. The product commands and MCP API are unchanged.

- `probe.cjs`: load this directory with `--extensionDevelopmentPath` in an **isolated user-data directory**. Set `workspaceMapAudit.output` to an absolute Windows output directory. The workspace must have a folder named `Audit fixture` with disposable sample.ts, sample.py and notes.md files. The probe records extension/tool metadata, performs definition/reference queries and edits only those fixtures. It creates one non-persistent control-directory watcher and disposes it with the development extension.
- The control file `control.json` accepts a unique `id` and an action: `snapshot`, `exercise`, `openNotes`, `paste`, `toolQuery`, or `closeEditors`. Results are written to control-result.json. `toolQuery` invokes only the existing read-only code-usages tool. `closeEditors` refuses while a document is dirty.
- `sample.py`: Windows process-tree sampling with psutil; takes `--marker`, `--seconds`, `--interval`, and `--output`. Command lines stay in memory and are reduced to process roles. Map the UI Extension Host with the probe snapshot PID because Electron utility command lines do not always identify its role.
- `profile-inspector.mjs`: capture a bounded CPU profile from a local Node inspector after checking its PID matches the explicitly supplied development host. Usage: `node profile-inspector.mjs <port> <pid> <seconds> <output>`.
- `sample-linux.py`: standard-library `/proc` sampling for the current user’s VS Code and map processes. Record the actual remote Extension Host PID separately, and attribute its subtree in analysis. Output includes PSS, RSS, swap, CPU time and file descriptors where available.

Use identical workspace content, retained editor tabs, probe code and warm-up actions for comparisons. Label cold startup separately from steady-state sampling. Close the audit window, confirm its helpers exit, remove temporary fixture files, and retain only the selected evidence. User account, session and model configuration are outside these probes.

The one-off clipboard fixture exposed that Windows format promotion can change the clipboard sequence without a user copy. That fixture was removed; its restoration failure is recorded in the audit report. Future image tests should run in a disposable desktop session or verify content ownership as well as sequence.
