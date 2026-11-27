// Version 1 local judge fixtures. The executor receives only the input for each case.
export const additionalJudgeCases: Readonly<Record<string, readonly { input: string; answer: string }[]>> = {
  'workshop-invoice': [
    { input: '4 7 1\n', answer: '5074' },
    { input: '9 1 0\n', answer: '8860' },
    { input: '1000000 0 0\n', answer: '700002650' },
  ],
  'exactly-one-siren': [
    { input: '0 1 2 3\n', answer: '0' },
    { input: '12 1 2 4\n', answer: '6' },
    { input: '35 3 5 15\n', answer: '14' },
  ],
  'badge-initials': [
    { input: 'z\n', answer: 'Z' },
    { input: 'aLPHa Alpha alpha\n', answer: 'AAA' },
    { input: 'eAST by North west\n', answer: 'EBNW' },
  ],
  'dispatch-label-windows': [
    { input: '2\nZZBAAB\n', answer: '2 3' },
    { input: '26\nZYXWVUTSRQPONMLKJIHGFEDCBA\n', answer: '1 1' },
    { input: '3\nCCCAB\n', answer: '1 3' },
  ],
  'radio-rotation': [
    { input: 'a\nb\n', answer: '-1 0' },
    { input: 'abcabcabc\ncabcabcab\n', answer: '2 3' },
    { input: 'book\nbook\n', answer: '0 1' },
  ],
  'waterline-readings': [
    { input: '1 1000000000\n1000000000\n', answer: '1 0' },
    { input: '5 -5\n-6 -4 0 -5 9\n', answer: '4 20' },
    { input: '4 7\n6 6 6 6\n', answer: '0 0' },
  ],
  'strongest-shift': [
    { input: '6 3\n-10 -2 -2 -2 -9 -10\n', answer: '-6 2' },
    { input: '4 1\n3 7 -1 7\n', answer: '7 2' },
    { input: '6 3\n0 0 8 -2 6 10\n', answer: '14 4' },
  ],
  'longest-low-drift-window': [
    { input: '6 2\n1 3 5 7 7 7\n', answer: '4 3' },
    { input: '4 2000000000\n-1000000000 1000000000 -1 0\n', answer: '4 1' },
    { input: '6 0\n8 4 4 3 3 8\n', answer: '2 2' },
  ],
  'restock-ledger': [
    { input: '5 4\n00 0 000 00 0\n000\n00\n0\n0000\n', answer: '1\n2\n2\n0' },
    { input: '1 1\nabcdefghijkl\nabc\n', answer: '0' },
    { input: '3 3\nz0 q1 z0\nz0\nz0\nq1\n', answer: '2\n2\n1' },
  ],
  'pressure-pairs': [
    { input: '5 0\n-3 -3 3 3 3\n', answer: '6' },
    { input: '4 -2000000000\n-1000000000 0 -1000000000 -1000000000\n', answer: '3' },
    { input: '3 8\n1 4 7\n', answer: '1' },
  ],
  'balanced-vote-ranges': [
    { input: 'CCABCC\n', answer: '9' },
    { input: 'ABBA\n', answer: '3' },
    { input: 'BCBC\n', answer: '0' },
  ],
  'leaderboard-ties': [
    { input: '4\naa 0\nb 1\na 0\naba -1\n', answer: 'b 1\na 0\naa 0\naba -1' },
    { input: '2\nz -1000000000\na 1000000000\n', answer: 'a 1000000000\nz -1000000000' },
    { input: '3\nzz -7\nza -7\nz -7\n', answer: 'z -7\nza -7\nzz -7' },
  ],
  'merge-booking-windows': [
    { input: '4\n5 8\n1 3\n3 5\n3 5\n', answer: '1\n1 8' },
    { input: '3\n999999999 1000000000\n0 1\n2 3\n', answer: '3\n0 1\n2 3\n999999999 1000000000' },
    { input: '4\n4 6\n2 5\n8 10\n9 10\n', answer: '2\n2 6\n8 10' },
  ],
  'deferred-deliveries': [
    { input: '1\n1000000000 1000000000\n', answer: '1' },
    { input: '5\n8 8\n1 9\n2 9\n3 9\n3 9\n', answer: '4' },
    { input: '3\n6 9\n4 4\n2 6\n', answer: '2' },
  ],
  'first-signal-crossing': [
    { input: '4 3\n-8 -8 -3 -3\n-7\n-3\n-2\n', answer: '3\n3\n-1' },
    { input: '2 3\n-1000000000 1000000000\n0\n-1000000000\n1000000000\n', answer: '2\n1\n2' },
    { input: '5 2\n0 1 1 1 2\n1\n1\n', answer: '2\n2' },
  ],
  'weekend-shuttles': [
    { input: '3 2\n4 8 4\n', answer: '12' },
    { input: '1 8\n1000000\n', answer: '1000000' },
    { input: '5 3\n3 3 3 3 3\n', answer: '6' },
  ],
  'signal-tower-spacing': [
    { input: '5 3\n0 3 4 6 7\n', answer: '3\n1 2 4' },
    { input: '4 2\n-1000000000 -1000000000 1000000000 1000000000\n', answer: '2000000000\n1 3' },
    { input: '3 3\n2 2 8\n', answer: '0\n1 2 3' },
  ],
  'nested-crates': [
    { input: '[]{}(())\n', answer: 'VALID' },
    { input: '([])}\n', answer: 'INVALID' },
    { input: '{([{}])\n', answer: 'INVALID' },
  ],
  'warmer-readings': [
    { input: '5 2\n3 1 4 4 5\n', answer: '2 1 2 1 0' },
    { input: '4 1\n-2 -2 -1 -3\n', answer: '0 1 0 0' },
    { input: '1 1\n1000000000\n', answer: '0' },
  ],
  'widest-billboard': [
    { input: '3\n1000 1000000\n1000 1000000\n1000 1000000\n', answer: '3000000000' },
    { input: '4\n3 2\n2 7\n4 5\n1 1\n', answer: '30' },
    { input: '3\n1 8\n4 1\n1 7\n', answer: '8' },
  ],
  'inspection-reach': [
    { input: '6 4 6\n2 1\n4 3\n5 4\n6 5\n', answer: '4' },
    { input: '3 3 2\n1 1\n2 2\n3 3\n', answer: '1' },
    { input: '5 0 3\n', answer: '1' },
  ],
  'room-waves': [
    { input: '1 6\n.S..S#\n', answer: '1 0 1 1 0 -1' },
    { input: '3 3\nS#.\n.#.\n...\n', answer: '0 -1 6\n1 -1 5\n2 3 4' },
    { input: '3 1\n.\n#\nS\n', answer: '-1\n-1\n0' },
  ],
  'crate-route-waiver': [
    { input: '4 5 1 4\n1 2 8\n1 2 3\n2 3 100\n3 4 4\n3 2 1\n', answer: '7' },
    { input: '3 1 3 1\n1 3 7\n', answer: '-1' },
    { input: '4 3 2 4\n2 1 7\n1 3 2\n3 4 2\n', answer: '4' },
  ],
  'postcard-counts': [
    { input: '49 0\n', answer: '586268941' },
    { input: '6 2\n1 2\n', answer: '0' },
    { input: '4 2\n3 1\n', answer: '1' },
  ],
  'study-weeks': [
    { input: '5 1\n1000000000 1 1000000000 1 1000000000\n', answer: '3000000000' },
    { input: '5 2\n6 8 -4 6 1\n', answer: '12' },
    { input: '1 0\n-1000000000\n', answer: '0' },
  ],
  'courier-switch-fees': [
    { input: '1 4 1000000\n8 0 1 2\n', answer: '11 1' },
    { input: '2 2 5\n1 7\n2 1\n', answer: '9 1' },
    { input: '3 3 2\n0 0 100\n100 0 0\n100 100 0\n', answer: '6 1' },
  ],
}
