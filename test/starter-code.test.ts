import assert from 'node:assert/strict'
import { test } from 'node:test'
import { starterCode, starterLanguageFor, starterLanguages } from '../src/shared/starter-code'

test('selects source starters by extension, preserving the runner’s C++ and Python aliases', () => {
  const files = {
    'lesson.c': 'c', 'lesson.C': 'cpp', 'lesson.cc': 'cpp', 'lesson.cxx': 'cpp', 'lesson.c++': 'cpp',
    'Main.java': 'java', 'lesson.py': 'python', 'lesson.python': 'python',
    'index.mjs': 'javascript', 'index.cjs': 'javascript', 'component.jsx': 'javascript',
    'component.tsx': 'typescript', 'index.htm': 'html', 'script.bash': 'shell', 'script.zsh': 'shell',
  } as const
  for (const [file, id] of Object.entries(files)) assert.equal(starterLanguageFor(file)?.id, id, file)
  for (const file of ['README', 'file.txt', 'file.h', 'file.hpp', 'file.toString', '/folder.py/README']) {
    assert.equal(starterLanguageFor(file), undefined, file)
  }
})

test('each starter’s suggested name resolves and its cursor lands on an empty editable line', () => {
  for (const language of starterLanguages) {
    assert.equal(starterLanguageFor(language.suggestedName), language)
    const { text, line, column } = starterCode(language, language.suggestedName)
    const editableLine = text.split('\n')[line - 1]
    assert.equal(editableLine.trim(), '', language.label)
    assert.equal(column, editableLine.length + 1, language.label)
    assert.ok(text.endsWith('\n'), language.label)
  }
})

test('C and C++ starters use their own standard headers and entry points', () => {
  const c = starterCode(starterLanguages[0], 'example.c')
  assert.match(c.text, /^#include <stdio\.h>\n\nint main\(void\) \{[\s\S]*return 0;\n\}\n$/)
  const cpp = starterCode(starterLanguages[1], 'example.C')
  assert.match(cpp.text, /^#include <iostream>\n\nint main\(\) \{/)
})

test('Java matches safe filenames and falls back to a portable class for other names', () => {
  const java = starterLanguages[2]
  const named = starterCode(java, 'C:\\lesson\\Hello_2.java').text
  assert.match(named, /^public class Hello_2 \{/)
  assert.match(named, /public static void main\(String\[\] args\)/)
  for (const file of ['class.java', 'var.java', 'record.java', '_.java', 'has-dashes.java', '123.java', '☀.java']) {
    assert.match(starterCode(java, file).text, /^class Main \{/, file)
  }
  assert.match(starterCode(java, 'Hello.java', { portableJava: true }).text, /^class Main \{/)
})
