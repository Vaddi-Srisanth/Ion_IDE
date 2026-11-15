# Learning redesign — implemented and pending

## Implemented in Milestone B

Learn lists compact built-in language/topic summaries immediately. Choosing one materializes only that collection locally through the existing validated store. No language is selected automatically. Installed/imported content wins over the bundled version; this does not silently upgrade a user's lessons. Existing Topics-first browsing, runnable examples, exercise handoff, actual sample results and local diagnostic history remain.

Practice Lab is accessible from Learn and Welcome, using the same Practice store, attempts, notes and manual/sample-result semantics. Imported content is managed through Preferences → Learning Content: reviewed JSON import, explicit update, export, and confirmed removal. The old shortcut identifier still routes to this settings section, preserving custom bindings.

## Not completed

The catalog is reference/introductory material, not a newly reviewed complete Python/Java/C academy. Milestone C still needs carefully reviewed practical paths, progressive hints, follow-up tasks and compact evidence for hint/exercise use. No new mastery score, automatic completion, AI tutor or AI explanation is implemented. Existing sample passes establish those samples only.

## Human learning check

No human study ran. For a future small pilot, ask a beginner to choose Python without help, explain an unfamiliar task in their own words, write/run an attempt, inspect a real error, use one hint, correct it, and solve a parallel task independently. Record confusion, navigation cost and hint usefulness with consent. Do not present completion rate as measured learning transfer or claim superior outcomes without that evidence.


## Implemented practical slice C

Python/Java/C each have one enriched `flow` lesson: reviewed objective/prerequisites, unchanged correct example/task/acceptance and samples, incomplete editable starter, three graduated hints, pitfalls and explicitly unverified follow-up. Open exercise retains the lesson beside the original editor. Run samples saves through the existing policy and uses the existing approved local runner; shared expected/actual results are visible beside code. No automatic solution generation or remote call. Other languages and reference topics remain available with their existing behavior.

Activity is an optional bounded 256-entry local LRU map inside existing learning.json. Lesson-open and hint counts are exploration, not completion. Actual Practice reports provide saved-source/sample freshness and passed/failed/unavailable/skipped counts; manual completion remains separate. Hiding the owning panel or leaving a running lesson cancels only its pending sample run. No polling, second progress store or compiler background service.

This is three practical lessons, not three completed courses. Follow-ups are unverified exercises, not automatic competence awards. Wider curriculum, question checking, AI Tutor and live Project Lens remain future milestones.
