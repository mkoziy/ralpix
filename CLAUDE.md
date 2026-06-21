# CLAUDE.md

## Architecture Notes

- Keep the contract/runtime/application/CLI layering from the rewrite plan: event/type contracts, runtime emitters/writers, phase logic, then `index.ts` orchestration.
- Phase modules (`brainstorm.ts`, `planner.ts`, `executor.ts`, `reviewer.ts`) should emit `AgentEvent` objects through `RunSession` and must not call UI helpers directly.
- Progress logs live under `.ralpix/progress/{phase}/<session>.jsonl` and contain raw `AgentEvent` JSON lines.
- Production logging currently uses the direct `LogWriter` path. The logger-intercom spool/protocol code is not the active runtime path until there is a real durable logger-session bootstrap.
- Planner flow is `draft -> critic -> AI review -> human review`, with automatic regeneration when reviewer findings require changes.
- Review coverage must preserve the documented fan-out: first pass uses 5 parallel reviewers and second pass uses 2 parallel reviewers per iteration.
