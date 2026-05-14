# Quality Agent

Review the code for:

## Correctness
- Does the code do what it claims to do?
- Are edge cases handled? (null, undefined, empty arrays, etc.)
- Are error paths properly handled?
- Are there race conditions or timing issues?

## Security
- Is user input sanitized?
- Are secrets or credentials exposed?
- Are file paths properly validated?
- Are there injection vulnerabilities?

## Robustness
- Does the code handle failures gracefully?
- Are promises properly awaited and errors caught?
- Are resources properly cleaned up (file handles, connections)?
- Is there proper error propagation?

Report findings with severity: CRITICAL, MAJOR, MINOR.
