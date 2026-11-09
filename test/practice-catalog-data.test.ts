import assert from 'node:assert/strict'
import { test } from 'node:test'
import { catalogDifficulties, maxPracticeSamples, practiceTopics } from '../src/shared/practice'
import { practiceChallenges } from '../src/main/practice/catalog-data'

test('the offline challenge catalog covers every topic and difficulty with complete runnable examples', () => {
  const combinations = new Set<string>()
  const ids = new Set<string>()
  for (const challenge of practiceChallenges) {
    const { id, title, topic, difficulty, statement, samples } = challenge
    assert.match(id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    assert.ok(!ids.has(id), 'Challenge IDs must be unique.')
    ids.add(id)
    combinations.add(topic + '/' + difficulty)
    assert.ok(title.trim().length > 0 && title.length <= 120)
    assert.ok(statement.length <= 20_000)
    assert.match(statement, /\n\nInput\n.+\n\nOutput\n.+\n\nConstraints\n/s)
    assert.ok(samples.length >= 3 && samples.length <= maxPracticeSamples)
    assert.equal(new Set(samples.map(({ input }) => input)).size, samples.length)
    assert.ok(statement.endsWith('Example input\n' + samples[0].input.trimEnd() + '\n\nExample output\n' + samples[0].expectedOutput))
    for (const { label, input, expectedOutput } of samples) {
      assert.ok(label.trim().length > 0 && label.length <= 80)
      assert.ok(input.endsWith('\n') && input.length <= 12_000)
      assert.ok(expectedOutput.trim().length > 0 && expectedOutput.length <= 12_000)
      assert.doesNotMatch(input + expectedOutput, /\u0000|\r/)
    }
  }
  for (const topic of practiceTopics) {
    for (const difficulty of catalogDifficulties) assert.ok(combinations.has(topic + '/' + difficulty))
  }
})
