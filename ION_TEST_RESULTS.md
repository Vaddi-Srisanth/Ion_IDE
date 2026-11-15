# Verification — local feature checkpoint

| Check | Actual result | Limit |
| --- | --- | --- |
| TypeScript | PASS | Compile-time, not native interaction |
| Production build | PASS | Production bundles, not installer or OS execution |
| Full local unit suite | 283 total; 257 pass; 26 skip; 0 fail | Windows-specific checks and flag-gated cases not called passing |
| Theme/shortcuts | 6pass | Theme contrast guard retained; initial light-hover failure fixed |
| Direct-selection migration | 7pass; combined pack suite15pass | Real disposable files/Practice records; native Windows execution pending |
| Baseline renderer | Four size/theme scenarios PASS | Initial strict bridge fixture failure preserved locally |
| Milestone A renderer | Four size/theme scenarios PASS | Native macOS/Windows not represented by Chrome |
| Fresh Learn/content settings | Four size/theme scenarios PASS | Actual React/Monaco with explicit test transport; backend disk tests separate |
| Retina renderer | Four 2× size/theme cases PASS | Browser2× is not native macOS/Windows scaling certification |
| Desktop regression scripts | Updated and syntax checked | Not executed locally: Electron registration constraint |
| Native feature CI | Configured, not run | No feature upload authorized |
| Live AI / Project Lens | Not implemented or tested | No source transmission or keys used |

Renderer journeys exercise actual unsaved editing, single Undo, stable editor-widget identity, keyboard focus, draft protection, direct selection, import preview/confirm/discard, confirmed removal, export and late-preview cleanup. External browser requests are blocked. These are not mocked native filesystem/terminal/recovery pass claims.

Native caller scripts were updated for the deliberate removal of Marketplace, retaining path/import/tamper/data-integrity assertions. Historical Marketplace benchmark names remain aliases for explicitly versioned direct-learning/content-settings workloads; their changed measurements must not be mixed with old Marketplace results. Existing Windows benchmark setup failure and rare GCC latency remain open historical issues.
