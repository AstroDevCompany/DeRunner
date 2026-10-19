# DeRunner

A fast, frosted-glass **process manager & inspector** built with Tauri v2 (Rust), React, Tailwind and pnpm. macOS-first, with Windows and Linux code paths behind the same shared monitoring engine.

By **MintFlow Technologies** ([mintflow.dev](https://mintflow.dev)). Lead developer: **Luca Montanari** ([instagram.com/montanarii.luca](https://instagram.com/montanarii.luca)).

## Features

- **Process Explorer**: live CPU, memory, disk and network per process; search (`pid:`, `user:`, `app:` filters), sort, column picker, virtualized for 1000+ processes.
- **Tree & Apps views**: parent→child hierarchy with rolled-up totals, or helpers grouped under their `.app`.
- **Inspector**: path, command line (secrets masked), cwd, parents/children, priority, environment, open files, sockets, code signature (macOS: signed / valid / notarized), and per-process CPU / memory / disk / network history charts (10 min at 1 s, 1 h at 10 s).
- **Colour-coded usage**: normal < 70%, high 70–90% (▲), critical > 90% (◆). Always colour + shape + number.
- **Tracking sessions**: manual or timed (1/5/10 min/custom) detailed recording with events (child spawns/exits, suspend/resume, priority changes, anomalies) → deterministic report + optional AI analysis, exportable as Markdown.
- **Anomaly detection**: sustained load, CPU spikes vs. baseline, leak-like memory growth, thread surges, process-spawn bursts, odd locations, zombies. Explainable and never auto-labelled malware; dismiss / allowlist.
- **Controls**: terminate (graceful / force / whole tree), suspend, resume, relaunch, bring window to front, change priority, with a protected-process guard.
- **Priority rules**: wildcard/regex rules re-applied when matching processes launch (sampler diff, no polling per rule) plus a light 30 s drift check. Works from the tray.
- **AI assistant**: Ollama, LM Studio, OpenAI, Anthropic, OpenRouter. All requests go through Rust; API keys live in the OS keychain; sensitive data is redacted before leaving the machine.
- **Tray**: show/focus, command palette, pause monitoring, stop tracking sessions, settings, update check, launch at login, quit. Live CPU next to the icon.
- **Command palette**: `⌘K` / `Ctrl+K`: processes and actions.
- **Frosted glass UI**, light / dark / system themes, "reduce transparency" mode.
- **Ports view**: listening sockets and the processes behind them.

## Develop

```bash
pnpm install
pnpm tauri dev        # native app
pnpm dev              # UI only in a browser, with a built-in mock backend
pnpm test             # frontend unit tests
(cd src-tauri && cargo test)
pnpm tauri build      # release bundle
pnpm icons            # regenerate icons from branding/logo.svg
```

## Performance design

- One sampler thread, minimal sysinfo refresh kinds, static fields read once per new pid.
- Compact delta snapshots over a Tauri `Channel` (arrays, not objects); nothing is sent when the window is hidden.
- Cadence adapts: user interval when visible, 5 s only if rules / sessions / background alerts need it, otherwise parked at ~0% CPU.
- Per-process network (macOS) polls one-shot `nettop` snapshots and diffs them (continuous `nettop` burns >100% CPU), and only while the window is visible or a session is recording.
- UI: virtualized table, live values kept outside React state, charts on canvas (uPlot), backdrop-filter only on large surfaces.

## Platform notes

| Capability | macOS | Windows | Linux |
|---|---|---|---|
| CPU / memory / disk per process | ✓ | ✓ | ✓ |
| Network per process | ✓ (`nettop`, ~5 s resolution) | system totals | system totals |
| Suspend / resume / priority | ✓ | ✓ | ✓ |
| Focus window | ✓ | ✓ | X11 (`xdotool`) |
| Code signature | ✓ | Authenticode | package owner |

Only macOS has been run by the author; Windows and Linux paths are written behind `cfg` gates and need testing on those systems. The macOS build is **not sandboxed** (required to inspect processes) and uses Tauri's `macOSPrivateApi` for the transparent window, so distribute it directly (signed + notarized), not via the Mac App Store.
Raising a process's priority, or touching other users' processes, needs elevated privileges; DeRunner reports this instead of failing silently.

## Releasing & updates

DeRunner checks a JSON manifest, currently
`https://raw.githubusercontent.com/AstroDevCompany/MintFlow-Releases/refs/heads/main/derunner.json`
(constant `UPDATE_MANIFEST_URL` in `src-tauri/src/update.rs`):

```json
{ "latest": "0.1.0", "windows": "", "macos": "" }
```

To publish a release: bump `version` in `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`; upload the builds; set `latest` and the direct download URL per platform (`macos`, `windows`, optional `linux`) in that file. An empty URL means "version exists, download not published yet".
A sample is in [`derunner.json`](derunner.json).
