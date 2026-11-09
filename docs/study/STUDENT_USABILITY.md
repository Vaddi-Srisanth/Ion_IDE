# Student debugging usability study

**Status** Materials verified locally. No participant sessions or outcomes recorded.

## Study question

How do students debug short C programs in Ion Learn and in their usual offline coding workflow? Measure correct repairs, time, explanations, delayed transfer, avoidable interactions, and voluntary return. Compare the workflows as a whole. This design does not isolate the effect of a single learning panel, generalize to other languages, or establish superiority to VS Code across its possible configurations.

## Setup

- Recruit adult students who have written simple C programs and regularly use a different coding workflow. Aim for 24 completed pairs, six per assignment row. Record actual recruitment, withdrawals, and missing sessions. Treat a small or incomplete run as a pilot. Recruit before viewing results and keep the same stopping rule.
- Use the same Mac, keyboard, compiler, and network-off setup for both tasks per student. Record hardware, OS, Ion build revision and hash, compiler version, and the usual editor and build tool versions. Ask each participant which workflow they already use and record their C experience and tool familiarity before assigning tasks.
- Set up Ion Learn with its offline C pack selected. Leave explanations accessible and show the original compiler output. Confirm that both workflows can open, save, compile, and run a correct warm-up program. Use the same short warm-up and basic navigation instructions in both workflows. Log installation or setup failures separately.
- Keep each student's usual offline editor, compiler launcher, and local reference material available. Turn off AI assistance and internet access for both workflows. Ion’s explanations are part of its workflow. Avoid teaching the tested concepts or suggesting how to use diagnostic hints.
- Each task starts with a separate copy of the provided form named `task.c`. Keep participant copies separate from facilitator files and avoid opening another student's work. Use a fresh Ion profile or clear the study profile’s learning history between participants so prior diagnostics are unavailable.

### Verify the fixtures before enrolling

Install the repository's locked dependencies and use the Apple command-line tools. Run this preflight against the same source revision as the Ion build under study.

```sh
node docs/study/verify.mjs
```

The preflight invokes `/usr/bin/clang` with C17 and the same warning and diagnostic-color options as Ion’s single-file C runner. It checks the real compiler output against Ion’s classifier and executes four reference cases for each form. On Apple Clang 21.0.0 (clang-2100.4.1.1) all four starter diagnostics matched their intended categories at high confidence and all 16 reference cases passed. Repeat this on the study machine. Record any mismatch and stop before using the affected form. [Verifier and grader](verify.mjs)

## Assignment

Use a recorded random ordering of the four rows in each block of four assignments. Save the row with a pseudonymous participant ID. The forms use different concepts so a fix in the first task cannot be copied into the second. The rows balance tool, form, and order. The delayed tasks always use the same neutral editor and compiler setup, with learning aids and study notes closed. Demonstrate the neutral setup with the same correct warm-up for everyone.

| Row | First task | Second task | Delayed order |
| --- | --- | --- | --- |
| 1 | Ion, A | Usual workflow, B | A-transfer, B-transfer |
| 2 | Usual workflow, A | Ion, B | B-transfer, A-transfer |
| 3 | Ion, B | Usual workflow, A | B-transfer, A-transfer |
| 4 | Usual workflow, B | Ion, A | A-transfer, B-transfer |

## Participant materials

Give only the current starter and the relevant prompt. Keep the scoring key, verifier, and case inputs with the facilitator during the study.

Read the same opening instructions each time. “The file contains a program with a bug. Repair it so it handles the stated inputs and prints the expected result. Keep it as a single C source file. You can use the editor, compiler output, and permitted local help. Tell me when you want me to check your saved program. This is a study of the workflow. Your participation and results do not affect any grade.”

| Form | Prompt and visible example | Starter |
| --- | --- | --- |
| A | Read a gross weight and a container weight as two integers. The container is between zero and the gross weight. Print the net weight on one line. Input `17 5` prints `12`. | [A](fixtures/a.c) |
| B | Read a sensor reading and its signed offset as two integers. Print the reading plus the offset on one line. Input `10 -3` prints `7`. | [B](fixtures/b.c) |
| A-transfer | Read the number of tasks and the points for each task as two nonnegative integers. Print the total points on one line. Input `4 7` prints `28`. | [A-transfer](fixtures/a-transfer.c) |
| B-transfer | Read current stock and its signed change as two integers. The final stock is nonnegative. Print final stock on one line. Input `30 -4` prints `26`. | [B-transfer](fixtures/b-transfer.c) |

All inputs and correct results fit in a C `int`. The program should print a single decimal integer followed by a newline, without a prompt. For a command-line workflow, this is the equivalent build and run command.

```sh
/usr/bin/clang -x c -std=c17 -Wall -Wextra -fdiagnostics-color=never task.c -o task && ./task
```

## Run the sessions

1. Ask for consent to observe interactions, keep short task submissions, and record scores. Tell participants what is collected, how long it is retained, and how to withdraw. Record tool familiarity and start both workflows at the warm-up state.
2. Start an eight-minute timer when you give the prompt and file. At each request to check, record elapsed active seconds, pause the timer, and make a numbered copy of the saved source. Grade the copy and report only pass or “some cases still fail.” Resume the timer if needed. Stop at the first four-case pass or at the cap. If the timer expires, grade the final saved source. Record tool failures, requests for help, and interruptions without supplying a code fix.
3. After each task, ask “What caused the compiler error, and why does your change fix it?” Record the answer verbatim or ask for a short written response. Give no technical feedback. Ask whether the student had fixed the same kind of error before the session and record yes, no, or unsure. Treat unfamiliarity as self-reported.
4. After 48 to 72 hours, give the two transfer forms in the assigned order. Allow six minutes per form with the same checking procedure. Record the actual interval and any relevant practice or help between sessions. Do not show original solutions, task notes, or learning explanations. Report missed follow-ups and out-of-window sessions separately.
5. After the transfer tasks, offer an optional five-minute practice problem and a **Skip** choice. “If you want, write a program that reads two integers and prints the larger one. Either of the two workflows is ready to use. You can also skip.” Alternate which workflow is listed first and make both equally easy to open. Count a return when a participant voluntarily opens Ion and begins work, regardless of whether they finish. Record Ion, usual workflow, skipped, or choice unavailable. Avoid reminders, rewards tied to the choice, or claims about later usage from this single observation.

## Scoring and reporting

| Outcome | Scoring rule |
| --- | --- |
| Correct repair and time | A correct repair passes all four grading cases with exit code zero and exact expected standard output. Time is active seconds to the first correct submitted snapshot. Exclude facilitator grading time. Mark unfinished attempts as censored at the limit, including those that never compile. Report success counts and paired times with incomplete attempts visible. If using a capped-time summary, assign the cap to incomplete attempts and label it as capped. |
| Final correctness | Report compile status and the number of cases passed, from zero through four, on the final saved copy. Accept any repair that meets the task behavior. |
| Root-cause explanation | **0** means missing, incorrect, or just repeats the compiler message. **1** means identifies the implicated operation or rule with an incomplete explanation. **2** means identifies the rule and connects the specific edit to it. Use the key below. |
| Delayed transfer | Score each delayed form separately with the same correctness and time rules. Link A-transfer to the workflow used for A and B-transfer to the workflow used for B. Retain missing follow-up cases in the denominators for attendance. |
| Avoidable interactions | Count a repeated run with byte-identical source and inputs after the same outcome, a wrong file or tool action immediately undone without gaining information, or reopening the same view solely because the workflow lost its state. Count one event per occurrence. Keep purposeful inspection of diagnostics, explanations, local references, and changed-input runs separate. |
| Voluntary return | Report counts for Ion, usual workflow, skipped, and unavailable, alongside the number offered a real choice. A person absent at follow-up has no observed choice. |

After reviewing the short standalone submission in a disposable environment, score it with the same offline grader. The grader builds and executes the submitted code with bounded time and output, so use a disposable account or VM without personal files or credentials.

```sh
node docs/study/verify.mjs --grade a /path/to/saved-task.c
```

Use `a`, `b`, `a-transfer`, or `b-transfer` as the form ID. The grader returns whether the program compiled and how many cases passed. Its exit code is zero for a full pass.

**Explanation key.** A calls a two-parameter function with one argument. A-transfer passes an extra third argument to a two-parameter function. A full explanation connects the declaration or definition to the corrected call. B uses unary indirection on an integer that already contains the offset. B-transfer applies indirection twice, although the first application already yields the integer value. A full explanation identifies the operand type and why the corrected expression uses the intended value.

Blind the person scoring explanations and final submissions to the workflow, task order, and time. Share only the form, anonymized submission, and response with tool references removed. If possible, use two graders and resolve disagreements before revealing the assignment. The live observer sees the workflow, so report interaction scoring as unblinded.

Use a local record with these fields. `participant_id, assignment_row, phase, form, workflow, tool_version, position, cap_s, first_correct_s, censored, compiled, cases_passed, explanation_0_to_2, avoidable_interactions, prior_error_familiarity, interval_hours, optional_choice, interruption_code`. Keep names and contact details outside the scoring file. Avoid screen recording by default. Delete raw submissions and notes on the retention date stated at consent, such as 30 days after scoring, and keep only aggregate data for reporting.

Compare paired outcomes and break them down by form and order. Report the sample size, limits, missing data, any baseline tooling differences, and raw counts alongside percentages. Show paired results for participants reporting unfamiliar errors as a clearly labeled exploratory subset. Report timing, program correctness, explanation, transfer, interactions, and voluntary return separately. Publish outcomes only after real sessions have been completed and scored.
