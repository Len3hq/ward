/**
 * "yes" and "no", on any channel.
 *
 * Two places have to agree on what an answer looks like: the gateway that resolves
 * an open confirmation, and the graph, which has to recognise a confirmation-shaped
 * message arriving when NOTHING is open — a restarted process, a redeploy, a
 * timed-out prompt. That case used to reach the conversational model, which
 * answered a "Yes" meant to approve a swap with "It seems like you might be looking
 * for assistance." The user believed they had approved a spend. Nothing had
 * happened, and nothing said so.
 *
 * So the patterns live here, and `agent/nodes/stale-confirm.ts` is what a bare
 * yes/no reaches when there is nothing to confirm.
 */

const YES =
  /^\s*(y|yes|yeah|yep|yup|confirm|confirmed|ok|okay|do it|go|send it|sure|approve[d]?)\s*!?\s*$/i;
const NO = /^\s*(n|no|nope|nah|cancel|stop|don'?t|abort|reject|deny)\s*!?\s*$/i;

/** `true` / `false` for an answer, `null` when the text is anything else. */
export function readAnswer(text: string): boolean | null {
  if (YES.test(text)) return true;
  if (NO.test(text)) return false;
  return null;
}

/** Whether this message is a bare yes or no and nothing else. */
export function isBareAnswer(text: string): boolean {
  return readAnswer(text) !== null;
}
