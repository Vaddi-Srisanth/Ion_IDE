# Resource profiles

Choose **Preferences → Resources** to switch profiles. The profile is saved per user. Switching takes effect in the open window and keeps tabs, unsaved text, and the active Monaco editor.

| Behavior | Minimal Mode | Full Mode |
| --- | --- | --- |
| Editing, save and autosave, file explorer, manual C runs | Available | Available |
| Offline Learn, Projects, and Practice | Loaded when their pane is opened | Loaded when their pane is opened |
| Online project planner | Unavailable | Available in Projects. Each request needs confirmation |
| Run approved project tests on save | Unavailable | Explicit opt-in per supported test while Projects is open |
| Editor after the final tab closes | Dispose the editor widget and models | Dispose the models and keep the widget warm until leaving the workbench |
| Closing the last macOS window | Confirm unsaved work, drain the runner, then quit | Keep the app available in the Dock until Quit |

Minimal is the default, including for profiles with no stored selection. Both profiles use the same local files and learning, project, and practice records. Both have on-demand directory reads and no filesystem watchers, project indexers, or AI agents.

Closing a pane removes its renderer subscriptions. It releases the in-memory learning history snapshot, cancels a practice batch, or cancels Projects automation and online planning. Validated on-disk records and unsaved panel drafts survive panel changes. Loaded JavaScript modules remain cached by the current process and can reopen quickly.

## Run on Save

1. Select **Full Mode**, open **Projects**, and review and approve a local C behavior test.
2. Expand that test and choose **Run on Save Off** to enable it. The native confirmation shows the exact test and authorizes future Ion saves of its source during the active Projects session.
3. Save the source normally. A short debounce groups nearby saves. The runner checks the saved revision, approved test, and active pane again before compiling and running.
4. Turn the test off, use Stop, leave the pane, or switch to Minimal to cancel pending work. Leaving the pane or switching to Minimal also clears session opt-ins.

Automatic runs support a conservative subset of self-contained C17 with direct standard angle-bracket includes. Other sources can use manual **Run Test**. External edits do not schedule execution. Source programs run with your OS permissions. The bounded runner constrains time and captured output and terminates normal process groups. Native execution is separate from the renderer sandbox.
