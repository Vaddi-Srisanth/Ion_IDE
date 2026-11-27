import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isWithin } from '../src/renderer/paths'

test('renderer workspace scoping follows Windows path casing without broadening sibling roots', () => {
  assert.equal(isWithin('c:\\users\\student\\course\\main.c', 'C:\\Users\\Student\\Course', 'win32'), true)
  assert.equal(isWithin('C:/Users/Student/Course/main.c', 'c:\\users\\student\\course', 'win32'), true)
  assert.equal(isWithin('C:\\Users\\Student\\Coursework\\main.c', 'c:\\users\\student\\course', 'win32'), false)
  assert.equal(isWithin('C:\\Users\\Student\\Course', 'c:\\users\\student\\course', 'win32'), true)
})

test('renderer workspace scoping preserves case-sensitive platform behavior', () => {
  assert.equal(isWithin('/Users/student/course/main.c', '/Users/student/course', 'darwin'), true)
  assert.equal(isWithin('/Users/Student/course/main.c', '/Users/student/course', 'darwin'), false)
  assert.equal(isWithin('/Users/student/coursework/main.c', '/Users/student/course', 'darwin'), false)
})
