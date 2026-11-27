# Phase 3 — Git and GitHub

Development branch `codex/ion-phase-3-source-control`. The public 0.9.9 installer contains the accepted Phase 2.5 application.

## First checkpoint

| Action in Source Control | Behavior |
| --- | --- |
| Browse repository | Explicitly loads recent HEAD history, local branches, tags and remote names. Each result is bounded. Remote identities expose only recognized GitHub owner/repository pairs. |
| Compare branch or latest stash | Uses pinned commit IDs and rechecks references after reading. Branches can be ahead, behind or diverged. Stash compares against its own base and flags separately stored untracked content. |
| Create lightweight tag | Creates a new local tag at the reviewed commit and rejects an existing tag. |
| New branch | Creates a new local ref at the reviewed commit. The expected old ref must be absent. Ion also checks registered working copies for a matching unborn branch before creating a ref. Staged files, working files, current branch and unsaved buffers are preserved. |
| Line history | Reads the committed version of a tracked text file on request. Shows authors and commit subjects for bounded line ranges at the displayed HEAD commit. |
| Review conflict | Shows the common ancestor, ours or theirs from the index, distinguishing a missing side from an empty file. The user edits and stages the resolution. |
| Load from GitHub | Uses the officially installed GitHub CLI and system-keyring sign-in; reads the account, open pull requests and open issues on demand. Only reviewed GitHub links can open. A pull request can be prepared and submitted in the user's browser. |
| Clone public repository | Enter the public repository name and choose the parent in a native folder picker. Anonymous cloning is independent of the GitHub CLI sign-in used for private account data. Git makes a shallow, single-branch anonymous HTTPS checkout. A native no-replace move publishes it into a fresh named folder on the same volume as temporary storage. The user opens it explicitly. |

Git operations require the repository's existing trust review. Local browsing has no network side effects. GitHub's executable path, host, environment, subprocesses and output are bounded independently from local Git. The production build places local Git, hosted GitHub reads and clone code in on-demand main-process modules.

## Evidence and limits

All 41 focused backend tests passed locally on macOS ARM64 with zero skips, including both opt-in network reads. An earlier fixture exposed a system SSH-to-HTTPS rewrite on the host. The corrected projection checks whether the rewritten address still identifies the same GitHub repository and refuses ambiguous or credential-bearing targets.

The focused suites exercise real commits, failed branch collisions, annotated tags, linked worktrees, merge conflicts, index and working-file preservation, cancellation, child cleanup, credentials in Git configuration and destination replacement. The local authenticated smoke read the Ion repository. An anonymous smoke cloned the public octocat/Hello-World fixture. Hosted CI exercises public cloning and a disposable production Electron journey; it does not have access to the developer's keyring.

The macOS headless Chromium test exercises stale responses, narrow controls, reviewed links and cancelled clone. It verifies no repository reads until the user requests them. An earlier intermediate production build also passed the local disposable Electron Git journey before the final hosted checks. Hosted validation covers the final candidate.

At the cached-branch checkpoint, Phase 3 remained open. Merging different trees, stash writes, discarding edits and transferring changes to an existing remote need independent data-safety checks. A normal Git checkout must not run inside Ion's current frozen status view: the view copies HEAD but references the live worktree. The existing index transaction alone cannot recover multiple working files after interruption. Private clone/system account administration and PR creation within Ion are outside that checkpoint. No throughput or memory improvement was claimed.

Native checkpoint `335996b`: macOS completed the production desktop journey. Windows passed 40 backend checks with one opt-in keyring test skipped, then the desktop fixture read an empty Monaco diff container before its lines had been observed. The follow-up waits for both original and modified saved lines under the existing eight-second deadline. [First native run](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45932089318).


The branch and stash comparison checkpoint `84a04a11b0d50a584a827d9b8f0ab0c30753dd38` passed on macOS ARM64 and Windows x64. Each host passed 43 focused backend cases and its production Electron journey. The single skipped case on each host requires a user keyring sign-in. Both hosts completed the anonymous public clone. [Comparison and tags verification](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45932532117).

New-branch creation checks linked, locked and unborn worktrees. An incomplete registry blocks creation. Git can still register a new worktree between the registry read and ref publication. A combined create-and-switch operation remains withheld because Git's ref transaction does not lock that registration step.

## Native line-history and public-clone checkpoint

Candidate `b7d5eb75289b817c9036fad91ef181924733bb5b` passed 48 of 49 focused backend checks on each hosted platform. The remaining case requires a personal GitHub CLI keyring, which passed locally together with the other 48 cases. Both native jobs cloned a public fixture. Their disposable offline Electron journeys verified the signed-out destination picker and cancellation, attribution for a clean file, changed line coordinates, and editing and Undo after a diff. Closing a pending line-history view cancels its read. The headless renderer also verified stale replies, paging and file/root changes. [macOS ARM64 and Windows x64 verification](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45933464062).

## Compare cached remote branches

Source Control → Browse Repository → Cached remote branches compares HEAD with a previously recorded remote-tracking commit. It labels the result as offline and keeps the cached commit visible during review. The Git service checks both reviewed commit IDs and the exact ref again after reading, omits symbolic and redirected refs, and preserves staged and working files.

On macOS ARM64, 38 focused Git tests passed, along with the headless renderer check and the offline production Electron journey. The focused fixtures cover packed refs, stale and symbolic selections, and preservation of staged and dirty bytes. The cached-branch increment still needs a native Windows run. Fetch, pull, push and changes to working-tree branches remain open.

## Same-tree switching, public fetch, and pull-request details — 27 November 2026

Local implementation checkpoint: `fefb4a2` on `codex/ion-phase-6-copilot` (not pushed).

Repository Browser now offers a reviewed local branch switch only when the current and target commits have identical file trees. The main process requires the primary checkout with no linked worktrees or in-progress merge/rebase operation. It atomically updates symbolic `HEAD` with commit-ID preconditions; it never checks files out. Tests verify staged index bytes, unstaged content and untracked files stay unchanged. A branch with a different tree remains unavailable for switching.

Cached remote branches now offer **Review fetch** for a recognized public GitHub remote. The native confirmation is cancel-by-default. Only after approval does Ion recheck the configured remote identity and exact cached ref, then fetch one branch over isolated anonymous HTTPS into a private bare staging repository outside the workspace. Git credential helpers, global/system configuration, SSH, proxies and terminal prompts are excluded. The fetch is shallow to 256 commits and enables Git object checks. Ion monitors incoming staging files, cancels once their combined size exceeds 256 MiB, and checks the size again before publication. It also rejects a non-fast-forward result, a changed cached ref, or a changed remote. Verified pack files are published with no-replace moves and the remote-tracking ref is updated with its previous OID as a compare-and-swap precondition. The user index and worktree are never changed. This is a public fetch of one selected branch; pull and push are still unavailable.

GitHub's on-demand pull-request details view now reads one explicitly selected PR through the installed official `gh` CLI. Returned body text is bounded, common credential-like strings and control characters are redacted, and repository text is rendered inertly. The PR link still requires an explicit user click. The existing browser-based PR creation path remains separate; Ion does not create, push or merge a PR in this checkpoint.

Targeted verification on macOS ARM64 with Git 2.56.0 passed `npm run typecheck`, `npm run build`, 14 focused backend cases, two renderer browser cases and the production Electron Source Control journey. One backend case that requires the developer's authenticated GitHub keyring was skipped. The desktop fetch journey canceled at the native confirmation, and the test observed no network requests; unit fixtures used a test-only local bare repository to exercise real Git fetch, pack validation, publication and fast-forward/ref-race handling. An oversized sparse incoming pack fixture verified cancellation and no publication beyond the 256 MiB threshold. Staged, unstaged and untracked data preservation passed. This increment has not had a native Windows run.

An initial desktop attempt failed to observe the fetch confirmation while the pre-confirmation path rebuilt the whole repository browser. The flow now presents the reviewed choice first and performs the exact remote/ref validation after approval, before any network transfer. The production Electron journey then passed without changing its existing eight-second deadline. The slow path does not grant permission to fetch: stale metadata is rejected after confirmation and before any transfer.

Phase 3 remains in progress. Different-tree checkout and merge, an apply-and-resolve workflow, stash writes/pop, restore/discard, pull, push and authenticated remote writes remain open. Private repository cloning and in-app PR creation are also open. No Windows result, public release, update-feed change or installed-app change is claimed.
