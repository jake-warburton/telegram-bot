import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadState, saveState, DEFAULT_CHAT_STATE, DEFAULT_STATE } from './state.js';
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
      lastUpdateId: 42,
      lastStartTime: 1000,
      defaultCurrentProject: '/some/path',
      legacyChatActive: true,
      chatStates: {
        '123': {
          currentProject: '/some/path',
          chatActive: true,
          computerUseSessionId: 'session-123',
          task: {
            id: 'task-1',
            goal: 'Ship feature',
            status: 'running',
            attempt: 1,
            maxAttempts: 5,
            startedAt: '2026-03-31T00:00:00.000Z',
            updatedAt: '2026-03-31T00:00:00.000Z',
            currentProject: '/some/path',
          },
        },
      },
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
    writeFileSync(TEST_PATH, JSON.stringify({ defaultCurrentProject: '/foo' }));
    const state = loadState(TEST_PATH);
    expect(state.defaultCurrentProject).toBe('/foo');
    expect(state.lastUpdateId).toBe(0);
    expect(state.lastStartTime).toBe(0);
    expect(state.legacyChatActive).toBe(false);
    expect(state.chatStates).toEqual({});
  });

  it('migrates the legacy single-chat shape', () => {
    writeFileSync(TEST_PATH, JSON.stringify({
      currentProject: '/legacy/path',
      chatActive: true,
      lastUpdateId: 7,
    }));

    const state = loadState(TEST_PATH);
    expect(state.defaultCurrentProject).toBe('/legacy/path');
    expect(state.legacyChatActive).toBe(true);
    expect(state.lastUpdateId).toBe(7);
    expect(state.chatStates).toEqual({});
  });

  it('fills defaults for partial per-chat state', () => {
    writeFileSync(TEST_PATH, JSON.stringify({
      chatStates: {
        '123': {
          currentProject: '/foo',
        },
      },
    }));

    const state = loadState(TEST_PATH);
    expect(state.chatStates).toEqual({
      '123': {
        ...DEFAULT_CHAT_STATE,
        currentProject: '/foo',
        task: undefined,
      },
    });
  });
});

describe('saveState', () => {
  it('writes state to disk as JSON', () => {
    const state: BotState = {
      lastUpdateId: 99,
      lastStartTime: 2000,
      defaultCurrentProject: '/test',
      legacyChatActive: false,
      chatStates: {
        '123': {
          currentProject: '/test',
          chatActive: false,
        },
      },
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
