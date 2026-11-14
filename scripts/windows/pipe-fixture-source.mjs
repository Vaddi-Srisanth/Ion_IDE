// Private native controls, not an application/runtime module.
export function pipeFixtureSources(input) {
  const source = input.replaceAll('\r\n', '\n')
  const candidate = 'CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT'
  if (source.split(candidate).length !== 2) throw new Error('Expected exactly one pipe-only runnable launch flag.')
  const pipe = source.slice(source.indexOf('int pipeProcess('), source.indexOf('}  // namespace'))
  if (pipe.includes('ResumeThread(') || pipe.includes('lpReserved2 = descriptors.data()')) {
    throw new Error('The candidate pipe path must have neither manual ResumeThread nor a CRT packet.')
  }
  const ready = '  if (!report(ready)) return failure(ERROR_BROKEN_PIPE);\n'
  if (source.split(ready).length !== 2) throw new Error('Expected exactly one pipe readiness boundary.')
  const resumed = ready + '  if (ResumeThread(thread.get()) == static_cast<DWORD>(-1)) return failure(GetLastError());\n'
  const baseline = source.replace(candidate, 'CREATE_SUSPENDED | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT').replace(ready, resumed)
  return { baseline, detached: baseline.replace('CREATE_SUSPENDED | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT',
    'CREATE_SUSPENDED | DETACHED_PROCESS | EXTENDED_STARTUPINFO_PRESENT') }
}
