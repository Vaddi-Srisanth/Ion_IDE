import type { PracticeChallengeSummary } from '../../shared/practice'

type ChallengeId = PracticeChallengeSummary['id']

/** Two staged hints per original offline challenge; none contains hidden judge cases. */
export const practiceChallengeHints: Record<ChallengeId, readonly [string, string]> = {
  'minutes-to-clock': ['How many complete groups of 60 fit in the total?', 'The remainder after division by 60 is the leftover minutes.'],
  'workshop-invoice': ['Split the hours into the three rate bands before applying the discount.', 'Round down the discounted labor once, then add the fragile-item fee.'],
  'exactly-one-siren': ['For each period subset, count positive multiples up to N using its least common multiple.', 'Combine the single, pairwise, and triple overlaps by inclusion-exclusion to count times with exactly one siren.'],
  'badge-initials': ['The first character of the line and every character after a space begins a word.', 'Uppercase only those selected characters; keep their original order.'],
  'dispatch-label-windows': ['A candidate substring always has length K; maintain counts as the window slides one position.', 'A valid window contains K distinct letters, all within A through the Kth letter. Reset the window when an outside letter enters.'],
  'radio-rotation': ['A left rotation is a length-N substring of the original message repeated twice.', 'Search the doubled message for the captured word, counting only start positions below N; a prefix-function search handles repeated patterns efficiently.'],
  'waterline-readings': ['Process each reading independently in one pass.', 'For a reading at least L, increment the count and add reading − L to the excess.'],
  'strongest-shift': ['Compute the sum of the first K readings, then slide by one position at a time.', 'Subtract the outgoing value and add the incoming one. Update the answer only on a strictly larger sum so ties keep the earliest start.'],
  'longest-low-drift-window': ['Grow a sliding window while tracking its minimum and maximum with monotonic deques.', 'When max − min exceeds D, move the left edge until valid again; keep the earliest window when lengths tie.'],
  'restock-ledger': ['Build a frequency table for the delivered codes before reading the queries.', 'Each query is one lookup; a missing key has frequency zero.'],
  'pressure-pairs': ['Scan values from left to right and look up how many earlier values equal target − current.', 'Add the current value to the frequency map only after counting, so an item cannot pair with itself.'],
  'balanced-vote-ranges': ['Map A to +1, B to −1, and C to 0. A balanced range has equal prefix balances at its ends.', 'Count equal-prefix pairs, then subtract ranges made only of C characters; those have no positive A/B vote count.'],
  'leaderboard-ties': ['Use one comparator with score descending as its first key.', 'When scores match, compare identifiers in ascending ASCII order.'],
  'merge-booking-windows': ['Sort intervals by start, then extend the current interval while the next start is at most its end.', 'Because endpoints are half-open, touching intervals such as [2, 4) and [4, 7) combine under the problem rule.'],
  'deferred-deliveries': ['Sort deliveries by deadline and track the total duration of the selected set.', 'If the total exceeds the current deadline, remove the selected delivery with the greatest duration.'],
  'first-signal-crossing': ['For each threshold, search the nondecreasing array for the first value that is not smaller.', 'Use a lower-bound search and convert the zero-based position to one-based only when a qualifying value exists.'],
  'weekend-shuttles': ['The capacity cannot be below the heaviest crate or above the sum of all weights.', 'Binary-search that range; greedily pack each day in order to test whether a capacity fits within D days.'],
  'signal-tower-spacing': ['For a proposed minimum distance, greedily choose the earliest site that is far enough from the last chosen site.', 'Binary-search the largest feasible distance. Reconstruct the lexicographically earliest index tuple while checking that enough later sites can complete it.'],
  'nested-crates': ['Push each opener onto a stack.', 'A closer is valid only when it matches the stack top; the stack must also be empty at the end.'],
  'warmer-readings': ['Keep indices whose next strictly warmer reading has not been found in a decreasing-temperature stack.', 'When a warmer value arrives, resolve every colder top index; discard unresolved indices that move beyond the D-position limit.'],
  'widest-billboard': ['A rectangle of height H can span consecutive panels whose heights are all at least H.', 'Use a monotonic stack of heights and prefix sums of widths; when a height is popped, its maximal span ends at the current panel.'],
  'inspection-reach': ['Build an undirected adjacency list and start a traversal at S.', 'Mark a site when you add it to the stack or queue so duplicate roads do not count it twice.'],
  'room-waves': ['Initialize one queue with every beacon at distance zero.', 'Run multi-source BFS through open neighbors; walls are excluded and cells left unvisited have distance −1.'],
  'crate-route-waiver': ['Treat each site as two states: waiver unused or already used.', 'For each directed road, relax a normal-cost move in the same layer and, if unused, a zero-cost move into the used layer.'],
  'postcard-counts': ['Let ways[i] count sequences that land on station i; the previous one and two stations are the only predecessors.', 'Set ways[i] to zero for a closed station, otherwise add the valid predecessor counts modulo 1,000,000,007.'],
  'study-weeks': ['For each prefix, compare skipping this week with taking it after the required rest gap.', 'Taking week i adds its score to the best prefix ending no later than i − G − 1; the empty schedule keeps the total at least zero.'],
  'courier-switch-fees': ['At each cell, keep separate best costs for arriving from the left and from above.', 'A move pays the destination cell; add the switch fee only when the previous direction differs, and sum path counts on tied minimum costs.'],
}
