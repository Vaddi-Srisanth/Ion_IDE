/** Ion-owned source-file launcher for JDK 17+. It runs only inside an approved test operation. */
export const junitHelper = String.raw`import com.sun.source.tree.*;
import com.sun.source.util.*;
import java.io.*;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.stream.Collectors;
import javax.lang.model.element.*;
import javax.tools.*;
import org.junit.jupiter.engine.JupiterTestEngine;
import org.junit.platform.engine.*;
import org.junit.platform.engine.discovery.DiscoverySelectors;
import org.junit.platform.engine.reporting.ReportEntry;
import org.junit.platform.engine.support.descriptor.MethodSource;
import org.junit.platform.launcher.*;
import org.junit.platform.launcher.core.*;

class IonJUnit {
    record Location(String path, long line) {
        String json() { return "{\"path\":" + quote(path) + ",\"line\":" + line + "}"; }
    }

    // Use the compiler's source positions and resolved method signatures. JUnit's
    // MethodSource identifies the declaring method even for nested/inherited tests.
    static Map<String,Location> compile(Path root, Path classes, String jar) throws Exception {
        Map<String,Location> locations = new HashMap<>();
        List<Path> files;
        try (var paths = Files.walk(root)) {
            files = paths.filter(p -> p.toString().endsWith(".java") && Files.isRegularFile(p, LinkOption.NOFOLLOW_LINKS)).sorted().toList();
        }
        if (files.isEmpty()) return locations;
        var compiler = ToolProvider.getSystemJavaCompiler();
        if (compiler == null) throw new IOException("JUnit requires a full JDK 17 or newer.");
        List<String> errors = new ArrayList<>();
        DiagnosticListener<JavaFileObject> diagnostics = d -> {
            if (d.getKind() == Diagnostic.Kind.ERROR && errors.size() < 3)
                errors.add(clipped(d.getMessage(Locale.ROOT)));
        };
        try (var manager = compiler.getStandardFileManager(diagnostics, Locale.ROOT, StandardCharsets.UTF_8)) {
            var task = (JavacTask)compiler.getTask(null, manager, diagnostics,
                List.of("-proc:none", "-implicit:none", "-classpath", jar, "-sourcepath", classes.toString(), "-d", classes.toString()), null, manager.getJavaFileObjectsFromPaths(files));
            List<CompilationUnitTree> units = new ArrayList<>();
            task.parse().forEach(units::add);
            task.analyze();
            if (!errors.isEmpty()) throw new IOException("Java compilation failed: " + String.join("\n", errors));
            var trees = Trees.instance(task);
            for (var unit : units) {
                String path = root.relativize(Path.of(unit.getSourceFile().toUri())).toString().replace(File.separatorChar, '/');
                new TreePathScanner<Void,Void>() {
                    @Override public Void visitMethod(MethodTree tree, Void unused) {
                        if (trees.getElement(getCurrentPath()) instanceof ExecutableElement method && method.getEnclosingElement() instanceof TypeElement owner) {
                            String parameters = method.getParameters().stream().map(p -> task.getTypes().erasure(p.asType()).toString()).collect(Collectors.joining(","));
                            String key = task.getElements().getBinaryName(owner) + "#" + method.getSimpleName() + "(" + parameters + ")";
                            long pos = trees.getSourcePositions().getStartPosition(unit, tree);
                            if (pos >= 0) locations.put(key, new Location(path, unit.getLineMap().getLineNumber(pos)));
                        }
                        return super.visitMethod(tree, unused);
                    }
                }.scan(unit, null);
            }
            task.generate();
            if (!errors.isEmpty()) throw new IOException("Java compilation failed: " + String.join("\n", errors));
        }
        return locations;
    }

    static String clipped(String value) {
        StringBuilder result = new StringBuilder();
        int size = 0;
        for (int i = 0; i < value.length();) {
            int c = value.codePointAt(i);
            i += Character.charCount(c);
            if (c == 0) continue;
            size += c <= 127 ? 1 : c <= 2047 ? 2 : c <= 65535 ? 3 : 4;
            if (size > 2048) break;
            result.appendCodePoint(c);
        }
        return result.toString();
    }
    static String quote(String value) {
        StringBuilder s = new StringBuilder("\"");
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (c == '"' || c == '\\') s.append('\\').append(c);
            else if (c < 32) s.append(String.format("\\u%04x", (int)c));
            else s.append(c);
        }
        return s.append('"').toString();
    }

    static final class Report implements AutoCloseable {
        final OutputStream stream;
        int written;
        Report(Path path) throws IOException { stream = Files.newOutputStream(path, StandardOpenOption.CREATE_NEW); }
        void write(String json, boolean footer) {
            byte[] bytes = (json + "\n").getBytes(StandardCharsets.UTF_8);
            if (written + bytes.length > 2 * 1024 * 1024 - (footer ? 0 : 16384)) throw new IllegalStateException("JUnit report exceeds 2 MiB.");
            try { stream.write(bytes); stream.flush(); written += bytes.length; }
            catch (IOException e) { throw new UncheckedIOException(e); }
        }
        public void close() throws IOException { stream.close(); }
    }

    static final class Case {
        final TestIdentifier test;
        final Location location;
        final String selector;
        final boolean group;
        long start;
        boolean finished;
        String outcome = "", message = "", output = "";
        Case(TestIdentifier test, Location location) {
            this.test = test; this.location = location;
            selector = location.path() + "::" + test.getUniqueId();
            group = !test.isTest();
        }
        String node() {
            return "{\"selector\":" + quote(selector) + ",\"label\":" + quote(clipped(test.getDisplayName())) + ",\"location\":" + location.json() + "}";
        }
        void observe(String next, String detail) {
            List<String> priority = List.of("", "skipped", "passed", "failed", "error");
            if (priority.indexOf(next) > priority.indexOf(outcome)) {
                outcome = next;
                message = clipped(detail);
            }
        }
    }

    static Map<UniqueId,Case> cases(TestPlan plan, Map<String,Location> locations) {
        Map<UniqueId,Case> rows = new LinkedHashMap<>();
        for (var engine : plan.getRoots()) for (var test : plan.getDescendants(engine)) {
            String segment = test.getUniqueIdObject().getLastSegment().getType();
            if (!test.isTest() && !segment.equals("test-template") && !segment.equals("test-factory")) {
                if (segment.equals("class-template")) throw new IllegalArgumentException("JUnit parameterized classes are not supported.");
                continue;
            }
            if (!(test.getSource().orElse(null) instanceof MethodSource source)) throw new IllegalArgumentException("JUnit test has no Java method source.");
            Method method = source.getJavaMethod();
            String parameters = Arrays.stream(method.getParameterTypes()).map(Class::getCanonicalName).collect(Collectors.joining(","));
            String key = method.getDeclaringClass().getName() + "#" + method.getName() + "(" + parameters + ")";
            Location location = locations.get(key);
            if (location == null) throw new IllegalArgumentException("JUnit test source is outside the compiled Java sources: " + key);
            if (rows.size() >= 1000) throw new IllegalArgumentException("JUnit collection exceeds 1000 methods.");
            rows.put(test.getUniqueIdObject(), new Case(test, location));
        }
        return rows;
    }

    static final class Outcomes implements TestExecutionListener {
        final Map<UniqueId,Case> rows;
        final Report report;
        final List<String> errors;
        Outcomes(Map<UniqueId,Case> rows, Report report, List<String> errors) { this.rows = rows; this.report = report; this.errors = errors; }

        Case owner(UniqueId id) {
            for (;;) {
                Case row = rows.get(id);
                if (row != null) return row;
                if (id.getSegments().size() == 1) return null;
                id = id.removeLastSegment();
            }
        }
        void finish(Case row) {
            if (row.finished) return;
            long duration = row.start == 0 ? 0 : (System.nanoTime() - row.start) / 1000000;
            report.write("{\"kind\":\"case\",\"case\":{\"selector\":" + quote(row.selector) + ",\"outcome\":" + quote(row.outcome) +
                ",\"durationMs\":" + duration + ",\"message\":" + quote(row.message) + ",\"output\":" + quote(row.output) +
                ",\"location\":" + row.location.json() + ",\"finished\":true}}", false);
            row.finished = true;
        }
        @Override public void executionStarted(TestIdentifier test) {
            Case row = rows.get(test.getUniqueIdObject());
            if (row != null) row.start = System.nanoTime();
        }
        @Override public void reportingEntryPublished(TestIdentifier test, ReportEntry entry) {
            Case row = owner(test.getUniqueIdObject());
            if (row != null) for (String key : List.of("stdout", "stderr")) {
                String text = entry.getKeyValuePairs().get(key);
                if (text != null) row.output = clipped(row.output + text);
            }
        }
        void blocked(UniqueId parent, String outcome, String detail) {
            for (var entry : rows.entrySet()) if (!entry.getValue().finished && entry.getKey().hasPrefix(parent)) {
                Case row = entry.getValue();
                row.observe(outcome, detail);
                finish(row);
            }
        }
        @Override public void executionSkipped(TestIdentifier test, String reason) {
            UniqueId id = test.getUniqueIdObject();
            Case row = owner(id);
            if (row == null) blocked(id, "skipped", reason);
            else { row.observe("skipped", reason); if (rows.containsKey(id)) finish(row); }
        }
        @Override public void executionFinished(TestIdentifier test, TestExecutionResult result) {
            UniqueId id = test.getUniqueIdObject();
            Case row = owner(id);
            Throwable cause = result.getThrowable().orElse(null);
            String detail = cause == null ? "" : cause.toString();
            String outcome = switch (result.getStatus()) {
                case SUCCESSFUL -> "passed";
                case ABORTED -> "skipped";
                case FAILED -> cause instanceof AssertionError ? "failed" : "error";
            };
            if (row == null) {
                if (!outcome.equals("passed")) {
                    if (!outcome.equals("skipped") && errors.isEmpty()) errors.add(clipped(test.getDisplayName() + ": " + detail));
                    blocked(id, outcome.equals("skipped") ? "skipped" : "error", detail);
                }
                return;
            }
            // A successful factory/template container supplies no test evidence on its own.
            if (test.isTest() || !outcome.equals("passed")) row.observe(outcome, detail);
            if (rows.containsKey(id)) {
                if (row.group && row.outcome.isEmpty()) row.observe("error", "JUnit supplied no invocation outcomes for this method.");
                finish(row);
            }
        }
    }

    static int operate(String[] args, Report report, List<String> errors) throws Exception {
        boolean run = args[0].equals("run");
        Path root = Path.of(args[1]).toRealPath(), classes = Path.of(args[2]);
        var sources = compile(root, classes, args[3]);
        var selected = Files.readAllLines(Path.of(args[4]), StandardCharsets.UTF_8);
        var request = LauncherDiscoveryRequestBuilder.request().enableImplicitConfigurationParameters(false)
            .configurationParameter("junit.jupiter.execution.parallel.enabled", "false")
            .configurationParameter("junit.platform.output.capture.stdout", "true")
            .configurationParameter("junit.platform.output.capture.stderr", "true")
            .configurationParameter("junit.platform.output.capture.maxBuffer", "2048");
        if (run) for (String selector : selected)
            request.selectors(DiscoverySelectors.selectUniqueId(selector.substring(selector.indexOf("::") + 2)));
        else request.selectors(DiscoverySelectors.selectClasspathRoots(Set.of(classes)));
        Launcher launcher = LauncherFactory.create(LauncherConfig.builder()
            .enableTestEngineAutoRegistration(false).addTestEngines(new JupiterTestEngine())
            .enableTestExecutionListenerAutoRegistration(false).enableLauncherSessionListenerAutoRegistration(false)
            .enableLauncherDiscoveryListenerAutoRegistration(false).enablePostDiscoveryFilterAutoRegistration(false).build());
        TestPlan plan = launcher.discover(request.build());
        var rows = cases(plan, sources);
        if (run && !new HashSet<>(selected).equals(rows.values().stream().map(c -> c.selector).collect(Collectors.toSet())))
            throw new IllegalArgumentException("Selected JUnit identities changed. Discover again.");
        report.write("{\"kind\":\"collection\",\"nodes\":[" + rows.values().stream().map(Case::node).collect(Collectors.joining(",")) + "]}", false);
        if (!run) return rows.isEmpty() ? 5 : 0;
        launcher.execute(plan, new Outcomes(rows, report, errors));
        if (rows.values().stream().anyMatch(c -> !c.finished) && errors.isEmpty()) errors.add("JUnit did not finish the selected methods.");
        if (!errors.isEmpty()) return 3;
        return rows.values().stream().anyMatch(c -> c.outcome.equals("failed") || c.outcome.equals("error")) ? 1 : 0;
    }

    public static void main(String[] args) throws IOException {
        long started = System.nanoTime();
        List<String> errors = new ArrayList<>();
        int exit = 3;
        try (Report report = new Report(Path.of(args[5]))) {
            try { exit = operate(args, report, errors); }
            catch (Exception | LinkageError e) { errors.clear(); errors.add(clipped(e.toString())); }
            report.write("{\"kind\":\"complete\",\"version\":1,\"complete\":true,\"exitCode\":" + exit +
                ",\"durationMs\":" + (System.nanoTime() - started) / 1000000 + ",\"errors\":[" +
                errors.stream().map(IonJUnit::quote).collect(Collectors.joining(",")) + "]}", true);
        }
        System.exit(exit);
    }
}
`
