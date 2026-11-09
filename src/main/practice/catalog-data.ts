import type { PracticeChallenge } from '../../shared/practice'

// Original offline prompts. Sample fixtures are shared by the reader and runner.
export const practiceChallenges: readonly PracticeChallenge[] = [
  {
    id: "minutes-to-clock",
    title: "Minutes to Clock",
    topic: "Basics",
    difficulty: "Easy",
    statement: `A timer reports the total minutes spent on a task. Convert that duration to whole hours and leftover minutes.

Input
A single integer M, the total number of minutes.

Output
Print the number of whole hours and the remaining minutes, separated by one space. The minutes are printed without leading zeroes.

Constraints
0 ≤ M ≤ 1,000,000,000.

Example input
137

Example output
2 17`,
    samples: [
      { label: "Minutes left over", input: "137\n", expectedOutput: "2 17" },
      { label: "Zero duration", input: "0\n", expectedOutput: "0 0" },
      { label: "Exact hour", input: "60\n", expectedOutput: "1 0" },
      { label: "Large duration", input: "1000000000\n", expectedOutput: "16666666 40" },
    ],
  },
  {
    id: "workshop-invoice",
    title: "Workshop Invoice",
    topic: "Basics",
    difficulty: "Medium",
    statement: `A workshop charges 1,250 cents per hour for the first three hours, 900 cents per hour for hours four through eight, and 700 cents per hour after that. A percentage discount applies to labor. Multiply the labor subtotal by (100 − D) and divide by 100, rounding down once. Then add a 750-cent packaging fee if the item is fragile.

Input
One line with three integers H D F. H is the number of hours, D is the discount percentage, and F is 1 for a fragile item or 0 otherwise.

Output
Print the final invoice in whole cents.

Constraints
0 ≤ H ≤ 1,000,000, 0 ≤ D ≤ 100, and F is either 0 or 1. Intermediate totals can exceed the range of a signed 32-bit integer.

Example input
10 13 1

Example output
9145`,
    samples: [
      { label: "All three rates", input: "10 13 1\n", expectedOutput: "9145" },
      { label: "Exactly three hours", input: "3 15 0\n", expectedOutput: "3187" },
      { label: "Packaging without labor", input: "0 50 1\n", expectedOutput: "750" },
      { label: "Full discount", input: "8 100 1\n", expectedOutput: "750" },
    ],
  },
  {
    id: "exactly-one-siren",
    title: "Exactly One Siren",
    topic: "Basics",
    difficulty: "Hard",
    statement: `Three separate sirens sound at positive multiples of their respective periods. Count the minutes from 1 through N when exactly one siren sounds. Two sirens with the same period still count as two sirens when they sound together.

Input
One line with four integers N A B C. The last three numbers are the siren periods in minutes.

Output
Print the number of minutes when exactly one siren sounds.

Constraints
0 ≤ N ≤ 1,000,000,000,000 and 1 ≤ A, B, C ≤ 10,000. Use an integer representation large enough for the counts.

Example input
30 2 3 5

Example output
14`,
    samples: [
      { label: "Overlapping schedules", input: "30 2 3 5\n", expectedOutput: "14" },
      { label: "Two matching periods", input: "20 4 4 6\n", expectedOutput: "2" },
      { label: "All periods equal", input: "100 7 7 7\n", expectedOutput: "0" },
      { label: "Long observation", input: "1000000000000 2 3 5\n", expectedOutput: "466666666668" },
    ],
  },
  {
    id: "badge-initials",
    title: "Badge Initials",
    topic: "Strings",
    difficulty: "Easy",
    statement: `A conference badge uses the first letter of every word in a name. Read the name and turn those initials into one uppercase badge code.

Input
One line containing one or more words separated by single spaces. Each word consists of ASCII letters A–Z or a–z.

Output
Print the uppercase initials in the same order as the words, with no separators.

Constraints
1 ≤ number of words ≤ 100. Each word has 1–50 letters.

Example input
north Star project

Example output
NSP`,
    samples: [
      { label: "Mixed case", input: "north Star project\n", expectedOutput: "NSP" },
      { label: "One word", input: "turing\n", expectedOutput: "T" },
      { label: "Single-letter words", input: "a B c D\n", expectedOutput: "ABCD" },
      { label: "Full uppercase", input: "NEW YORK\n", expectedOutput: "NY" },
    ],
  },
  {
    id: "dispatch-label-windows",
    title: "Dispatch Label Windows",
    topic: "Strings",
    difficulty: "Medium",
    statement: `A dispatch label consists of the first K uppercase English letters, each exactly once in any order. Find every contiguous substring of a recorded signal that could be a label. Overlapping labels count separately.

Input
The first line contains K. The second line contains the signal as one string of uppercase ASCII letters.

Output
Print the total number of labels and the 1-based start of the first label, separated by a space. Print 0 -1 when there is no label.

Constraints
1 ≤ K ≤ 26 and 1 ≤ signal length ≤ 200,000. The signal may contain letters outside the label alphabet.

Example input
3
ABCBACD

Example output
3 1`,
    samples: [
      { label: "Several overlapping labels", input: "3\nABCBACD\n", expectedOutput: "3 1" },
      { label: "Every window matches", input: "2\nABAB\n", expectedOutput: "3 1" },
      { label: "Signal too short", input: "4\nABC\n", expectedOutput: "0 -1" },
      { label: "One-letter label", input: "1\nDAAAB\n", expectedOutput: "3 2" },
    ],
  },
  {
    id: "radio-rotation",
    title: "Radio Rotation",
    topic: "Strings",
    difficulty: "Hard",
    statement: `A rotating radio dial displays a lowercase message. A left shift by s moves the first s characters to the end without changing their order. Find the smallest shift that produces the captured message, and count all distinct shift amounts that work.

Input
Two lines, each with one lowercase ASCII word. The first is the original message and the second is the captured message. The words have equal length N.

Output
Print the smallest valid s and the number of valid shifts, separated by one space. Only shifts 0 through N − 1 are considered. Print -1 0 if none works.

Constraints
1 ≤ N ≤ 200,000.

Example input
abab
baba

Example output
1 2`,
    samples: [
      { label: "Repeating pattern", input: "abab\nbaba\n", expectedOutput: "1 2" },
      { label: "One valid shift", input: "abcde\ndeabc\n", expectedOutput: "3 1" },
      { label: "No alignment", input: "abcde\nacbde\n", expectedOutput: "-1 0" },
      { label: "All shifts valid", input: "aaaaaa\naaaaaa\n", expectedOutput: "0 6" },
    ],
  },
  {
    id: "waterline-readings",
    title: "Waterline Readings",
    topic: "Arrays",
    difficulty: "Easy",
    statement: `A gauge records a sequence of water levels. Count readings at or above a warning level and sum how far those readings are above it. Readings equal to the warning level count but add zero to the excess.

Input
The first line contains N and the warning level L. The second line contains N integer readings.

Output
Print the count and the total excess as two space-separated integers.

Constraints
1 ≤ N ≤ 200,000. L and every reading are integers from −1,000,000,000 through 1,000,000,000. The total may exceed a signed 32-bit integer.

Example input
6 10
8 10 14 10 7 16

Example output
4 10`,
    samples: [
      { label: "Crossing the warning level", input: "6 10\n8 10 14 10 7 16\n", expectedOutput: "4 10" },
      { label: "None at the level", input: "3 5\n1 2 3\n", expectedOutput: "0 0" },
      { label: "Exactly at the level", input: "4 -2\n-2 -3 -1 -2\n", expectedOutput: "3 1" },
      { label: "Large excess", input: "3 -1000000000\n1000000000 1000000000 1000000000\n", expectedOutput: "3 6000000000" },
    ],
  },
  {
    id: "strongest-shift",
    title: "Strongest Shift",
    topic: "Arrays",
    difficulty: "Medium",
    statement: `A solar station records its net energy at each hour. Pick exactly K consecutive hours whose readings have the largest sum. If multiple shifts tie, choose the one that starts first.

Input
The first line contains N and K. The second line contains N signed integer readings in time order.

Output
Print the largest sum followed by the 1-based index of the first hour in that shift.

Constraints
1 ≤ K ≤ N ≤ 200,000 and each reading is between −1,000,000,000 and 1,000,000,000. The sum may exceed a signed 32-bit integer.

Example input
7 3
1 -2 5 4 -1 2 -6

Example output
8 3`,
    samples: [
      { label: "Best shift in the middle", input: "7 3\n1 -2 5 4 -1 2 -6\n", expectedOutput: "8 3" },
      { label: "All readings negative", input: "5 2\n-5 -2 -3 -1 -8\n", expectedOutput: "-4 3" },
      { label: "Tied shifts", input: "6 2\n1 2 1 2 1 2\n", expectedOutput: "3 1" },
      { label: "Whole recording", input: "3 3\n1000000000 1000000000 1000000000\n", expectedOutput: "3000000000 1" },
    ],
  },
  {
    id: "longest-low-drift-window",
    title: "Longest Low-Drift Window",
    topic: "Arrays",
    difficulty: "Hard",
    statement: `A test recording is stable over a contiguous segment when its maximum and minimum readings differ by at most D. Find the longest stable segment. If several have the same length, choose the earliest start.

Input
The first line contains N and D. The second line contains N signed integer readings in recording order.

Output
Print the length and the 1-based starting index of the chosen segment.

Constraints
1 ≤ N ≤ 200,000, 0 ≤ D ≤ 2,000,000,000, and each reading is between −1,000,000,000 and 1,000,000,000.

Example input
9 3
8 9 7 40 6 7 9 8 11

Example output
4 5`,
    samples: [
      { label: "A spike splits the recording", input: "9 3\n8 9 7 40 6 7 9 8 11\n", expectedOutput: "4 5" },
      { label: "Zero allowed drift", input: "6 0\n-2 -2 3 3 3 0\n", expectedOutput: "3 3" },
      { label: "Equal best lengths", input: "6 1\n1 2 7 8 3 4\n", expectedOutput: "2 1" },
      { label: "Single reading", input: "1 0\n-15\n", expectedOutput: "1 1" },
    ],
  },
  {
    id: "restock-ledger",
    title: "Restock Ledger",
    topic: "Hash maps",
    difficulty: "Easy",
    statement: `A storeroom records one product code per delivered box. Answer each query with the number of delivered boxes carrying that exact code.

Input
The first line contains N and Q. The second line contains N product codes separated by spaces. Then come Q query lines, each containing one product code.

Output
Print Q lines, one count per query in the original query order. Use 0 for a product code never delivered.

Constraints
1 ≤ N, Q ≤ 100,000. Codes have 1–12 characters, using lowercase ASCII letters or digits.

Example input
6 4
bolt nut bolt washer nut bolt
bolt
nut
cap
bolt

Example output
3
2
0
3`,
    samples: [
      { label: "Repeated and missing codes", input: "6 4\nbolt nut bolt washer nut bolt\nbolt\nnut\ncap\nbolt\n", expectedOutput: "3\n2\n0\n3" },
      { label: "One delivery", input: "1 2\np9\np9\np8\n", expectedOutput: "1\n0" },
      { label: "Codes are exact", input: "4 3\na01 a1 a01 b2\na1\na01\nb2\n", expectedOutput: "1\n2\n1" },
      { label: "Every code matches", input: "3 2\nx x x\nx\nx\n", expectedOutput: "3\n3" },
    ],
  },
  {
    id: "pressure-pairs",
    title: "Pressure Pairs",
    topic: "Hash maps",
    difficulty: "Medium",
    statement: `Choose any two different sensor readings. Count how many pairs sum to the target pressure. Two readings at different positions count as distinct even if their values are equal.

Input
The first line contains N and T. The second line contains N signed integer readings.

Output
Print the number of index pairs (i, j) with i < j and reading[i] + reading[j] = T.

Constraints
1 ≤ N ≤ 200,000. Readings are integers between −1,000,000,000 and 1,000,000,000 and T is between −2,000,000,000 and 2,000,000,000. The count may exceed a signed 32-bit integer.

Example input
7 8
5 3 4 4 7 1 3

Example output
4`,
    samples: [
      { label: "Multiple ways to pair", input: "7 8\n5 3 4 4 7 1 3\n", expectedOutput: "4" },
      { label: "No second index", input: "1 10\n5\n", expectedOutput: "0" },
      { label: "Negative values", input: "6 0\n-2 2 0 0 -2 2\n", expectedOutput: "5" },
      { label: "All readings identical", input: "6 4\n2 2 2 2 2 2\n", expectedOutput: "15" },
    ],
  },
  {
    id: "balanced-vote-ranges",
    title: "Balanced Vote Ranges",
    topic: "Hash maps",
    difficulty: "Hard",
    statement: `A vote log contains A votes, B votes, and C abstentions. Count contiguous ranges containing the same positive number of A and B votes. Abstentions can appear anywhere in a qualifying range. A range of only abstentions does not qualify.

Input
A single line with a string of A, B, and C characters.

Output
Print the number of qualifying ranges. Ranges with different starting or ending positions count separately.

Constraints
1 ≤ log length ≤ 200,000. The answer may exceed a signed 32-bit integer.

Example input
CABACB

Example output
7`,
    samples: [
      { label: "Abstentions between votes", input: "CABACB\n", expectedOutput: "7" },
      { label: "Abstentions only", input: "CCCCC\n", expectedOutput: "0" },
      { label: "Alternating votes", input: "ABABAB\n", expectedOutput: "9" },
      { label: "Unbalanced log", input: "AAAAACCC\n", expectedOutput: "0" },
    ],
  },
  {
    id: "leaderboard-ties",
    title: "Leaderboard Ties",
    topic: "Sorting",
    difficulty: "Easy",
    statement: `Print a scoreboard from highest to lowest score. At a tied score, order competitors by their identifiers in ASCII lexicographic order.

Input
The first line contains N. Each of the next N lines has a unique competitor identifier followed by an integer score.

Output
Print N lines with identifier and score separated by one space, in scoreboard order.

Constraints
1 ≤ N ≤ 100,000. Identifiers consist of 1–12 lowercase ASCII letters. Scores lie between −1,000,000,000 and 1,000,000,000.

Example input
4
reed 21
lime 21
onyx 4
pine 9

Example output
lime 21
reed 21
pine 9
onyx 4`,
    samples: [
      { label: "A tie at the top", input: "4\nreed 21\nlime 21\nonyx 4\npine 9\n", expectedOutput: "lime 21\nreed 21\npine 9\nonyx 4" },
      { label: "Negative scores", input: "3\nzed -3\nyak -10\nant -3\n", expectedOutput: "ant -3\nzed -3\nyak -10" },
      { label: "A single competitor", input: "1\nbot 0\n", expectedOutput: "bot 0" },
      { label: "Prefix identifiers", input: "3\nab 7\na 7\nabc 7\n", expectedOutput: "a 7\nab 7\nabc 7" },
    ],
  },
  {
    id: "merge-booking-windows",
    title: "Merge Booking Windows",
    topic: "Sorting",
    difficulty: "Medium",
    statement: `A studio receives booking intervals [start, end). Combine intervals that overlap or touch, so the resulting windows represent exactly the booked time with a gap between each pair of windows.

Input
The first line contains N. Each of the next N lines contains two integers, the start and end of one booking. Bookings may be listed in any order.

Output
Print the number of resulting windows on the first line. Print the start and end of each merged window on a separate line, in increasing start order.

Constraints
1 ≤ N ≤ 200,000 and 0 ≤ start < end ≤ 1,000,000,000.

Example input
5
14 16
2 7
4 9
9 10
20 24

Example output
3
2 10
14 16
20 24`,
    samples: [
      { label: "Unsorted and touching bookings", input: "5\n14 16\n2 7\n4 9\n9 10\n20 24\n", expectedOutput: "3\n2 10\n14 16\n20 24" },
      { label: "All contained", input: "4\n1 8\n2 3\n2 5\n1 4\n", expectedOutput: "1\n1 8" },
      { label: "Distinct windows", input: "3\n9 10\n3 5\n6 8\n", expectedOutput: "3\n3 5\n6 8\n9 10" },
      { label: "One booking", input: "1\n0 1\n", expectedOutput: "1\n0 1" },
    ],
  },
  {
    id: "deferred-deliveries",
    title: "Deferred Deliveries",
    topic: "Sorting",
    difficulty: "Hard",
    statement: `A dispatcher can complete one delivery at a time. All deliveries are available at minute 0. Each takes its full duration without interruption, and finishes on time if its completion minute is at most its deadline. Choose a subset and an order that finish the most deliveries on time.

Input
The first line contains N. Each of the next N lines contains a delivery duration followed by its deadline.

Output
Print the largest possible number of on-time deliveries.

Constraints
1 ≤ N ≤ 200,000. Durations and deadlines are integers from 1 through 1,000,000,000. No time is required between deliveries.

Example input
5
5 5
2 6
2 6
1 7
4 10

Example output
4`,
    samples: [
      { label: "A long delivery should be dropped", input: "5\n5 5\n2 6\n2 6\n1 7\n4 10\n", expectedOutput: "4" },
      { label: "Nothing fits", input: "3\n6 1\n5 2\n3 1\n", expectedOutput: "0" },
      { label: "Equal deadlines", input: "4\n5 7\n2 7\n2 7\n3 7\n", expectedOutput: "3" },
      { label: "All deliveries fit", input: "3\n2 2\n3 5\n1 6\n", expectedOutput: "3" },
    ],
  },
  {
    id: "first-signal-crossing",
    title: "First Signal Crossing",
    topic: "Search",
    difficulty: "Easy",
    statement: `A sorted signal log lists measured values. For each threshold, locate the earliest reading that reaches or exceeds that threshold. Multiple readings may have the same value.

Input
The first line contains N and Q. The second line contains N readings in nondecreasing order. Each of the next Q lines contains one threshold.

Output
Print one line per query with the first qualifying reading’s 1-based index, or -1 when there is no qualifying reading.

Constraints
1 ≤ N, Q ≤ 200,000. Each reading and threshold is an integer between −1,000,000,000 and 1,000,000,000.

Example input
6 5
-5 2 2 9 11 11
-5
2
3
11
12

Example output
1
2
4
5
-1`,
    samples: [
      { label: "A duplicate threshold", input: "6 5\n-5 2 2 9 11 11\n-5\n2\n3\n11\n12\n", expectedOutput: "1\n2\n4\n5\n-1" },
      { label: "Before the first reading", input: "2 2\n4 10\n1\n3\n", expectedOutput: "1\n1" },
      { label: "A single reading", input: "1 3\n7\n6\n7\n8\n", expectedOutput: "1\n1\n-1" },
      { label: "Several equal readings", input: "3 2\n8 8 8\n8\n9\n", expectedOutput: "1\n-1" },
    ],
  },
  {
    id: "weekend-shuttles",
    title: "Weekend Shuttles",
    topic: "Search",
    difficulty: "Medium",
    statement: `Move a line of crates in their original order. On each day, take one nonempty consecutive group from the front. Crates cannot be split, and unused days are allowed. Find the smallest fixed daily weight capacity that can move every crate within D days.

Input
The first line contains N and D. The second line contains the N positive crate weights in the required order.

Output
Print the smallest possible daily weight capacity as an integer.

Constraints
1 ≤ N, D ≤ 200,000 and 1 ≤ each weight ≤ 1,000,000. A total weight may exceed a signed 32-bit integer.

Example input
5 2
4 2 7 3 5

Example output
13`,
    samples: [
      { label: "Balance two days", input: "5 2\n4 2 7 3 5\n", expectedOutput: "13" },
      { label: "Only one day", input: "4 1\n2 9 4 2\n", expectedOutput: "17" },
      { label: "More days than crates", input: "3 9\n4 1 6\n", expectedOutput: "6" },
      { label: "Order affects the answer", input: "5 3\n7 6 1 5 8\n", expectedOutput: "12" },
    ],
  },
  {
    id: "signal-tower-spacing",
    title: "Signal Tower Spacing",
    topic: "Search",
    difficulty: "Hard",
    statement: `Choose K tower sites along a straight line. Maximize the smallest distance between two consecutive chosen sites. Among placements with the same optimum, choose the lexicographically smallest tuple of site indices. Compare index tuples left to right and prefer the smaller index at the first difference.

Input
The first line contains N and K. The second line contains N site coordinates in nondecreasing order. Two sites may share a coordinate and still have different indices.

Output
Print the optimal smallest distance on the first line. On the second line, print the K chosen 1-based indices in increasing order, separated by spaces.

Constraints
2 ≤ K ≤ N ≤ 200,000. Coordinates lie between −1,000,000,000 and 1,000,000,000.

Example input
6 3
0 2 3 5 7 9

Example output
4
1 4 6`,
    samples: [
      { label: "Multiple good placements", input: "6 3\n0 2 3 5 7 9\n", expectedOutput: "4\n1 4 6" },
      { label: "Duplicate coordinates", input: "5 3\n1 1 1 3 3\n", expectedOutput: "0\n1 2 3" },
      { label: "All sites required", input: "4 4\n0 5 8 20\n", expectedOutput: "3\n1 2 3 4" },
      { label: "Negative coordinates", input: "5 2\n-10 -4 -4 5 8\n", expectedOutput: "18\n1 5" },
    ],
  },
  {
    id: "nested-crates",
    title: "Nested Crates",
    topic: "Stacks and queues",
    difficulty: "Easy",
    statement: `A packing scanner records opening and closing markers for crates. A closer must match the most recent unclosed opener. Decide whether the sequence describes a completely closed set of crates.

Input
One line containing a nonempty string of the six characters ( ) [ ] { }, with no spaces.

Output
Print VALID if every closer matches its opener and no crate remains open. Otherwise print INVALID.

Constraints
1 ≤ sequence length ≤ 200,000.

Example input
{[()][]}

Example output
VALID`,
    samples: [
      { label: "Nested crate types", input: "{[()][]}\n", expectedOutput: "VALID" },
      { label: "Closers cross", input: "([)]\n", expectedOutput: "INVALID" },
      { label: "One crate left open", input: "(()\n", expectedOutput: "INVALID" },
      { label: "Starts with a closer", input: "][\n", expectedOutput: "INVALID" },
    ],
  },
  {
    id: "warmer-readings",
    title: "Warmer Readings",
    topic: "Stacks and queues",
    difficulty: "Medium",
    statement: `For each temperature reading, find how many positions ahead the next strictly warmer reading occurs. The search stops after at most D positions. An equal temperature does not count as warmer.

Input
The first line contains N and D. The second line contains N integer temperatures in measurement order.

Output
Print N space-separated distances. Print 0 for a reading with no strictly warmer reading within the next D positions.

Constraints
1 ≤ N ≤ 200,000, 0 ≤ D ≤ N, and temperatures range from −1,000,000,000 through 1,000,000,000.

Example input
7 3
17 17 18 16 15 16 21

Example output
2 1 0 3 1 1 0`,
    samples: [
      { label: "Warmer readings within range", input: "7 3\n17 17 18 16 15 16 21\n", expectedOutput: "2 1 0 3 1 1 0" },
      { label: "Too far to wait", input: "4 2\n4 3 2 8\n", expectedOutput: "0 2 1 0" },
      { label: "No lookahead", input: "3 0\n1 2 3\n", expectedOutput: "0 0 0" },
      { label: "All equal", input: "4 4\n7 7 7 7\n", expectedOutput: "0 0 0 0" },
    ],
  },
  {
    id: "widest-billboard",
    title: "Widest Billboard",
    topic: "Stacks and queues",
    difficulty: "Hard",
    statement: `A line of adjacent panels has no gaps. A rectangular sign starts at the shared bottom edge and must span one or more whole consecutive panels. Its width is the sum of their widths and its height cannot exceed the shortest chosen panel. Find the largest possible area.

Input
The first line contains N. Each of the next N lines contains one panel’s width and height, in left-to-right order.

Output
Print the maximum area of the sign.

Constraints
1 ≤ N ≤ 200,000, 1 ≤ width ≤ 1,000, and 1 ≤ height ≤ 1,000,000. The area may exceed a signed 32-bit integer.

Example input
5
2 4
1 2
3 5
2 5
4 1

Example output
25`,
    samples: [
      { label: "Different panel widths", input: "5\n2 4\n1 2\n3 5\n2 5\n4 1\n", expectedOutput: "25" },
      { label: "A wide short panel wins", input: "3\n1 100\n1000 2\n1 100\n", expectedOutput: "2004" },
      { label: "Equal heights", input: "3\n1 6\n5 6\n7 6\n", expectedOutput: "78" },
      { label: "One panel", input: "1\n4 7\n", expectedOutput: "28" },
    ],
  },
  {
    id: "inspection-reach",
    title: "Inspection Reach",
    topic: "Graphs",
    difficulty: "Easy",
    statement: `An inspector starts at one site and can travel in either direction along any listed road. Count the distinct sites the inspector can reach, including the starting site.

Input
The first line contains N, M, and S. Sites are numbered 1 through N, and S is the starting site. Each of the next M lines contains the two sites joined by a road.

Output
Print the number of reachable sites.

Constraints
1 ≤ N ≤ 200,000, 0 ≤ M ≤ 200,000, and 1 ≤ S ≤ N. Duplicate roads and roads from a site to itself may occur.

Example input
7 5 2
1 2
2 3
3 4
5 6
6 7

Example output
4`,
    samples: [
      { label: "Disconnected parts", input: "7 5 2\n1 2\n2 3\n3 4\n5 6\n6 7\n", expectedOutput: "4" },
      { label: "Isolated start", input: "4 2 4\n1 2\n2 3\n", expectedOutput: "1" },
      { label: "Duplicate roads", input: "3 4 1\n1 2\n1 2\n2 2\n2 3\n", expectedOutput: "3" },
      { label: "Single site", input: "1 0 1\n", expectedOutput: "1" },
    ],
  },
  {
    id: "room-waves",
    title: "Room Waves",
    topic: "Graphs",
    difficulty: "Medium",
    statement: `All beacons begin transmitting simultaneously. A signal crosses one open grid edge per tick. It can move up, down, left, or right, and cannot pass through walls. For each square, find the first tick at which any beacon’s signal arrives.

Input
The first line contains R and C. Each of the next R lines contains C characters. S is a beacon, . is an open square, and # is a wall. There can be zero or more beacons.

Output
Print R rows of C space-separated integers. Beacons have arrival time 0. Print -1 for a wall or an open square that cannot receive a signal.

Constraints
R and C are positive and R × C ≤ 100,000.

Example input
3 5
S...#
.##..
...S.

Example output
0 1 2 2 -1
1 -1 -1 1 2
2 2 1 0 1`,
    samples: [
      { label: "Two beacons and a barrier", input: "3 5\nS...#\n.##..\n...S.\n", expectedOutput: "0 1 2 2 -1\n1 -1 -1 1 2\n2 2 1 0 1" },
      { label: "Sealed corner", input: "3 3\nS#.\n.#.\n.#.\n", expectedOutput: "0 -1 -1\n1 -1 -1\n2 -1 -1" },
      { label: "No beacons", input: "2 4\n....\n.##.\n", expectedOutput: "-1 -1 -1 -1\n-1 -1 -1 -1" },
      { label: "One beacon", input: "1 1\nS\n", expectedOutput: "0" },
    ],
  },
  {
    id: "crate-route-waiver",
    title: "Crate Route With One Waiver",
    topic: "Graphs",
    difficulty: "Hard",
    statement: `A courier needs to get from S to T over directed toll roads. One waiver can make the toll of one traversed road zero. The courier may also finish without using the waiver.

Input
The first line contains N, M, S, and T. The next M lines contain U V W, meaning a directed road from U to V with toll W. Sites are numbered 1 through N.

Output
Print the minimum total toll, or -1 if T cannot be reached from S. When S and T are the same, the trip can cost 0.

Constraints
1 ≤ N ≤ 100,000, 0 ≤ M ≤ 200,000, and 1 ≤ W ≤ 1,000,000. Parallel roads may occur.

Example input
4 5 1 4
1 2 9
2 4 2
1 3 3
3 4 3
1 4 20

Example output
0`,
    samples: [
      { label: "A free direct road wins", input: "4 5 1 4\n1 2 9\n2 4 2\n1 3 3\n3 4 3\n1 4 20\n", expectedOutput: "0" },
      { label: "Better path uses the waiver", input: "4 5 1 4\n1 2 3\n2 4 8\n1 3 1\n3 4 20\n3 2 2\n", expectedOutput: "1" },
      { label: "Directed roads do not connect", input: "3 2 1 3\n2 1 1\n2 3 1\n", expectedOutput: "-1" },
      { label: "Already at the destination", input: "1 0 1 1\n", expectedOutput: "0" },
    ],
  },
  {
    id: "postcard-counts",
    title: "Postcard Counts",
    topic: "Dynamic programming",
    difficulty: "Easy",
    statement: `A postcard travels from station 0 to station N. In one move it advances one or two stations. It may jump over a closed station but must never land on one. Count its possible move sequences.

Input
The first line contains N and B, the number of closed stations. If B is positive, the second line contains B distinct closed-station indices.

Output
Print the number of valid sequences modulo 1,000,000,007. Count the empty sequence when N is 0.

Constraints
0 ≤ N ≤ 100,000, 0 ≤ B ≤ N, and closed stations are numbered from 1 through N. Station N itself may be closed.

Example input
6 1
3

Example output
4`,
    samples: [
      { label: "One closed station", input: "6 1\n3\n", expectedOutput: "4" },
      { label: "No closures", input: "5 0\n", expectedOutput: "8" },
      { label: "The destination is closed", input: "6 2\n2 6\n", expectedOutput: "0" },
      { label: "Already at the destination", input: "0 0\n", expectedOutput: "1" },
    ],
  },
  {
    id: "study-weeks",
    title: "Study Weeks",
    topic: "Dynamic programming",
    difficulty: "Medium",
    statement: `Each week offers one optional study session with a signed focus score. If you take a session, leave at least G entire weeks without a session before taking another. Choose sessions to maximize their combined score. Skipping every session is allowed.

Input
The first line contains N and G. The second line contains N scores, one per week in chronological order.

Output
Print the maximum attainable total focus score.

Constraints
1 ≤ N ≤ 200,000, 0 ≤ G ≤ N, and each score lies between −1,000,000,000 and 1,000,000,000. The total may exceed a signed 32-bit integer.

Example input
7 2
8 9 1 5 6 10 5

Example output
19`,
    samples: [
      { label: "Two rest weeks", input: "7 2\n8 9 1 5 6 10 5\n", expectedOutput: "19" },
      { label: "Skip negative sessions", input: "5 0\n1 -2 3 -4 5\n", expectedOutput: "9" },
      { label: "Every session loses focus", input: "3 1\n-5 -1 -6\n", expectedOutput: "0" },
      { label: "Only one session can fit", input: "4 4\n3 9 4 8\n", expectedOutput: "9" },
    ],
  },
  {
    id: "courier-switch-fees",
    title: "Courier Switch Fees",
    topic: "Dynamic programming",
    difficulty: "Hard",
    statement: `A courier crosses a grid from its top-left square to its bottom-right square using only right and down moves. The courier pays the cost of every visited square, including the first and last. Whenever two consecutive moves have different directions, add a switch fee. The first move has no switch fee.

Input
The first line contains R, C, and F, the switch fee. The next R lines each contain C nonnegative square costs.

Output
Print the minimum total cost and the number of distinct paths achieving it, separated by a space. Report the path count modulo 1,000,000,007. A 1 × 1 grid has one path with no moves.

Constraints
R and C are positive and R × C ≤ 100,000. Square costs and F are integers between 0 and 1,000,000.

Example input
2 3 3
1 2 1
1 2 1

Example output
8 2`,
    samples: [
      { label: "A turn costs extra", input: "2 3 3\n1 2 1\n1 2 1\n", expectedOutput: "8 2" },
      { label: "Many paths share the minimum", input: "3 3 0\n1 1 1\n1 1 1\n1 1 1\n", expectedOutput: "5 6" },
      { label: "Positive fee favors fewer turns", input: "3 3 5\n0 0 0\n0 0 0\n0 0 0\n", expectedOutput: "5 2" },
      { label: "A single square", input: "1 1 17\n7\n", expectedOutput: "7 1" },
    ],
  },
]
