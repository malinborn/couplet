import type { LinkControl } from './open-link';
import type { PathKind } from '../../links/types';

export interface FakeLinkControl extends LinkControl {
  /** Every call, as `name:argument`. */
  readonly calls: string[];
  /** What `pathKinds` answers per path; a path not listed is a regular file. */
  readonly kinds: Map<string, PathKind>;
}

/**
 * A recording `LinkControl` for tests — no vitest import, so any test file can
 * use it. `overrides` replace single members (e.g. a rejecting `pathKinds`).
 */
export function fakeLinkControl(overrides: Partial<LinkControl> = {}): FakeLinkControl {
  const calls: string[] = [];
  const kinds = new Map<string, PathKind>();
  const base: LinkControl = {
    home: () => '/Users/me',
    pathKinds: async (paths) => {
      calls.push(`pathKinds:${paths.join(',')}`);
      return paths.map((p) => kinds.get(p) ?? 'file');
    },
    openFile: async (path, fragment) => {
      calls.push(`openFile:${path}#${fragment ?? ''}`);
    },
    reveal: async (path) => {
      calls.push(`reveal:${path}`);
    },
    missing: (path) => {
      calls.push(`missing:${path}`);
    },
    unresolvable: (url, reason) => {
      calls.push(`unresolvable:${url}:${reason}`);
    },
  };
  return Object.assign(base, overrides, { calls, kinds });
}
