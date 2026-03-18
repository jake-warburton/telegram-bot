import { describe, it, expect } from 'vitest';
import { isAllowedUser, formatOutput, parseProjectArg } from './bot.js';

describe('isAllowedUser', () => {
  it('allows whitelisted user IDs', () => {
    expect(isAllowedUser(123, [123, 456])).toBe(true);
  });

  it('rejects non-whitelisted user IDs', () => {
    expect(isAllowedUser(789, [123, 456])).toBe(false);
  });

  it('rejects when allowlist is empty', () => {
    expect(isAllowedUser(123, [])).toBe(false);
  });
});

describe('formatOutput', () => {
  it('wraps short output in code block', () => {
    const result = formatOutput('hello world');
    expect(result).toEqual({ type: 'text', content: '```\nhello world\n```' });
  });

  it('returns file type for output over 4096 chars', () => {
    const longOutput = 'x'.repeat(5000);
    const result = formatOutput(longOutput);
    expect(result).toEqual({ type: 'file', content: longOutput });
  });

  it('accounts for code fence chars in length check', () => {
    const exactFit = 'x'.repeat(4088);
    const result = formatOutput(exactFit);
    expect(result).toEqual({ type: 'text', content: '```\n' + exactFit + '\n```' });
  });

  it('sends as file when code fence pushes over limit', () => {
    const justOver = 'x'.repeat(4089);
    const result = formatOutput(justOver);
    expect(result).toEqual({ type: 'file', content: justOver });
  });

  it('handles empty output', () => {
    const result = formatOutput('');
    expect(result).toEqual({ type: 'text', content: '(no output)' });
  });
});

describe('parseProjectArg', () => {
  const projects = [
    '/Users/jake/repos/project-a',
    '/Users/jake/repos/project-b',
    '/Users/jake/repos/my-app',
  ];

  it('matches by index (1-based)', () => {
    expect(parseProjectArg('1', projects)).toBe('/Users/jake/repos/project-a');
  });

  it('matches by basename', () => {
    expect(parseProjectArg('my-app', projects)).toBe('/Users/jake/repos/my-app');
  });

  it('matches by partial basename', () => {
    expect(parseProjectArg('project-a', projects)).toBe('/Users/jake/repos/project-a');
  });

  it('returns null for no match', () => {
    expect(parseProjectArg('nonexistent', projects)).toBeNull();
  });

  it('returns null for out-of-range index', () => {
    expect(parseProjectArg('99', projects)).toBeNull();
  });
});
