# Phase 3 — Git and GitHub

Development branch `codex/ion-phase-6-copilot`. The public 0.9.9 installer contains the accepted Phase 2.5 application.

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

## Reviewed in-app pull-request creation — 27 November 2026

Ion can now create a pull request for a repository loaded from the signed-in GitHub account. The user enters an existing head branch (optionally `owner:branch` for a fork), base branch, title, description and draft choice. Ion shows a review summary, then a native cancel-by-default confirmation before submitting the request through the officially installed `gh api` CLI to GitHub's REST create-pull-request endpoint. The remote head branch must already exist; this action never pushes commits or changes local files. Credentials remain in the GitHub CLI's OS credential flow and are never sent to the renderer. A successful response is checked against the requested repository, title, branches and draft state before its pull-request link becomes available.

The POST uses an isolated temporary `GH_CONFIG_DIR`, fixed `github.com` host and bounded request/response. PR fields are sent on stdin rather than command arguments. On an ambiguous network/timeout result Ion tells the user to reload the PR list before retrying, preventing blind duplicate submissions. GitHub documents that this endpoint can trigger notifications and return validation/rate-limit errors; the explicit native confirmation presents the target and warns that participants may be notified. [Create a pull request](https://docs.github.com/en/rest/pulls/pulls#create-a-pull-request) · [GitHub CLI `gh api`](https://cli.github.com/manual/gh_api).

Targeted macOS verification passed type checking, production build, **9 focused GitHub tests** (one live-keyring test skipped), and the headless Git browser journey including review-before-submit and created-link navigation. The suite verified stdin payloads, token-free renderer results, request validation, fixed host/method, response validation, no retry on uncertain outcomes and private scratch cleanup. No real GitHub PR was created. This increment has not had a native Windows run.

Phase 3 remains open: pull/push, authenticated Git remote transfer, different-tree branch switching/merge, stash writes/pop, restore/discard, and a three-way merge-resolution workflow still need independent safety designs and checks. Private cloning and in-app sign-in/sign-out administration also remain open. No public release, update-feed change, installed-app change or push of this development branch is claimed.

## Authenticated GitHub clone — 27 November 2026

Local implementation checkpoint: `8b335fe` on `codex/ion-phase-6-copilot` (not pushed).

The GitHub panel adds **Clone with GitHub account…** after a repository has been loaded through the signed-in GitHub CLI. The main process rechecks that the same repository remains loaded before and after the native destination picker. The installed `gh repo clone` command performs the shallow HTTPS clone; its credential handling stays within the CLI/Git subprocesses. Ion passes no token through renderer IPC or environment variables. The checkout is staged outside all workspaces and is published to the selected parent with the existing no-replace native move.

Clone requests are one branch at depth 1, without tags, submodules or an upstream remote. Git system/global configuration is isolated, prompts and hooks are disabled, and only HTTPS transport is allowed. The incoming Git pack is monitored and the operation is canceled above 256 MiB. Before publication Ion verifies the requested credential-free GitHub origin URL and rejects stored credential helpers or authorization headers. Closing the GitHub panel cancels the operation and waits for the Git subprocess tree to drain before removing verified staging.

On macOS ARM64, type checking and the production build passed. The focused clone suite passed **10 tests** with one opt-in anonymous live-clone test skipped; it covers scrubbed inherited credentials, worktree tool rejection, destination races, credential-free remote validation, diagnostic redaction, cancellation, cleanup and the pack limit. The GitHub API suite passed **9 tests** with one live-keyring test skipped. The headless renderer verified that authenticated cloning is hidden until the repository is loaded and that the two clone modes remain explicit. The production Electron Source Control journey verified rejection of authenticated cloning before a repository is loaded and cancellation of the public-clone picker.

No live private repository was cloned. Authenticated access to an actual private repository and the native Windows x64 journey remain unverified. This is an implementation checkpoint, not Phase 3 completion. Pull/push, authenticated remote transfer, different-tree switching/merge, stash writes/pop, restore/discard, three-way conflict resolution and GitHub account administration remain open. No release, update-feed, installed-app or public branch change was made.

## Reviewed GitHub issue details — 27 November 2026

Selecting an issue from the currently loaded open-issue list now reads its details through the officially installed GitHub CLI. The main process requires the exact repository/issue URL from that list both before and after the request. The response must identify the requested issue, match its GitHub URL and not be a pull request. Title and body are treated as untrusted text; common credentials are redacted, body text is capped at 8 KiB, and React renders it inertly. The view shows open/closed state and author, supports opening the reviewed issue in the browser, and returns keyboard focus to its list entry when hidden. The feature is read-only and starts no request until the user selects an issue.

Targeted macOS verification passed type checking, production build, the offline GitHub API fixture suite (**11 passed, 1 live-keyring test skipped**) and the offline headless Source Control journey. Fixtures cover credential redaction, wrong-repository and pull-request responses, oversized bodies, invalid authors, request identity checks, description truncation and private scratch cleanup. The renderer check covers inert text and focus return. No live GitHub issue request or native Windows run was made.

## Reviewed stash snapshots — 27 November 2026

Source Control → Browse Repository → Latest stash can save a reviewed snapshot of tracked staged and working changes. Ion asks through a native cancel-by-default confirmation, verifies the repository status and branch again, and creates a Git stash object without clearing or replacing the current index or working files. Existing stash history is retained. Untracked files are excluded and called out in the interface and confirmation. The operation stays offline. It blocks detached/unborn heads, incomplete status and unresolved conflicts; applying or popping a stash is not included in this increment.

Targeted macOS verification passed six real-Git comparison and stash tests. The snapshot test covers cancellation, preservation of staged diff and working/untracked file contents, retention of an earlier stash, and confirmation that untracked data is not stored. The offline Git browser journey, typecheck and production build passed. An initial run exposed that Git writes the stash reflog in addition to the stash ref; the isolated configuration now exposes only a verified repository reflog directory for this operation. No Windows run was made.

## Authenticated GitHub fetch — 27 November 2026

Cached remote branch review now offers both anonymous HTTPS fetch and **Fetch with GitHub account**. Authenticated fetch stays dormant until the user selects that action and approves the native cancel-by-default dialog. Only after approval does Ion retrieve a bounded credential through the installed official GitHub CLI and its existing OS keyring configuration. The credential is kept in the main process, converted to an HTTP Basic header for the isolated Git subprocess environment, and never placed in argv, renderer IPC, repository config or files. The authenticated request is still restricted to the reviewed HTTPS GitHub repository and branch.

Both modes reuse the isolated staging repository, HTTPS-only transport, bounded shallow fetch, 256 MiB cancellation, object integrity checks, fast-forward-only ref publication, no-replace pack moves and cached-ref compare-and-swap. Neither mode checks out files or changes the active branch, index or worktree.

Targeted macOS verification passed **5/5 focused fetch tests**, type checking, production build and the headless Git browser journey. The new real-Git fixture verifies credential retrieval happens only after approval, decodes the isolated Git config header to the test-only credential, confirms the credential is absent from command arguments, and verifies the cached ref advances while the index and dirty working file stay unchanged. Existing force-push rejection, ref race and oversized-pack cancellation remain passing. This used a local bare repository and fake credential; private GitHub transfer and native Windows verification remain open. Pull and push are not implemented.

## GitHub keyring access for isolated API requests — 27 November 2026

Reviewing the authenticated GitHub path found that its isolated `GH_CONFIG_DIR` contained no user account configuration. Although the official `gh api` calls were isolated from user aliases, endpoints, and other CLI configuration, they could not reliably access the user's existing system-keyring sign-in. Ion now asks the installed GitHub CLI for a short-lived `gh auth token --hostname github.com` using its normal user configuration, validates the bounded result, then passes the credential only to the isolated main-process `gh api` subprocess. The renderer receives only the already-redacted account or repository result. The isolated request still fixes the host, API method and endpoint; user CLI aliases and config do not affect it. Authentication failure returns a fixed sign-in instruction without echoing CLI output.

Targeted verification on macOS ARM64 passed all **12 offline GitHub API tests**, type checking, production build and the headless Git browser journey. Tests verify that token retrieval sees the normal CLI configuration but not inherited token/debug/proxy variables, invalid credentials stop before an API request, API calls use only the temporary configuration plus the main-process token, and the token is not returned in renderer data. Tool identity is revalidated before credential retrieval. A subsequent opt-in smoke test used the existing `gh` keyring login for a read-only overview of `Vaddi-Srisanth/Ion_IDE`; **13/13 tests passed with zero skips**, including the live account, PR and issue read. No remote write was made. Native Windows authentication remains unverified.
