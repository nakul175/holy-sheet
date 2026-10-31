import type {ConditionalDraftAuthority} from './shared-record-conditions';

/** Production draft-epoch adapter for conditional policy publication.
 *
 * Suite proof remains authenticateRecordAuthority. This adapter does not read
 * draft values and does not claim a qualified inventory of connected writers,
 * so preview stays blocked and publication fails closed.
 */
export function failClosedConditionalDraftEpoch(): ConditionalDraftAuthority {
 return {inspect: async () => ({complete: false, quiescent: false, revision: ''})};
}
