import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename, relative } from "node:path";

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

export interface WorkspaceInfo {
  isMonorepo: boolean;
  packageManager: PackageManagerType;
  rootName: string;
  rootVersion?: string;
  packages: WorkspacePackage[];
  packageDependencyGraph: Record<string, string[]>;
  commands: {
    install: string;
    build: string;
    test: string;
    dev: string;
  };
}

export class WorkspaceAnalyzer {
  private repoPath: string;

  constructor(repoPath: string = process.cwd()) {
    this.repoPath = repoPath;
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

    return {
      isMonorepo,
      packageManager,
      rootName,
      packages,
      packageDependencyGraph,
      commands,
    };
  }

  private hasExplicitMonorepoConfig(): boolean {
    return (
      existsSync(join(this.repoPath, "pnpm-workspace.yaml")) ||
      existsSync(join(this.repoPath, "lerna.json")) ||
      existsSync(join(this.repoPath, "go.work")) ||
      this.hasCargoWorkspace() ||
      this.hasNpmWorkspaces()
    );
  }

  private hasCargoWorkspace(): boolean {
    const cargoPath = join(this.repoPath, "Cargo.toml");
    if (!existsSync(cargoPath)) return false;
    try {
      const content = readFileSync(cargoPath, "utf-8");
      return content.includes("[workspace]");
    } catch {
      return false;
    }
  }

  private hasNpmWorkspaces(): boolean {
    const pkgPath = join(this.repoPath, "package.json");
    if (!existsSync(pkgPath)) return false;
    try {
      const data = JSON.parse(readFileSync(pkgPath, "utf-8"));
      return Array.isArray(data.workspaces) || !!data.workspaces?.packages;
    } catch {
      return false;
    }
  }

  private detectPackageManager(): PackageManagerType {
    if (existsSync(join(this.repoPath, "pnpm-lock.yaml")) || existsSync(join(this.repoPath, "pnpm-workspace.yaml"))) {
      return "pnpm";
    }
    if (existsSync(join(this.repoPath, "bun.lockb")) || existsSync(join(this.repoPath, "bunfig.toml"))) {
      return "bun";
    }
    if (existsSync(join(this.repoPath, "yarn.lock"))) {
      return "yarn";
    }
    if (existsSync(join(this.repoPath, "package-lock.json")) || existsSync(join(this.repoPath, "package.json"))) {
      return "npm";
    }
    if (existsSync(join(this.repoPath, "Cargo.lock")) || existsSync(join(this.repoPath, "Cargo.toml"))) {
      return "cargo";
    }
    if (existsSync(join(this.repoPath, "go.work")) || existsSync(join(this.repoPath, "go.mod"))) {
      return "go";
    }
    if (existsSync(join(this.repoPath, "poetry.lock")) || existsSync(join(this.repoPath, "pyproject.toml"))) {
      return "poetry";
    }
    if (existsSync(join(this.repoPath, "Pipfile")) || existsSync(join(this.repoPath, "requirements.txt"))) {
      return "pip";
    }
    if (existsSync(join(this.repoPath, "pom.xml"))) {
      return "maven";
    }
    if (existsSync(join(this.repoPath, "build.gradle")) || existsSync(join(this.repoPath, "build.gradle.kts"))) {
      return "gradle";
    }
    if (this.hasDotnetSolution()) {
      return "dotnet";
    }
    if (existsSync(join(this.repoPath, "composer.json"))) {
      return "composer";
    }
    if (existsSync(join(this.repoPath, "Gemfile"))) {
      return "bundler";
    }
    return "unknown";
  }

  private hasDotnetSolution(): boolean {
    try {
      const files = readdirSync(this.repoPath);
      return files.some((f) => f.endsWith(".sln") || f.endsWith(".slnx"));
    } catch {
      return false;
    }
  }

  private discoverPackages(): WorkspacePackage[] {
    const packages: WorkspacePackage[] = [];
    const searchDirs = ["packages", "crates", "apps", "services", "modules", "libs"];

    for (const dirName of searchDirs) {
      const baseDir = join(this.repoPath, dirName);
      if (existsSync(baseDir) && statSync(baseDir).isDirectory()) {
        try {
          const entries = readdirSync(baseDir);
          for (const entry of entries) {
            const subDir = join(baseDir, entry);
            if (statSync(subDir).isDirectory()) {
              const pkg = this.tryReadPackage(subDir);
              if (pkg) {
                packages.push(pkg);
              }
            }
          }
        } catch {
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
    if (existsSync(pkgJsonPath)) {
      try {
        const data = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
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
      } catch {
        // Fallback
      }
    }

    // 2. Rust Cargo.toml
    const cargoTomlPath = join(dir, "Cargo.toml");
    if (existsSync(cargoTomlPath)) {
      try {
        const content = readFileSync(cargoTomlPath, "utf-8");
        const nameMatch = /name\s*=\s*["']([^"']+)["']/.exec(content);
        const name = nameMatch ? nameMatch[1] : dirBasename;
        const isBin = content.includes("[[bin]]") || existsSync(join(dir, "src", "main.rs"));

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
      } catch {
        // Fallback
      }
    }

    // 3. Go go.mod
    const goModPath = join(dir, "go.mod");
    if (existsSync(goModPath)) {
      try {
        const content = readFileSync(goModPath, "utf-8");
        const modMatch = /module\s+([^\s\n]+)/.exec(content);
        const name = modMatch ? modMatch[1] : dirBasename;
        const isMain = existsSync(join(dir, "main.go"));

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
      } catch {
        // Fallback
      }
    }

    // 4. Python pyproject.toml
    const pyprojectPath = join(dir, "pyproject.toml");
    if (existsSync(pyprojectPath)) {
      try {
        const content = readFileSync(pyprojectPath, "utf-8");
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
      } catch {
        // Fallback
      }
    }

    return null;
  }

  private resolveCommands(pm: PackageManagerType) {
    switch (pm) {
      case "pnpm":
        return {
          install: "pnpm install",
          build: "pnpm build",
          test: "pnpm test",
          dev: "pnpm dev",
        };
      case "yarn":
        return {
          install: "yarn install",
          build: "yarn build",
          test: "yarn test",
          dev: "yarn dev",
        };
      case "bun":
        return {
          install: "bun install",
          build: "bun run build",
          test: "bun test",
          dev: "bun run dev",
        };
      case "cargo":
        return {
          install: "cargo fetch",
          build: "cargo build --release",
          test: "cargo test",
          dev: "cargo run",
        };
      case "go":
        return {
          install: "go mod download",
          build: "go build ./...",
          test: "go test ./...",
          dev: "go run .",
        };
      case "poetry":
        return {
          install: "poetry install",
          build: "poetry build",
          test: "poetry run pytest",
          dev: "poetry run python main.py",
        };
      case "pip":
        return {
          install: "pip install -r requirements.txt",
          build: "python -m build",
          test: "pytest",
          dev: "python app.py",
        };
      case "maven":
        return {
          install: "mvn dependency:resolve",
          build: "mvn clean package",
          test: "mvn test",
          dev: "mvn spring-boot:run",
        };
      case "gradle":
        return {
          install: "./gradlew dependencies",
          build: "./gradlew build",
          test: "./gradlew test",
          dev: "./gradlew bootRun",
        };
      case "dotnet":
        return {
          install: "dotnet restore",
          build: "dotnet build",
          test: "dotnet test",
          dev: "dotnet run",
        };
      case "composer":
        return {
          install: "composer install",
          build: "composer dump-autoload -o",
          test: "composer test",
          dev: "php -S localhost:8000",
        };
      default:
        return {
          install: "npm install",
          build: "npm run build",
          test: "npm test",
          dev: "npm run dev",
        };
    }
  }
}
