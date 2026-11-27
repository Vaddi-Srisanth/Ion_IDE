import assert from 'node:assert/strict'
import { test } from 'node:test'
import { practiceChallenges } from '../src/main/practice/catalog-data'
import { additionalJudgeCases } from '../src/main/practice/catalog-judge-cases'

const numbers = (line: string) => line.split(' ').map(Number)
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0)

// Use exhaustive choices on the small fixtures so no optimized contestant algorithm is required.
const answers: Record<string, (lines: string[]) => string> = {
  'workshop-invoice'([line]) {
    const [hours, discount, fragile] = numbers(line)
    let subtotal = 0
    for (let hour = 1; hour <= hours; hour++) subtotal += hour <= 3 ? 1250 : hour <= 8 ? 900 : 700
    return String(Math.floor(subtotal * (100 - discount) / 100) + fragile * 750)
  },
  'exactly-one-siren'([line]) {
    const [n, ...periods] = numbers(line)
    // All three schedules repeat after the product, even when some periods coincide.
    const cycle = periods.reduce((product, value) => product * value, 1)
    let whole = 0, remainder = 0
    for (let minute = 1; minute <= Math.min(n, cycle); minute++) {
      if (periods.filter(period => minute % period === 0).length !== 1) continue
      whole++
      if (minute <= n % cycle) remainder++
    }
    return String(whole * Math.floor(n / cycle) + remainder)
  },
  'badge-initials'([name]) {
    return name.split(' ').map(word => word[0].toUpperCase()).join('')
  },
  'dispatch-label-windows'([size, signal]) {
    const k = Number(size), labels: number[] = []
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.slice(0, k)
    for (let start = 0; start <= signal.length - k; start++) {
      if ([...signal.slice(start, start + k)].sort().join('') === alphabet) labels.push(start + 1)
    }
    return [labels.length, labels[0] ?? -1].join(' ')
  },
  'radio-rotation'([original, captured]) {
    const shifts: number[] = []
    for (let i = 0; i < original.length; i++) {
      if (original.slice(i) + original.slice(0, i) === captured) shifts.push(i)
    }
    return [shifts[0] ?? -1, shifts.length].join(' ')
  },
  'waterline-readings'([header, line]) {
    const [, level] = numbers(header), qualified = numbers(line).filter(value => value >= level)
    return [qualified.length, sum(qualified.map(value => value - level))].join(' ')
  },
  'strongest-shift'([header, line]) {
    const [n, k] = numbers(header), readings = numbers(line)
    const totals = Array.from({ length: n - k + 1 }, (_, i) => sum(readings.slice(i, i + k)))
    const highest = Math.max(...totals)
    return [highest, totals.indexOf(highest) + 1].join(' ')
  },
  'longest-low-drift-window'([header, line]) {
    const [n, drift] = numbers(header), readings = numbers(line)
    for (let length = n; length >= 1; length--) {
      for (let start = 0; start <= n - length; start++) {
        const group = readings.slice(start, start + length)
        if (Math.max(...group) - Math.min(...group) <= drift) return [length, start + 1].join(' ')
      }
    }
    throw new Error('At least one reading is required.')
  },
  'restock-ledger'([, deliveries, ...queries]) {
    const boxes = deliveries.split(' ')
    return queries.map(query => boxes.filter(box => box === query).length).join('\n')
  },
  'pressure-pairs'([header, line]) {
    const [, target] = numbers(header), readings = numbers(line)
    return String(sum(readings.map((value, i) => readings.slice(i + 1).filter(other => value + other === target).length)))
  },
  'balanced-vote-ranges'([log]) {
    let count = 0
    for (let start = 0; start < log.length; start++) {
      for (let end = start + 1; end <= log.length; end++) {
        const range = [...log.slice(start, end)], a = range.filter(v => v === 'A').length
        if (a > 0 && a === range.filter(v => v === 'B').length) count++
      }
    }
    return String(count)
  },
  'leaderboard-ties'([, ...competitors]) {
    const scores = competitors.map(line => Number(line.split(' ')[1]))
    return [...new Set(scores)].sort((a, b) => b - a).flatMap(score =>
      competitors.filter((_, i) => scores[i] === score).map(line => line.split(' ')[0]).sort().map(id => id + ' ' + score)
    ).join('\n')
  },
  'merge-booking-windows'([, ...rows]) {
    const bookings = rows.map(numbers), ends = [...new Set(bookings.flat())].sort((a, b) => a - b)
    const windows: number[][] = []
    for (let i = 1; i < ends.length; i++) {
      const left = ends[i - 1], right = ends[i]
      if (!bookings.some(([start, end]) => start <= left && right <= end)) continue
      const last = windows.at(-1)
      if (last && last[1] === left) last[1] = right
      else windows.push([left, right])
    }
    return [windows.length, ...windows.map(window => window.join(' '))].join('\n')
  },
  'deferred-deliveries'([, ...rows]) {
    const deliveries = rows.map(numbers)
    function schedule(time: number, remaining: number[][]): number {
      let best = 0
      for (const [index, [duration, deadline]] of remaining.entries()) {
        if (time + duration <= deadline) {
          best = Math.max(best, 1 + schedule(time + duration, remaining.filter((_, i) => i !== index)))
        }
      }
      return best
    }
    return String(schedule(0, deliveries))
  },
  'first-signal-crossing'([, line, ...queries]) {
    const readings = numbers(line)
    return queries.map(query => {
      const index = readings.findIndex(value => value >= Number(query))
      return index < 0 ? -1 : index + 1
    }).join('\n')
  },
  'weekend-shuttles'([header, line]) {
    const [n, days] = numbers(header), weights = numbers(line)
    function partition(start: number, available: number): number {
      if (start === n) return 0
      if (available === 0) return Infinity
      let best = Infinity
      for (let end = start + 1; end <= n; end++) {
        best = Math.min(best, Math.max(sum(weights.slice(start, end)), partition(end, available - 1)))
      }
      return best
    }
    return String(partition(0, days))
  },
  'signal-tower-spacing'([header, line]) {
    const [n, k] = numbers(header), sites = numbers(line)
    let best = -1, winners: number[] = []
    function place(next: number, indices: number[]) {
      if (indices.length === k) {
        const spacing = Math.min(...indices.slice(1).map((index, i) => sites[index] - sites[indices[i]]))
        // Enumerate in lexicographic order and keep the first optimum.
        if (spacing > best) {
          best = spacing
          winners = indices
        }
        return
      }
      for (let i = next; i < n; i++) place(i + 1, [...indices, i])
    }
    place(0, [])
    return best + '\n' + winners.map(i => i + 1).join(' ')
  },
  'nested-crates'([line]) {
    let remaining = line
    for (;;) {
      const reduced = remaining.replace(/\(\)|\[\]|\{\}/g, '')
      if (reduced === remaining) return reduced.length ? 'INVALID' : 'VALID'
      remaining = reduced
    }
  },
  'warmer-readings'([header, line]) {
    const [, distance] = numbers(header), readings = numbers(line)
    return readings.map((value, i) =>
      readings.slice(i + 1, i + 1 + distance).findIndex(next => next > value) + 1
    ).join(' ')
  },
  'widest-billboard'([, ...rows]) {
    const panels = rows.map(numbers)
    let best = 0
    for (let i = 0; i < panels.length; i++) {
      for (let end = i + 1; end <= panels.length; end++) {
        const rectangle = panels.slice(i, end)
        best = Math.max(best, sum(rectangle.map(panel => panel[0])) * Math.min(...rectangle.map(panel => panel[1])))
      }
    }
    return String(best)
  },
  'inspection-reach'([header, ...rows]) {
    const [, , start] = numbers(header), roads = rows.map(numbers), sites = new Set([start])
    let count = 0
    while (count !== sites.size) {
      count = sites.size
      for (const [a, b] of roads) {
        if (sites.has(a) || sites.has(b)) {
          sites.add(a)
          sites.add(b)
        }
      }
    }
    return String(sites.size)
  },
  'room-waves'([header, ...grid]) {
    const [r, c] = numbers(header)
    const times: number[][] = grid.map(row => [...row].map(cell => cell === 'S' ? 0 : -1))
    // A square receives at tick t if a neighbor received at t - 1.
    for (let tick = 1; tick <= r * c; tick++) {
      for (let i = 0; i < r; i++) {
        for (let j = 0; j < c; j++) {
          if (grid[i][j] !== '.' || times[i][j] >= 0) continue
          const neighbors = [times[i - 1]?.[j], times[i + 1]?.[j], times[i][j - 1], times[i][j + 1]]
          if (neighbors.includes(tick - 1)) times[i][j] = tick
        }
      }
    }
    return times.map(row => row.join(' ')).join('\n')
  },
  'crate-route-waiver'([header, ...rows]) {
    const [, , start, target] = numbers(header), roads = rows.map(numbers)
    let best = Infinity
    // With positive tolls, an optimal route can omit cycles and waive its largest toll.
    function visit(site: number, visited: number[], cost: number, largest: number) {
      if (site === target) {
        best = Math.min(best, cost - largest)
        return
      }
      for (const [from, to, toll] of roads) {
        if (from === site && !visited.includes(to)) visit(to, [...visited, to], cost + toll, Math.max(largest, toll))
      }
    }
    visit(start, [start], 0, 0)
    return String(Number.isFinite(best) ? best : -1)
  },
  'postcard-counts'([header, closed = '']) {
    const [n] = numbers(header), blocked = new Set(closed ? numbers(closed) : [])
    // Count exact paths with arbitrary precision and apply the modulus only at the end.
    const paths = [1n]
    for (let i = 1; i <= n; i++) paths[i] = blocked.has(i) ? 0n : paths[i - 1] + (paths[i - 2] ?? 0n)
    return String(paths[n] % 1000000007n)
  },
  'study-weeks'([header, line]) {
    const [n, gap] = numbers(header), scores = numbers(line)
    function choose(week: number): number {
      if (week >= n) return 0
      return Math.max(choose(week + 1), scores[week] + choose(week + gap + 1))
    }
    return String(choose(0))
  },
  'courier-switch-fees'([header, ...rows]) {
    const [r, c, fee] = numbers(header), costs = rows.map(numbers)
    const completed: number[] = []
    function move(i: number, j: number, direction: string, bill: number) {
      const cost = bill + costs[i][j]
      if (i === r - 1 && j === c - 1) completed.push(cost)
      if (i + 1 < r) move(i + 1, j, 'down', cost + (direction === 'right' ? fee : 0))
      if (j + 1 < c) move(i, j + 1, 'right', cost + (direction === 'down' ? fee : 0))
    }
    move(0, 0, '', 0)
    const lowest = Math.min(...completed)
    return [lowest, completed.filter(cost => cost === lowest).length % 1000000007].join(' ')
  },
}

test('additional local suites cover every remaining original challenge', () => {
  const ids = practiceChallenges.map(challenge => challenge.id).filter(id => id !== 'minutes-to-clock').sort()
  assert.equal(ids.length, 26)
  assert.deepEqual(Object.keys(additionalJudgeCases).sort(), ids)
  assert.deepEqual(Object.keys(answers).sort(), ids)
})

for (const { id, title, samples } of practiceChallenges.filter(challenge => challenge.id !== 'minutes-to-clock')) {
  test(title + ' public and hidden expectations agree with the reference calculation', () => {
    const cases = additionalJudgeCases[id]
    assert.ok(cases.length >= 2 && cases.length <= 4)
    const fixtures = [...samples.map(({ input, expectedOutput }) => ({ input, answer: expectedOutput })), ...cases]
    assert.equal(new Set(fixtures.map(fixture => fixture.input)).size, fixtures.length)
    for (const { input, answer } of fixtures) {
      assert.ok(input.endsWith('\n') && input.length <= 12_000)
      assert.ok(answer.length > 0 && answer.length <= 12_000 && !answer.endsWith('\n'))
      assert.doesNotMatch(input + answer, /\r|\u0000/)
      assert.equal(answers[id](input.slice(0, -1).split('\n')), answer, id + ' on ' + JSON.stringify(input))
    }
  })
}
