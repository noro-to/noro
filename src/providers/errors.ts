import { ModelError } from '../classify/index.js';

export const USAGE_LIMIT_MESSAGE = 'usage limit reached; rerun later';

/**
 * A provider's rate or plan limit. The message is always exactly
 * "usage limit reached; rerun later": a rerun resumes from the last
 * checkpoint, so finished steps aren't paid for twice.
 */
export class UsageLimitError extends ModelError {
  constructor(
    readonly provider: string,
    readonly detail?: string,
  ) {
    super(USAGE_LIMIT_MESSAGE, 429);
    this.name = 'UsageLimitError';
  }
}

/** Provider error text that means a rate, quota or plan limit (not an outage). */
export function looksLikeUsageLimit(text: string): boolean {
  return /\b429\b|rate[ _-]?limit|usage[ _-]?limit|limit reached|hit your (usage )?limit|quota|too many requests|resource[ _-]?exhausted|throttl/i.test(text);
}
