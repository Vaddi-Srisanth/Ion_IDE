# Learning redesign — implemented and pending

## Implemented in Milestone B

Learn lists compact built-in language/topic summaries immediately. Choosing one materializes only that collection locally through the existing validated store. No language is selected automatically. Installed/imported content wins over the bundled version; this does not silently upgrade a user's lessons. Existing Topics-first browsing, runnable examples, exercise handoff, actual sample results and local diagnostic history remain.

Practice Lab is accessible from Learn and Welcome, using the same Practice store, attempts, notes and manual/sample-result semantics. Imported content is managed through Preferences → Learning Content: reviewed JSON import, explicit update, export, and confirmed removal. The old shortcut identifier still routes to this settings section, preserving custom bindings.

## Not completed

The catalog is reference/introductory material, not a newly reviewed complete Python/Java/C academy. Milestone C adds the introductory practical slice described below; complete multi-lesson course progression and independently verified follow-ups remain unfinished. No new mastery score or automatic completion is implemented. Optional reviewed-context AI Tutor is implemented separately in E; live-provider usefulness remains unverified. Existing sample passes establish those samples only.

## Human learning check

No human study ran. For a future small pilot, ask a beginner to choose Python without help, explain an unfamiliar task in their own words, write/run an attempt, inspect a real error, use one hint, correct it, and solve a parallel task independently. Record confusion, navigation cost and hint usefulness with consent. Do not present completion rate as measured learning transfer or claim superior outcomes without that evidence.


## Implemented practical slice C

Python/Java/C each have one enriched `flow` lesson: reviewed objective/prerequisites, unchanged correct example/task/acceptance and samples, incomplete editable starter, three graduated hints, pitfalls and explicitly unverified follow-up. Open exercise retains the lesson beside the original editor. Run samples saves through the existing policy and uses the existing approved local runner; shared expected/actual results are visible beside code. No automatic solution generation or remote call. Other languages and reference topics remain available with their existing behavior.

Activity is an optional bounded 256-entry local LRU map inside existing learning.json. Lesson-open and hint counts are exploration, not completion. Actual Practice reports provide saved-source/sample freshness and passed/failed/unavailable/skipped counts; manual completion remains separate. Hiding the owning panel or leaving a running lesson cancels only its pending sample run. No polling, second progress store or compiler background service.

This is three practical lessons, not three completed courses. Follow-ups are unverified exercises, not automatic competence awards. Wider curriculum and independently checked questions remain future work. E integrates optional reviewed-context Tutor/Lens prose; this does not replace local lesson feedback or test evidence.


## Small learner pilot protocol — prepared, not executed

Use an isolated profile and a beginner's informed consent; do not collect source, audio or personal data by default. Record Ion revision, OS/toolchain versions, task language and prior familiarity. Allow20–30minutes; the observer must not supply code.

1. Ask the learner to enter Learn, choose Python, Java or C and find the introductory flow lesson without help. Record confusion and navigation steps.
2. Ask them to restate the task and expected behavior before opening the exercise. Observe whether the starter and Run samples are discoverable.
3. Have them make an independent attempt, run it, inspect real expected/actual output and explain a failure. Record the original diagnostic category without claiming its cause if unknown.
4. Offer one graduated hint only when requested. Ask what changed in their reasoning; record whether it gave away too much or remained vague.
5. Have them correct the attempt and rerun available samples. Ask what those samples do and do not establish.
6. Give an analogous task with changed bounds/filter behavior and no hint. Evaluate reasoning and representative cases manually; record assistance separately from independent performance.
7. Relaunch offline and confirm the learner can find their attempt, notes and actual saved evidence. Check that manual completion and sample success are not confused with mastery.

Record task completion/assistance, confusion points, lost work, incorrect explanations, hint usefulness and suggestions. Fix safety/data-loss defects first. A small convenience pilot cannot establish general learning gains or superiority over another IDE. No results or participants are claimed here.
