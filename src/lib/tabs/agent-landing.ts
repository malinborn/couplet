/**
 * Where an agent's command lands in this window (spec §5):
 * - `live` — its file is the active tab: handled in the live view;
 * - `activate` — switch to its tab first (`show`/`open` with `focus`);
 * - `background` — handled without switching; the tab shimmers.
 *
 * `edit` and `ask` never switch tabs. Nothing switches while the human is
 * typing (`typing.ts`), or while the active tab shows another agent's
 * question — an agent never takes the view away from either.
 */
export type Landing = 'live' | 'activate' | 'background';

export interface LandingInput {
  cmd: 'show' | 'edit' | 'ask' | 'open';
  /** The command's file is this window's active tab. */
  active: boolean;
  /** The command may take the view (`AiCommandPayload.focus`). */
  focus: boolean;
  typing: boolean;
  /** The active tab shows an agent's live `ask`. */
  liveAsk: boolean;
}

export function decideLanding(i: LandingInput): Landing {
  if (i.active) return 'live';
  if (i.cmd === 'edit' || i.cmd === 'ask') return 'background';
  return i.focus && !i.typing && !i.liveAsk ? 'activate' : 'background';
}
