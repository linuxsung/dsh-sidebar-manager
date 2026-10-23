# Sidebar Manager

**English** · [한국어](README.ko.md)

> Status: active (v0.1.3) · Last updated: 2026-10-23 · Repository: [linuxsung/dsh-sidebar-manager](https://github.com/linuxsung/dsh-sidebar-manager)

## Index

| Section | Purpose |
|---|---|
| v0.1.3 documentation hotfix | English default and Korean companion alignment |
| M1–M4 promotion cores | Type A registration, Type B-cold, live handoff API, journal and lock |
| Implementation status | P1 UI / P2 Host / P3 manager panel / M1–M4 |
| Overview | What the plugin does and what it does not do |
| Layout | Package file responsibilities |
| Install | Local checkout and marketplace install |
| Safety rules | Move/Fork/Delete transaction invariants |
| Confirmation gate | What must be shown before a risky operation |
| UI copy (i18n) | Where user-facing strings live |

## v0.1.3 documentation hotfix

The published v0.1.2 root `README.md` was Korean, while `README.ko.md` held an older
and shorter Korean copy. Starting with v0.1.3 the repository follows the global
documentation standard:

- `README.md` is the English default and links to the Korean companion.
- `README.ko.md` is the full Korean translation and links back to `README.md`.
- `release-harness` now validates the staged documentation on every `run` and
  `publish`: an English root, a localized companion, and reciprocal top-of-file
  switchers. A non-English root stops the release with exit 5 before packaging.

This release also publishes the M1–M4 promotion host cores that landed on `main`
after v0.1.2. The UI button, shortcut, and automatic skill trigger (M5) are still
out of scope.

## M1–M4 promotion cores

Host-level project promotion API. It does not yet include a UI button, a shortcut,
or automatic skill activation (M5).

> **Important distinction:** Type A is currently **Register (directory
> registration)**. It attaches only sessions whose `cwd` matches the registered
> directory; it does not move the parent session that worked from another `cwd`.
> The full **Promote** path requires an `existing + sessionId +
> sessionPolicy(move|handoff|defer)` connector. For that reason
> `release-harness` currently declares `sessionIds: []`.

```text
POST /api/local/sidebar/promotion/preview
POST /api/local/sidebar/promotion/apply
POST /api/local/sidebar/promotion/status
```

### Type A — register an existing directory

```json
{ "mode": "existing", "path": "C:\\...\\release-harness", "title": "Universal Release Ops Harness" }
```

- Canonical `realpath`, `projectsRoot` containment, default-workspace and
  duplicate-title blocking.
- Attaches unaccounted sessions with the same `cwd`, oldest first. The result is
  ordered newest first.
- Uses only the public `workspaceRegistry.create(path, title)` API.
- `restartRequired=false`; `workspace.follow` reflects the change immediately.
- **Sessions with a different `cwd` are not attached.** Moving them requires a
  separate `sessionPolicy`.

### Type B-cold — scratch directory plus session relocation

```json
{ "mode": "scratch-cold", "sessionId": "session-...", "path": "C:\\...\\new-project", "title": "New Project" }
```

- Cold sessions only.
- Creates the target directory → `git init -b main` → `release.manifest.json`
  template → initial commit.
- Moves the session log through staging → `buildRelocated` → `verifyRelocated` →
  rename. Event frames are preserved byte-for-byte; only the header `cwd` is
  rewritten.
- Writes a `prepared → provisioned → log-ready → files-ready` journal and returns
  `restartRequired=true`.
- The next boot finalizer creates the target workspace and confirms ownership with
  **detach → attach**.
- On a crash before `log-ready` the original log and cache are restored; a
  `files-ready` journal resumes finalization.

### Type B-live — handoff from the last completed turn

```json
{ "mode": "scratch-handoff", "sessionId": "session-...", "path": "C:\\...\\new-project", "title": "New Project" }
```

- The source session may be live. Only the completed prefix after the last
  `turn/end` is used as the seed.
- Creates a new session with `agents.create({ seed, inheritedEventCount, cwd:
  target, parentSession, isSeeded: true })` and mounts the existing agent preset.
- Creates the target workspace and attaches the new session immediately.
  `restartRequired=false`.
- The source session ID and ownership do not change. A new session ID is issued.
- Journal: `prepared → workspace-ready → child-created → committed`. If the
  process crashes at `child-created`, the boot finalizer retries only the attach.

### Shared mechanics

- Paths: `stateDir/promotion/pending.json`, `stateDir/promotion/lock.json`.
- Single-writer lock with stale PID/TTL reclamation.
- Target path, title, and Windows name validation live in
  `lib/path-policy.mjs` and `lib/provision.mjs`.
- The generated `release.manifest.json` template uses the `release-harness`
  schema URL and an initial `0.1.0` version.

Verification: `npm test` **33/33**, isolated Playwright E2E **83/83**.
The E2E suite exercises Type A immediate visibility, the Type B-cold restart
finalizer, and Type B-live new-session/immediate-UI behavior on a real DSH.

### Next connector (not implemented)

```json
{
  "mode": "existing",
  "path": "C:\\...\\release-harness",
  "title": "Universal Release Ops Harness",
  "sessionId": "session-7b2cc3e8-ae1c-4ba6-bdb7-66cc0933366e",
  "sessionPolicy": "move"
}
```

- `move`: cold only, same ID, restart.
- `handoff`: live allowed, new ID, no restart.
- `defer`: switch the execution cwd first, then move and restart after the turn
  ends.

## Implementation status

- **P1 Client UI complete** — session hover trash, the three-item `⋯` menu, and
  the Confirmation Gate dialog live in `lib/client.js`.
- **P2 Host complete** — three preview routes (`session/move`,
  `workspace/rename-folder`, `session/fork-to-workspace`) plus
  purge/archive/restore/archived/move/rename-folder/fork routes, journal, and boot
  finalizer in `lib/transaction.mjs`.
- **P3 Manager Panel complete** — `sidebar.panellist` plus the `main` panel as the
  third top-level menu. Inline row rename, include-folder checkbox,
  rename/archive buttons, and the folder-change gate. The footer button was
  removed.
- **M1–M4 promotion Host complete** — Type A path policy/journal/lock,
  Type B-cold provisioning and 2PC, Type B-live handoff. Includes the
  preview/apply/status routes and the boot finalizer. UI and automatic activation
  remain follow-up work.
- **Live E2E passing** — Playwright **83/83 checks** in an isolated DSH instance
  (port 3099), covering the Move/Rename/Fork restart finalizers, Type A,
  Type B-cold, and handoff.

## Overview

A single local plugin that manages sessions and workspaces from the DSH sidebar.

1. **Permanent delete** — removes the log, project cache, and registry mapping of
   an archived cold session.
2. **Workspace archive** — archives member sessions, releases the workspace
   registration, and restores it from the top Workspace manager panel.
3. **Move to Workspace** — rewrites the zstd header `cwd` of a cold session and
   updates the physical path plus registry through 2PC.
4. **Fork to New Workspace** — creates a new project directory and workspace, then
   copies the source session log under a new ID as its first session. It creates no
   live child, so the restart finalizer can attach safely.
5. **Workspace Manager panel** — the third top-level menu. Edit a row name inline
   and press Enter to save. The real directory-name input and Confirmation Gate
   appear only when the folder is included.

## Layout

| Path | Role |
|---|---|
| `lib/index.js` | Host entry. Registers transaction and promotion Exact Fetch routes |
| `lib/transaction.mjs` | 2PC for Move/Archive/Purge/Fork |
| `lib/promotion.mjs` | Promotion mode dispatch, Type A preview/apply/status, boot finalizer |
| `lib/promotion-store.mjs` | Promotion journal, atomic writes, single-writer lock |
| `lib/provision.mjs` | Scratch-target planning, Git init, `release.manifest.json` template |
| `lib/scratch-promotion.mjs` | Type B-cold provisioning, log relocation, rollback/finalizer |
| `lib/handoff.mjs` | Type B-live boundary/seed, agent preset mount, child attach |
| `lib/path-policy.mjs` | Canonical path, `projectsRoot` containment, title/name validation |
| `lib/session-log.mjs` | zstd frame parsing, header rewrite/copy, integrity verification |
| `lib/client.js` | Browser entry. Registers the official slots |
| `cordis.patch.yml` | Profile bundle patch |
| `locale/{en,ko}.json` | Plugin display metadata |
| `market/index.json` | Marketplace index (format 1) template |

## Install

```powershell
# after an npm release
dsh plugin --profile web add @nolit/dsh-sidebar-manager

# local checkout
dsh plugin --profile web add link:<path-to-dsh-sidebar-manager>
```

For marketplace distribution, run `npm publish`, update `versions` in
`market/index.json`, then add the index URL from Plugins → Discover.

## Safety rules

- Move/Fork accepts **cold sessions only**; active or open sessions are rejected.
- Fork copies the source log under a new ID instead of calling
  `sessionController.fork`, avoiding a live child.
- The finalizer always uses **detach → attach**. If attach fails, the session
  remains unaccounted and the journal guarantees a retry.
- Rollback does not restore the whole `workspace.json`. It reverts only the log,
  cache, and directory touched by the transaction, preserving concurrent registry
  changes.
- A title-only change saves immediately without a restart. A real directory change
  is applied after the Confirmation Gate and a restart.
- Every file operation snapshots the original under `~/.dsh/backup/<txid>/`.
- The rewritten header file is written to the new location and passes integrity
  verification before the old path is cleaned up and the registry is updated.
- The confirmation dialog discloses that the agent's future CWD will move to the
  new workspace.

## Confirmation Gate

Before Move, Fork to New Workspace, or a folder-linked Rename, the dialog shows
the following on one screen and keeps the execute button disabled until the
confirmation checkbox is checked:

1. **Impact preview** — affected cold-session count `N`, old path → new path, and
   target workspace title/ID.
2. **CWD warning** — "From now on, commands run and files created by the agent
   will be rooted at `newPath`."
3. **Restart notice** — "Files are relocated now, but the sidebar will not reflect
   the change until the DSH server restarts."
4. **Explicit confirmation** — the execute button stays disabled until
   `[ ] I understand the impact and that a restart is required.` is checked.

Execute-button conditions:

```text
preflight.preview.ok === true
  && confirmCheckbox === true
  && preflight.liveSessionCount === 0
  && (folderRename ? preflight.isDefaultWorkspace === false : true)
```

`preflight.preview` is a **read-only** route that returns
`{ affectedSessionCount, liveSessionCount, oldPath, newPath, targetExists,
   workspaceTitle, isDefaultWorkspace, blockers[] }`.
A non-empty `blockers` disables both the execute button and the checkbox and shows
the reason.

## UI copy (i18n)

Every user-facing string lives in **one `I18N = { ko: {...}, en: {...} }` object at
the top of [lib/client.js](<lib/client.js>)**. Do not hardcode UI text in the rest
of the code.

- The `ko` and `en` key structures must match; edit only that object for copy
  changes.
- The language follows `navigator.language`: `ko*` selects Korean, otherwise
  English.
- Placeholders such as `{count}`, `{oldPath}`, and `{newPath}` are replaced by
  `t(key, vars)`.
- Marketplace titles/descriptions are handled separately by the `meta` object in
  `locale/{en,ko}.json`.
