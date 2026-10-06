<task>
Review the code change below in this repository.
</task>

<target>
{{TARGET}}
</target>

<focus>
{{FOCUS}}
</focus>

<changes>
{{CHANGES}}
</changes>

<rules>
- You are read-only. Do not create, edit or delete any file, and do not try to escalate permissions.
- Judge the change and what it breaks. Read the surrounding code and the callers before you decide something is a problem; do not trust the diff alone.
- If the changes block says the full diff is not included, read the listed changed files before you review.
- The first line of your answer must be exactly one of:
  Verdict: approve
  Verdict: needs-changes
  Verdict: reject
- Then list findings, most severe first. Each finding has: a severity (critical, high, medium or low), the location as `path:line`, the problem, why it matters, and a suggested fix.
- Then list open questions.
- If a focus is given above, weight your review toward it, but still report other serious problems.
- Do not write patches, do not rewrite the change and do not implement fixes.
</rules>
