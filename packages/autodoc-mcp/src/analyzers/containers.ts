import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, basename, extname } from "node:path";

export type ContainerRuntimePattern =
  | "docker-compose"
  | "podman-compose"
  | "podman-quadlet"
  | "kubernetes"
  | "helm"
  | "nomad"
  | "devcontainer"
  | "dockerfile"
  | "containerfile"
  | "none";

export interface DiscoveredContainerService {
  name: string;
  image?: string;
  ports: string[];
  role: "database" | "cache" | "queue" | "gateway" | "service" | "sfu" | "monitoring" | "other";
  technology: string;
  runtimePattern: ContainerRuntimePattern;
  sourceFile: string;
  environmentVariables: string[];
  dependsOn?: string[];
}

export interface ContainerInfraReport {
  detectedPatterns: ContainerRuntimePattern[];
  services: DiscoveredContainerService[];
  databases: DiscoveredContainerService[];
  caches: DiscoveredContainerService[];
  primaryContainerOrchestration: ContainerRuntimePattern;
}

export class ContainerInfraAnalyzer {
  private repoPath: string;

  constructor(repoPath: string = process.cwd()) {
    this.repoPath = repoPath;
  }

  public analyze(): ContainerInfraReport {
    const services: DiscoveredContainerService[] = [];
    const detectedPatterns = new Set<ContainerRuntimePattern>();

    // 1. Check Compose (Docker / Podman)
    this.discoverComposeFiles(services, detectedPatterns);

    // 2. Check Podman Quadlets (*.container, *.pod, *.kube)
    this.discoverPodmanQuadlets(services, detectedPatterns);

    // 3. Check Kubernetes Manifests
    this.discoverKubernetesManifests(services, detectedPatterns);

    // 4. Check Helm Charts
    this.discoverHelmCharts(services, detectedPatterns);

    // 5. Check HashiCorp Nomad Jobs
    this.discoverNomadJobs(services, detectedPatterns);

    // 6. Check Devcontainers
    this.discoverDevcontainers(services, detectedPatterns);

    // 7. Check Standalone Dockerfile / Containerfile
    this.discoverStandaloneContainerfiles(services, detectedPatterns);

    const databases = services.filter((s) => s.role === "database");
    const caches = services.filter((s) => s.role === "cache");

    let primary = "none" as ContainerRuntimePattern;
    if (detectedPatterns.has("kubernetes")) primary = "kubernetes";
    else if (detectedPatterns.has("helm")) primary = "helm";
    else if (detectedPatterns.has("podman-quadlet")) primary = "podman-quadlet";
    else if (detectedPatterns.has("docker-compose")) primary = "docker-compose";
    else if (detectedPatterns.has("podman-compose")) primary = "podman-compose";
    else if (detectedPatterns.has("nomad")) primary = "nomad";
    else if (detectedPatterns.has("dockerfile")) primary = "dockerfile";
    else if (detectedPatterns.has("containerfile")) primary = "containerfile";

    return {
      detectedPatterns: Array.from(detectedPatterns),
      services,
      databases,
      caches,
      primaryContainerOrchestration: primary,
    };
  }

  private discoverComposeFiles(services: DiscoveredContainerService[], patterns: Set<ContainerRuntimePattern>) {
    const candidates = [
      { file: "docker-compose.yml", pattern: "docker-compose" as ContainerRuntimePattern },
      { file: "docker-compose.yaml", pattern: "docker-compose" as ContainerRuntimePattern },
      { file: "compose.yml", pattern: "docker-compose" as ContainerRuntimePattern },
      { file: "compose.yaml", pattern: "docker-compose" as ContainerRuntimePattern },
      { file: "podman-compose.yml", pattern: "podman-compose" as ContainerRuntimePattern },
      { file: "podman-compose.yaml", pattern: "podman-compose" as ContainerRuntimePattern },
    ];

    for (const { file, pattern } of candidates) {
      const fullPath = join(this.repoPath, file);
      if (existsSync(fullPath)) {
        patterns.add(pattern);
        try {
          const content = readFileSync(fullPath, "utf-8");
          this.parseComposeYaml(content, file, pattern, services);
        } catch {
          // Ignore parse errors
        }
      }
    }
  }

  private parseComposeYaml(
    content: string,
    file: string,
    pattern: ContainerRuntimePattern,
    services: DiscoveredContainerService[]
  ) {
    // Simple YAML block parser for services:
    const lines = content.split("\n");
    let inServices = false;
    let currentService: Partial<DiscoveredContainerService> | null = null;
    let currentIndent = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      const leadingSpaces = line.search(/\S/);

      if (trimmed === "services:") {
        inServices = true;
        currentIndent = leadingSpaces;
        continue;
      }

      if (inServices) {
        // A top-level service key under services:
        if (leadingSpaces === currentIndent + 2 && trimmed.endsWith(":")) {
          if (currentService && currentService.name) {
            services.push(this.finalizeService(currentService, file, pattern));
          }
          currentService = {
            name: trimmed.slice(0, -1),
            ports: [],
            environmentVariables: [],
            dependsOn: [],
          };
        } else if (currentService && leadingSpaces > currentIndent + 2) {
          if (trimmed.startsWith("image:")) {
            currentService.image = trimmed.replace("image:", "").trim().replace(/['"]/g, "");
          } else if (trimmed.startsWith("- ") && (trimmed.includes(":") || /^\d+/.test(trimmed.slice(2)))) {
            // Port or env entry
            const val = trimmed.slice(2).trim();
            if (/\d+:\d+/.test(val)) {
              currentService.ports?.push(val);
            } else if (val.includes("=")) {
              currentService.environmentVariables?.push(val.split("=")[0].trim());
            }
          } else if (trimmed.startsWith("depends_on:")) {
            // next lines might be dependencies
          }
        }
      }
    }

    if (currentService && currentService.name) {
      services.push(this.finalizeService(currentService, file, pattern));
    }
  }

  private discoverPodmanQuadlets(services: DiscoveredContainerService[], patterns: Set<ContainerRuntimePattern>) {
    const quadletDirs = [this.repoPath, join(this.repoPath, "quadlets"), join(this.repoPath, "systemd"), join(this.repoPath, "containers")];

    for (const dir of quadletDirs) {
      if (!existsSync(dir)) continue;
      try {
        const files = readdirSync(dir);
        for (const file of files) {
          if (file.endsWith(".container") || file.endsWith(".kube") || file.endsWith(".pod")) {
            patterns.add("podman-quadlet");
            const fullPath = join(dir, file);
            const content = readFileSync(fullPath, "utf-8");
            const svcName = basename(file, extname(file));

            const imageMatch = /^Image=(.*)$/m.exec(content);
            const portMatches = Array.from(content.matchAll(/^PublishPort=(.*)$/gm)).map((m) => m[1].trim());

            services.push(
              this.finalizeService(
                {
                  name: svcName,
                  image: imageMatch ? imageMatch[1].trim() : undefined,
                  ports: portMatches,
                  environmentVariables: [],
                },
                file,
                "podman-quadlet"
              )
            );
          }
        }
      } catch {
        // Fallback
      }
    }
  }

  private discoverKubernetesManifests(services: DiscoveredContainerService[], patterns: Set<ContainerRuntimePattern>) {
    const k8sDirs = [join(this.repoPath, "k8s"), join(this.repoPath, "kubernetes"), join(this.repoPath, "deploy"), join(this.repoPath, "manifests")];

    for (const dir of k8sDirs) {
      if (!existsSync(dir)) continue;
      try {
        const files = readdirSync(dir);
        for (const file of files) {
          if (file.endsWith(".yaml") || file.endsWith(".yml")) {
            const fullPath = join(dir, file);
            const content = readFileSync(fullPath, "utf-8");
            if (content.includes("apiVersion:") && (content.includes("kind: Deployment") || content.includes("kind: StatefulSet") || content.includes("kind: Pod"))) {
              patterns.add("kubernetes");
              const nameMatch = /name:\s*([a-zA-Z0-9_-]+)/.exec(content);
              const imageMatch = /image:\s*([^\s\n]+)/.exec(content);
              const svcName = nameMatch ? nameMatch[1] : basename(file, extname(file));

              services.push(
                this.finalizeService(
                  {
                    name: svcName,
                    image: imageMatch ? imageMatch[1] : undefined,
                    ports: [],
                    environmentVariables: [],
                  },
                  join(basename(dir), file),
                  "kubernetes"
                )
              );
            }
          }
        }
      } catch {
        // Fallback
      }
    }
  }

  private discoverHelmCharts(services: DiscoveredContainerService[], patterns: Set<ContainerRuntimePattern>) {
    const chartDirs = [join(this.repoPath, "charts"), join(this.repoPath, "helm")];

    for (const dir of chartDirs) {
      if (!existsSync(dir)) continue;
      try {
        const files = readdirSync(dir);
        for (const file of files) {
          const chartPath = join(dir, file, "Chart.yaml");
          if (existsSync(chartPath)) {
            patterns.add("helm");
            const content = readFileSync(chartPath, "utf-8");
            const nameMatch = /^name:\s*(.+)$/m.exec(content);
            const chartName = nameMatch ? nameMatch[1].trim() : file;

            services.push({
              name: chartName,
              ports: [],
              role: "service",
              technology: "Helm Chart / Kubernetes",
              runtimePattern: "helm",
              sourceFile: join(basename(dir), file, "Chart.yaml"),
              environmentVariables: [],
            });
          }
        }
      } catch {
        // Fallback
      }
    }
  }

  private discoverNomadJobs(services: DiscoveredContainerService[], patterns: Set<ContainerRuntimePattern>) {
    try {
      const files = readdirSync(this.repoPath);
      for (const file of files) {
        if (file.endsWith(".nomad") || file.endsWith(".nomad.hcl")) {
          patterns.add("nomad");
          const content = readFileSync(join(this.repoPath, file), "utf-8");
          const jobMatch = /job\s+["']([^"']+)["']/.exec(content);
          const imageMatch = /image\s*=\s*["']([^"']+)["']/.exec(content);

          services.push(
            this.finalizeService(
              {
                name: jobMatch ? jobMatch[1] : basename(file, extname(file)),
                image: imageMatch ? imageMatch[1] : undefined,
                ports: [],
                environmentVariables: [],
              },
              file,
              "nomad"
            )
          );
        }
      }
    } catch {
      // Fallback
    }
  }

  private discoverDevcontainers(services: DiscoveredContainerService[], patterns: Set<ContainerRuntimePattern>) {
    const devcontainerPath = join(this.repoPath, ".devcontainer", "devcontainer.json");
    if (existsSync(devcontainerPath)) {
      patterns.add("devcontainer");
      try {
        const content = readFileSync(devcontainerPath, "utf-8");
        const json = JSON.parse(content);
        services.push({
          name: json.name || "devcontainer",
          image: json.image,
          ports: Array.isArray(json.forwardPorts) ? json.forwardPorts.map(String) : [],
          role: "service",
          technology: "VS Code Devcontainer",
          runtimePattern: "devcontainer",
          sourceFile: ".devcontainer/devcontainer.json",
          environmentVariables: [],
        });
      } catch {
        // Fallback
      }
    }
  }

  private discoverStandaloneContainerfiles(_services: DiscoveredContainerService[], patterns: Set<ContainerRuntimePattern>) {
    if (existsSync(join(this.repoPath, "Dockerfile"))) {
      patterns.add("dockerfile");
    }
    if (existsSync(join(this.repoPath, "Containerfile"))) {
      patterns.add("containerfile");
    }
  }

  private finalizeService(
    partial: Partial<DiscoveredContainerService>,
    sourceFile: string,
    pattern: ContainerRuntimePattern
  ): DiscoveredContainerService {
    const name = partial.name || "service";
    const image = partial.image || "";
    const lower = `${name} ${image}`.toLowerCase();

    let role: DiscoveredContainerService["role"] = "service";
    let technology = image || name;

    if (lower.includes("mongo")) {
      role = "database";
      technology = "MongoDB";
    } else if (lower.includes("valkey")) {
      role = "cache";
      technology = "Valkey In-Memory Key-Value";
    } else if (lower.includes("redis")) {
      role = "cache";
      technology = "Redis";
    } else if (lower.includes("postgres") || lower.includes("pgsql")) {
      role = "database";
      technology = "PostgreSQL";
    } else if (lower.includes("mysql") || lower.includes("mariadb")) {
      role = "database";
      technology = "MySQL / MariaDB";
    } else if (lower.includes("rabbit") || lower.includes("kafka") || lower.includes("nats")) {
      role = "queue";
      technology = "Message Broker";
    } else if (lower.includes("nginx") || lower.includes("caddy") || lower.includes("traefik") || lower.includes("envoy")) {
      role = "gateway";
      technology = "Reverse Proxy / Gateway";
    } else if (lower.includes("livekit") || lower.includes("mediasoup") || lower.includes("sfu")) {
      role = "sfu";
      technology = "WebRTC SFU";
    }

    return {
      name,
      image: partial.image,
      ports: partial.ports || [],
      role,
      technology,
      runtimePattern: pattern,
      sourceFile,
      environmentVariables: partial.environmentVariables || [],
      dependsOn: partial.dependsOn || [],
    };
  }
}
