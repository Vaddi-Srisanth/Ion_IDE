# Portable local profiles

Use **Preferences → Local Data → Export Local Profile…** and select a destination folder. Ion publishes a complete `Profile` inside a new dated `Ion IDE Backup …` folder. Each export leaves the active profile and existing backups untouched. The versioned `ion-profile-backup.json` lists the export date and counts. The export works offline and supports up to 64 MiB of profile data and 512 project records. If the app is interrupted during export, a folder without `Profile` is incomplete.

The copy includes preferences and recent locations, custom themes, installed learning packs, the selected learning language, learning history, and saved project specifications, test approvals, and evidence. It excludes the online planner configuration and credentials, source files, unsaved recovery drafts, practice attempts, and browser data. Save recovered drafts and back up workspaces separately. The export can contain local paths and test output. Keep it in a location you control.

## Use an exported profile on macOS

1. Quit Ion. Keep an untouched copy of the backup and copy its `Profile` folder to a writable location on local disk.
2. Launch the matching macOS build with an absolute profile path. Adjust both paths for your installation.

```sh
ion_profile="$HOME/Documents/Ion Portable/Profile"
"/Applications/Ion IDE.app/Contents/MacOS/Ion IDE" "--user-data-dir=$ion_profile"
```

The app uses the chosen directory for its data and the Chromium session. Changes made in this session stay in that working copy. You can also start with an empty writable folder to make a separate profile. Quit and open Ion from Finder to return to the standard profile in `~/Library/Application Support/Ion IDE/`. [Electron app data paths](https://www.electronjs.org/docs/latest/api/app/)

Project metadata is keyed to the canonical workspace path. A project reopens with its metadata when the same folder is available at the same path. Reopen and retest projects after copying their files because test evidence depends on the source file revision. Workspaces at a different path currently start with separate project metadata. You can recover the original specification from the exported project record and paste it into the Projects specification editor for the relocated folder.

Use a single writer for each profile. For a removable drive, copy the profile to local disk before launching and copy the closed profile back when finished. A live profile can accumulate caches and recovery drafts. To make a smaller shareable copy, use **Export Local Profile…** again. Reconfigure the online provider on the target Mac if needed. The compatible Ion app and any local language toolchains are installed separately for that machine.
