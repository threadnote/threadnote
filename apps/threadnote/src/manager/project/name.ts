export function isManagerProjectName(project: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/u.test(project) && !project.endsWith(' ');
}
