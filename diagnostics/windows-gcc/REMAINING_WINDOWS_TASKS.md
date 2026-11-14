# Remaining Windows diagnostic tasks

The approved hosted workflow has actually run. See [HOSTED_RESULTS.md](HOSTED_RESULTS.md); do not treat the old pre-execution checklist as pending proof for all lanes.

- Original12.67-second/12.62-second READY-to-CLEAN outlier: not reproduced in the final909 trials, cause unknown, finding open. Do not call it fixed.
- Two direct PowerShell observer errors after compiler exit0: retain both failed samples and all timings. Export only a reviewed structured observer failure kind, native error code and known boundary to investigate; do not ignore membership errors or weaken Job ownership.
- B/C kernel GCC/cc1/linker exit and internal native reader/Job cleanup stages: still independently uninstrumented. A future slow sample needs those boundaries before attributing time to compiler, OS or cleanup.
- Security scanning/filesystem attribution: not measured. Never disable protections to obtain a passing run.
- Full installed-app Windows UI/installer/upgrade tests, low-memory physical hardware and macOS registration crash: outside this diagnostic task; the hosted benchmark is not release approval.
- No release, installer publication, main merge, update-feed change or installed-app modification is authorized by this diagnostic workflow.

Verified scope: actual Windows2022x64, GCC14.2.0, all303 Ion Node and303 Electron engine trials successful;303 direct attempts include2 observer failures. All909 reported owned-process cleanup. Native stage timings, all failures, versions and source/adapter hashes are preserved in the CI artifacts and local report.
