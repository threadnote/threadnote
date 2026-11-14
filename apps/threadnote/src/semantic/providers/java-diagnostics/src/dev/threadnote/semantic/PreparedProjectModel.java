package dev.threadnote.semantic;

import java.net.URI;
import java.io.InputStream;
import java.util.IdentityHashMap;
import java.util.concurrent.atomic.AtomicReference;
import java.util.concurrent.Callable;
import org.eclipse.core.runtime.IStatus;
import org.eclipse.buildship.core.BuildConfiguration;
import org.eclipse.buildship.core.GradleCore;
import org.eclipse.buildship.core.LocalGradleDistribution;
import org.eclipse.jdt.ls.core.internal.managers.GradleProjectImporter;
import org.eclipse.jdt.ls.core.internal.JavaLanguageServerPlugin;
import org.eclipse.jdt.ls.core.internal.preferences.Preferences;
import java.nio.ByteBuffer;
import java.nio.channels.SeekableByteChannel;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import org.eclipse.core.resources.IProject;
import org.eclipse.core.resources.IFile;
import org.eclipse.core.resources.IMarker;
import org.eclipse.core.resources.IResource;
import org.eclipse.core.resources.IResourceFilterDescription;
import org.eclipse.core.resources.ResourcesPlugin;
import org.eclipse.core.runtime.IPath;
import org.eclipse.core.runtime.IProgressMonitor;
import org.eclipse.jdt.core.IAccessRule;
import org.eclipse.jdt.core.IClasspathAttribute;
import org.eclipse.jdt.core.IClasspathEntry;
import org.eclipse.jdt.core.IJavaProject;
import org.eclipse.jdt.core.JavaCore;
import org.eclipse.jdt.internal.core.JavaModelManager;
import org.eclipse.jdt.internal.core.JavaModelManager.PerProjectInfo;
import org.eclipse.jdt.internal.core.JavaProject;
import org.eclipse.jdt.launching.IVMInstall;
import org.eclipse.jdt.launching.JavaRuntime;
import org.eclipse.jdt.ls.core.internal.IDelegateCommandHandler;

/** Setup-only model command and source-snapshot metadata. Classpaths come only from the pinned cache, never resolving getters. */
public final class PreparedProjectModel implements IDelegateCommandHandler {
  private static final String COMMAND = "threadnote.java.preparedProjectModel.v1";
  private static final String JRE = "org.eclipse.jdt.launching.JRE_CONTAINER/"
      + "org.eclipse.jdt.internal.debug.ui.launcher.StandardVMType/JavaSE-21";
  private static boolean isJre(String path) { return JRE.equals(path) || (JRE + "/").equals(path); }
  private static final Set<String> ATTRIBUTES = Set.of("maven.pomderived", "maven.groupId", "maven.artifactId",
      "maven.version", "maven.scope", "maven.classifier", "maven.optionaldependency", "optional", "test",
      "ignore_optional_problems", "m2e-apt", "gradle_scope", "gradle_used_by_scope", "module",
      "without_test_code", "limit-modules", "add-exports", "add-reads", "patch-module");

  static final class Unsupported extends Exception {
    final Map<String, String> evidence;
    Unsupported(String reason) { this(reason, Map.of()); }
    Unsupported(String reason, Map<String, String> evidence) { super(reason); this.evidence = evidence; }
  }
  static final class Budget {
    int characters;
    long libraryBytes;
    final IProgressMonitor monitor;
    Budget(IProgressMonitor monitor) { this.monitor = monitor; }
    String text(String value, int maximum) throws Unsupported {
      require(value != null && value.length() <= maximum, "capacity");
      for (int i = 0; i < value.length(); i++) {
        char c = value.charAt(i);
        require(!Character.isISOControl(c), "invalid-text");
        if (Character.isHighSurrogate(c))
          require(++i < value.length() && Character.isLowSurrogate(value.charAt(i)), "invalid-text");
        else require(!Character.isLowSurrogate(c), "invalid-text");
      }
      characters += value.length();
      require(characters <= 65536, "capacity");
      check();
      return value;
    }
    void check() throws Unsupported { require(monitor != null && !monitor.isCanceled(), "canceled"); }
  }
  record Host(Path project, Path javaHome, List<Path> caches, String build) {}

  private static String frame(List<String> values) {
    StringBuilder image = new StringBuilder();
    image.append(values.size()).append(';');
    for (String value : values) image.append(value.length()).append(':').append(value);
    return image.toString();
  }

  private static String bytesDigest(byte[] bytes) throws Unsupported {
    try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)); }
    catch (java.security.NoSuchAlgorithmException unavailable) { throw new Unsupported("gradle-status-unknown"); }
  }

  /** One private preparation process owns one attempt. Correlation data never substitutes native ownership. */
  static final class ImportAttempt {
    record State(String binding, String phase, Unsupported refusal, String configuration) {}
    private final AtomicReference<State> state = new AtomicReference<>();
    State enter(String binding) throws Unsupported {
      State start = new State(binding, "in-flight", null, null);
      if (state.compareAndSet(null, start)) return start;
      State current = state.get();
      require(current.binding().equals(binding), "gradle-binding-changed");
      if (current.refusal() != null) throw current.refusal();
      require("synchronized".equals(current.phase()), "gradle-in-flight");
      return null; // Passive observation, never another synchronize.
    }
    State configure(State start, String configuration) throws Unsupported {
      require(start != null && start.configuration() == null && "in-flight".equals(start.phase()), "gradle-binding-changed");
      State configured = new State(start.binding(), "in-flight", null, configuration);
      require(state.compareAndSet(start, configured), "gradle-canceled");
      return configured;
    }
    void verifyConfiguration(String binding, String configuration) throws Unsupported {
      check(binding);
      require(configuration.equals(state.get().configuration()), "gradle-binding-changed");
    }
    void succeeded(State start) throws Unsupported {
      require(start != null && start.configuration() != null && "in-flight".equals(start.phase()), "gradle-binding-changed");
      require(state.compareAndSet(start, new State(start.binding(), "synchronized", null, start.configuration())), "gradle-canceled");
    }
    void failed(String binding, Unsupported refusal) {
      for (;;) {
        State current = state.get();
        if (current == null || !current.binding().equals(binding) || current.refusal() != null) return;
        if (state.compareAndSet(current, new State(binding, "failed", refusal, current.configuration()))) return;
      }
    }
    void observing(String binding) throws Unsupported {
      check(binding);
      require("synchronized".equals(state.get().phase()), "gradle-in-flight");
    }
    void check(String binding) throws Unsupported {
      State current = state.get();
      require(current != null && current.binding().equals(binding), "gradle-binding-changed");
      if (current.refusal() != null) throw current.refusal();
    }
  }
  private static final ImportAttempt GRADLE_ATTEMPT = new ImportAttempt();

  /** Foreign admission fails before this boundary; every failure of an admitted operation is terminal. */
  static <T> T admitted(ImportAttempt attempt, String binding, Callable<T> operation) throws Unsupported {
    if (binding != null) attempt.check(binding);
    try {
      if (binding != null) require(!Thread.currentThread().isInterrupted(), "gradle-canceled");
      T result = operation.call();
      if (binding != null) {
        require(!Thread.currentThread().isInterrupted(), "gradle-canceled");
        attempt.check(binding);
      }
      return result;
    } catch (Unsupported refusal) {
      if (binding != null) attempt.failed(binding, refusal);
      throw refusal;
    } catch (Exception | LinkageError failure) {
      Unsupported refusal = new Unsupported("observation-failed");
      if (binding != null) attempt.failed(binding, refusal);
      throw refusal;
    }
  }

  /** Matching passive admission includes its cancellation/configuration preflight, not just later model reads. */
  static ImportAttempt.State enterImport(ImportAttempt attempt, String binding, Callable<Void> passivePreflight) throws Unsupported {
    ImportAttempt.State start = attempt.enter(binding);
    if (start == null) admitted(attempt, binding, passivePreflight);
    return start;
  }

  static Object observeBound(ImportAttempt attempt, String binding, Callable<Object> observation) throws Unsupported {
    if (binding != null) attempt.observing(binding);
    return admitted(attempt, binding, () -> {
      Object result = observation.call();
      if (binding != null) attempt.observing(binding);
      return result;
    });
  }

  record GradleSetup(BuildConfiguration configuration, String binding) {}
  private static GradleSetup gradleSetup(Host host, Budget budget) throws Exception {
    Path gradleHome = propertyPath("threadnote.java.preparedGradleHomeUri");
    String control = System.getProperty("threadnote.ownedImport.controlSha256");
    require(control != null && control.matches("[a-f0-9]{64}"), "invalid-host");
    // Refuse remote/version/wrapper preferences BEFORE the upstream builder could consult distribution metadata.
    require(JavaLanguageServerPlugin.getPreferencesManager() != null, "gradle-configuration-refused");
    Preferences preferences = JavaLanguageServerPlugin.getPreferencesManager().getPreferences();
    require(preferences != null && !preferences.isImportGradleEnabled() && !preferences.isGradleWrapperEnabled()
        && (preferences.getGradleVersion() == null || preferences.getGradleVersion().isBlank())
        && preferences.isImportGradleOfflineEnabled()
        && preferences.getUpdateBuildConfigurationStatus() == Preferences.FeatureStatus.disabled
        && preferences.getGradleArguments() != null && preferences.getGradleArguments().isEmpty()
        && preferences.getGradleJvmArguments() != null && preferences.getGradleJvmArguments().isEmpty(), "gradle-configuration-refused");
    require(preferences.getGradleHome() != null && canonical(Path.of(preferences.getGradleHome())).equals(gradleHome)
        && preferences.getGradleUserHome() != null && canonical(Path.of(preferences.getGradleUserHome())).equals(host.caches().get(1))
        && preferences.getGradleJavaHome() != null && canonical(Path.of(preferences.getGradleJavaHome())).equals(host.javaHome()), "gradle-configuration-refused");
    BuildConfiguration config = GradleProjectImporter.getBuildConfiguration(host.project());
    require(config != null && config.isOverrideWorkspaceConfiguration() && config.isOfflineMode()
        && !config.isAutoSync() && !config.isBuildScansEnabled(), "gradle-configuration-refused");
    require(canonical(config.getRootProjectDirectory().toPath()).equals(host.project())
        && config.getJavaHome().isPresent()
        && canonical(config.getJavaHome().get().toPath()).equals(host.javaHome())
        && config.getGradleUserHome().isPresent()
        && canonical(config.getGradleUserHome().get().toPath()).equals(host.caches().get(1))
        && config.getGradleDistribution() instanceof LocalGradleDistribution local
        && canonical(local.getLocation().toPath()).equals(gradleHome), "gradle-configuration-refused");
    require(config.getArguments() != null && config.getArguments().size() <= 14
        && config.getJvmArguments() != null && config.getJvmArguments().isEmpty(), "gradle-configuration-refused");
    List<String> arguments = List.copyOf(config.getArguments());
    List<String> jvmArguments = List.copyOf(config.getJvmArguments());
    require(arguments.size() >= 2 && arguments.size() <= 14 && arguments.size() % 2 == 0
        && jvmArguments.isEmpty(), "gradle-configuration-refused");
    List<String> scripts = new ArrayList<>();
    Set<String> distinct = new HashSet<>();
    List<String> resources = List.of("/gradle/init/init.gradle", "/gradle/protobuf/init.gradle",
        "/gradle/android/init.gradle", "/gradle/aspectj/init.gradle", "/gradle/kotlin/init.gradle",
        "/gradle/groovy/init.gradle", "/gradle/scala/init.gradle");
    for (int i = 0; i < arguments.size(); i += 2) {
      require("--init-script".equals(arguments.get(i)), "gradle-configuration-refused");
      Path file = canonical(Path.of(budget.text(arguments.get(i + 1), 8192)));
      require(Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS) && Files.size(file) <= 131072,
          "gradle-configuration-refused");
      byte[] bytes;
      try (InputStream input = Files.newInputStream(file, StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS)) {
        bytes = input.readNBytes(131073);
      }
      require(bytes.length <= 131072, "gradle-configuration-refused");
      try (InputStream input = Files.newInputStream(file, StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS)) {
        require(Arrays.equals(bytes, input.readNBytes(131073)), "gradle-configuration-refused");
      }
      String matched = null;
      for (String resource : resources) {
        try (InputStream input = GradleProjectImporter.class.getResourceAsStream(resource)) {
          if (input == null) continue;
          byte[] expected = input.readNBytes(131073);
          if (matched == null && expected.length <= 131072 && Arrays.equals(expected, bytes)) matched = resource;
        }
      }
      require(matched != null && distinct.add(matched) && (i != 0 || resources.get(0).equals(matched)),
          "gradle-configuration-refused");
      scripts.add(frame(List.of(file.toString(), bytesDigest(bytes))));
    }
    String image = frame(List.of(host.project().toString(), gradleHome.toString(), host.javaHome().toString(),
        host.caches().get(1).toString(), control, frame(arguments), frame(scripts), frame(jvmArguments),
        Boolean.toString(config.isShowConsoleView()), Boolean.toString(config.isShowExecutionsView())));
    return new GradleSetup(config, DiagnosticSnapshot.sha256(budget.text(image, 16384)));
  }

  /** One budget/cycle set covers the entire status and throwable graph. Imported text never leaves this process. */
  static final class StatusImage {
    private final IdentityHashMap<Object, Boolean> seen = new IdentityHashMap<>();
    private final StringBuilder image = new StringBuilder();
    private int nodes;
    String reason = "gradle-synchronization-failed";
    void text(String value) throws Unsupported {
      require(value != null && value.length() <= 1024, "gradle-status-unknown");
      byte[] bytes = value.getBytes(StandardCharsets.UTF_8);
      require(bytes.length <= 4096, "gradle-status-unknown");
      image.append(bytes.length).append(':').append(bytesDigest(bytes));
      require(image.length() <= 8192, "gradle-status-unknown");
    }
    void node(Object value, int depth) throws Unsupported {
      require(value != null && depth <= 8 && ++nodes <= 32 && seen.put(value, true) == null, "gradle-status-unknown");
    }
    void cause(Throwable cause, int depth) throws Unsupported {
      if (cause == null) return;
      node(cause, depth);
      text(cause.getClass().getName());
      String message = cause.getMessage();
      text(message == null ? "" : message);
      if (cause instanceof LinkageError) reason = "gradle-linkage-failed";
      if (cause instanceof IllegalStateException && ("Owned Gradle import control refused.".equals(message)
          || "Embedded or unowned Gradle execution is refused.".equals(message))) reason = "gradle-control-refused";
      cause(cause.getCause(), depth + 1);
      Throwable[] suppressed = cause.getSuppressed();
      require(suppressed.length <= 32 - nodes, "gradle-status-unknown");
      for (Throwable item : suppressed) cause(item, depth + 1);
    }
    void status(IStatus status, int depth) throws Unsupported {
      node(status, depth);
      text(status.getPlugin()); text(status.getMessage());
      image.append(status.getSeverity()).append(':').append(status.getCode()).append(';');
      require(image.length() <= 8192, "gradle-status-unknown");
      cause(status.getException(), depth + 1);
      IStatus[] children = status.getChildren();
      require(children != null && children.length <= 32 - nodes, "gradle-status-unknown");
      for (IStatus child : children) status(child, depth + 1);
    }
    Unsupported refusal() throws Unsupported { return new Unsupported(reason, Map.of("statusSha256", bytesDigest(image.toString().getBytes(StandardCharsets.UTF_8)))); }
  }

  private static String synchronizeGradle(Host host, Budget budget) throws Exception {
    // Claim before configuration extraction (which can materialize upstream init scripts), never after a build begins.
    Path selectedGradleHome = propertyPath("threadnote.java.preparedGradleHomeUri");
    String control = System.getProperty("threadnote.ownedImport.controlSha256");
    require(control != null && control.matches("[a-f0-9]{64}"), "invalid-host");
    String binding = DiagnosticSnapshot.sha256(frame(List.of(host.project().toString(), host.javaHome().toString(), host.caches().get(1).toString(), selectedGradleHome.toString(), control)));
    ImportAttempt.State start = enterImport(GRADLE_ATTEMPT, binding, () -> {
      budget.check();
      GRADLE_ATTEMPT.verifyConfiguration(binding, gradleSetup(host, budget).binding());
      return null;
    });
    if (start == null) return binding;
    IProgressMonitor original = budget.monitor;
    IProgressMonitor guarded = new IProgressMonitor() {
      public void beginTask(String name, int total) { original.beginTask(name, total); }
      public void done() { original.done(); }
      public void internalWorked(double work) { original.internalWorked(work); }
      public boolean isCanceled() {
        boolean canceled = original.isCanceled() || Thread.currentThread().isInterrupted();
        if (canceled) GRADLE_ATTEMPT.failed(binding, new Unsupported("gradle-canceled"));
        return canceled;
      }
      public void setCanceled(boolean value) { if (value) GRADLE_ATTEMPT.failed(binding, new Unsupported("gradle-canceled")); original.setCanceled(value); }
      public void setTaskName(String name) { original.setTaskName(name); }
      public void subTask(String name) { original.subTask(name); }
      public void worked(int work) { original.worked(work); }
    };
    try {
      require(!guarded.isCanceled(), "gradle-canceled");
      GradleSetup setup = gradleSetup(host, budget);
      start = GRADLE_ATTEMPT.configure(start, setup.binding());
      require(!guarded.isCanceled(), "gradle-canceled");
      org.eclipse.buildship.core.SynchronizationResult result = GradleCore.getWorkspace().createBuild(setup.configuration()).synchronize(guarded);
      require(result != null, "gradle-status-unknown");
      IStatus status = result.getStatus();
      require(!guarded.isCanceled(), "gradle-canceled");
      require(status != null, "gradle-status-unknown");
      if (!status.isOK()) { StatusImage diagnostics = new StatusImage(); diagnostics.status(status, 0); throw diagnostics.refusal(); }
      require(setup.binding().equals(gradleSetup(host, budget).binding()), "gradle-binding-changed");
      require(!guarded.isCanceled(), "gradle-canceled");
      GRADLE_ATTEMPT.succeeded(start);
      budget.check();
      return binding;
    } catch (Unsupported refusal) { GRADLE_ATTEMPT.failed(binding, refusal); throw refusal;
    } catch (Exception | LinkageError failure) {
      StatusImage diagnostics = new StatusImage();
      Unsupported refusal;
      try { diagnostics.cause(failure, 0); refusal = diagnostics.refusal(); }
      catch (Unsupported malformed) { refusal = malformed; }
      GRADLE_ATTEMPT.failed(binding, refusal); throw refusal;
    }
  }


  @Override
  public Object executeCommand(String command, List<Object> arguments, IProgressMonitor monitor) throws Exception {
    // This gate precedes even project lookup, cache access and known VM setup.
    if (!"true".equals(System.getProperty("threadnote.java.preparation")))
      throw new IllegalStateException("Java preparation command unavailable in analysis");
    require(COMMAND.equals(command) && arguments != null && arguments.size() == 1
        && arguments.get(0) instanceof Map<?, ?>, "invalid-request");
    Map<?, ?> request = (Map<?, ?>) arguments.get(0);
    require(request.keySet().equals(Set.of("protocolVersion", "requestToken"))
        && request.get("protocolVersion") instanceof Number version && version.doubleValue() == 1,
        "invalid-request");
    Budget budget = new Budget(monitor);
    require(request.get("requestToken") instanceof String, "invalid-request");
    String token = budget.text((String) request.get("requestToken"), 128);
    require(token.matches("[A-Za-z0-9._-]+"), "invalid-request");
    try {
      Host host = host();
      String validatedBinding = "gradle".equals(host.build()) ? synchronizeGradle(host, budget) : null;
      return observeBound(GRADLE_ATTEMPT, validatedBinding, () -> {
      IProject project = selectedProject(host.project());
      IJavaProject javaProject = JavaCore.create(project);
      JavaModelManager manager = JavaModelManager.getJavaModelManager();
      PerProjectInfo info = manager.getPerProjectInfo(project, false);
      requireCached(info != null, "project-info", "info-absent");
      Map<String, Object> before = cached(javaProject, info, host, budget, "initial");
      // Select only from the immutable image; Buildship preserves a trailing separator on the same known JRE path.
      String capturedJre = null;
      for (Object raw : (List<?>) before.get("rawClasspath")) {
        Map<?, ?> entry = (Map<?, ?>) raw;
        if (Integer.valueOf(IClasspathEntry.CPE_CONTAINER).equals(entry.get("kind")) && isJre((String) entry.get("path")))
          capturedJre = (String) entry.get("path");
      }
      require(capturedJre != null, "unqualified-jre");
      IPath jrePath = org.eclipse.core.runtime.Path.fromPortableString(capturedJre);
      // Known VM registry/EE initialization is admitted setup work, not a passive lookup or classpath resolution.
      IVMInstall vm = JavaRuntime.getVMInstall(jrePath);
      require(vm != null && vm.getInstallLocation() != null, "unqualified-jre");
      Path actualHome = canonical(vm.getInstallLocation().toPath());
      require(actualHome.equals(host.javaHome()), "unqualified-jre");
      Map<String, String> vmImage = vm(vm, budget);
      List<Map<String, Object>> libraries = libraries(before, host, budget);
      IVMInstall selectedAfter = JavaRuntime.getVMInstall(jrePath);
      require(selectedAfter != null && vmImage.equals(vm(selectedAfter, new Budget(monitor))), "model-changed");
      Map<String, Object> after = cached(javaProject, info, host, new Budget(monitor), "confirmed");
      require(manager.getPerProjectInfo(project, false) == info && before.equals(after)
          && vmImage.equals(vm(vm, new Budget(monitor)))
          && actualHome.equals(canonical(vm.getInstallLocation().toPath())), "model-changed");
      require(libraries.equals(libraries(after, host, new Budget(monitor))), "library-changed");
      budget.check();
      return Map.of("protocolVersion", 1, "requestToken", token, "status", "observed-cached",
          "model", before, "vm", vmImage, "libraries", libraries);
      });
    } catch (Unsupported refusal) {
      if ("observation-failed".equals(refusal.getMessage()))
        return Map.of("protocolVersion", 1, "requestToken", token, "status", "unsupported", "reason", "observation-failed");
      return Map.of("protocolVersion", 1, "requestToken", token, "status", "unsupported",
          "reason", refusal.getMessage(), "evidence", refusal.evidence);
    } catch (Exception | LinkageError failure) {
      // Unvalidated host/config input cannot poison another trusted binding.
      // Provider or filesystem exception messages can contain private paths or arbitrary imported text.
      return Map.of("protocolVersion", 1, "requestToken", token, "status", "unsupported", "reason", "observation-failed");
    }
  }

  private static Host host() throws Exception {
    Path project = propertyPath("threadnote.java.preparedProjectUri");
    Path home = propertyPath("threadnote.java.projectJavaHomeUri");
    Path maven = propertyPath("threadnote.java.preparedMavenCacheUri");
    Path gradle = propertyPath("threadnote.java.preparedGradleCacheUri");
    String build = System.getProperty("threadnote.java.preparedBuild");
    require("maven".equals(build) || "gradle".equals(build), "invalid-host");
    require(!project.startsWith(home) && !home.startsWith(project), "invalid-host");
    for (Path cache : List.of(maven, gradle))
      require(!project.startsWith(cache) && !cache.startsWith(project)
          && !home.startsWith(cache) && !cache.startsWith(home), "invalid-host");
    return new Host(project, home, List.of(maven, gradle), build);
  }
  private static Path propertyPath(String key) throws Exception {
    String value = System.getProperty(key);
    require(value != null && value.length() <= 8192, "invalid-host");
    URI uri = new URI(value);
    require("file".equals(uri.getScheme()) && uri.getRawAuthority() == null
        && uri.getRawQuery() == null && uri.getRawFragment() == null, "invalid-host");
    Path path = canonical(Path.of(uri));
    require(Files.isDirectory(path, LinkOption.NOFOLLOW_LINKS), "invalid-host");
    return path;
  }
  private static Path canonical(Path path) throws Exception {
    require(path.isAbsolute() && path.normalize().equals(path) && path.toRealPath().equals(path), "unsafe-path");
    return path;
  }
  private static IProject selectedProject(Path selected) throws Exception {
    IProject result = null;
    IProject[] projects = ResourcesPlugin.getWorkspace().getRoot().getProjects();
    require(projects.length <= 16, "capacity");
    for (IProject project : projects) {
      if (!project.isAccessible() || project.getLocationURI() == null) continue;
      if (Path.of(project.getLocationURI()).equals(selected)) {
        require(result == null, "ambiguous-project");
        result = project;
      }
    }
    require(result != null && result.hasNature(JavaCore.NATURE_ID), "unmanaged-project");
    return result;
  }

  record CacheImage(List<Map<String, Object>> raw, List<Map<String, Object>> resolved,
      String outputPath, long timestamp, String optionsDigest) {}
  record PassiveProjection(Map<String, Object> image, List<Map<String, Object>> raw) {}

  /** Membership belongs to the same immutable image attested for the AST, including its physical source links. */
  static boolean projectionSourceMember(Map<String, Object> image, IPath target, String sourceUri) throws Exception {
    URI uri = new URI(sourceUri);
    if (!"file".equals(uri.getScheme()) || uri.getRawAuthority() != null || uri.getRawQuery() != null
        || uri.getRawFragment() != null) return false;
    Path file = Path.of(uri);
    if (!file.isAbsolute() || !file.normalize().equals(file)) return false;
    for (Object item : (List<?>) image.get("rawClasspath")) {
      Map<?, ?> entry = (Map<?, ?>) item;
      if (!Integer.valueOf(IClasspathEntry.CPE_SOURCE).equals(entry.get("kind"))) continue;
      IPath root = org.eclipse.core.runtime.Path.fromPortableString((String) entry.get("path"));
      if (!root.isPrefixOf(target) || root.equals(target)) continue;
      boolean physical = false;
      for (Object rawLink : (List<?>) image.get("links")) {
        Map<?, ?> link = (Map<?, ?>) rawLink;
        if (root.removeFirstSegments(1).toPortableString().equals(link.get("path"))) {
          Path directory = Path.of(new URI((String) link.get("uri")));
          Path selected = directory.resolve(target.removeFirstSegments(root.segmentCount()).toOSString()).normalize();
          physical = !selected.equals(directory) && selected.startsWith(directory) && selected.equals(file);
        }
      }
      if (!physical) continue;
      for (Object rawFilter : (List<?>) image.get("resourceFilters")) {
        Map<?, ?> filter = (Map<?, ?>) rawFilter;
        var matcher = java.util.regex.Pattern.compile((String) filter.get("arguments"));
        for (String segment : target.removeFirstSegments(1).segments())
          if (matcher.matcher(segment).matches()) return false;
      }
      if (!org.eclipse.jdt.internal.compiler.util.Util.isExcluded(target.toString().toCharArray(),
          fullPatterns(root, entry.get("inclusions")), fullPatterns(root, entry.get("exclusions")), false)) return true;
    }
    return false;
  }
  private static char[][] fullPatterns(IPath root, Object rawPatterns) {
    List<?> patterns = (List<?>) rawPatterns;
    if (patterns.isEmpty()) return null;
    char[][] result = new char[patterns.size()][];
    for (int i = 0; i < patterns.size(); i++)
      result[i] = root.removeTrailingSeparator().append(org.eclipse.core.runtime.Path.fromPortableString((String) patterns.get(i)))
          .toString().toCharArray();
    return result;
  }

  /** Called only from an already captured source snapshot, never exposed as an analysis model command. */
  static PassiveProjection passiveProjection(IJavaProject project, IProgressMonitor monitor) throws Exception {
    Budget budget = new Budget(monitor);
    var resource = project.getProject();
    require(resource instanceof org.eclipse.core.internal.resources.Project && resource.isAccessible()
        && resource.isOpen(), "unmanaged-project");
    var pinnedProject = (org.eclipse.core.internal.resources.Project) resource;
    var description = pinnedProject.internalGetDescription();
    require(description != null && Arrays.equals(description.getNatureIds(), new String[] {JavaCore.NATURE_ID})
        && description.getBuildSpec().length == 0 && description.getReferencedProjects().length == 0
        && description.getDynamicReferences().length == 0
        && (description.getVariables() == null || description.getVariables().isEmpty()), "unsupported-resource-model");
    var manager = JavaModelManager.getJavaModelManager();
    var info = manager.getPerProjectInfo(resource, false);
    require(info != null, "model-not-cached");
    CacheImage cache = cacheImage(info, budget);
    privateOutput(cache.outputPath(), project);
    for (Map<String, Object> entry : cache.raw())
      if (entry.containsKey("outputPath")) privateOutput((String) entry.get("outputPath"), project);
    Set<String> sourceLinks = new HashSet<>();
    int jres = 0;
    for (Map<String, Object> entry : cache.raw()) {
      int kind = (Integer) entry.get("kind");
      String path = (String) entry.get("path");
      if (kind == IClasspathEntry.CPE_SOURCE) {
        IPath source = org.eclipse.core.runtime.Path.fromPortableString(path);
        require(source.isAbsolute() && source.segmentCount() == 2
            && source.segment(0).equals(project.getElementName())
            && source.segment(1).matches("source-(?:[0-9]|[12][0-9]|3[01])")
            && sourceLinks.add(source.segment(1)), "unsupported-linked-resource");
      } else if (kind == IClasspathEntry.CPE_CONTAINER) {
        require(isJre(path), "unsupported-container");
        jres++;
      } else require(kind == IClasspathEntry.CPE_LIBRARY, "unsupported-entry");
    }
    require(jres == 1 && !sourceLinks.isEmpty(), "incomplete-projection");
    var descriptions = description.getLinks();
    require(descriptions != null && descriptions.size() == sourceLinks.size(), "unsupported-linked-resource");
    Map<String, Map<String, Object>> links = new TreeMap<>();
    for (var entry : descriptions.entrySet()) {
      var link = entry.getValue();
      String path = budget.text(entry.getKey().toPortableString(), 8192);
      require(sourceLinks.contains(path) && link != null && entry.getKey().equals(link.getProjectRelativePath())
          && link.getType() == IResource.FOLDER && !link.isGroup(), "unsupported-linked-resource");
      URI uri = link.getLocationURI();
      require(uri != null && "file".equals(uri.getScheme()) && uri.getRawAuthority() == null
          && uri.getRawQuery() == null && uri.getRawFragment() == null, "unsupported-linked-resource");
      // Compare metadata before any filesystem access through these links. The host's expected digest owns the allowset.
      Path target = Path.of(uri);
      require(target.isAbsolute() && target.normalize().equals(target), "unsafe-path");
      links.put(path, Map.of("path", path, "uri", budget.text(uri.toASCIIString(), 8192), "type", link.getType()));
    }
    String charset = resource.getDefaultCharset(true);
    require("UTF-8".equals(charset), "unsupported-charset");
    Map<String, Object> image = Map.of("format", "threadnote-passive-java-projection-v1",
        "projectCharset", charset, "outputPath", cache.outputPath(), "rawClasspath", cache.raw(),
        "resolvedClasspath", cache.resolved(), "links", List.copyOf(links.values()),
        "resourceFilters", resourceFilters(description, resource, budget));
    require(manager.getPerProjectInfo(resource, false) == info
        && cache.equals(cacheImage(info, new Budget(monitor)))
        && pinnedProject.internalGetDescription() == description, "model-changed");
    return new PassiveProjection(image, cache.raw());
  }

  private static void privateOutput(String value, IJavaProject project) throws Unsupported {
    IPath output = org.eclipse.core.runtime.Path.fromPortableString(value);
    require(output.isAbsolute() && output.segmentCount() == 2
        && output.segment(0).equals(project.getElementName())
        && output.segment(1).matches("output-(?:[0-9]|[12][0-9]|3[0-2])"), "unsupported-output");
  }

  private static void requireCached(boolean condition, String stage, String missing) throws Unsupported {
    if (!condition) throw new Unsupported("model-not-cached", stage == null ? Map.of()
        : Map.of("cacheStage", stage, "cacheCondition", missing));
  }
  private static CacheImage cacheImage(PerProjectInfo info, Budget budget) throws Exception {
    return cacheImage(info, budget, null);
  }
  private static CacheImage cacheImage(PerProjectInfo info, Budget budget, String stage) throws Exception {
    synchronized (info) {
      // Preserve the original conjunction's short-circuit read order and the same info monitor.
      requireCached(info.rawClasspath != null, stage, "raw-absent");
      requireCached(info.rawClasspath != JavaProject.INVALID_CLASSPATH, stage, "raw-invalid");
      requireCached(!info.writtingRawClasspath, stage, "raw-writing");
      requireCached(info.rawClasspathStatus != null, stage, "raw-status-absent");
      requireCached(info.rawClasspathStatus.isOK(), stage, "raw-status-failed");
      requireCached(info.unresolvedEntryStatus != null, stage, "unresolved-status-absent");
      requireCached(info.unresolvedEntryStatus.isOK(), stage, "unresolved-status-failed");
      requireCached(info.getResolvedClasspath() != null, stage, "resolved-absent");
      requireCached(info.options != null, stage, "options-absent");
      requireCached(info.outputLocation != null, stage, "output-absent");
      require(info.rawClasspath.length <= 162 && info.resolvedClasspath.length <= 512
          && info.options.size() <= 2048, "capacity");
      List<Map<String, Object>> raw = entries(info.rawClasspath, budget, false);
      List<Map<String, Object>> resolved = entries(info.resolvedClasspath, budget, true);
      StringBuilder options = new StringBuilder();
      for (Map.Entry<String, String> option : new TreeMap<>(info.options).entrySet()) {
        String key = budget.text(option.getKey(), 256);
        String value = budget.text(option.getValue(), 8192);
        options.append(key.length()).append(':').append(key).append(value.length()).append(':').append(value);
      }
      return new CacheImage(raw, resolved, budget.text(info.outputLocation.toPortableString(), 8192),
          info.rawTimeStamp, DiagnosticSnapshot.sha256(options.toString()));
    }
  }
  private static Map<String, Object> cached(IJavaProject project, PerProjectInfo info, Host host, Budget budget, String stage)
      throws Exception {
    // Only bounded immutable primitives leave the info monitor. Resource, filesystem and global-option work stays outside.
    CacheImage cache = cacheImage(info, budget, stage);
    require(project.getProject().isAccessible() && project.getProject().getLocationURI() != null
        && canonical(Path.of(project.getProject().getLocationURI())).equals(host.project()), "unmanaged-project");
    require(project.getProject() instanceof org.eclipse.core.internal.resources.Project, "unsupported-resource-model");
    // The public getDescription() clone deliberately drops links and filters; inspect only the pinned cached description.
    var pinnedProject = (org.eclipse.core.internal.resources.Project) project.getProject();
    var description = pinnedProject.internalGetDescription();
    require(description != null, "unsupported-resource-model");
    var links = description.getLinks();
    require(links == null || links.isEmpty(), "unsupported-linked-resource");
    List<Map<String, Object>> resourceFilters = resourceFilters(description, project.getProject(), budget);
    String importer = host.build().equals("maven") ? "org.eclipse.m2e.core.maven2Nature"
        : "org.eclipse.buildship.core.gradleprojectnature";
    String container = host.build().equals("maven") ? "org.eclipse.m2e.MAVEN2_CLASSPATH_CONTAINER"
        : "org.eclipse.buildship.core.gradleclasspathcontainer";
    String[] natureIds = description.getNatureIds();
    require(natureIds.length <= 8 && Arrays.asList(natureIds).contains(importer), "wrong-importer");
    List<String> natures = new ArrayList<>();
    for (String nature : natureIds) {
      require(nature.equals(JavaCore.NATURE_ID) || nature.equals(importer), "unsupported-nature");
      natures.add(budget.text(nature, 256));
    }
    int importerCount = 0;
    int jreCount = 0;
    for (Map<String, Object> entry : cache.raw()) {
      int kind = (Integer) entry.get("kind");
      require(kind == IClasspathEntry.CPE_SOURCE || kind == IClasspathEntry.CPE_LIBRARY
          || kind == IClasspathEntry.CPE_CONTAINER, "unsupported-entry");
      if (kind == IClasspathEntry.CPE_CONTAINER) {
        String id = (String) entry.get("path");
        if (!isJre(id) && !id.equals(container))
          throw new Unsupported("unsupported-container", Map.of("idSha256", DiagnosticSnapshot.sha256(id)));
        if (isJre(id)) jreCount++; else importerCount++;
      }
    }
    require(jreCount == 1 && importerCount == 1, "incomplete-import");
    IMarker[] markers = project.getProject().findMarkers(IMarker.PROBLEM, true, IResource.DEPTH_ZERO);
    require(markers.length <= 512, "capacity");
    for (IMarker marker : markers)
      require(marker.getAttribute(IMarker.SEVERITY, IMarker.SEVERITY_ERROR) < IMarker.SEVERITY_ERROR,
          "project-import-error");
    List<Map<String, Object>> raw = locations(cache.raw(), project, host, budget);
    List<Map<String, Object>> resolved = locations(cache.resolved(), project, host, budget);
    Map<String, String> options = new TreeMap<>();
    Map<String, String> actualOptions = project.getOptions(true);
    require(actualOptions.size() <= 2048, "capacity");
    for (Map.Entry<String, String> entry : actualOptions.entrySet()) {
      if (entry.getKey().startsWith("org.eclipse.jdt.core.compiler."))
        options.put(budget.text(entry.getKey(), 256), budget.text(entry.getValue(), 8192));
    }
    String charset = project.getProject().getDefaultCharset(true);
    require("UTF-8".equalsIgnoreCase(charset), "unsupported-charset");
    Map<String, Object> model = new TreeMap<>(Map.of("projectUri", budget.text(host.project().toUri().toASCIIString(), 8192),
        "build", host.build(), "natures", List.copyOf(natures), "rawClasspath", raw,
        "resolvedClasspath", resolved, "compilerOptions", Map.copyOf(options),
        "outputUri", physical(org.eclipse.core.runtime.Path.fromPortableString(cache.outputPath()), project, host, budget),
        "projectCharset", charset, "rawTimestamp", cache.timestamp(), "cachedOptionsSha256", cache.optionsDigest()));
    model.put("resourceFilters", resourceFilters);
    model.put("sourceEncoding", sourceEncoding(project.getProject(), host, resolved, budget));
    var finalLinks = description.getLinks();
    require(pinnedProject.internalGetDescription() == description && (finalLinks == null || finalLinks.isEmpty())
        && resourceFilters.equals(resourceFilters(description, project.getProject(), new Budget(budget.monitor)))
        && cache.equals(cacheImage(info, new Budget(budget.monitor), stage + "-stability")), "model-changed");
    return Map.copyOf(model);
  }

  /** Conservative superset: check every physical .java below source roots, including classpath exclusions. */
  private static Map<String, Object> sourceEncoding(IProject project, Host host,
      List<Map<String, Object>> entries, Budget budget) throws Exception {
    List<Path> pending = new ArrayList<>();
    for (Map<String, Object> entry : entries)
      if (Integer.valueOf(IClasspathEntry.CPE_SOURCE).equals(entry.get("kind")) && Boolean.TRUE.equals(entry.get("exists")))
        pending.add(Path.of(new URI((String) entry.get("uri"))));
    Set<Path> visited = new HashSet<>();
    Map<String, String> sources = new TreeMap<>();
    int count = 0;
    long totalBytes = 0;
    while (!pending.isEmpty()) {
      budget.check();
      Path directory = pending.remove(pending.size() - 1);
      if (!visited.add(directory)) continue;
      require(!directory.equals(host.project()) && directory.startsWith(host.project())
          && canonical(directory).equals(directory) && Files.isDirectory(directory, LinkOption.NOFOLLOW_LINKS), "unsafe-source");
      try (var children = Files.newDirectoryStream(directory)) {
        for (Path file : children) {
          budget.check();
          require(++count <= 20000, "capacity");
          canonical(file);
          BasicFileAttributes before = Files.readAttributes(file, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
          if (before.isDirectory()) { pending.add(file); continue; }
          require(before.isRegularFile(), "unsafe-source");
          if (!file.getFileName().toString().toLowerCase(Locale.ROOT).endsWith(".java")) continue;
          require(before.fileKey() != null && before.size() <= 4 * 1024 * 1024, "capacity");
          totalBytes += before.size();
          require(totalBytes <= 256L * 1024 * 1024, "capacity");
          ByteBuffer bytes = ByteBuffer.allocate((int) before.size());
          try (SeekableByteChannel channel = Files.newByteChannel(file, StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS)) {
            while (bytes.hasRemaining()) {
              budget.check();
              require(channel.read(bytes) != -1, "source-changed");
            }
            require(channel.read(ByteBuffer.allocate(1)) == -1, "source-changed");
          }
          bytes.flip();
          // BOM stripping differs between provider and host text APIs; qualify it separately before supporting it.
          require(bytes.remaining() < 3 || bytes.get(0) != (byte) 0xef
              || bytes.get(1) != (byte) 0xbb || bytes.get(2) != (byte) 0xbf, "unsupported-source-bom");
          var decoded = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
              .onUnmappableCharacter(CodingErrorAction.REPORT).decode(bytes.asReadOnlyBuffer());
          require(decoded.length() <= 2 * 1024 * 1024, "capacity");
          String relative = budget.text(host.project().relativize(file).toString().replace(java.io.File.separatorChar, '/'), 8192);
          IFile resource = project.getFile(org.eclipse.core.runtime.Path.fromPortableString(relative));
          require(resource instanceof org.eclipse.core.internal.resources.File && resource.isAccessible()
              && !resource.isLinked(IResource.CHECK_ANCESTORS) && !resource.isVirtual()
              && resource.getLocationURI() != null && Path.of(resource.getLocationURI()).equals(file), "unsafe-source");
          // This is admitted setup observation. The pinned IFile implementation includes per-file, detected and inherited charset.
          String charset = resource.getCharset(true);
          require("UTF-8".equalsIgnoreCase(charset), "unsupported-source-charset");
          BasicFileAttributes after = Files.readAttributes(file, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
          require(after.isRegularFile() && before.fileKey().equals(after.fileKey()) && before.size() == after.size()
              && before.lastModifiedTime().equals(after.lastModifiedTime()) && canonical(file).equals(file)
              && charset.equals(resource.getCharset(true)), "source-changed");
          MessageDigest digest = MessageDigest.getInstance("SHA-256");
          digest.update(bytes);
          sources.put(relative, HexFormat.of().formatHex(digest.digest()));
        }
      }
    }
    StringBuilder image = new StringBuilder("threadnote-java-source-encoding-v1\n");
    for (var source : sources.entrySet())
      image.append(source.getKey().length()).append(':').append(source.getKey()).append(source.getValue());
    return Map.of("policy", "utf8-no-bom-v1", "sourceCount", sources.size(),
        "sourceDigest", DiagnosticSnapshot.sha256(image.toString()));
  }
  private static List<Map<String, Object>> resourceFilters(
      org.eclipse.core.internal.resources.ProjectDescription description, IProject selectedProject, Budget budget) throws Exception {
    var filters = description.getFilters();
    if (filters == null || filters.isEmpty()) return List.of();
    require(filters.size() <= 1, "unsupported-resource-filter");
    int count = 0;
    List<Map<String, Object>> result = new ArrayList<>();
    int expectedType = IResourceFilterDescription.EXCLUDE_ALL | IResourceFilterDescription.FILES
        | IResourceFilterDescription.FOLDERS | IResourceFilterDescription.INHERITABLE;
    // The pinned JDT LS adds this root basename filter to ordinary imports. Preserve its actual semantics for v2 projection.
    String expectedArguments = "node_modules|\\.git|__CREATED_BY_JAVA_LANGUAGE_SERVER__";
    for (var entry : filters.entrySet()) {
      require(entry.getKey().isEmpty() && entry.getValue() != null && entry.getValue().size() <= 1,
          "unsupported-resource-filter");
      for (var filter : entry.getValue()) {
        require(++count <= 1 && filter.getType() == expectedType && selectedProject.equals(filter.getResource()),
            "unsupported-resource-filter");
        var matcher = filter.getFileInfoMatcherDescription();
        require(matcher != null && matcher.getArguments() instanceof String, "unsupported-resource-filter");
        String id = budget.text(matcher.getId(), 256);
        String arguments = budget.text((String) matcher.getArguments(), 8192);
        require(id.equals("org.eclipse.core.resources.regexFilterMatcher") && arguments.equals(expectedArguments),
            "unsupported-resource-filter");
        result.add(Map.of("path", budget.text(entry.getKey().toPortableString(), 8192), "type", filter.getType(),
            "id", budget.text(Long.toString(filter.getId()), 20),
            "matcherId", id, "arguments", arguments));
      }
    }
    return List.copyOf(result);
  }
  private static List<Map<String, Object>> locations(List<Map<String, Object>> entries,
      IJavaProject project, Host host, Budget budget) throws Exception {
    List<Map<String, Object>> result = new ArrayList<>();
    for (Map<String, Object> entry : entries) {
      Map<String, Object> image = new TreeMap<>(entry);
      int kind = (Integer) entry.get("kind");
      if (kind == IClasspathEntry.CPE_SOURCE) {
        String uri = physical(org.eclipse.core.runtime.Path.fromPortableString((String) entry.get("path")), project, host, budget);
        image.put("uri", uri);
        image.put("exists", Files.exists(Path.of(new URI(uri)), LinkOption.NOFOLLOW_LINKS));
        if (entry.containsKey("outputPath")) {
          image.put("outputUri", physical(org.eclipse.core.runtime.Path.fromPortableString((String) entry.get("outputPath")), project, host, budget));
          image.remove("outputPath");
        }
      } else if (kind == IClasspathEntry.CPE_LIBRARY) {
        Path library = canonical(Path.of(org.eclipse.core.runtime.Path.fromPortableString((String) entry.get("path")).toOSString()));
        require(library.startsWith(host.javaHome()) || host.caches().stream().anyMatch(library::startsWith),
            "library-outside-allowset");
        image.put("uri", budget.text(library.toUri().toASCIIString(), 8192));
      }
      result.add(Map.copyOf(image));
    }
    return List.copyOf(result);
  }
  private static List<Map<String, Object>> entries(IClasspathEntry[] entries, Budget budget, boolean resolved) throws Exception {
    List<Map<String, Object>> result = new ArrayList<>();
    int roots = 0;
    int libraries = 0;
    for (IClasspathEntry entry : entries) {
      budget.check();
      int kind = entry.getEntryKind();
      require(!resolved || kind == IClasspathEntry.CPE_SOURCE || kind == IClasspathEntry.CPE_LIBRARY,
          "unresolved-entry");
      if (kind == IClasspathEntry.CPE_SOURCE) require(++roots <= 32, "capacity");
      if (kind == IClasspathEntry.CPE_LIBRARY) require(++libraries <= 128, "capacity");
      Map<String, Object> image = new TreeMap<>();
      image.put("kind", kind);
      image.put("path", budget.text(entry.getPath().toPortableString(), 8192));
      image.put("contentKind", entry.getContentKind());
      image.put("exported", entry.isExported());
      image.put("combineAccessRules", entry.combineAccessRules());
      image.put("inclusions", patterns(entry.getInclusionPatterns(), budget));
      image.put("exclusions", patterns(entry.getExclusionPatterns(), budget));
      if (entry.getOutputLocation() != null)
        image.put("outputPath", budget.text(entry.getOutputLocation().toPortableString(), 8192));
      if (entry.getSourceAttachmentPath() != null)
        image.put("sourceAttachmentPath", budget.text(entry.getSourceAttachmentPath().toPortableString(), 8192));
      if (entry.getSourceAttachmentRootPath() != null)
        image.put("sourceAttachmentRoot", budget.text(entry.getSourceAttachmentRootPath().toPortableString(), 8192));
      IClasspathAttribute[] attributes = entry.getExtraAttributes();
      require(attributes.length <= 32, "capacity");
      List<Map<String, String>> attrs = new ArrayList<>();
      for (IClasspathAttribute attribute : attributes) {
        String name = budget.text(attribute.getName(), 256);
        String value = budget.text(attribute.getValue(), 8192);
        if ("javadoc_location".equals(name)) {
          attrs.add(Map.of("name", "javadoc_location", "valueSha256", DiagnosticSnapshot.sha256(value),
              "access", "disabled"));
          continue;
        }
        if (!ATTRIBUTES.contains(name))
          throw new Unsupported("unsupported-attribute", Map.of("nameSha256", DiagnosticSnapshot.sha256(name)));
        attrs.add(Map.of("name", name, "value", value));
      }
      image.put("attributes", List.copyOf(attrs));
      IAccessRule[] rules = entry.getAccessRules();
      require(rules.length <= 32, "capacity");
      List<Map<String, Object>> access = new ArrayList<>();
      for (IAccessRule rule : rules)
        access.add(Map.of("pattern", budget.text(rule.getPattern().toPortableString(), 8192),
            "kind", rule.getKind(), "ignoreIfBetter", rule.ignoreIfBetter()));
      image.put("accessRules", List.copyOf(access));
      result.add(Map.copyOf(image));
    }
    require(!resolved || roots > 0, "missing-source-model");
    return List.copyOf(result);
  }
  private static List<String> patterns(IPath[] patterns, Budget budget) throws Unsupported {
    require(patterns.length <= 128, "capacity");
    List<String> result = new ArrayList<>();
    for (IPath pattern : patterns) result.add(budget.text(pattern.toPortableString(), 8192));
    return List.copyOf(result);
  }
  private static String physical(IPath path, IJavaProject project, Host host, Budget budget) throws Exception {
    require(path.isAbsolute() && path.segmentCount() >= 1 && path.segment(0).equals(project.getElementName()),
        "foreign-project-path");
    Path target = host.project().resolve(path.removeFirstSegments(1).toOSString()).normalize();
    require(target.startsWith(host.project()), "unsafe-path");
    IResource resource = path.segmentCount() == 1 ? project.getProject()
        : project.getProject().getFolder(path.removeFirstSegments(1));
    require(!resource.isLinked(IResource.CHECK_ANCESTORS) && !resource.isVirtual()
        && resource.getLocationURI() != null && Path.of(resource.getLocationURI()).equals(target),
        "unsupported-linked-resource");
    Path ancestor = target;
    while (!Files.exists(ancestor, LinkOption.NOFOLLOW_LINKS)) {
      budget.check();
      ancestor = ancestor.getParent();
      require(ancestor != null && ancestor.startsWith(host.project()), "unsafe-path");
    }
    canonical(ancestor);
    require(Files.isDirectory(ancestor, LinkOption.NOFOLLOW_LINKS), "unsafe-path");
    return budget.text(target.toUri().toASCIIString(), 8192);
  }
  private static Map<String, String> vm(IVMInstall vm, Budget budget) throws Exception {
    return Map.of("type", budget.text(vm.getVMInstallType().getId(), 256),
        "id", budget.text(vm.getId(), 256), "name", budget.text(vm.getName(), 256),
        "javaHomeUri", budget.text(canonical(vm.getInstallLocation().toPath()).toUri().toASCIIString(), 8192));
  }
  private static List<Map<String, Object>> libraries(Map<String, Object> image, Host host, Budget budget)
      throws Exception {
    List<Map<String, Object>> result = new ArrayList<>();
    for (Object raw : (List<?>) image.get("resolvedClasspath")) {
      Map<?, ?> entry = (Map<?, ?>) raw;
      if (!Integer.valueOf(IClasspathEntry.CPE_LIBRARY).equals(entry.get("kind"))) continue;
      Path path = Path.of(new URI((String) entry.get("uri")));
      if (path.startsWith(host.javaHome())) continue; // Full SDK integrity is independently pinned by the host.
      require(host.caches().stream().anyMatch(path::startsWith), "library-outside-allowset");
      BasicFileAttributes before = Files.readAttributes(path, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
      require(before.isRegularFile() && before.fileKey() != null && before.size() <= 64 * 1024 * 1024,
          "unsupported-library");
      budget.libraryBytes += before.size();
      require(budget.libraryBytes <= 512L * 1024 * 1024, "capacity");
      MessageDigest digest = MessageDigest.getInstance("SHA-256");
      long length = 0;
      try (SeekableByteChannel channel = Files.newByteChannel(path, StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS)) {
        ByteBuffer bytes = ByteBuffer.allocate(65536);
        while (channel.read(bytes) != -1) {
          budget.check();
          length += bytes.position();
          require(length <= before.size(), "library-changed");
          bytes.flip(); digest.update(bytes); bytes.clear();
        }
      }
      BasicFileAttributes after = Files.readAttributes(path, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
      require(length == before.size() && after.isRegularFile() && before.fileKey().equals(after.fileKey())
          && before.size() == after.size() && before.lastModifiedTime().equals(after.lastModifiedTime())
          && canonical(path).equals(path), "library-changed");
      result.add(Map.of("uri", budget.text(path.toUri().toASCIIString(), 8192),
          "sha256", HexFormat.of().formatHex(digest.digest()), "bytes", length));
    }
    return List.copyOf(result);
  }
  private static void require(boolean condition, String reason) throws Unsupported {
    if (!condition) throw new Unsupported(reason);
  }
}
