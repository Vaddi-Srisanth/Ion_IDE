# Project planning evaluation

Run the reviewed reference cases offline with `node scripts/evaluate-project-plans.mjs`. The corpus includes a C adder, a browser file-export task, a local checklist, and a C temperature converter. All four human-authored plans passed the version 1 schema and the targeted checks for feasible technology, explicit prerequisites, verifiable criteria, and unnecessary complexity. The browser case checks that the plan uses a download or another viable file-access mechanism.

The reference run tests the evaluation rubric and the project validator. It does not measure model quality. Unit tests separately exercise malformed replies, key isolation, and the permitted request body against a simulated provider response.

## Optional live comparison

Set `ION_PLAN_EVAL_ENDPOINT`, `ION_PLAN_EVAL_MODEL`, and `ION_PLAN_EVAL_API_KEY` in a temporary shell environment, then run:

```sh
node scripts/evaluate-project-plans.mjs --online
```

The script alternates the minimal and constrained prompts over the same four synthetic goals. It sends eight requests to the configured HTTPS provider and can incur charges. Set `ION_PLAN_EVAL_INPUT_USD_PER_MILLION` and `ION_PLAN_EVAL_OUTPUT_USD_PER_MILLION` for cost estimates when usage is returned. Report raw validity and rubric results, elapsed time, token usage, and optional cost. Review failed cases before changing either prompt. This run was not executed because no provider credentials were available.

The production planner requests a strict JSON response where supported and always applies local validation. Its schema follows the Chat Completions structured output format. [OpenAI Structured Outputs documentation](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=chat)
