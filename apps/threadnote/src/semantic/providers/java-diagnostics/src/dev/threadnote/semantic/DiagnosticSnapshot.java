package dev.threadnote.semantic;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.concurrent.atomic.AtomicLong;
import org.eclipse.core.resources.IFile;
import org.eclipse.core.resources.IResource;
import org.eclipse.core.resources.ResourcesPlugin;
import org.eclipse.core.runtime.IProgressMonitor;
import org.eclipse.jdt.core.IBuffer;
import org.eclipse.jdt.core.IBufferChangedListener;
import org.eclipse.jdt.core.IClasspathEntry;
import org.eclipse.jdt.core.ICompilationUnit;
import org.eclipse.jdt.core.IJavaProject;
import org.eclipse.jdt.core.JavaCore;
import org.eclipse.jdt.core.compiler.IProblem;
import org.eclipse.jdt.core.dom.AST;
import org.eclipse.jdt.core.dom.ASTParser;
import org.eclipse.jdt.core.dom.CompilationUnit;
import org.eclipse.jdt.launching.JavaRuntime;
import org.eclipse.jdt.ls.core.internal.DocumentAdapter;
import org.eclipse.jdt.ls.core.internal.IDelegateCommandHandler;
import org.eclipse.jdt.ls.core.internal.JDTUtils;
import org.eclipse.jdt.ls.core.internal.JobHelpers;
import org.eclipse.jdt.ls.core.internal.handlers.DocumentLifeCycleHandler;
import org.eclipse.jface.text.IDocument;
import org.eclipse.jface.text.IDocumentExtension4;
import org.eclipse.jface.text.ISynchronizable;

/** Stateless, read-only reports from the pinned JDT engine. No version reflection, reconcile or command delegation. */
public final class DiagnosticSnapshot implements IDelegateCommandHandler {
  private static final String COMMAND = "threadnote.java.diagnosticSnapshot.v1";
  static final int MAX_TEXT = 2 * 1024 * 1024;
  private static final int MAX_TOTAL_TEXT = 8 * 1024 * 1024;
  private static final String PROCESS_ANNOTATIONS = "org.eclipse.jdt.core.compiler.processAnnotations";
  private static final String JRE = "org.eclipse.jdt.launching.JRE_CONTAINER/"
      + "org.eclipse.jdt.internal.debug.ui.launcher.StandardVMType/JavaSE-21";
  record Input(String uri, String expectedHash, ICompilationUnit unit, IBuffer buffer,
      IDocument document, Object lock, long stamp, String text) {}
  record Model(IJavaProject project, String projectUri, String javaHomeUri,
      List<String> sourceRoots, List<String> libraries, Map<String, String> options,
      List<String> rawClasspath, List<String> resolvedClasspath, Map<String, Object> projection) {
    Map<String, Object> image() {
      Map<String, Object> result = new TreeMap<>(Map.of("projectUri", projectUri, "javaHomeUri", javaHomeUri,
          "sourceRoots", sourceRoots, "libraries", libraries,
          "compilerOptions", compilerOptions(options),
          "annotationProcessing", "disabled-for-snapshot"));
      if (projection != null) result.put("projection", projection);
      return Map.copyOf(result);
    }
  }

  @Override
  public Object executeCommand(String command, List<Object> arguments, IProgressMonitor monitor) throws Exception {
    check(monitor != null && !monitor.isCanceled(), "Canceled diagnostic request");
    String resolver = System.getProperty("ICompilationUnitResolver");
    check(resolver == null || resolver.isBlank(), "Unqualified compilation resolver");
    boolean typeDefinition = "threadnote.java.typeDefinitionSnapshot.v1".equals(command);
    check((COMMAND.equals(command) || typeDefinition) && arguments != null && arguments.size() == 1
        && arguments.get(0) instanceof Map<?, ?>, "Invalid diagnostic request");
    Map<?, ?> request = (Map<?, ?>) arguments.get(0);
    Set<String> fields = new HashSet<>(Set.of("protocolVersion", "requestToken", "uri", "projectUri",
        "javaHomeUri", "sourceRoots", "libraries", "inputs"));
    if (typeDefinition) fields.add("position");
    if (request.containsKey("compilerOptions")) fields.add("compilerOptions");
    String projectionDigest = null;
    if (request.containsKey("projectionDigest")) {
      fields.add("projectionDigest");
      projectionDigest = text(request.get("projectionDigest"), 64);
      check(projectionDigest.matches("[0-9a-f]{64}") && request.containsKey("compilerOptions"),
          "Invalid projection identity");
    }
    check(request.keySet().equals(fields), "Invalid snapshot fields");
    check(request.get("protocolVersion") instanceof Number version && version.doubleValue() == 1,
        "Unsupported diagnostic protocol");
    String targetUri = fileUri(text(request.get("uri"), 8192));
    String projectUri = fileUri(text(request.get("projectUri"), 8192));
    String javaHomeUri = fileUri(text(request.get("javaHomeUri"), 8192));
    String token = text(request.get("requestToken"), 128);
    check(token.matches("[A-Za-z0-9._-]+"), "Invalid diagnostic token");
    List<String> sourceRoots = fileUris(request.get("sourceRoots"), 32, false);
    List<String> libraries = fileUris(request.get("libraries"), 128, true);
    check(request.get("inputs") instanceof List<?>, "Missing diagnostic inputs");
    List<?> rawInputs = (List<?>) request.get("inputs");
    check(!rawInputs.isEmpty() && rawInputs.size() <= 128, "Diagnostic input capacity");
    JobHelpers.waitForJobs(DocumentLifeCycleHandler.DOCUMENT_LIFE_CYCLE_JOBS, monitor);
    AtomicLong generation = new AtomicLong();
    IBufferChangedListener listener = event -> generation.incrementAndGet();
    List<IBuffer> observed = new ArrayList<>();
    List<Input> inputs = new ArrayList<>();
    Set<ICompilationUnit> units = new HashSet<>();
    try {
      int totalText = 0;
      for (Object raw : rawInputs) {
        check(!monitor.isCanceled(), "Canceled diagnostic capture");
        check(raw instanceof Map<?, ?>, "Invalid diagnostic input");
        Map<?, ?> item = (Map<?, ?>) raw;
        check(item.keySet().equals(Set.of("uri", "contentSha256", "utf16Length")), "Invalid input fields");
        String uri = fileUri(text(item.get("uri"), 8192));
        String hash = text(item.get("contentSha256"), 64);
        check(hash.matches("[0-9a-f]{64}"), "Invalid input digest");
        check(item.get("utf16Length") instanceof Number, "Missing input length");
        Number length = (Number) item.get("utf16Length");
        check(length.doubleValue() == length.intValue() && length.intValue() >= 0
            && length.intValue() <= MAX_TEXT, "Invalid input length");
        IFile managed = null;
        ICompilationUnit unit = null;
        if (projectionDigest == null) {
          managed = JDTUtils.findFile(uri);
          check(managed != null && managed.isAccessible() && managed.getLocationURI() != null
              && fileUri(managed.getLocationURI().toString()).equals(uri), "Unmanaged physical source");
          unit = JDTUtils.resolveCompilationUnit(managed);
        }
        else {
          ICompilationUnit[] copies = JavaCore.getWorkingCopies(null);
          check(copies.length <= 128, "Diagnostic input capacity");
          Path selected = Path.of(new URI(uri));
          for (ICompilationUnit copy : copies) {
            check(!monitor.isCanceled(), "Canceled projection capture");
            if (!(copy.getResource() instanceof IFile resource) || resource.getLocationURI() == null) continue;
            URI location = resource.getLocationURI();
            if (!"file".equals(location.getScheme()) || location.getRawAuthority() != null
                || location.getRawQuery() != null || location.getRawFragment() != null) continue;
            if (selected.equals(Path.of(location).normalize()) || uri.equals(fileUri(location.toString()))) {
              check(unit == null, "Ambiguous compilation unit");
              unit = copy;
              managed = resource;
            }
          }
          check(unit != null, copies.length == 0 ? "Missing existing working copy inventory"
              : "Physical source has no existing working copy");
          check(managed.isAccessible() && managed.getLocationURI() != null, "Physical source mapping inaccessible");
          check(fileUri(managed.getLocationURI().toString()).equals(uri), "Physical source mapping differs");
        }
        check(unit != null && unit.equals(unit.getPrimary()) && unit.isWorkingCopy()
            && !JDTUtils.isDefaultProject(unit) && units.add(unit),
            "Unqualified or duplicate compilation unit");
        if (projectionDigest == null) check(JDTUtils.isOnClassPath(unit), "Unqualified source membership");
        check(fileUri(unit.getJavaProject().getProject().getLocationURI().toString()).equals(projectUri),
            "Compilation unit outside selected private project");
        IBuffer buffer = unit.getBuffer();
        check(buffer != null && !buffer.isClosed() && !observed.contains(buffer)
            && buffer instanceof DocumentAdapter, "Unqualified buffer");
        DocumentAdapter adapter = (DocumentAdapter) buffer;
        IDocument document = adapter.getDocument();
        check(document instanceof ISynchronizable && document instanceof IDocumentExtension4,
            "Unqualified document synchronization");
        ISynchronizable synchronizedDocument = (ISynchronizable) document;
        Object lock = synchronizedDocument.getLockObject();
        check(lock != null, "Missing existing document lock");
        synchronized (lock) {
          check(unit.getBuffer() == buffer && adapter.getDocument() == document
              && synchronizedDocument.getLockObject() == lock, "Document identity changed");
          buffer.addBufferChangedListener(listener);
          observed.add(buffer);
          long stamp = ((IDocumentExtension4) document).getModificationStamp();
          String content = document.get();
          check(stamp != IDocumentExtension4.UNKNOWN_MODIFICATION_STAMP && content != null
              && content.length() == length.intValue() && sha256(content).equals(hash), "Diagnostic input differs");
          totalText += content.length();
          check(totalText <= MAX_TOTAL_TEXT, "Diagnostic input capacity");
          inputs.add(new Input(uri, hash, unit, buffer, document, lock, stamp, content));
        }
      }
      membership(units);
      Input target = inputs.stream().filter(input -> input.uri().equals(targetUri)).findFirst().orElseThrow();
      Model model = model(target.unit().getJavaProject(), projectionDigest, monitor);
      check(model.projectUri().equals(projectUri) && model.javaHomeUri().equals(javaHomeUri)
          && model.sourceRoots().equals(sourceRoots) && model.libraries().equals(libraries), "Prepared model differs");
      if (request.containsKey("compilerOptions"))
        check(compilerOptions(model.options()).equals(request.get("compilerOptions")), "Prepared compiler options differ");
      if (model.projection() != null)
        for (Input input : inputs)
          check(input.unit().getJavaProject().equals(model.project()) && sourceMember(input.unit(), input.uri(), model),
              "Source outside captured projection");
      Map<String, String> compilerOptions = new TreeMap<>(target.unit().getOptions(true));
      check(compilerOptions.equals(model.options()) && generation.get() == 0, "Compilation basis changed");
      CompilationUnit ast = parse(target.unit(), target.text(), model, compilerOptions, monitor);
      int[] lines = lineStarts(target.text());
      List<Object> diagnostics = new ArrayList<>();
      int diagnosticCharacters = 0;
      if (!typeDefinition) for (IProblem problem : ast.getProblems()) {
        check(!monitor.isCanceled() && diagnostics.size() < 4096, "Diagnostic output capacity or cancellation");
        int start = problem.getSourceStart();
        int last = problem.getSourceEnd();
        check(start >= 0 && last >= start && last < target.text().length(), "Unpositioned semantic diagnostic");
        String message = problem.getMessage();
        check(message != null && message.length() <= 16384, "Diagnostic message capacity");
        diagnosticCharacters += message.length();
        List<String> problemArguments = Arrays.asList(problem.getArguments());
        check(problemArguments.size() <= 128, "Diagnostic argument capacity");
        for (String argument : problemArguments) {
          check(argument != null && argument.length() <= 16384, "Diagnostic argument capacity");
          diagnosticCharacters += argument.length();
        }
        check(diagnosticCharacters <= 1024 * 1024, "Diagnostic output capacity");
        diagnostics.add(Map.of("range", Map.of("start", position(lines, start), "end", position(lines, last + 1)),
            "severity", problem.isError() ? 1 : problem.isWarning() ? 2 : 3,
            "code", Integer.toString(problem.getID()), "source", "Java", "message", message,
            "data", Map.of("arguments", problemArguments)));
      }
      TypeDefinitionSnapshot.Result typeResult = typeDefinition
          ? TypeDefinitionSnapshot.read(request.get("position"), target, inputs, model, ast,
              MAX_TOTAL_TEXT - totalText, monitor) : null;
      if (typeResult != null) typeResult.verify(model);
      List<Object> identities = new ArrayList<>();
      for (Input input : inputs) {
        synchronized (input.lock()) {
          check(input.unit().equals(input.unit().getPrimary()) && input.unit().isWorkingCopy()
              && input.unit().getBuffer() == input.buffer() && !input.buffer().isClosed()
              && ((DocumentAdapter) input.buffer()).getDocument() == input.document()
              && ((ISynchronizable) input.document()).getLockObject() == input.lock()
              && ((IDocumentExtension4) input.document()).getModificationStamp() == input.stamp()
              && sha256(input.document().get()).equals(input.expectedHash()), "Diagnostic source changed");
          identities.add(Map.of("uri", input.uri(), "contentSha256", sha256(input.text()),
              "utf16Length", input.text().length()));
        }
      }
      membership(units);
      check(!monitor.isCanceled() && model.equals(model(model.project(), projectionDigest, monitor))
          && compilerOptions.equals(target.unit().getOptions(true)) && generation.get() == 0,
          "Snapshot basis changed");
      Map<String, Object> report = new TreeMap<>(Map.of("protocolVersion", 1, "requestToken", token, "uri", target.uri(),
          "contentSha256", sha256(target.text()), "utf16Length", target.text().length(),
          "model", model.image(), "inputs", List.copyOf(identities)));
      if (typeResult == null) report.put("diagnostics", List.copyOf(diagnostics));
      else { report.put("position", typeResult.position()); report.put("typeDefinition", typeResult.image()); }
      return Map.copyOf(report);
    } finally {
      for (IBuffer buffer : observed) buffer.removeBufferChangedListener(listener);
    }
  }

  private static Map<String, String> compilerOptions(Map<String, String> options) {
    Map<String, String> compiler = new TreeMap<>();
    int characters = 0;
    for (var option : options.entrySet())
      if (option.getKey().startsWith("org.eclipse.jdt.core.compiler.")) {
        check(option.getKey().length() <= 8192 && option.getValue() != null && option.getValue().length() <= 8192,
            "Compiler option capacity");
        characters += option.getKey().length() + option.getValue().length();
        check(characters <= 128 * 1024 && compiler.size() < 2048, "Compiler option capacity");
        compiler.put(option.getKey(), option.getValue());
      }
    return Map.copyOf(compiler);
  }

  static CompilationUnit parse(ICompilationUnit unit, String text, Model model,
      Map<String, String> compilerOptions, IProgressMonitor monitor) {
    check(compilerOptions.equals(model.options()), "Compilation options differ");
    ASTParser parser = ASTParser.newParser(AST.getJLSLatest());
    parser.setKind(ASTParser.K_COMPILATION_UNIT);
    parser.setSource(text.toCharArray());
    parser.setProject(model.project());
    Map<String, String> parserOptions = new TreeMap<>(compilerOptions);
    parserOptions.put(PROCESS_ANNOTATIONS, JavaCore.DISABLED);
    parser.setCompilerOptions(parserOptions);
    parser.setUnitName(unit.getPath().toPortableString());
    parser.setWorkingCopyOwner(null);
    parser.setResolveBindings(true);
    parser.setBindingsRecovery(true);
    parser.setStatementsRecovery(true);
    parser.setIgnoreMethodBodies(false);
    CompilationUnit ast = (CompilationUnit) parser.createAST(monitor);
    check(ast.getAST().hasResolvedBindings(), "Semantic bindings unavailable");
    return ast;
  }

  static boolean sourceMember(ICompilationUnit unit, String uri, Model model) throws Exception {
    return model.projection() == null ? JDTUtils.isOnClassPath(unit)
        : PreparedProjectModel.projectionSourceMember(model.projection(), unit.getPath(), uri);
  }

  private static Model model(IJavaProject project, String expectedProjectionDigest, IProgressMonitor monitor) throws Exception {
    var resource = project.getProject();
    check(resource.isAccessible() && resource.isOpen(), "Private project unavailable");
    if (expectedProjectionDigest != null) return projectedModel(project, expectedProjectionDigest, monitor);
    var description = resource.getDescription();
    check(Arrays.equals(description.getNatureIds(), new String[] {JavaCore.NATURE_ID})
        && description.getBuildSpec().length == 0 && project.getRequiredProjectNames().length == 0,
        "Unqualified project builders, natures or required projects");
    Map<String, String> options = new TreeMap<>(project.getOptions(true));
    check(options.size() <= 2048 && "21".equals(options.get(JavaCore.COMPILER_COMPLIANCE))
        && "21".equals(options.get(JavaCore.COMPILER_SOURCE))
        && "21".equals(options.get(JavaCore.COMPILER_CODEGEN_TARGET_PLATFORM))
        && JavaCore.ENABLED.equals(options.get(JavaCore.COMPILER_RELEASE))
        && (options.get(PROCESS_ANNOTATIONS) == null || JavaCore.DISABLED.equals(options.get(PROCESS_ANNOTATIONS))),
        "Unqualified compiler options");
    var vm = JavaRuntime.getVMInstall(project);
    check(vm != null, "Project JDK unavailable");
    List<String> roots = new ArrayList<>();
    List<String> libraries = new ArrayList<>();
    List<String> raw = new ArrayList<>();
    IClasspathEntry[] entries = project.getRawClasspath();
    check(entries.length <= 162, "Classpath capacity");
    int jres = 0;
    for (IClasspathEntry entry : entries) {
      check(entry.getExtraAttributes().length == 0 && entry.getAccessRules().length == 0,
          "Unqualified classpath attributes");
      raw.add(entry.toString());
      if (entry.getEntryKind() == IClasspathEntry.CPE_SOURCE) {
        check(entry.getInclusionPatterns().length == 0 && entry.getExclusionPatterns().length == 0,
            "Unqualified source filters");
        IResource source = ResourcesPlugin.getWorkspace().getRoot().findMember(entry.getPath());
        check(source != null && source.isAccessible() && source.getLocationURI() != null, "Source root unavailable");
        roots.add(fileUri(source.getLocationURI().toString()));
      } else if (entry.getEntryKind() == IClasspathEntry.CPE_LIBRARY) {
        Path file = Path.of(entry.getPath().toOSString()).toRealPath();
        check(Files.isRegularFile(file), "Classpath artifact unavailable");
        libraries.add(file.toUri().toASCIIString());
      } else if (entry.getEntryKind() == IClasspathEntry.CPE_CONTAINER) {
        check(JRE.equals(entry.getPath().toPortableString()), "Unqualified classpath container");
        jres++;
      } else throw new IllegalStateException("Unqualified classpath entry");
    }
    check(jres == 1 && !roots.isEmpty(), "Missing prepared classpath");
    IClasspathEntry[] resolvedEntries = project.getResolvedClasspath(false);
    check(resolvedEntries.length <= 512, "Resolved classpath capacity");
    List<String> resolved = new ArrayList<>();
    for (IClasspathEntry entry : resolvedEntries) resolved.add(entry.toString());
    return new Model(project, fileUri(resource.getLocationURI().toString()),
        vm.getInstallLocation().toPath().toRealPath().toUri().toASCIIString(),
        List.copyOf(roots), List.copyOf(libraries), Map.copyOf(options), List.copyOf(raw), List.copyOf(resolved), null);
  }

  private static Model projectedModel(IJavaProject project, String expectedDigest, IProgressMonitor monitor) throws Exception {
    var observed = PreparedProjectModel.passiveProjection(project, monitor);
    // Qualify immutable cached metadata before following any additional projected source or binary path.
    check(projectionDigest(observed.image()).equals(expectedDigest), "Projection differs");
    List<String> roots = new ArrayList<>();
    List<String> libraries = new ArrayList<>();
    String jre = null;
    for (var entry : observed.raw()) {
      check(!monitor.isCanceled(), "Canceled projection capture");
      int kind = (Integer) entry.get("kind");
      String path = (String) entry.get("path");
      if (kind == IClasspathEntry.CPE_SOURCE) {
        var folder = project.getProject().getFolder(org.eclipse.core.runtime.Path.fromPortableString(path).removeFirstSegments(1));
        String alias = folder.getProjectRelativePath().toPortableString();
        String expectedUri = null;
        for (Object item : (List<?>) observed.image().get("links")) {
          Map<?, ?> link = (Map<?, ?>) item;
          if (alias.equals(link.get("path"))) expectedUri = (String) link.get("uri");
        }
        check(expectedUri != null && folder.getLocationURI() != null
            && sourceFolderIdentity(new URI(expectedUri), monitor).equals(sourceFolderIdentity(folder.getLocationURI(), monitor)),
            "Source link changed");
        // A linked resource can exist in Eclipse while its optional physical target is absent.
        if (Files.notExists(Path.of(new URI(expectedUri)), java.nio.file.LinkOption.NOFOLLOW_LINKS)) {
          boolean optional = false;
          for (Object item : (List<?>) entry.get("attributes")) {
            Map<?, ?> attribute = (Map<?, ?>) item;
            if ("optional".equals(attribute.get("name")) && "true".equals(attribute.get("value"))) optional = true;
          }
          check(optional && Files.notExists(Path.of(new URI(expectedUri)), java.nio.file.LinkOption.NOFOLLOW_LINKS),
              "Source root unavailable");
          continue;
        }
        check(folder.isAccessible() && folder.isLinked() && !folder.isVirtual(), "Source root unavailable");
        roots.add(fileUri(expectedUri));
      } else if (kind == IClasspathEntry.CPE_LIBRARY) {
        Path file = Path.of(org.eclipse.core.runtime.Path.fromPortableString(path).toOSString());
        check(file.isAbsolute() && file.normalize().equals(file) && file.toRealPath().equals(file)
            && Files.isRegularFile(file), "Classpath artifact unavailable");
        libraries.add(file.toUri().toASCIIString());
      } else jre = path; // The cached-image validator already permits exactly one qualified JRE container.
    }
    check(jre != null && !roots.isEmpty(), "Missing prepared classpath");
    // Resolve only the captured fixed JRE path; a project getter could resolve a concurrently replaced foreign container.
    var vm = JavaRuntime.getVMInstall(org.eclipse.core.runtime.Path.fromPortableString(jre));
    check(vm != null && vm.getInstallLocation() != null, "Project JDK unavailable");
    Map<String, String> options = new TreeMap<>(project.getOptions(true));
    check(options.size() <= 2048 && "21".equals(options.get(JavaCore.COMPILER_COMPLIANCE))
        && "21".equals(options.get(JavaCore.COMPILER_SOURCE))
        && "21".equals(options.get(JavaCore.COMPILER_CODEGEN_TARGET_PLATFORM))
        && JavaCore.ENABLED.equals(options.get(JavaCore.COMPILER_RELEASE))
        && JavaCore.DISABLED.equals(options.get(PROCESS_ANNOTATIONS)), "Unqualified compiler options");
    return new Model(project, fileUri(project.getProject().getLocationURI().toString()),
        vm.getInstallLocation().toPath().toRealPath().toUri().toASCIIString(), List.copyOf(roots), List.copyOf(libraries),
        Map.copyOf(options), List.of(), List.of(), observed.image());
  }

  private static Path sourceFolderIdentity(URI uri, IProgressMonitor monitor) throws Exception {
    check(!monitor.isCanceled(), "Canceled projection capture");
    check("file".equals(uri.getScheme()) && uri.getRawAuthority() == null && uri.getRawQuery() == null
        && uri.getRawFragment() == null, "Unqualified source link");
    Path target = Path.of(uri);
    check(target.isAbsolute() && target.normalize().equals(target), "Unqualified source link");
    Path ancestor = target;
    int depth = 0;
    while (!Files.exists(ancestor, java.nio.file.LinkOption.NOFOLLOW_LINKS)) {
      check(!monitor.isCanceled() && ++depth <= 128, "Source link capacity or cancellation");
      ancestor = ancestor.getParent();
      check(ancestor != null, "Unqualified source link");
    }
    Path existing = ancestor.toRealPath();
    check(!monitor.isCanceled() && Files.isDirectory(existing), "Unqualified source link");
    return existing.resolve(ancestor.relativize(target)).normalize();
  }

  static String projectionDigest(Map<String, Object> image) throws Exception {
    StringBuilder framed = new StringBuilder("threadnote-java-passive-projection-v1\n");
    projectionFrame(image, framed);
    return sha256(framed.toString());
  }
  private static void projectionFrame(Object value, StringBuilder result) {
    if (value == null) result.append('z');
    else if (value instanceof String text) result.append('s').append(text.length()).append(':').append(text);
    else if (value instanceof Boolean flag) result.append(flag ? 't' : 'f');
    else if (value instanceof Integer integer) result.append('n').append(integer).append(';');
    else if (value instanceof List<?> list) {
      result.append('a').append(list.size()).append(":[");
      for (Object item : list) projectionFrame(item, result);
      result.append(']');
    } else if (value instanceof Map<?, ?> map) {
      Map<String, Object> fields = new TreeMap<>();
      for (var field : map.entrySet()) {
        check(field.getKey() instanceof String, "Invalid projection image");
        fields.put((String) field.getKey(), field.getValue());
      }
      result.append('o').append(fields.size()).append(":[");
      for (var field : fields.entrySet()) { projectionFrame(field.getKey(), result); projectionFrame(field.getValue(), result); }
      result.append(']');
    } else throw new IllegalStateException("Invalid projection image");
    check(result.length() <= 2 * 1024 * 1024, "Projection image capacity");
  }

  private static void membership(Set<ICompilationUnit> expected) throws Exception {
    Set<ICompilationUnit> actual = new HashSet<>(Arrays.asList(JavaCore.getWorkingCopies(null)));
    check(actual.equals(expected), "Open buffer membership differs");
  }

  private static String text(Object raw, int maximum) {
    check(raw instanceof String value && !value.isEmpty() && value.length() <= maximum, "Invalid string field");
    return (String) raw;
  }

  static String fileUri(String value) throws Exception {
    URI uri = new URI(value);
    check("file".equals(uri.getScheme()) && uri.getAuthority() == null && uri.getQuery() == null
        && uri.getFragment() == null, "Unqualified file URI");
    return Path.of(uri).toRealPath().toUri().toASCIIString();
  }

  private static List<String> fileUris(Object raw, int maximum, boolean empty) throws Exception {
    check(raw instanceof List<?>, "Invalid path inventory");
    List<?> list = (List<?>) raw;
    check(list.size() <= maximum && (empty || !list.isEmpty()), "Path inventory capacity");
    List<String> paths = new ArrayList<>();
    for (Object value : list) paths.add(fileUri(text(value, 8192)));
    check(new HashSet<>(paths).size() == paths.size(), "Duplicate path inventory");
    return List.copyOf(paths);
  }

  static String sha256(String text) throws Exception {
    for (int index = 0; index < text.length(); index++) {
      char c = text.charAt(index);
      if (Character.isHighSurrogate(c)) {
        check(++index < text.length() && Character.isLowSurrogate(text.charAt(index)), "Invalid source encoding");
      } else check(!Character.isLowSurrogate(c), "Invalid source encoding");
    }
    return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8)));
  }

  static int[] lineStarts(String text) {
    int[] starts = new int[text.length() + 1];
    int count = 1;
    for (int index = 0; index < text.length(); index++) {
      char character = text.charAt(index);
      if (character == '\r') {
        if (index + 1 < text.length() && text.charAt(index + 1) == '\n') index++;
        starts[count++] = index + 1;
      } else if (character == '\n') starts[count++] = index + 1;
    }
    return Arrays.copyOf(starts, count);
  }

  static Map<String, Integer> position(int[] starts, int offset) {
    int index = Arrays.binarySearch(starts, offset);
    int line = index >= 0 ? index : -index - 2;
    return Map.of("line", line, "character", offset - starts[line]);
  }

  static void check(boolean condition, String message) {
    if (!condition) throw new IllegalStateException(message);
  }
}
