# Phase 3 — Git and GitHub

Development branch `codex/ion-phase-3-source-control`. The public 0.9.9 installer contains the accepted Phase 2.5 application.

## First checkpoint

| Action in Source Control | Behavior |
| --- | --- |
| Browse repository | Explicitly loads recent HEAD history, local branches, tags and remote names. Each result is bounded. Remote identities expose only recognized GitHub owner/repository pairs. |
| New branch | Creates a new local ref at the reviewed commit. The expected old ref must be absent. Staged files, working files, current branch and unsaved buffers are preserved. |
| Review conflict | Shows the common ancestor, ours or theirs from the index, distinguishing a missing side from an empty file. The user edits and stages the resolution. |
| Load from GitHub | Uses the officially installed GitHub CLI and system-keyring sign-in; reads the account, open pull requests and open issues on demand. Only reviewed GitHub links can open. A pull request can be prepared and submitted in the user's browser. |
| Clone public repository | A native folder picker selects the parent. Git makes a shallow, single-branch anonymous HTTPS checkout. A native no-replace move publishes it into a fresh named folder on the same volume as temporary storage. The user opens it explicitly. |

Git operations require the repository's existing trust review. Local browsing has no network side effects. GitHub's executable path, host, environment, subprocesses and output are bounded independently from local Git. The production build places local Git, hosted GitHub reads and clone code in on-demand main-process modules.

## Evidence and limits

All 41 focused backend tests passed locally on macOS ARM64 with zero skips, including both opt-in network reads. An earlier fixture exposed a system SSH-to-HTTPS rewrite on the host. The corrected projection checks whether the rewritten address still identifies the same GitHub repository and refuses ambiguous or credential-bearing targets.

The focused suites exercise real commits., failed branch collisions, annotated tags, linked worktrees, merge conflicts, index and working-file preservation, cancellation, child cleanup, credentials in Git configuration and destination replacement. The local authenticated smoke read the Ion repository. An anonymous smoke cloned the public octocat/Hello-World fixture. Hosted CI exercises public cloning and a disposable production Electron journey; it does not have access to the developer's keyring.

The macOS headless Chromium test exercises stale responses, narrow controls, reviewed links and cancelled clone. It verifies no repository reads until the user requests them. An earlier intermediate production build also passed the local disposable Electron Git journey before the final permission precaution was reiterated. Hosted validation covers the final candidate.

Phase 3 remains open. Switching branches, merging different trees, stash writes, discarding edits and transferring changes to an existing remote need independent data-safety checks. A normal Git checkout must not run inside Ion's current frozen status view: the view copies HEAD but references the live worktree. The existing index transaction alone cannot recover multiple working files after interruption. Private clone/system account administration and PR creation within Ion are outside this first checkpoint. No throughput or memory improvement is claimed.
