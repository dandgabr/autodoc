export const IGNORED_DIRECTORIES = new Set([
  "node_modules",
  "target",
  ".git",
  "dist",
  "build",
  ".autodoc",
  ".turbo",
  ".next",
  "vendor",
  "__pycache__",
  ".venv",
  "venv",
  ".cargo",
  ".idea",
  ".vscode",
  ".coverage",
  "coverage",
  ".svelte-kit",
  ".nuxt",
  ".output",
]);

export const TEST_DIR_NAMES = new Set([
  "tests",
  "__tests__",
  "test",
  "testing",
  "fixtures",
  "__fixtures__",
  "mocks",
  "__mocks__",
  "e2e",
  "spec",
  "specs",
]);

/**
 * Checks if a directory should be ignored during filesystem recursion.
 */
export function isIgnoredDirectory(dirName: string, includeTests: boolean = false): boolean {
  if (IGNORED_DIRECTORIES.has(dirName) || dirName.startsWith(".")) {
    return true;
  }
  if (!includeTests && TEST_DIR_NAMES.has(dirName.toLowerCase())) {
    return true;
  }
  return false;
}

/**
 * Checks if a relative or absolute file path corresponds to a test file, mock, or fixture.
 */
export function isTestPath(pathOrName: string): boolean {
  const normalized = pathOrName.replace(/\\/g, "/").toLowerCase();
  const segments = normalized.split("/");

  // Check if any parent directory is a known test directory
  for (let i = 0; i < segments.length - 1; i++) {
    if (TEST_DIR_NAMES.has(segments[i])) {
      return true;
    }
  }

  const filename = segments[segments.length - 1];

  // Specific test file naming patterns across languages
  if (
    filename.includes(".test.") ||
    filename.includes(".spec.") ||
    filename.includes(".mock.") ||
    filename.includes(".fixture.") ||
    filename.startsWith("test_") ||
    /_test\.[a-z0-9]+$/i.test(filename) ||
    /test\.[a-z0-9]+$/i.test(filename) ||
    /tests\.[a-z0-9]+$/i.test(filename) ||
    ((filename.endsWith(".java") || filename.endsWith(".kt") || filename.endsWith(".cs")) &&
      /[a-z0-9_]+tests?\.[a-z0-9]+$/i.test(filename))
  ) {
    return true;
  }

  return false;
}
