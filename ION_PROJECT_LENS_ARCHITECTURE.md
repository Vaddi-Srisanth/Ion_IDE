# Project Lens — planned architecture, not implemented

Milestone D has not begun. No Analyze button, project snapshot, source citation or project-aware answer is advertised as working. Validate the representative UI and learning migration on native platforms before broadening product state and IPC.

The intended implementation is one lazy panel and one request-owned main-process service. Reuse `WorkspaceFiles` grants/read validation, existing ripgrep retrieval, language capabilities, navigation and the Projects model. Require the exact current authorized workspace root; an individual granted file or subfolder is not permission for a project-wide scan.

An explicit Analyze action captures root/generation/request identity, reads bounded metadata and selected source, and returns relative paths, revisions, evidence ranges, exclusions and truncation. Proposed initial budgets must be enforced/tested before acceptance, not merely documented. Cancel on superseding request, close, workspace change and window shutdown. No watcher, vector database, permanent index, new renderer or project execution is required.

Symbols from an already enabled language service can supplement evidence; do not silently launch every server or execute build scripts to discover a project. Offline facts must remain useful without AI. Expected follow-up: manifest/framework fixtures for C/C++, Java, Python, JS/TS/React and mixed repositories, plus authorization/cancellation/secret-exclusion tests.
