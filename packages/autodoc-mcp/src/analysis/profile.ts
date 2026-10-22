import type { Fact, InventoryFile } from './contracts.js';
import type { SnapshotContext } from './snapshot.js';
import { readInventoryFiles } from './source-reader.js';

export type ProjectProfile = 'static_site' | 'cli' | 'library' | 'service' | 'workspace' | 'mixed' | 'unknown';

export interface ProjectProfileAssessment {
  profile: ProjectProfile;
  state: 'confirmed' | 'hypothesis' | 'unknown';
  evidenceIds: string[];
  rationale: string;
}

function readAll<T extends 'facts' | 'evidence'>(context: SnapshotContext, collection: T): T extends 'facts' ? Fact[] : Array<{ id: string; path: string }> {
  const items: Array<Record<string, unknown>> = [];
  let cursor: string | null = null;
  const visited = new Set<string>();
  do {
    const page = context.readPage(collection, cursor, 500);
    if (page.scanId !== context.scanId || page.repositoryRoot !== context.repositoryRoot || page.collection !== collection) {
      throw new Error(`${collection} page does not belong to the pinned snapshot`);
    }
    items.push(...page.items as Array<Record<string, unknown>>);
    cursor = page.nextCursor;
    if (cursor && visited.has(cursor)) throw new Error(`${collection} pagination returned a repeated cursor`);
    if (cursor) visited.add(cursor);
  } while (cursor);
  return items as T extends 'facts' ? Fact[] : Array<{ id: string; path: string }>;
}

function attributeText(fact: Fact, key: string): string | undefined {
  const value = fact.attributes[key];
  return typeof value === 'string' ? value : undefined;
}

function inventorySignals(files: InventoryFile[]): { staticSite: boolean; cli: boolean; workspace: boolean; mixed: boolean } {
  const paths = files.filter((file) => !file.excludedReason).map((file) => file.path.toLowerCase());
  const html = paths.some((path) => /(^|\/)index\.html?$/.test(path) || path.endsWith('.html'));
  const styles = paths.some((path) => path.endsWith('.css'));
  const rootMain = paths.some((path) => /^(main|cli)\.(py|ts|tsx|js|jsx|rs|go)$/.test(path));
  const manifests = paths.filter((path) => /(^|\/)(package\.json|cargo\.toml|pyproject\.toml|go\.mod|pom\.xml|build\.gradle(?:\.kts)?)$/.test(path));
  const hasWebAssets = html || styles || paths.some((path) => /(^|\/)(vite|webpack|next|astro)\.config\./.test(path));
  const hasCode = paths.some((path) => /\.(py|ts|tsx|js|jsx|rs|go|java|cs|cpp|c)$/.test(path));
  return {
    staticSite: html && (styles || paths.some((path) => path.endsWith('.js'))),
    cli: rootMain,
    workspace: manifests.some((path) => path.includes('/')),
    mixed: hasWebAssets && hasCode && rootMain,
  };
}

/** Classify a project conservatively. Filename-only assessments remain hypotheses. */
export function inferProjectProfile(context: SnapshotContext): ProjectProfileAssessment {
  const facts = readAll(context, 'facts');
  const evidence = readAll(context, 'evidence');
  const evidenceIds = new Set(evidence.map((item) => item.id));
  const explicit = facts.find((fact) => {
    if (fact.kind.toLowerCase() !== 'project_profile') return false;
    return fact.evidenceIds.length > 0 && fact.evidenceIds.every((id) => evidenceIds.has(id));
  });
  const allowed = new Set<ProjectProfile>(['static_site', 'cli', 'library', 'service', 'workspace', 'mixed', 'unknown']);
  if (explicit) {
    const profile = attributeText(explicit, 'profile') as ProjectProfile | undefined;
    if (profile && allowed.has(profile)) {
      return { profile, state: 'confirmed', evidenceIds: [...explicit.evidenceIds], rationale: 'Explicit profile fact with evidence in the pinned snapshot.' };
    }
  }

  const files = readInventoryFiles(context);
  const signals = inventorySignals(files);
  if (signals.mixed) return { profile: 'mixed', state: 'hypothesis', evidenceIds: [], rationale: 'Web assets and a root entrypoint coexist in inventory.' };
  if (signals.staticSite) return { profile: 'static_site', state: 'hypothesis', evidenceIds: [], rationale: 'HTML and web assets coexist in inventory; runtime behavior was not established.' };
  if (signals.cli) return { profile: 'cli', state: 'hypothesis', evidenceIds: [], rationale: 'A root entrypoint filename is present; command-line behavior was not established.' };
  if (signals.workspace) return { profile: 'workspace', state: 'hypothesis', evidenceIds: [], rationale: 'Nested manifests are present; workspace relationships were not established.' };
  if (files.some((file) => file.category === 'source')) return { profile: 'unknown', state: 'unknown', evidenceIds: [], rationale: 'Source is inventoried, but available evidence does not establish a project profile.' };
  return { profile: 'unknown', state: 'unknown', evidenceIds: [], rationale: 'The snapshot does not contain sufficient evidence to classify this project.' };
}
