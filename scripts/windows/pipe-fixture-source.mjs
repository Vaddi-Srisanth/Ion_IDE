// Private native controls, not an application/runtime module.
export function pipeFixtureSources(input) {
  const source = input.replaceAll('\r\n', '\n')
  const candidate = 'CREATE_SUSPENDED | DETACHED_PROCESS | EXTENDED_STARTUPINFO_PRESENT'
  if (source.split(candidate).length !== 2) throw new Error('Expected exactly one pipe-only detached launch flag.')
  const packet = /  \/\/ CRT_STDIO_INHERITANCE_BEGIN\n[\s\S]*?  \/\/ CRT_STDIO_INHERITANCE_END\n/g
  if ([...source.matchAll(packet)].length !== 1) throw new Error('Expected one bounded standard-descriptor inheritance packet.')
  const detached = source.replace(packet, '')
  return { detached, baseline: detached.replace(candidate, 'CREATE_SUSPENDED | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT') }
}
