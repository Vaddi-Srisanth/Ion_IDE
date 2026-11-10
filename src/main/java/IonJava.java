import com.sun.source.tree.*;
import com.sun.source.util.*;
import java.io.*;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.regex.Pattern;
import javax.lang.model.element.*;
import javax.lang.model.type.*;
import javax.tools.*;

class IonJava {
    private static final String PROBE = "__ion_cursor__";
    private static final int LIMIT = 100;
    private static final List<String> STANDARD = List.of(
        "java.lang", "java.util", "java.io", "java.nio.file", "java.time", "java.math",
        "java.util.concurrent", "java.util.function", "java.util.stream");
    private static final Pattern IMPORT_PREFIX = Pattern.compile(
        "\\s*import\\s+((?:\\p{javaJavaIdentifierStart}\\p{javaJavaIdentifierPart}*\\.)*)");
    private static final Base64.Encoder ENCODER = Base64.getEncoder();
    private static final Base64.Decoder DECODER = Base64.getDecoder();

    static String encode(String value) {
        return ENCODER.encodeToString(value.getBytes(StandardCharsets.UTF_8));
    }

    static String decode(String value) {
        return new String(DECODER.decode(value), StandardCharsets.UTF_8);
    }

    static String field(Object value) {
        String text = String.valueOf(value);
        return encode(text.substring(0, Math.min(2048, text.length())));
    }

    static void add(List<String> result, Object... fields) {
        if (result.size() >= LIMIT) return;
        result.add(String.join("\t", Arrays.stream(fields).map(IonJava::field).toList()));
    }

    static class Source extends SimpleJavaFileObject {
        final String text;

        Source(Path path, String text) {
            super(path.toUri(), Kind.SOURCE);
            this.text = text;
        }

        @Override public CharSequence getCharContent(boolean ignoreEncodingErrors) {
            return text;
        }
    }

    static class ScopedFiles extends ForwardingJavaFileManager<StandardJavaFileManager> {
        final Path root;

        ScopedFiles(StandardJavaFileManager files, Path root) {
            super(files);
            this.root = root;
        }

        boolean safe(JavaFileObject file) {
            try {
                return file != null && "file".equals(file.toUri().getScheme())
                    && Path.of(file.toUri()).toRealPath().startsWith(root)
                    && Files.size(Path.of(file.toUri())) <= 512 * 1024;
            } catch (IOException | IllegalArgumentException ignored) {
                return false;
            }
        }

        @Override public Iterable<JavaFileObject> list(Location location, String name,
            Set<JavaFileObject.Kind> kinds, boolean recurse) throws IOException {
            var files = super.list(location, name, kinds, recurse);
            if (location != StandardLocation.SOURCE_PATH) return files;
            var result = new ArrayList<JavaFileObject>();
            for (var file : files) {
                if (safe(file)) result.add(file);
                if (result.size() >= 256) break;
            }
            return result;
        }

        @Override public JavaFileObject getJavaFileForInput(Location location, String name, JavaFileObject.Kind kind)
            throws IOException {
            var file = super.getJavaFileForInput(location, name, kind);
            return location == StandardLocation.SOURCE_PATH && !safe(file) ? null : file;
        }
    }

    static class Analysis {
        final Trees trees;
        final JavacTask task;
        final CompilationUnitTree unit;
        final SourcePositions positions;

        Analysis(JavacTask task) throws IOException {
            this.task = task;
            unit = task.parse().iterator().next();
            task.analyze();
            trees = Trees.instance(task);
            positions = trees.getSourcePositions();
        }

        TreePath at(int offset) {
            var paths = new TreePathScanner<TreePath, Void>() {
                @Override public TreePath scan(Tree node, Void ignored) {
                    if (node == null) return null;
                    long start = positions.getStartPosition(unit, node);
                    long end = positions.getEndPosition(unit, node);
                    if (node != unit && (start < 0 || start > offset || end < offset)) return null;
                    var path = super.scan(node, null);
                    return path != null ? path : node == unit ? new TreePath(unit) : new TreePath(getCurrentPath(), node);
                }

                @Override public TreePath reduce(TreePath first, TreePath second) {
                    return first != null ? first : second;
                }
            };
            return paths.scan(unit, null);
        }

        TreePath probe() {
            return new TreePathScanner<TreePath, Void>() {
                @Override public TreePath visitIdentifier(IdentifierTree tree, Void ignored) {
                    return tree.getName().contentEquals(PROBE) ? getCurrentPath() : null;
                }

                @Override public TreePath visitMemberSelect(MemberSelectTree tree, Void ignored) {
                    return tree.getIdentifier().contentEquals(PROBE) ? getCurrentPath() : super.visitMemberSelect(tree, ignored);
                }

                @Override public TreePath reduce(TreePath first, TreePath second) {
                    return first != null ? first : second;
                }
            }.scan(unit, null);
        }

        Scope scope(TreePath path) {
            try { return path == null ? null : trees.getScope(path); }
            catch (IllegalArgumentException ignored) { return null; }
        }

        DeclaredType receiver(TreePath path) {
            if (!(path.getLeaf() instanceof MemberSelectTree select)) return null;
            TypeMirror type = trees.getTypeMirror(new TreePath(path, select.getExpression()));
            if (type instanceof TypeVariable variable) type = variable.getUpperBound();
            return type instanceof DeclaredType declared && type.getKind() != TypeKind.ERROR ? declared : null;
        }

        List<? extends Element> members(DeclaredType type) {
            return task.getElements().getAllMembers((TypeElement) type.asElement());
        }

        void completeImport(List<String> result, String parent, String prefix) {
            var seen = new HashSet<String>();
            for (var candidate : STANDARD) {
                if (!candidate.startsWith(parent) || candidate.length() == parent.length()) continue;
                var segment = candidate.substring(parent.length()).split("\\.", 2)[0];
                if (segment.startsWith(prefix) && seen.add(segment)) add(result, segment, "package", parent + segment, segment);
            }
            if (parent.isEmpty()) return;
            var pkg = task.getElements().getPackageElement(parent.substring(0, parent.length() - 1));
            if (pkg == null) return;
            for (var element : pkg.getEnclosedElements()) {
                if (element.getModifiers().contains(Modifier.PUBLIC)) offer(result, seen, element, prefix, null);
            }
        }

        void complete(List<String> result, int offset, String prefix) {
            TreePath path = probe();
            Scope scope = scope(path != null ? path : at(offset));
            var seen = new HashSet<String>();
            if (path != null && path.getLeaf() instanceof MemberSelectTree select) {
                var receiverPath = new TreePath(path, select.getExpression());
                Element selected = trees.getElement(receiverPath);
                if (selected instanceof PackageElement pkg) {
                    for (var element : pkg.getEnclosedElements()) offer(result, seen, element, prefix, null);
                    return;
                }
                var receiver = receiver(path);
                if (receiver == null) return;
                for (var member : members(receiver)) {
                    if (scope != null && !trees.isAccessible(scope, member, receiver)) continue;
                    if (selected instanceof TypeElement && !member.getModifiers().contains(Modifier.STATIC)) continue;
                    offer(result, seen, member, prefix, null);
                }
                return;
            }
            TypeElement owner = scope == null ? null : scope.getEnclosingClass();
            for (Scope frame = scope; frame != null && result.size() < LIMIT; frame = frame.getEnclosingScope()) {
                for (var element : frame.getLocalElements()) offer(result, seen, element, prefix, null);
            }
            if (owner != null) {
                for (var member : members((DeclaredType) owner.asType())) offer(result, seen, member, prefix, null);
            }
            if (prefix.length() < 2) return;
            var names = new LinkedHashSet<>(STANDARD);
            for (var imported : unit.getImports()) {
                String name = imported.getQualifiedIdentifier().toString();
                int dot = name.lastIndexOf('.');
                if (!imported.isStatic() && dot > 0 && names.size() < 20) names.add(name.substring(0, dot));
            }
            for (var name : names) {
                var pkg = task.getElements().getPackageElement(name);
                if (pkg == null) continue;
                for (var item : pkg.getEnclosedElements()) {
                    if (item instanceof TypeElement type && item.getModifiers().contains(Modifier.PUBLIC)) {
                        offer(result, seen, type, prefix, name.equals("java.lang") ? null : type.getQualifiedName().toString());
                    }
                }
            }
        }

        void signature(List<String> result, int offset, String text) {
            var path = at(offset);
            while (path != null && !(path.getLeaf() instanceof MethodInvocationTree)) path = path.getParentPath();
            if (path == null) return;
            var call = (MethodInvocationTree) path.getLeaf();
            var selector = new TreePath(path, call.getMethodSelect());
            var select = call.getMethodSelect();
            var memberName = select instanceof MemberSelectTree member ? member.getIdentifier().toString() : select.toString();
            var declared = receiver(selector);
            Scope scope = scope(path);
            if (declared == null && scope != null && scope.getEnclosingClass() != null) {
                declared = (DeclaredType) scope.getEnclosingClass().asType();
            }
            var candidates = new LinkedHashSet<ExecutableElement>();
            if (trees.getElement(path) instanceof ExecutableElement executable) candidates.add(executable);
            if (declared != null) {
                for (var member : members(declared)) {
                    if (member instanceof ExecutableElement executable && member.getSimpleName().contentEquals(memberName)
                        && (scope == null || trees.isAccessible(scope, member, declared))) candidates.add(executable);
                }
            }
            int index = 0;
            for (var argument : call.getArguments()) {
                long end = positions.getEndPosition(unit, argument);
                if (end >= 0 && end < offset && text.substring((int) end, offset).stripLeading().startsWith(",")) index++;
            }
            for (var method : candidates) {
                var fields = new ArrayList<Object>();
                fields.add(index);
                var parameters = method.getParameters().stream()
                    .map(parameter -> parameter.asType() + " " + parameter.getSimpleName()).toList();
                fields.add(method.getSimpleName() + "(" + String.join(", ", parameters) + ")");
                fields.addAll(parameters);
                add(result, fields.toArray());
            }
        }

        void navigate(List<String> result, int offset, boolean references) {
            TreePath current = at(offset);
            Element target = current == null ? null : trees.getElement(current);
            if (target == null) return;
            if (!references) {
                locate(result, trees.getPath(target), target);
                return;
            }
            new TreePathScanner<Void, Void>() {
                @Override public Void visitIdentifier(IdentifierTree tree, Void ignored) {
                    if (target.equals(trees.getElement(getCurrentPath()))) locate(result, getCurrentPath(), target);
                    return null;
                }

                @Override public Void visitMemberSelect(MemberSelectTree tree, Void ignored) {
                    if (target.equals(trees.getElement(getCurrentPath()))) locate(result, getCurrentPath(), target);
                    return super.visitMemberSelect(tree, ignored);
                }
            }.scan(unit, null);
        }

        void locate(List<String> result, TreePath path, Element target) {
            if (path == null) return;
            var file = path.getCompilationUnit();
            var uri = file.getSourceFile().toUri();
            if (!"file".equals(uri.getScheme())) return;
            long start = positions.getStartPosition(file, path.getLeaf());
            if (path.getLeaf() instanceof MemberSelectTree member) {
                start = positions.getEndPosition(file, member) - member.getIdentifier().length();
            } else if (path.getLeaf() instanceof MethodTree || path.getLeaf() instanceof VariableTree
                || path.getLeaf() instanceof ClassTree) {
                try {
                    var text = file.getSourceFile().getCharContent(true);
                    var name = target.getSimpleName().toString();
                    var matcher = Pattern.compile("(?<![\\p{javaJavaIdentifierPart}])"
                        + Pattern.quote(name) + "(?![\\p{javaJavaIdentifierPart}])").matcher(text);
                    long end = positions.getEndPosition(file, path.getLeaf());
                    if (start >= 0 && end >= start && end <= text.length()
                        && matcher.region((int) start, (int) Math.min(end, start + 512)).find()) start = matcher.start();
                } catch (IOException ignored) {}
            }
            if (start < 0) return;
            add(result, Path.of(uri), file.getLineMap().getLineNumber(start), file.getLineMap().getColumnNumber(start));
        }
    }

    static void offer(List<String> result, Set<String> seen, Element symbol, String prefix, String qualified) {
        String name = symbol.getSimpleName().toString();
        if (result.size() >= LIMIT || name.isEmpty() || !name.startsWith(prefix) || name.equals(PROBE)) return;
        String kind = switch (symbol.getKind()) {
            case CLASS, RECORD, ENUM, INTERFACE, ANNOTATION_TYPE -> "class";
            case METHOD -> "method";
            case FIELD, ENUM_CONSTANT -> "field";
            case LOCAL_VARIABLE, PARAMETER, RESOURCE_VARIABLE, EXCEPTION_PARAMETER, BINDING_VARIABLE -> "variable";
            case PACKAGE -> "package";
            default -> "";
        };
        if (kind.isEmpty() || !seen.add(kind + ":" + name)) return;
        var owner = symbol.getEnclosingElement();
        add(result, name, kind, symbol.asType() + (owner == null ? "" : " · " + owner), qualified == null ? name : qualified);
    }

    static void query(List<String> result, Path file, Path root, String operation, int offset, String text) throws IOException {
        var diagnostics = new DiagnosticCollector<JavaFileObject>();
        var compiler = ToolProvider.getSystemJavaCompiler();
        String prefix = "";
        String importParent = null;
        if (operation.equals("complete")) {
            int start = offset;
            int end = offset;
            while (start > 0 && Character.isJavaIdentifierPart(text.charAt(start - 1))) start--;
            while (end < text.length() && Character.isJavaIdentifierPart(text.charAt(end))) end++;
            prefix = text.substring(start, offset);
            int boundary = Math.max(text.lastIndexOf('\n', start - 1), text.lastIndexOf(';', start - 1));
            if (start - boundary < 512) {
                var importPrefix = IMPORT_PREFIX.matcher(text.substring(boundary + 1, start));
                if (importPrefix.matches()) importParent = importPrefix.group(1);
            }
            String tail = text.substring(end);
            boolean member = start > 0 && text.charAt(start - 1) == '.';
            String suffix = importParent == null && member && !tail.stripLeading().startsWith("(") ? "()" : "";
            text = text.substring(0, start) + PROBE + suffix + tail;
            offset = start;
        }
        var source = new Source(file, text);
        try (var files = compiler.getStandardFileManager(diagnostics, Locale.ROOT, StandardCharsets.UTF_8)) {
            files.setLocationFromPaths(StandardLocation.CLASS_PATH, List.of());
            var roots = new ArrayList<Path>();
            if (root != null) {
                for (var dir : List.of(root, root.resolve("src"), root.resolve("src/main/java"), root.resolve("src/test/java"))) {
                    if (Files.isDirectory(dir) && dir.toRealPath().startsWith(root)) roots.add(dir);
                }
            }
            files.setLocationFromPaths(StandardLocation.SOURCE_PATH, roots);
            var scoped = new ScopedFiles(files, root == null ? file.getParent() : root);
            var task = (JavacTask) compiler.getTask(new StringWriter(), scoped, diagnostics,
                List.of("-proc:none", "-implicit:none", "-Xlint:all"), null, List.of(source));
            var analysis = new Analysis(task);
            switch (operation) {
                case "diagnostics" -> {
                    for (var item : diagnostics.getDiagnostics()) {
                        if (item.getSource() == null || !item.getSource().toUri().equals(source.toUri()) || item.getStartPosition() < 0) continue;
                        String severity = switch (item.getKind()) {
                            case ERROR -> "error";
                            case WARNING, MANDATORY_WARNING -> "warning";
                            default -> "note";
                        };
                        add(result, severity, item.getStartPosition(), item.getEndPosition(), item.getMessage(Locale.ROOT));
                    }
                }
                case "complete" -> {
                    if (importParent == null) analysis.complete(result, offset, prefix);
                    else analysis.completeImport(result, importParent, prefix);
                }
                case "signature" -> analysis.signature(result, offset, text);
                case "definition", "references" -> analysis.navigate(result, offset, operation.equals("references"));
                default -> throw new IllegalArgumentException("Unknown Java query");
            }
        }
    }

    public static void main(String[] args) throws IOException {
        Path root = args.length == 0 ? null : Path.of(args[0]);
        try (var input = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8))) {
            for (String line; (line = input.readLine()) != null;) {
                var request = line.split("\t", -1);
                if (request.length != 5) break;
                var result = new ArrayList<String>();
                try {
                    query(result, Path.of(decode(request[2])), root, request[1], Integer.parseInt(request[3]), decode(request[4]));
                    System.out.println(request[0] + "\t" + encode(String.join("\n", result)));
                } catch (Exception failure) {
                    System.out.println(request[0] + "\t!" + field(failure.getClass().getSimpleName()));
                }
                System.out.flush();
            }
        }
    }
}
