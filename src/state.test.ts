import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadState, saveState, DEFAULT_STATE } from './state.js';
import type { BotState } from './state.js';

const TEST_PATH = join(import.meta.dirname, '..', 'state.test.tmp.json');

afterEach(() => {
  try { unlinkSync(TEST_PATH); } catch {}
});

describe('loadState', () => {
  it('returns defaults when file does not exist', () => {
    const state = loadState(TEST_PATH);
    expect(state).toEqual(DEFAULT_STATE);
  });

  it('reads existing state from disk', () => {
    const saved: BotState = {
      currentProject: '/some/path',
      lastUpdateId: 42,
      lastStartTime: 1000,
      chatActive: true,
    };
    writeFileSync(TEST_PATH, JSON.stringify(saved));
    const state = loadState(TEST_PATH);
    expect(state).toEqual(saved);
  });

  it('returns defaults for corrupted JSON', () => {
    writeFileSync(TEST_PATH, 'not json!!!');
    const state = loadState(TEST_PATH);
    expect(state).toEqual(DEFAULT_STATE);
  });

  it('merges partial state with defaults', () => {
    writeFileSync(TEST_PATH, JSON.stringify({ currentProject: '/foo' }));
    const state = loadState(TEST_PATH);
    expect(state.currentProject).toBe('/foo');
    expect(state.lastUpdateId).toBe(0);
    expect(state.lastStartTime).toBe(0);
    expect(state.chatActive).toBe(false);
  });
});

describe('saveState', () => {
  it('writes state to disk as JSON', () => {
    const state: BotState = {
      currentProject: '/test',
      lastUpdateId: 99,
      lastStartTime: 2000,
      chatActive: false,
    };
    saveState(TEST_PATH, state);
    const raw = JSON.parse(readFileSync(TEST_PATH, 'utf-8'));
    expect(raw).toEqual(state);
  });

  it('overwrites existing state', () => {
    saveState(TEST_PATH, { ...DEFAULT_STATE, lastUpdateId: 1 });
    saveState(TEST_PATH, { ...DEFAULT_STATE, lastUpdateId: 2 });
    const raw = JSON.parse(readFileSync(TEST_PATH, 'utf-8'));
    expect(raw.lastUpdateId).toBe(2);
  });
});
