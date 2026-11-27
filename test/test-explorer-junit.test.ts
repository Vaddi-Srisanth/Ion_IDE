import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { revision, WorkspaceFiles } from '../src/main/files'
import { TestExplorerService } from '../src/main/test-explorer/service'
import { prepareJunit } from '../src/main/test-explorer/junit'

test('JUnit rejects unsafe or fabricated selections before consulting installed tools', async () => {
  for (const value of ['../Thing.java::[engine:junit-jupiter]/[method:test()]', 'Thing.java::display-name', 'Thing.java::[engine:junit-jupiter]/bad\narg']) {
    await assert.rejects(prepareJunit('/workspace', ['/workspace'], '/scratch', 'run', [value]), /test|selector|selection/i)
  }
  await assert.rejects(prepareJunit('/workspace', ['/workspace'], '/scratch', 'run', []), /selection|discover/i)
})

const jar = process.env.ION_JUNIT_PLATFORM_JAR
test('JUnit checks installed jar bytes and stages only the reviewed saved Java revisions', { skip: !jar }, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'ion-junit-inputs-')))
  const root = join(directory, 'workspace'), scratch = join(directory, 'private')
  await mkdir(root); await mkdir(scratch)
  t.after(async () => { process.env.ION_JUNIT_PLATFORM_JAR = jar; await rm(directory, { recursive: true, force: true }) })
  process.env.ION_JUNIT_PLATFORM_JAR = join(root, 'test.jar')
  await writeFile(process.env.ION_JUNIT_PLATFORM_JAR, 'fake')
  await assert.rejects(prepareJunit(root, [root], scratch, 'discover', []), /outside every workspace/)
  process.env.ION_JUNIT_PLATFORM_JAR = join(directory, 'fake.jar')
  await writeFile(process.env.ION_JUNIT_PLATFORM_JAR, 'fake')
  await assert.rejects(prepareJunit(root, [root], scratch, 'discover', []), /Unrecognized JUnit Platform jar/)
  process.env.ION_JUNIT_PLATFORM_JAR = jar
  const plan = await prepareJunit(root, [root], scratch, 'discover', [])
  const file = join(root, 'Example.java')
  await writeFile(file, 'class Example {}')
  const original = revision(await stat(file, { bigint: true }))
  await writeFile(file, 'class Changed {}')
  await assert.rejects(plan.stageSources!({ 'Example.java': original }), /changed/)
  await assert.rejects(access(join(scratch, 'sources', 'Example.java')), { code: 'ENOENT' })
})

test('real JUnit discovery, unique-ID execution, source links, outcomes, cancellation and cleanup', { skip: !jar, timeout: 120_000 }, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'ion-junit-live-')))
  const root = join(directory, 'workspace with spaces'), profile = join(directory, 'profile')
  const source = join(root, 'src', 'test', 'java', 'demo', 'Cases.java'), main = join(root, 'src', 'main', 'java', 'demo', 'Calc.java')
  await mkdir(dirname(source), { recursive: true })
  await mkdir(dirname(main), { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true }))
  await writeFile(main, 'package demo; class Calc { static int doubleIt(int x) { return 2*x; } }')
  const lines = [
    'package demo;', 'import org.junit.jupiter.api.*;', 'import org.junit.jupiter.params.*;', 'import org.junit.jupiter.params.provider.*;',
    'import java.nio.file.*;', 'import java.util.stream.Stream;', 'class Cases {',
    ' @Test @DisplayName("same label") void pass() { System.out.println("actual stdout"); Assertions.assertEquals(4, Calc.doubleIt(2)); }',
    ' @Test @DisplayName("same label") void fail() { Assertions.fail("observed assertion"); }',
    ' @Test @DisplayName("same label") void untouched() throws Exception { Files.createFile(Path.of("unselected-ran")); }',
    ' @Disabled("real skip") @Test void disabled() {}',
    ' @ParameterizedTest @ValueSource(ints={1,2}) void parameter(int n) { Assertions.assertNotEquals(2, n, "second invocation failed"); }',
    ' @TestFactory Stream<DynamicTest> factory() { return Stream.of(DynamicTest.dynamicTest("dynamic", () -> Assertions.assertTrue(true))); }',
    ' @TestFactory Stream<DynamicTest> emptyFactory() { return Stream.empty(); }',
    ' @Nested class Inner { @Test void nested() { } }',
    ' @Nested class Broken { @BeforeAll static void setup() { throw new IllegalStateException("fixture setup"); } @Test void blocked() {} }',
    ' @Test void slow() throws Exception { Files.createFile(Path.of("slow-started")); Thread.sleep(30_000L); }',
    '}',
  ]
  await writeFile(source, lines.join('\n'))
  const files = new WorkspaceFiles(); await files.grant(root, 'folder', true)
  const scratches: string[] = []
  let allow = false
  const service = new TestExplorerService({ profile: () => profile, files: () => files, approve: async review => {
    assert.match(review.warning, /JUnit Jupiter/)
    assert.match(review.warning, /5\.13\.4/)
    assert.ok(review.args.includes('--class-path'))
    const helper = review.args.find(arg => arg.endsWith('IonJUnit.java'))!
    scratches.push(dirname(helper))
    return allow
  } })
  t.after(() => service.close())
  assert.equal((await service.discover(root, 'junit')).status, 'cancelled')
  allow = true
  const discovery = await service.discover(root, 'junit')
  assert.equal(discovery.status, 'completed', discovery.message)
  const snapshot = discovery.snapshot!
  const cases = snapshot.nodes.filter(n => n.kind === 'test')
  assert.equal(cases.length, 10)
  assert.equal(cases.filter(n => n.label === 'same label').length, 3)
  assert.ok(cases.every(n => n.location?.path === 'src/test/java/demo/Cases.java'))
  const at = (fragment: string) => cases.find(n => n.location?.line === lines.findIndex(line => line.includes(fragment)) + 1)!
  assert.notEqual(at('void pass()').id, at('void fail()').id)
  const selected = ['void pass()', 'void fail()', 'void disabled()', 'void parameter(', 'Stream<DynamicTest> factory()', 'void nested()'].map(text => at(text).id)
  const run = await service.run(root, snapshot.revision, selected)
  assert.equal(run.status, 'completed', run.message)
  const actual = run.snapshot!.history.at(-1)!.cases
  const result = (fragment: string) => actual.find(c => c.id === at(fragment).id)!
  assert.deepEqual(actual.map(c => c.outcome).sort(), ['failed', 'failed', 'passed', 'passed', 'passed', 'skipped'])
  assert.match(result('void pass()').output, /actual stdout/)
  assert.match(result('void fail()').message, /observed assertion/)
  assert.match(result('void parameter(').message, /second invocation failed/)
  assert.match(result('void disabled()').message, /real skip/)
  await assert.rejects(access(join(root, 'unselected-ran')), { code: 'ENOENT' })
  const broken = await service.run(root, run.snapshot!.revision, [at('void blocked()').id])
  assert.equal(broken.status, 'failed', broken.message)
  assert.equal(broken.snapshot!.history.at(-1)!.cases[0].outcome, 'error')
  assert.match(broken.snapshot!.history.at(-1)!.cases[0].message, /fixture setup/)
  const empty = await service.run(root, broken.snapshot!.revision, [at('Stream<DynamicTest> emptyFactory()').id])
  assert.equal(empty.status, 'failed', empty.message)
  assert.equal(empty.snapshot!.history.at(-1)!.cases[0].outcome, 'error')
  assert.match(empty.snapshot!.history.at(-1)!.cases[0].message, /no invocation outcomes/)
  const pending = service.run(root, empty.snapshot!.revision, [at('void slow()').id])
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline && !await access(join(root, 'slow-started')).then(() => true, () => false)) {
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  try { await access(join(root, 'slow-started')) }
  finally { service.cancel() }
  const stopped = await pending
  assert.equal(stopped.status, 'cancelled', stopped.message)
  assert.equal(stopped.snapshot!.history.at(-1)!.cases[0].outcome, 'cancelled')
  await service.drain()
  await writeFile(source, (await readFile(source, 'utf8')) + '\n// edit')
  assert.equal((await service.list(root))?.stale, true)
  for (const scratch of scratches) await assert.rejects(access(scratch), { code: 'ENOENT' })
})
