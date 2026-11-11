# Ion IDE architecture

Ion IDE is a macOS-first, offline desktop editor. Electron provides native windows and dialogs and a Node process for filesystem and toolchain work. React, Vite, and Monaco supply the interface. Versioned local JSON under Electron's user-data directory stores preferences, learning history, project specifications and evidence, and practice metadata. Individual learning concepts and practice source files are separate resources. The current bounded record sizes and access patterns do not require a database service.

## Boundaries

- **Renderer** owns workbench layout, tab and buffer state, and Monaco. Opening the first document loads Monaco on demand. One editor displays the active document and retains up to three recent text models. It detaches closed models. Minimal Mode disposes the widget after the last tab closes. Full Mode can keep an empty widget warm until leaving the workbench. The tab store keeps unsaved text when a model is evicted. The explorer lists directories as they are expanded.
- **Preload** exposes typed file, settings, recovery, lifecycle, and Run Console operations. The main process validates requests against the active workbench frame.
- **Main process** owns native dialogs, filesystem authorization, stale-file checks, persistence, and the controlled process runner. The renderer loads local bundled resources through a restricted application protocol. A C run compiles the selected saved file using an installed toolchain, then runs a temporary binary.
- **Shared contracts** describe the data crossing the desktop boundary. The renderer consumes these contracts without knowing how a compiler was located or how preferences were stored.

### File integrity and recovery

`WorkspaceFiles` serializes mutations and compares the opened file revision before replacing a saved file with a synced temporary file. `Documents` owns dirty flags, edit versions, autosave, and the three-model cache seam. A dirty buffer checkpoints on a bounded interval, with one write in flight per draft. Main keeps the private atomic recovery files in the profile and reads only their headers to offer recovery at startup. Restored tabs lazily load their text as untitled drafts, with the original path available as a display hint. They inherit no filesystem grant. Saving or discarding clears the corresponding checkpoint. A renderer crash drains the failed window's owned processes and preview resources before a replacement window offers recovery.

Session metadata stores authorized paths, ordered tabs, the active tab, and compact editor selections and scroll positions in a separate bounded file. Resume validates each file again and resolves dirty tabs through the recovery journal. Monaco keeps three live source models and uses a bounded, session-only cache of detached edit deltas keyed by tab identity. It checks that reopened content matches before reusing that history. The persisted metadata contains no edit deltas or file contents.

Large text previews read bounded, revision-checked byte ranges through `WorkspaceFiles`. The decoder handles UTF-8 characters that cross a page boundary. The preview keeps one page in the renderer and exposes no editing or run action. Explicit Save As and recovery can preserve an already-edited buffer that outgrows the normal edit limit.

### Appearance

Each theme has a separate versioned palette file. Main validates imports and uses a metadata-only registry to enumerate custom themes. The workbench reads the selected palette and applies its semantic CSS variables to all panes. The theme picker opens the catalog on demand and uses three swatch values per theme where metadata is available. A preview loads the selected palette, and closing or canceling the picker discards it. Apply persists the preference and an eight-theme recent list. Favorites are local theme IDs. Monaco updates a single named theme slot, preserving the existing editor and its text models. System appearance uses a media-query change listener only while Automatic is selected.

### Commands and local data

The native menu, keyboard dispatcher, and command palette share command identifiers and validated preference overrides. Quick Open enumerates an explicitly authorized workspace on demand and cancels obsolete requests. The keyboard split controls operate the existing source/document layout.

Search in Files starts one bundled ripgrep process in the current granted root. Main consumes its output incrementally, validates result paths, and bounds elapsed time, output, and result count. Cancellation kills the child. The optional search UI loads on demand and no index persists between queries.

Profile export is an explicit, lazy main-process operation. It copies only allowed stores into a fresh private profile directory at the selected destination. The export uses the app's existing data formats and can be opened through Electron's user-data directory option.

### Document previews

Supported document extensions use the same tab store as code and bypass Monaco's text model and save paths. The workbench keeps a single visible preview session. It can pin that session beside the active source tab without restarting the viewer. Hidden document tabs keep metadata. Closing or replacing the visible preview aborts preparation and releases its handles.

In a document-only view, Monaco detaches its displayed source model and preserves its selection, folds and scroll position in the bounded model cache. Switching back or entering split view reattaches the model with its undo history. The editor lets Chromium choose compositor layers for lines and gutter while retaining hardware acceleration.

Main verifies document access through the existing workspace grants and gives the renderer an opaque preview ID. PDF.js uses a local range transport and starts a parser worker only when needed. The PDF layout reserves scroll space for the whole file and rasterizes the pages that intersect the viewport. A bounded Node worker handles CSV and OOXML from a private snapshot. The renderer receives paged table or Word data and loads Word raster images only for the current section. PowerPoint preflight validates the archive before a time-limited, network-denied LibreOffice conversion. The resulting PDF lives only for the preview session.

### Interactive execution

The desktop run service is loaded on the first Run request. Language plans resolve trusted local executables, working directories, compile steps, and launch arguments. Main scopes the source to the workspace, handles approval, and gives each run an ID for streamed output, input, resize, and cancellation. Compilation reuses the bounded process executor. A signed native helper allocates a PTY for the program and translates input and resize frames. The renderer lazy-loads xterm when the console opens and keeps bounded replay data for collapse and reopen. Practice and Projects retain the existing pipe-based runner for repeatable stdin and separate stdout/stderr. Browser preview uses a separate network-denied Electron session and a workspace-limited asset protocol.

The general-purpose Terminal loads its window-owned service only on the first explicit request. Main resolves the shell and workspace directory, and the same native helper opens a separate PTY for each interactive shell. The renderer acknowledges output as xterm parses it, allowing the helper to apply backpressure without retaining an unbounded transcript. Bounded session buffers keep parsing while the panel is hidden. Closing a session terminates its native job groups and disposes its renderer. Window teardown drains the sessions independently of the code runner.

### Local language adapters

A shared capability catalog describes file extensions, Monaco grammars, Run Console coverage, formatters, semantic providers, and offline learning packs. The catalog stores metadata. It does not start a tool or read lesson bodies. Formatters and execution plans retain their own adapters. Debugger and test adapters can use the same language IDs as they are added.

The main process owns a single scoped semantic session. Both Java and clangd use the same validated buffer snapshot, revision check, source-location response, and editor navigation path. clangd starts on a definition or references request from a saved C/C++ tab when enabled. It uses the local toolchain with background indexing and workspace clangd configuration disabled, and does not invoke compiler drivers to extract settings. The adapter opens one translation unit and caps queued requests and results. Back/Forward retains up to 64 locations in each direction for the active workspace.

The editor registers Java providers only while a Java model is active. Basic mode uses local keyword and snippet data. Smart Java uses a language-tagged request with an authorized path, buffer revision, and cursor offset. Main lazy-loads a single JDK compiler API worker for the current workspace or standalone file. The worker uses the live buffer, standard library, and scoped local source roots. It disables annotation processing and never generates class files from the user's source. The editor rejects responses for an obsolete revision and keeps live diagnostics separate from Run Console results.

Each request has an eight-second deadline and a 256 KiB buffer limit. The service keeps at most one running request, one pending diagnostic, and one pending interactive request. Closing the last Java tab, disabling Smart Java, or closing the window stops the worker. Switching away gives it a short grace period to support quick tab switches. Language tooling is independent of lesson packs and Run.

### Document formatting

The Format status control and command share the active Monaco model. The renderer snapshots its text and revision only on request and cancels on an edit, tab change, or Escape. Main validates the file grant and saved revision before and after running a language-specific formatter. The formatter adapter loads lazily and uses the existing process runner with structured arguments, stdin, a ten-second deadline, bounded stdout/stderr, and a private temporary directory. External tools resolve outside the workspace. Prettier receives a temporary data-only configuration with built-in parsers.

The renderer checks the model and revision again before applying one undoable edit. Monaco keeps its existing model, encoding metadata, selection, and scroll position. The active tab briefly holds its autosave timer while the request is pending and resumes its existing save policy afterward.

## Desktop foundation

File mutations use the bounded `ion-file-ops` helper, loaded as a short-lived process only for a write, rename or Trash operation. It receives path components and validated directory identities from [WorkspaceFiles](src/main/files.ts). On macOS it opens the parent directory and uses relative operations with exclusive names or atomic exchange. On Windows it pins the directory chain, rejects reparse points, and moves retained and replacement entries without clobbering. Normal saves remove the previous copy only after the parent and displaced revision have been checked. Contested copies remain beside the source. Source staging uses bounded stdin with the same editing limit and is synchronized before publication. Window teardown waits for an in-flight file mutation to settle. [Native bridge](src/main/file-mutations.ts) · [Race tests](test/file-mutation-races.test.ts)

1. Establish the desktop shell, build, IPC boundaries, and native lifecycle.
2. Connect the welcome screen, explorer, editor, tabs, save and autosave, and persistent appearance controls.
3. Connect C toolchain detection, compile and run, cancellation, and output with explicit local execution consent.
4. Exercise core workflows on macOS, compare production startup and interaction profiles, and package the app.

### First launch

Main checks whether the profile has an Ion preferences file. For a new profile, it records first launch through the existing atomic preference write queue and passes a single boolean through the isolated preload. An incoming system file request takes precedence over onboarding. The renderer reuses its Welcome and workspace commands, and imports the cinematic scene only while onboarding or an explicit replay is visible and motion is allowed. The scene owns one bounded canvas and releases its drawing loop, listeners, and backing buffer when dismissed.

## Optional workspace services

Source Control opens a short-lived service for the active repository root. The preload binds every operation to that root, and the main process revalidates it against the workspace grant. Git commands use structured arguments, bounded output, and no permanent child. The renderer keeps status only while the panel is open. The read-only diff creates two bounded Monaco models on demand and disposes both when closed. It leaves the source editor mounted.

Saved Run Tests uses the Projects store and its existing approval records. A language adapter maps validated test cases onto the shared runner. The C adapter groups compatible cases for one compile and records stdout, stderr, exit status, timing, and a compiler location when it identifies the selected source. A suite owns one abort signal and one workspace scope. The source and project revisions are checked before execution, and completed evidence is saved together. The Run Console and Practice observe the same execution guard.

- **Learning** exposes a lazy catalog of declarative language packs. Installing a pack copies validated lesson data into the profile. A separate selection enables the language in Learn. The renderer requests topic metadata and individual lessons. Learning Lens links high-confidence C diagnostics to Problems and the editor while Learn is open and the C pack is selected. The runner passes bounded diagnostics and the checked source revision. The editor drops markers on the first unsaved change. History uses existing local storage and records C resolutions only when the compiler completed successfully.
- **Projects** validates versioned specifications independently of the provider. Scoped declarative tests are reviewed and approved before using the shared C runner. Only an explicit online planning action reaches the provider. Credentials stay in main-process OS-backed encrypted storage.
- **Practice** lazy-loads an offline catalog with filtering by topic and difficulty. Starting a challenge creates or resumes a local problem and the selected language’s solution file. The store preserves manual problems, independent attempts, and bounded result previews. The runner takes an approved source snapshot and checks console output for C, C++, Java, Python, or JavaScript.
- Renderer panels and main-process services load on demand. An explicit panel lifecycle releases history caches and cancels optional work. Full Mode can schedule reviewed project checks from eligible saves. Minimal Mode drains the process tree and quits after the last window closes.

## Roadmap

See [ROADMAP.md](ROADMAP.md) for release scope and [PROJECT_AUDIT.md](PROJECT_AUDIT.md) for current implementation evidence. [RESOURCE_PROFILES.md](RESOURCE_PROFILES.md) and [ARCHITECTURE_PERFORMANCE_AUDIT.md](ARCHITECTURE_PERFORMANCE_AUDIT.md) cover lifecycle policy and measured alternatives.
