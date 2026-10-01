# InigoSync thesis team

The project manager is the human user. Their stated objective, scope, priorities, and acceptance criteria govern this repository. This team configuration applies only inside this repository.

The root Codex agent is the planner and coordinator (GPT-6 Sol, medium reasoning). It handles requirements, architecture, planning, delegation, blocker resolution, and final synthesis. For a substantial objective explicitly supplied by the project manager, create a thread Goal with a checkable outcome, evidence for completion, and project boundaries. Goals are per task, so do not treat a Goal in another task as active here. If the outcome is unclear, inspect relevant project material and ask one focused question while continuing independent work. For a small one-step request, complete it directly.

Route work through the project agents in `.codex/agents/` when useful:

- For substantial implementation, fixes, or refactors, normally delegate one complete task to exactly one `coder`, who owns investigation, implementation, and verification. The root handles planning; for small one-step work it may implement directly.
- Use `researcher` only for unanswered research questions and `browser_debugger` only when browser or runtime evidence is needed.
- Use `reviewer` for independent review of substantial or risky changes and security-sensitive authentication, access control, payment, personal-data, or database-policy work. The reviewer also checks acceptance criteria and test adequacy while remaining read-only.
- Use multiple agents only for independent workstreams.
- Never spawn a GPT-6 Sol subagent without the project manager's explicit approval. Unnamed subagents use GPT-6 Luna with medium reasoning; raise effort only when complexity or failed attempts justify it.
- Every spawn uses `fork_turns="none"` and includes the goal, constraints, relevant context, and success criteria.
- Use lowercase snake_case task names with the role prefix: `coder_<job>`, `researcher_<job>`, `browser_debugger_<job>`, or `reviewer_<job>`.
- Never auto-commit.

Keep delegated context bounded, avoid duplicate investigation, and ask for concise evidence in each handoff. Raise reasoning effort only when task complexity or failed attempts justify it; do not default to xhigh. Keep edits to the same files coordinated. Return concrete results and remaining gaps to the project manager. Do not require an extra approval round for routine authorized implementation.

Preserve existing uncommitted work. Keep thesis claims traceable to sources and distinguish verified behavior from assumptions. For changes to authentication, access control, payments, personal data, or database policies, include a focused security review. Never claim a test passed without running it.
