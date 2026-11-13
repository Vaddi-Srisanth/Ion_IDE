import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { access, copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parseArgs, promisify } from 'node:util'
import { build } from 'esbuild'
import { buildWindowsPty } from './windows/build-pty.mjs'

const { values } = parseArgs({ options: { source: { type: 'string', default: '.' }, out: { type: 'string' } } })
const sourceRoot = resolve(values.source)
const run = promisify(execFile)
const scratch = await realpath(await mkdtemp(join(tmpdir(), 'ion-notebook-trust-')))
const workspace = join(scratch, 'workspace café 学习')
const bin = join(workspace, process.platform === 'win32' ? 'Scripts' : 'bin')
const marker = join(scratch, 'probe-ran')
const interpreter = join(bin, process.platform === 'win32' ? 'python.exe' : 'python3')
const report = { complete: false, source: sourceRoot, platform: process.platform, cases: [] }
const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'"
try {
  await mkdir(bin, { recursive: true })
  // A real harmless executable proves that a probe ran, not just that a mock
  // spawn callback was called. Windows uses a native fixture on a native host.
  const response = JSON.stringify({ version: '3.11.0', prefix: workspace, names: ['python3'], label: 'Trust fixture' })
  if (process.platform === 'win32') {
    const wide = text => 'L"' + Array.from({ length: text.length }, (_, i) => '\\x' + text.charCodeAt(i).toString(16)).join('') + '"'
    const fixture = join(scratch, 'fixture.c')
    await writeFile(fixture, '#include <stdio.h>\n#include <wchar.h>\nint main(void) { FILE *f = _wfopen(' + wide(marker)
      + ', L"wb"); if (!f) return 9; fputs("executed", f); fclose(f); puts(' + JSON.stringify(response) + '); return 0; }\n')
    // MinGW's linker does not accept every Unicode output path. Compile in the
    // ASCII scratch root, then use native filesystem APIs to place the real
    // executable at the Unicode path whose authorization is being tested.
    const compiled = join(scratch, 'fixture-python.exe')
    await run('gcc.exe', ['-x', 'c', fixture, '-o', compiled], { windowsHide: true, timeout: 30000 })
    await copyFile(compiled, interpreter)
    await buildWindowsPty(join(scratch, 'ion-pty.exe'), 'x64')
  } else {
    await writeFile(interpreter, '#!/bin/sh\nprintf executed > ' + shellQuote(marker)
      + '\nprintf \'%s\\n\' ' + shellQuote(response) + '\n', { mode: 0o700 })
  }
  await build({ entryPoints: { environments: join(sourceRoot, 'src/main/notebooks/python-environments.ts'),
    kernels: join(sourceRoot, 'src/main/notebooks/kernel-service.ts') }, outdir: join(scratch, 'modules'),
    bundle: true, platform: 'node', format: 'cjs', outExtension: { '.js': '.cjs' }, loader: { '.py': 'text' },
    nodePaths: [resolve('node_modules')], logLevel: 'silent' })
  const childScript = join(scratch, 'checks.cjs')
  await writeFile(childScript, `
    const assert=require('node:assert/strict');
    const fs=require('node:fs/promises');
    const {NotebookPythonEnvironments}=require(${JSON.stringify(join(scratch, 'modules/environments.cjs'))});
    const {NotebookKernels}=require(${JSON.stringify(join(scratch, 'modules/kernels.cjs'))});
    const workspace=${JSON.stringify(workspace)}, interpreter=${JSON.stringify(interpreter)}, marker=${JSON.stringify(marker)};
    const exists=()=>fs.access(marker).then(()=>true,()=>false);
    (async()=>{
      const service=new NotebookPythonEnvironments();
      try {
        const found=await service.discover(workspace);
        assert.equal(await exists(),false,'Discovery must never execute an inherited PATH/venv/Conda candidate before authorization.');
        assert.ok(!found.some(item=>item.path===interpreter),'Automatic discovery must exclude workspace-controlled paths.');
        const selected=await service.add(interpreter);
        assert.equal(await exists(),false,'Choosing an interpreter must only inspect its file, not execute it.');
        assert.equal(selected.path,interpreter);
        console.log('PASS non-executing discovery and explicit selection');
        const verified=await service.verify(selected);
        assert.equal(verified.id,selected.id);
        assert.equal(verified.label,'Trust fixture');
        assert.equal(await exists(),true,'Explicitly authorized validation executes the chosen interpreter.');
        await fs.rm(marker);
        const original=await fs.readFile(interpreter);
        await fs.appendFile(interpreter,Buffer.from([10]));
        await assert.rejects(service.verify(selected),/interpreter changed/);
        assert.equal(await exists(),false,'Replaced executables must be rejected before probing.');
        await fs.writeFile(interpreter,original);
        console.log('PASS post-approval validation and changed-interpreter rejection');
        const approved=await service.add(interpreter);
        await fs.appendFile(interpreter,Buffer.from([10]));
        await service.add(interpreter); // Another selection must not renew an earlier approval snapshot.
        await assert.rejects(service.assertCurrent(approved),/interpreter changed/);
        assert.equal(await exists(),false);
        await fs.writeFile(interpreter,original);
        console.log('PASS selection refresh cannot replace an approval snapshot');
      } finally { service.dispose(); }
      const kernels=new NotebookKernels(()=>{});
      try {
        const selected=await kernels.addInterpreter(interpreter);
        let approvals=0;
        const result=await kernels.run(${JSON.stringify(join(workspace, 'notes.ipynb'))},
          {id:'cancel-test',code:'print(42)',environmentId:selected.id},async()=>{approvals++;return false;},workspace);
        assert.equal(approvals,1); assert.equal(result.status,'interrupted');
        assert.equal(await exists(),false,'Declining Run must not execute an interpreter probe or kernel.');
        console.log('PASS declined Run starts no interpreter');
        await assert.rejects(kernels.run(${JSON.stringify(join(workspace, 'notes.ipynb'))},
          {id:'scope-test',code:'print(42)',environmentId:selected.id},async()=>true,workspace,()=>false),/workspace changed/);
        assert.equal(await exists(),false,'A changed workspace must be rejected before validation.');
        await assert.rejects(kernels.run(${JSON.stringify(join(workspace, 'notes.ipynb'))},
          {id:'replacement-test',code:'print(42)',environmentId:selected.id},async()=>{
            await fs.appendFile(interpreter,Buffer.from([10]));
            await kernels.addInterpreter(interpreter);return true;
          },workspace),/interpreter changed/);
        assert.equal(await exists(),false,'An executable changed while the approval prompt was open must not run.');
        console.log('PASS workspace and pending-approval replacement rejection');
      } finally { await kernels.dispose(); }
    })().catch(error=>{console.error(error);process.exitCode=1});
  `)
  const result = await run(process.execPath, [childScript], { env: { ...process.env, PATH: bin,
    VIRTUAL_ENV: workspace, CONDA_PREFIX: workspace,
    ...(process.platform === 'win32' ? { ION_WINDOWS_PROCESS_TEST_HELPER: join(scratch, 'ion-pty.exe') } : {}),
  }, timeout: 60000, windowsHide: true, maxBuffer: 8192 })
  report.cases.push({ name: 'real inherited interpreter marker and declined approval', passed: true, output: result.stdout.trim() })
  assert.equal(await access(marker).then(() => true, () => false), false)
  report.complete = true
  console.log(result.stdout.trim())
} catch (error) {
  report.error = String(error.stderr ?? error.stack ?? error)
  console.error(report.error)
  process.exitCode = 1
} finally {
  await rm(scratch, { recursive: true, force: true })
  if (values.out) {
    const path = resolve(values.out); await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify(report, null, 2) + '\n')
  }
}
