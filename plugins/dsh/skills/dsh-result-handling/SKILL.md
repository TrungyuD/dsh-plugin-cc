---
name: dsh-result-handling
description: Internal guidance for presenting dsh helper output back to the user
user-invocable: false
---

# dsh Result Handling

When the helper returns dsh output:
- Present dsh's final text verbatim, including the `dsh session: … · model: … · mode: …` footer.
- For `/dsh:review-plan` and `/dsh:code-review` output, keep the `Verdict:` line first and keep findings in the order dsh gave them.
- Use the file paths and line numbers exactly as dsh reports them.
- Preserve evidence boundaries. If dsh marked something as an inference, uncertainty, or open question, keep that distinction.
- If dsh made edits (rescue in `workspace-write` mode), say so explicitly and list the touched files when the helper provides them.
- Do not turn a failed or incomplete dsh run into a Claude-side implementation attempt. Report the failure and stop.
- If dsh was never successfully invoked, do not generate a substitute answer.
- CRITICAL: After presenting a plan, a plan review or a code review, STOP. Do not apply the plan, do not edit the reviewed plan and do not change the reviewed code. Explicitly ask the user what, if anything, they want done before touching a single file. Auto-applying fixes from a plan or review is strictly forbidden, even if the fix is obvious.
- If the helper reports a failed dsh run, include the most actionable stderr lines and stop there instead of guessing.
- If the helper reports that setup or authentication is required, direct the user to `/dsh:setup` and do not improvise alternate auth flows.
