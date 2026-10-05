<task>
Review the implementation plan below against the real codebase in this repository.
</task>

<focus>
{{FOCUS}}
</focus>

<plan_files>
{{PLAN_FILES}}
</plan_files>

<rules>
- You are read-only. Do not create, edit or delete any file, and do not try to escalate permissions.
- Check every claim the plan makes about the code by reading the code. Do not trust the plan's description.
- The first line of your answer must be exactly one of:
  Verdict: approve
  Verdict: needs-changes
  Verdict: reject
- Then list findings, most severe first. Each finding has: the plan location (file and heading), the codebase evidence (`path:line`), the problem, and a suggested change.
- Then list the claims you checked that hold.
- Then list open questions.
- If a focus is given above, weight your review toward it, but still report other serious problems.
- Do not rewrite the plan and do not implement it.
</rules>
