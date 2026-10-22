import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, basename, relative } from "node:path";
import type { SnapshotContext } from "../analysis/snapshot.js";
import { readInventoryFiles, readVerifiedSource, StaleSourceError } from "../analysis/source-reader.js";

export interface WorkspacePackage {
  name: string;
  relativePath: string;
  absolutePath: string;
  version?: string;
  dependencies: string[];
  devDependencies: string[];
  internalDependencies: string[];
  type: "library" | "service" | "application" | "unknown";
  manifestPath: string;
}

export type PackageManagerType =
  | "pnpm"
  | "npm"
  | "yarn"
  | "bun"
  | "cargo"
  | "go"
  | "poetry"
  | "pip"
  | "maven"
  | "gradle"
  | "dotnet"
  | "composer"
  | "bundler"
  | "unknown";

export interface MakefileWorkflow {
  hasMakefile: boolean;
  targets: string[];
  devTarget?: string;
  recommendedCommand?: string;
}

export interface WorkspaceInfo {
  isMonorepo: boolean;
  packageManager: PackageManagerType;
  rootName: string;
  rootVersion?: string;
  packages: WorkspacePackage[];
  packageDependencyGraph: Record<string, string[]>;
  commands: {
    install: string | null;
    build: string | null;
    test: string | null;
    dev: string | null;
  };
  makefile?: MakefileWorkflow;
}

export class WorkspaceAnalyzer {
  private repoPath: string;
  private snapshot?: SnapshotContext;

  constructor(repoPath: string = process.cwd(), snapshot?: SnapshotContext) {
    this.repoPath = repoPath;
    this.snapshot = snapshot;
  }

  private readText(filePath: string): string {
    if (this.snapshot) return readVerifiedSource(this.snapshot, relative(this.snapshot.repositoryRoot, filePath).split("\\").join("/")).toString("utf8");
    return readFileSync(filePath, "utf-8");
  }

  private exists(filePath: string): boolean {
    if (!this.snapshot) return existsSync(filePath);
    const relPath = relative(this.snapshot.repositoryRoot, filePath).split("\\").join("/").replace(/^\.$/, "");
    const prefix = relPath ? `${relPath}/` : "";
    return readInventoryFiles(this.snapshot).some((file) => (file.path === relPath || file.path.startsWith(prefix)) && !file.excludedReason);
  }

  private readDirectory(dirPath: string): string[] {
    if (!this.snapshot) return readdirSync(dirPath);
    const relDir = relative(this.snapshot.repositoryRoot, dirPath).split("\\").join("/").replace(/^\.$/, "");
    const prefix = relDir ? `${relDir}/` : "";
    return [...new Set(readInventoryFiles(this.snapshot).flatMap((file) => file.path.startsWith(prefix) ? [file.path.slice(prefix.length).split("/")[0]] : []))].filter(Boolean).sort();
  }

  public analyze(): WorkspaceInfo {
    const rootName = basename(this.repoPath) || "workspace";
    const packageManager = this.detectPackageManager();
    const packages = this.discoverPackages();

    const isMonorepo = packages.length > 1 || this.hasExplicitMonorepoConfig();
    const packageNames = new Set(packages.map((p) => p.name));

    // Resolve internal workspace dependencies
    for (const pkg of packages) {
      const internalDeps: string[] = [];
      for (const dep of [...pkg.dependencies, ...pkg.devDependencies]) {
        if (packageNames.has(dep)) {
          internalDeps.push(dep);
        }
      }
      pkg.internalDependencies = internalDeps;
    }

    const packageDependencyGraph: Record<string, string[]> = {};
    for (const pkg of packages) {
      packageDependencyGraph[pkg.name] = pkg.internalDependencies;
    }

    const commands = this.resolveCommands(packageManager);
    const makefile = this.detectMakefileWorkflow();

    return {
      isMonorepo,
      packageManager,
      rootName,
      packages,
      packageDependencyGraph,
      commands,
      makefile,
    };
  }

  private hasExplicitMonorepoConfig(): boolean {
    return (
      this.exists(join(this.repoPath, "pnpm-workspace.yaml")) ||
      this.exists(join(this.repoPath, "lerna.json")) ||
      this.exists(join(this.repoPath, "go.work")) ||
      this.hasCargoWorkspace() ||
      this.hasNpmWorkspaces()
    );
  }

  private hasCargoWorkspace(): boolean {
    const cargoPath = join(this.repoPath, "Cargo.toml");
    if (!this.exists(cargoPath)) return false;
    try {
      const content = this.readText(cargoPath);
      return content.includes("[workspace]");
    } catch (error) {
        if (error instanceof StaleSourceError) throw error;
      return false;
    }
  }

  private hasNpmWorkspaces(): boolean {
    const pkgPath = join(this.repoPath, "package.json");
    if (!this.exists(pkgPath)) return false;
    try {
      const data = JSON.parse(this.readText(pkgPath));
      return Array.isArray(data.workspaces) || !!data.workspaces?.packages;
    } catch (error) {
        if (error instanceof StaleSourceError) throw error;
      return false;
    }
  }

  private detectPackageManager(): PackageManagerType {
    if (this.exists(join(this.repoPath, "pnpm-lock.yaml")) || this.exists(join(this.repoPath, "pnpm-workspace.yaml"))) {
      return "pnpm";
    }
    if (this.exists(join(this.repoPath, "bun.lockb")) || this.exists(join(this.repoPath, "bunfig.toml"))) {
      return "bun";
    }
    if (this.exists(join(this.repoPath, "yarn.lock"))) {
      return "yarn";
    }
    if (this.exists(join(this.repoPath, "package-lock.json")) || this.exists(join(this.repoPath, "package.json"))) {
      return "npm";
    }
    if (this.exists(join(this.repoPath, "Cargo.lock")) || this.exists(join(this.repoPath, "Cargo.toml"))) {
      return "cargo";
    }
    if (this.exists(join(this.repoPath, "go.work")) || this.exists(join(this.repoPath, "go.mod"))) {
      return "go";
    }
    if (this.exists(join(this.repoPath, "poetry.lock")) || this.exists(join(this.repoPath, "pyproject.toml"))) {
      return "poetry";
    }
    if (this.exists(join(this.repoPath, "Pipfile")) || this.exists(join(this.repoPath, "requirements.txt"))) {
      return "pip";
    }
    if (this.exists(join(this.repoPath, "pom.xml"))) {
      return "maven";
    }
    if (this.exists(join(this.repoPath, "build.gradle")) || this.exists(join(this.repoPath, "build.gradle.kts"))) {
      return "gradle";
    }
    if (this.hasDotnetSolution()) {
      return "dotnet";
    }
    if (this.exists(join(this.repoPath, "composer.json"))) {
      return "composer";
    }
    if (this.exists(join(this.repoPath, "Gemfile"))) {
      return "bundler";
    }
    return "unknown";
  }

  private hasDotnetSolution(): boolean {
    try {
      const files = this.readDirectory(this.repoPath);
      return files.some((f) => f.endsWith(".sln") || f.endsWith(".slnx"));
    } catch (error) {
        if (error instanceof StaleSourceError) throw error;
      return false;
    }
  }

  private discoverPackages(): WorkspacePackage[] {
    const packages: WorkspacePackage[] = [];
    const searchDirs = ["packages", "crates", "apps", "services", "modules", "libs"];

    for (const dirName of searchDirs) {
      const baseDir = join(this.repoPath, dirName);
      if (this.exists(baseDir)) {
        try {
          const entries = this.readDirectory(baseDir);
          for (const entry of entries) {
            const subDir = join(baseDir, entry);
            if (this.exists(subDir)) {
              const pkg = this.tryReadPackage(subDir);
              if (pkg) {
                packages.push(pkg);
              }
            }
          }
        } catch (error) {
        if (error instanceof StaleSourceError) throw error;
          // Skip unreadable directories
        }
      }
    }

    // Also include root package if present and packages list is empty
    if (packages.length === 0) {
      const rootPkg = this.tryReadPackage(this.repoPath);
      if (rootPkg) {
        packages.push(rootPkg);
      }
    }

    return packages;
  }

  private tryReadPackage(dir: string): WorkspacePackage | null {
    const relPath = relative(this.repoPath, dir) || ".";
    const dirBasename = basename(dir);

    // 1. Node.js package.json
    const pkgJsonPath = join(dir, "package.json");
    if (this.exists(pkgJsonPath)) {
      try {
        const data = JSON.parse(this.readText(pkgJsonPath));
        const name = data.name || dirBasename;
        const deps = Object.keys(data.dependencies || {});
        const devDeps = Object.keys(data.devDependencies || {});
        
        let type: WorkspacePackage["type"] = "library";
        if (data.scripts?.start || data.scripts?.dev || relPath.includes("server") || relPath.includes("app")) {
          type = "service";
        } else if (relPath.includes("client") || relPath.includes("frontend") || relPath.includes("web") || deps.includes("react") || deps.includes("vue")) {
          type = "application";
        }

        return {
          name,
          relativePath: relPath,
          absolutePath: dir,
          version: data.version,
          dependencies: deps,
          devDependencies: devDeps,
          internalDependencies: [],
          type,
          manifestPath: pkgJsonPath,
        };
      } catch (error) {
        if (error instanceof StaleSourceError) throw error;
        // Fallback
      }
    }

    // 2. Rust Cargo.toml
    const cargoTomlPath = join(dir, "Cargo.toml");
    if (this.exists(cargoTomlPath)) {
      try {
        const content = this.readText(cargoTomlPath);
        const nameMatch = /name\s*=\s*["']([^"']+)["']/.exec(content);
        const name = nameMatch ? nameMatch[1] : dirBasename;
        const isBin = content.includes("[[bin]]") || this.exists(join(dir, "src", "main.rs"));

        return {
          name,
          relativePath: relPath,
          absolutePath: dir,
          dependencies: [],
          devDependencies: [],
          internalDependencies: [],
          type: isBin ? "service" : "library",
          manifestPath: cargoTomlPath,
        };
      } catch (error) {
        if (error instanceof StaleSourceError) throw error;
        // Fallback
      }
    }

    // 3. Go go.mod
    const goModPath = join(dir, "go.mod");
    if (this.exists(goModPath)) {
      try {
        const content = this.readText(goModPath);
        const modMatch = /module\s+([^\s\n]+)/.exec(content);
        const name = modMatch ? modMatch[1] : dirBasename;
        const isMain = this.exists(join(dir, "main.go"));

        return {
          name,
          relativePath: relPath,
          absolutePath: dir,
          dependencies: [],
          devDependencies: [],
          internalDependencies: [],
          type: isMain ? "service" : "library",
          manifestPath: goModPath,
        };
      } catch (error) {
        if (error instanceof StaleSourceError) throw error;
        // Fallback
      }
    }

    // 4. Python pyproject.toml
    const pyprojectPath = join(dir, "pyproject.toml");
    if (this.exists(pyprojectPath)) {
      try {
        const content = this.readText(pyprojectPath);
        const nameMatch = /name\s*=\s*["']([^"']+)["']/.exec(content);
        const name = nameMatch ? nameMatch[1] : dirBasename;

        return {
          name,
          relativePath: relPath,
          absolutePath: dir,
          dependencies: [],
          devDependencies: [],
          internalDependencies: [],
          type: "service",
          manifestPath: pyprojectPath,
        };
      } catch (error) {
        if (error instanceof StaleSourceError) throw error;
        // Fallback
      }
    }

    return null;
  }

  private resolveCommands(pm: PackageManagerType) {
    let scripts: Record<string, string> = {};
    const packageJsonPath = join(this.repoPath, "package.json");
    if (this.exists(packageJsonPath)) {
      try { scripts = JSON.parse(this.readText(packageJsonPath)).scripts ?? {}; } catch (error) {
        if (error instanceof StaleSourceError) throw error; /* Invalid manifests do not imply scripts. */ }
    }
    const runner = pm === "pnpm" ? "pnpm" : pm === "yarn" ? "yarn" : pm === "bun" ? "bun run" : "npm run";
    const commands = (names: string[]) => {
      const key = names.find((name) => typeof scripts[name] === "string");
      return key ? `${runner} ${key}` : null;
    };
    return { install: null, build: commands(["build"]), test: commands(["test"]), dev: commands(["dev", "start"]) };
  }

  private detectMakefileWorkflow(): MakefileWorkflow {
    const makefilePath = join(this.repoPath, "Makefile");
    if (!this.exists(makefilePath)) {
      return { hasMakefile: false, targets: [] };
    }

    try {
      const content = this.readText(makefilePath);
      const targetRegex = /^([a-zA-Z0-9_-]+)\s*:/gm;
      const targets: string[] = [];
      let match;
      while ((match = targetRegex.exec(content)) !== null) {
        targets.push(match[1]);
      }

      const devTarget = targets.find((t) => t === "dev" || t === "start" || t === "run");
      return {
        hasMakefile: true,
        targets,
        devTarget,
        recommendedCommand: devTarget ? `make ${devTarget}` : undefined,
      };
    } catch (error) {
        if (error instanceof StaleSourceError) throw error;
      return { hasMakefile: false, targets: [] };
    }
  }
}
