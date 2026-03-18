import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

// --- Config ---

interface CliTool {
  command: string;
  args: string[];
  promptArg: 'append';
  description: string;
}

interface Config {
  cli_tools: Record<string, CliTool>;
  projects: string[];
  default_project: string;
  command_timeout_ms: number;
}

export function loadConfig(path: string): Config {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

// --- Pure helpers ---

export function isAllowedUser(userId: number, allowedIds: number[]): boolean {
  return allowedIds.includes(userId);
}

export type FormattedOutput =
  | { type: 'text'; content: string }
  | { type: 'file'; content: string };

export function formatOutput(output: string): FormattedOutput {
  if (!output) {
    return { type: 'text', content: '(no output)' };
  }

  const wrapped = '```\n' + output + '\n```';
  if (wrapped.length <= 4096) {
    return { type: 'text', content: wrapped };
  }

  return { type: 'file', content: output };
}

export function parseProjectArg(
  arg: string,
  projects: string[],
): string | null {
  // Try numeric index (1-based)
  const idx = parseInt(arg, 10);
  if (!isNaN(idx) && idx >= 1 && idx <= projects.length) {
    return projects[idx - 1];
  }

  // Try basename match
  const match = projects.find((p) => basename(p) === arg);
  return match ?? null;
}
