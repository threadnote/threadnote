package dev.threadnote.semantic;

import java.lang.reflect.*;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.*;
import org.eclipse.jdt.core.ICompilationUnit;
import org.eclipse.jdt.core.IJavaProject;

/** Manual native regression using the qualified JDT classpath and snapshot bundle, outside the product JAR.
 * A persistent file change during the final SDK callback must refuse; no source-view equality is assumed. */
public final class JavaClosedCharsetFence {
  static java.nio.file.Path file;
  static int charsetCalls;
  static final String BEFORE="class Main {}\n";
  static final String AFTER="class Main {} // persistent change during final charset callback\n";
  static final class Resource extends org.eclipse.core.internal.resources.File {
    Resource() { super(org.eclipse.core.runtime.Path.fromPortableString("/threadnote-java/source-0/Main.java"), null); }
    @Override public boolean isAccessible() { return true; }
    @Override public boolean isVirtual() { return false; }
    @Override public URI getLocationURI() { return file.toUri(); }
    @Override public String getCharset(boolean implicit) {
      if (++charsetCalls==5) {
        try { Files.writeString(file,AFTER,StandardCharsets.UTF_8); }
        catch(Exception failure) { throw new IllegalStateException(failure); }
      }
      return "UTF-8";
    }
  }
  static Object base(Object proxy,Method method,Object[] args) {
    return switch(method.getName()) {
      case "equals" -> proxy==args[0];
      case "hashCode" -> System.identityHashCode(proxy);
      case "toString" -> "controlled-source-proxy";
      default -> throw new UnsupportedOperationException(method.getName());
    };
  }
  public static void main(String[] args) throws Exception {
    var directory=Files.createTempDirectory("tn-closed-charset-fence-").toRealPath();
    file=directory.resolve("Main.java");
    boolean verified=false;
    String failure="";
    try {
      Files.writeString(file,BEFORE,StandardCharsets.UTF_8);
      var resource=new Resource();
      var project=(IJavaProject)Proxy.newProxyInstance(JavaClosedCharsetFence.class.getClassLoader(),new Class<?>[]{IJavaProject.class},JavaClosedCharsetFence::base);
      var sourcePath=org.eclipse.core.runtime.Path.fromPortableString("/threadnote-java/source-0/Main.java");
      var unit=(ICompilationUnit)Proxy.newProxyInstance(JavaClosedCharsetFence.class.getClassLoader(),new Class<?>[]{ICompilationUnit.class},(proxy,method,values)->switch(method.getName()) {
        case "getResource" -> resource;
        case "getJavaProject" -> project;
        case "getOptions" -> Map.of();
        case "getPath" -> sourcePath;
        case "isWorkingCopy" -> false;
        default -> base(proxy,method,values);
      });
      var projection=Map.<String,Object>of(
        "rawClasspath",List.of(Map.of("kind",3,"path","/threadnote-java/source-0","inclusions",List.of(),"exclusions",List.of())),
        "links",List.of(Map.of("path","source-0","uri",directory.toUri().toASCIIString())),"resourceFilters",List.of());
      var model=new DiagnosticSnapshot.Model(project,"file:///private/project/","file:///private/sdk/",List.of(directory.toUri().toASCIIString()),List.of(),Map.of(),List.of(),List.of(),projection);
      Method read=TypeDefinitionSnapshot.class.getDeclaredMethod("closedSource",ICompilationUnit.class,String.class,int.class,DiagnosticSnapshot.Model.class);
      read.setAccessible(true);
      Object captured=read.invoke(null,unit,file.toUri().toASCIIString(),1024,model);
      Method verify=captured.getClass().getDeclaredMethod("verify",DiagnosticSnapshot.Model.class);
      verify.setAccessible(true);
      try { verify.invoke(captured,model); verified=true; }
      catch(InvocationTargetException error) { failure=error.getCause().getMessage(); }
      boolean changed=Files.readString(file).equals(AFTER);
      System.out.println("{\"charsetCalls\":"+charsetCalls+",\"mutationObserved\":"+changed+",\"returnedStaleVerification\":"+(verified&&changed)+",\"verificationRefused\":"+(!verified)+",\"failure\":\""+failure+"\"}");
      if(charsetCalls!=5||!changed)throw new AssertionError("Controlled callback was not exercised");
      if(verified)throw new AssertionError("Closed source verification returned stale evidence after charset callback");
    } finally {
      Files.deleteIfExists(file);
      Files.deleteIfExists(directory);
    }
  }
}
