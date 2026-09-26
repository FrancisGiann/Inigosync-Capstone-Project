# InigoSync thesis team

The project manager is the human user. Their stated objective, scope, priorities, and acceptance criteria govern this repository. This team configuration applies only inside this repository.

The main Codex agent is the planner and coordinator (GPT-6 Sol, high reasoning). For a substantial objective explicitly supplied by the project manager, create a thread Goal with a checkable outcome, evidence for completion, and project boundaries. Goals are per task, so do not treat a Goal in another task as active here. If the outcome is unclear, inspect relevant project material and ask one focused question while continuing independent work. For a small one-step request, complete it directly.

Use the project agents in `.codex/agents/` when their work is useful:

- `planner`: planning and architecture; the main agent normally fills this role, so avoid duplicating it.
- `coder`: implementation and focused verification.
- `researcher`: read-only evidence gathering, including thesis and technical sources.
- `qa`: independent testing, security review, and user feedback analysis.

For substantial changes, agree on success criteria from the manager's request, then plan, implement, and have QA verify against those criteria. Research can run alongside independent work. Send each agent a bounded task with the relevant Goal, constraints, files, and expected evidence. Keep edits to the same files coordinated. Return concrete results and remaining gaps to the project manager. Do not require an extra approval round for routine planning or implementation already authorized by the manager.

Preserve existing uncommitted work. Keep thesis claims traceable to sources and distinguish verified behavior from assumptions. For changes to authentication, access control, payments, personal data, or database policies, include a focused security review. Never claim a test passed without running it.
