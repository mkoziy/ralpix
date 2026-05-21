/**
 * Prompt loading and variable expansion.
 *
 * Looks up prompts in order: project → global → bundled.
 * Expands {{VAR}} placeholders and {{agent:name}} agent includes.
 */
/**
 * Load a prompt file. Searches:
 *   1. ./.ralpix/prompts/<name>.md
 *   2. ~/.ralpix/prompts/<name>.md
 *   3. bundled/prompts/<name>.md (fallback)
 */
export declare function loadPrompt(name: string, cwd: string): string;
/**
 * Load an agent file. Searches:
 *   1. ~/.ralpix/agents/<name>.md
 *   2. bundled/agents/<name>.md (fallback)
 */
export declare function loadAgent(name: string): string;
/**
 * Replace {{VAR}} placeholders with values from a record.
 * Unknown variables are left as-is.
 */
export declare function expandVariables(template: string, vars: Record<string, string>): string;
/**
 * Replace {{agent:name}} placeholders with the content of agent files.
 */
export declare function expandAgents(template: string): string;
/**
 * Full expansion: variables first, then agent includes.
 */
export declare function expandPrompt(template: string, vars: Record<string, string>): string;
//# sourceMappingURL=prompt.d.ts.map