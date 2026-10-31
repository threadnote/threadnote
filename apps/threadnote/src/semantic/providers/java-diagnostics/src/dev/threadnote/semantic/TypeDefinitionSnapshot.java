package dev.threadnote.semantic;

import java.net.URI;
import java.nio.ByteBuffer;
import java.nio.channels.Channels;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.eclipse.core.resources.IFile;
import org.eclipse.core.runtime.IProgressMonitor;
import org.eclipse.jdt.core.ICompilationUnit;
import org.eclipse.jdt.core.IType;
import org.eclipse.jdt.core.dom.AbstractTypeDeclaration;
import org.eclipse.jdt.core.dom.CompilationUnit;
import org.eclipse.jdt.core.dom.IBinding;
import org.eclipse.jdt.core.dom.ITypeBinding;
import org.eclipse.jdt.core.dom.IVariableBinding;
import org.eclipse.jdt.core.dom.NodeFinder;
import org.eclipse.jdt.core.dom.SimpleName;
import org.eclipse.jdt.ls.core.internal.JDTUtils;
import dev.threadnote.semantic.DiagnosticSnapshot.Input;
import dev.threadnote.semantic.DiagnosticSnapshot.Model;
import static dev.threadnote.semantic.DiagnosticSnapshot.check;

/** Source type lookup uses the captured direct AST; it never calls cached-AST or binary/source-discovery handlers. */
final class TypeDefinitionSnapshot {
  record Result(Map<String, Object> image, Map<String, Integer> position, SourceImage source) {
    void verify(Model model) throws Exception {
      if (source != null) source.verify(model);
    }
  }
  private record SourceImage(ICompilationUnit unit, String uri, String text, BasicFileAttributes attributes) {
    void verify(Model model) throws Exception {
      check(unit.getJavaProject().equals(model.project()) && JDTUtils.isOnClassPath(unit)
          && unit.getOptions(true).equals(model.options()), "Type source model changed");
      check(unit.getResource() instanceof IFile resource && resource.isAccessible()
          && DiagnosticSnapshot.fileUri(resource.getLocationURI().toString()).equals(uri), "Type source identity changed");
      if (attributes == null) {
        check(unit.equals(unit.getPrimary()) && unit.isWorkingCopy(), "Type working copy changed");
      } else {
        check(!unit.isWorkingCopy(), "Type source ownership changed");
        SourceImage after = closedSource(unit, uri, text.length());
        check(sameFile(attributes, after.attributes()) && text.equals(after.text()), "Closed type source changed");
      }
    }
  }

  static Result read(Object rawPosition, Input target, List<Input> inputs, Model model,
      CompilationUnit ast, int remainingCharacters, IProgressMonitor monitor) throws Exception {
    check(rawPosition instanceof Map<?, ?>, "Missing type position");
    Map<?, ?> raw = (Map<?, ?>) rawPosition;
    check(raw.keySet().equals(Set.of("line", "character")), "Invalid type position fields");
    int line = counter(raw.get("line"));
    int character = counter(raw.get("character"));
    Map<String, Integer> position = Map.of("line", line, "character", character);
    int[] starts = DiagnosticSnapshot.lineStarts(target.text());
    check(line < starts.length, "Type position outside source");
    int start = starts[line];
    int end = line + 1 < starts.length ? starts[line + 1] : target.text().length();
    while (end > start && (target.text().charAt(end - 1) == '\r' || target.text().charAt(end - 1) == '\n')) end--;
    check(character <= end - start, "Type position outside line");
    int offset = start + character;
    check(offset == 0 || offset == target.text().length()
        || !(Character.isHighSurrogate(target.text().charAt(offset - 1))
            && Character.isLowSurrogate(target.text().charAt(offset))), "Type position splits encoding");
    var node = new NodeFinder(ast, offset, 0).getCoveringNode();
    if (!(node instanceof SimpleName name)) return unsupported(position, "no-source-type");
    IBinding binding = name.resolveBinding();
    ITypeBinding type = binding instanceof IVariableBinding variable ? variable.getType()
        : binding instanceof ITypeBinding selected ? selected : null;
    if (type == null || type.isRecovered() || type.isArray() || type.isPrimitive())
      return unsupported(position, "no-source-type");
    type = type.getTypeDeclaration();
    if (type.getKey() == null || type.getKey().length() > 16384)
      return unsupported(position, "unrepresentable-source");
    if (!type.isFromSource()) return unsupported(position, "binary-type");
    if (!(type.getJavaElement() instanceof IType element)) return unsupported(position, "unrepresentable-source");
    ICompilationUnit unit = element.getCompilationUnit();
    if (unit == null || !unit.getJavaProject().equals(model.project()) || !JDTUtils.isOnClassPath(unit)
        || JDTUtils.isDefaultProject(unit) || !(unit.getResource() instanceof IFile resource)
        || !resource.isAccessible() || resource.getLocationURI() == null)
      return unsupported(position, "unrepresentable-source");
    String uri = DiagnosticSnapshot.fileUri(resource.getLocationURI().toString());
    Path file = Path.of(URI.create(uri));
    boolean contained = false;
    for (String root : model.sourceRoots()) {
      Path directory = Path.of(URI.create(root));
      if (!file.equals(directory) && file.startsWith(directory)) contained = true;
    }
    if (!contained) return unsupported(position, "unrepresentable-source");
    Input captured = inputs.stream().filter(input -> input.unit().equals(unit)).findFirst().orElse(null);
    SourceImage source;
    if (captured != null) source = new SourceImage(unit, uri, captured.text(), null);
    else {
      check(!unit.isWorkingCopy(), "Uncaptured type working copy");
      source = closedSource(unit, uri, Math.min(DiagnosticSnapshot.MAX_TEXT, remainingCharacters));
    }
    check(source.text().length() <= DiagnosticSnapshot.MAX_TEXT && !monitor.isCanceled(), "Type source capacity or cancellation");
    CompilationUnit declarationAst = unit.equals(target.unit()) ? ast
        : DiagnosticSnapshot.parse(unit, source.text(), model, model.options(), monitor);
    var declaration = declarationAst.findDeclaringNode(type.getKey());
    if (!(declaration instanceof AbstractTypeDeclaration declared) || declared.resolveBinding() == null
        || declared.resolveBinding().isRecovered() || !type.getKey().equals(declared.resolveBinding().getKey()))
      return unsupported(position, "unrepresentable-source");
    SimpleName declaredName = declared.getName();
    int[] lines = DiagnosticSnapshot.lineStarts(source.text());
    Map<String, Object> location = Map.of("uri", uri,
        "range", Map.of("start", DiagnosticSnapshot.position(lines, declaredName.getStartPosition()),
            "end", DiagnosticSnapshot.position(lines, declaredName.getStartPosition() + declaredName.getLength())),
        "contentSha256", DiagnosticSnapshot.sha256(source.text()), "utf16Length", source.text().length());
    return new Result(Map.of("status", "source", "location", location), position, source);
  }

  private static Result unsupported(Map<String, Integer> position, String reason) {
    return new Result(Map.of("status", "unsupported", "reason", reason), position, null);
  }

  private static int counter(Object value) {
    check(value instanceof Number, "Invalid type position");
    Number number = (Number) value;
    check(number.doubleValue() == number.intValue() && number.intValue() >= 0
        && number.intValue() <= DiagnosticSnapshot.MAX_TEXT, "Type position capacity");
    return number.intValue();
  }

  private static SourceImage closedSource(ICompilationUnit unit, String uri, int maximumCharacters) throws Exception {
    check(maximumCharacters >= 0, "Type source capacity");
    Path file = Path.of(URI.create(uri));
    BasicFileAttributes before = Files.readAttributes(file, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
    check(before.isRegularFile() && before.fileKey() != null && before.size() <= 4L * maximumCharacters,
        "Unqualified closed type source");
    byte[] bytes;
    int maximumBytes = 4 * maximumCharacters;
    try (var channel = Files.newByteChannel(file, Set.of(StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS));
        var stream = Channels.newInputStream(channel)) {
      bytes = stream.readNBytes(maximumBytes + 1);
    }
    check(bytes.length <= maximumBytes, "Type source capacity");
    BasicFileAttributes after = Files.readAttributes(file, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
    check(sameFile(before, after) && after.size() == bytes.length && file.toRealPath().equals(file),
        "Type source changed during capture");
    String text = StandardCharsets.UTF_8.newDecoder().decode(ByteBuffer.wrap(bytes)).toString();
    check(text.length() <= maximumCharacters, "Type source capacity");
    return new SourceImage(unit, uri, text, after);
  }

  private static boolean sameFile(BasicFileAttributes left, BasicFileAttributes right) {
    return left.fileKey().equals(right.fileKey()) && left.size() == right.size()
        && left.lastModifiedTime().equals(right.lastModifiedTime());
  }
}
