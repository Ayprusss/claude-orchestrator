// The verification loop every orchestrator agent is given (not in any
// marketplace we could search: see docs). Pure text; queue.ts appends it to a
// task's prompt, ahead of the report note.

export const VERIFY_MAX_ROUNDS = 10

export type VerifyOptions = {
  /** Rounds of check-and-fix before reporting; 0 turns the loop off. */
  rounds: number
  /** The conditions the orchestrator set for this task, if it set any. */
  criteria?: string
  /** A verification skill to use when the session has it ('' = none). */
  skill?: string
}

const cleanSkill = (s: string | undefined) => (s ?? '').trim().replace(/^\//, '').replace(/[^A-Za-z0-9:_-]/g, '')

/** The directive appended to a task's prompt; '' when the loop is off. */
export function verifyNote(o: VerifyOptions): string {
  const rounds = Math.min(VERIFY_MAX_ROUNDS, Math.floor(o.rounds))
  if (!(rounds > 0)) return ''
  const criteria = (o.criteria ?? '').trim()
  const skill = cleanSkill(o.skill)
  return [
    '',
    '',
    `Verify your work before you report, for up to ${rounds} round${rounds === 1 ? '' : 's'} of check and fix.`,
    skill ? `If the \`${skill}\` skill is available, use it for this; otherwise follow these steps.` : '',
    criteria ? `Done means all of: ${criteria}` : 'Done means everything the task above asks for.',
    '1. List each condition. After your changes, check each one yourself: run the checks the project already has that apply (tests, type-check, lint, build) and read your own diff. Only call a condition met if you saw it pass.',
    '2. If any fails, fix the cause and check again. Never weaken, skip or delete a test or a condition to make it pass.',
    `3. Stop when all pass, or after ${rounds} round${rounds === 1 ? '' : 's'}; then say which still fail and why.`,
    'End your reply with "Verified: yes" or "Verified: no", and one line of evidence per condition.',
  ]
    .filter((l, i) => l !== '' || i < 2)
    .join('\n')
}
