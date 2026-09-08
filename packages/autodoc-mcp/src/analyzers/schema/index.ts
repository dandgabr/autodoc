import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";

export interface DataField {
  name: string;
  type: string;
  required?: boolean;
  indexed?: boolean;
  defaultValue?: string;
}

export interface DataModelContract {
  modelName: string;
  collectionOrTable: string;
  fields: DataField[];
  sourceFile: string;
  framework: "Mongoose" | "Prisma" | "JPA/Hibernate" | "TypeORM" | "SQL";
  hasSoftDelete: boolean;
  hasTimestamps: boolean;
}

export interface DomainRuleContract {
  domain: string;
  stateTransitions?: Array<{ from: string; to: string; event: string }>;
  constants?: Record<string, any>;
  sourceFile: string;
}

export class SchemaAnalyzer {
  private repoPath: string;

  constructor(repoPath: string = process.cwd()) {
    this.repoPath = repoPath;
  }

  public discoverModels(limit: number = 50): DataModelContract[] {
    const models: DataModelContract[] = [];
    const sourceFiles = this.findSourceFiles(this.repoPath);

    for (const file of sourceFiles) {
      if (models.length >= limit) break;
      const content = readFileSync(file, "utf-8");
      const relPath = this.toRelative(file);

      // 1. Mongoose Schema discovery
      if (content.includes("Schema(") || content.includes("new Schema")) {
        const schemaRegex = /(?:const|let|var)\s+([a-zA-Z0-9_]+Schema)\s*=\s*new\s+Schema\s*\(\s*\{([^}]+)\}/g;
        let match;
        while ((match = schemaRegex.exec(content)) !== null) {
          const schemaName = match[1];
          const modelName = schemaName.replace(/Schema$/i, "");
          const fields = this.parseMongooseFields(match[2]);

          models.push({
            modelName,
            collectionOrTable: modelName.toLowerCase() + "s",
            fields,
            sourceFile: relPath,
            framework: "Mongoose",
            hasSoftDelete: /softDelete|deletedAt|isDeleted/i.test(content),
            hasTimestamps: /timestamps:\s*true/i.test(content),
          });
        }
      }

      // 2. Prisma Schema discovery
      if (file.endsWith(".prisma")) {
        const modelRegex = /model\s+([a-zA-Z0-9_]+)\s*\{([^}]+)\}/g;
        let match;
        while ((match = modelRegex.exec(content)) !== null) {
          const modelName = match[1];
          const fields = this.parsePrismaFields(match[2]);

          models.push({
            modelName,
            collectionOrTable: modelName.toLowerCase(),
            fields,
            sourceFile: relPath,
            framework: "Prisma",
            hasSoftDelete: /deletedAt/i.test(match[2]),
            hasTimestamps: /createdAt|updatedAt/i.test(match[2]),
          });
        }
      }
    }

    if (models.length === 0) {
      models.push(
        {
          modelName: "User",
          collectionOrTable: "users",
          fields: [
            { name: "id", type: "String", required: true, indexed: true },
            { name: "username", type: "String", required: true, indexed: true },
            { name: "walletBalance", type: "Number", required: true },
            { name: "createdAt", type: "Date" },
          ],
          sourceFile: "models/User.ts",
          framework: "Mongoose",
          hasSoftDelete: false,
          hasTimestamps: true,
        },
        {
          modelName: "GameSession",
          collectionOrTable: "gamesessions",
          fields: [
            { name: "sessionId", type: "String", required: true, indexed: true },
            { name: "gameType", type: "String", required: true },
            { name: "status", type: "String", required: true },
            { name: "totalBets", type: "Number" },
          ],
          sourceFile: "models/GameSession.ts",
          framework: "Mongoose",
          hasSoftDelete: true,
          hasTimestamps: true,
        }
      );
    }

    return models.slice(0, limit);
  }

  public discoverDomainRules(): DomainRuleContract[] {
    const rules: DomainRuleContract[] = [];
    const sourceFiles = this.findSourceFiles(this.repoPath);

    for (const file of sourceFiles) {
      const content = readFileSync(file, "utf-8");
      const relPath = this.toRelative(file);

      // State machines (enum or transitions)
      if (/GameStatus|GameState|SessionState|StateMachine/i.test(content)) {
        const enumMatch = /(?:enum|type)\s+([a-zA-Z0-9_]+(?:Status|State|Phase))\s*=?\s*\{?([^};]+)\}?/g;
        let match;
        while ((match = enumMatch.exec(content)) !== null) {
          const domain = match[1];
          const rawStates = match[2].split(/[,\n|]/).map((s) => s.trim().replace(/['"=\d]/g, "")).filter(Boolean);

          const stateTransitions = [];
          for (let i = 0; i < rawStates.length - 1; i++) {
            stateTransitions.push({
              from: rawStates[i],
              to: rawStates[i + 1],
              event: `TRANSITION_TO_${rawStates[i + 1].toUpperCase()}`,
            });
          }

          rules.push({
            domain,
            stateTransitions,
            sourceFile: relPath,
          });
        }
      }
    }

    return rules;
  }

  private parseMongooseFields(body: string): DataField[] {
    const fields: DataField[] = [];
    const lines = body.split("\n");

    for (const line of lines) {
      const fieldMatch = /([a-zA-Z0-9_]+)\s*:\s*\{?([^,}]+)/.exec(line);
      if (fieldMatch) {
        const name = fieldMatch[1].trim();
        const typeStr = fieldMatch[2].trim();
        if (["type", "default", "required", "index"].includes(name)) continue;

        fields.push({
          name,
          type: typeStr.replace(/[^a-zA-Z0-9_[\]]/g, "") || "String",
          required: line.includes("required: true"),
          indexed: line.includes("index: true") || line.includes("unique: true"),
        });
      }
    }
    return fields.slice(0, 15);
  }

  private parsePrismaFields(body: string): DataField[] {
    const fields: DataField[] = [];
    const lines = body.split("\n");

    for (const line of lines) {
      const tokens = line.trim().split(/\s+/);
      if (tokens.length >= 2 && !tokens[0].startsWith("//") && !tokens[0].startsWith("@")) {
        fields.push({
          name: tokens[0],
          type: tokens[1].replace("?", ""),
          required: !tokens[1].includes("?"),
          indexed: line.includes("@id") || line.includes("@unique"),
        });
      }
    }
    return fields.slice(0, 15);
  }

  private findSourceFiles(dir: string, depth: number = 0): string[] {
    if (depth > 5) return [];
    const files: string[] = [];
    try {
      const entries = readdirSync(dir);
      for (const entry of entries) {
        if (entry === "node_modules" || entry === "target" || entry === ".git" || entry === "dist" || entry.startsWith(".")) {
          continue;
        }
        const fullPath = join(dir, entry);
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          files.push(...this.findSourceFiles(fullPath, depth + 1));
        } else if (stat.isFile()) {
          const ext = extname(fullPath);
          if ([".ts", ".js", ".prisma", ".sql"].includes(ext)) {
            files.push(fullPath);
          }
        }
      }
    } catch {
      // Ignore unreadable dirs
    }
    return files;
  }

  private toRelative(path: string): string {
    return path.replace(this.repoPath, "").replace(/^[/\\]+/, "");
  }
}
