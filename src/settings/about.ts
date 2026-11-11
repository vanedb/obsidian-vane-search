/** The line shown at the foot of the settings tab, so a bug report can say exactly what is installed. */
export function versionLine(pluginVersion: string, engineVersion: string): string {
  return `Vane Search ${pluginVersion} · VaneDB engine ${engineVersion}`;
}
