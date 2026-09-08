import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, extname, basename } from "node:path";
import { isIgnoredDirectory, isTestPath } from "../utils.js";

export interface DataField {
  name: string;
  type: string;
  required?: boolean;
  indexed?: boolean;
  defaultValue?: string;
  ref?: string;
}

export interface CompoundIndex {
  fields: Record<string, number>;
  unique?: boolean;
  partialFilterExpression?: string;
}

export interface DataModelContract {
  modelName: string;
  collectionOrTable: string;
  fields: DataField[];
  compoundIndexes?: CompoundIndex[];
  sourceFile: string;
  framework: "Mongoose" | "Prisma" | "SQLAlchemy" | "JPA/Hibernate" | "TypeORM" | "EFCore" | "GORM" | "SeaORM" | "SQL";
  hasSoftDelete: boolean;
  hasTimestamps: boolean;
  isDiscriminator?: boolean;
  baseModel?: string;
  discriminatorKey?: string;
  isSubdocument?: boolean;
  parentModel?: string;
}

export interface DomainRuleContract {
  domain: string;
  stateTransitions?: Array<{ from: string; to: string; event: string }>;
  constants?: Record<string, any>;
  sourceFile: string;
}

export interface SchemaAnalyzerOptions {
  includeTests?: boolean;
}

export class SchemaAnalyzer {
  private repoPath: string;
  private includeTests: boolean;

  constructor(repoPath: string = process.cwd(), options: SchemaAnalyzerOptions = {}) {
    this.repoPath = repoPath;
    this.includeTests = options.includeTests ?? false;
  }

  public discoverModels(limit: number = 100, includeSubdocuments: boolean = false, includeTests?: boolean): DataModelContract[] {
    const models: Map<string, DataModelContract> = new Map();
    const effectiveIncludeTests = includeTests ?? this.includeTests;
    const sourceFiles = this.findSourceFiles(this.repoPath, 0, effectiveIncludeTests);

    for (const file of sourceFiles) {
      const content = readFileSync(file, "utf-8");
      const relPath = this.toRelative(file);
      const ext = extname(file);

      // 1. Mongoose Schemas, Models & Discriminators
      if (content.includes("Schema") || content.includes("mongoose") || content.includes("discriminator")) {
        this.extractMongooseModels(content, relPath, models);
      }

      // 2. Prisma Schemas
      if (ext === ".prisma") {
        this.extractPrismaModels(content, relPath, models);
      }

      // 3. Python SQLAlchemy / Django
      if (ext === ".py" && (content.includes("Base") || content.includes("models.Model") || content.includes("__tablename__"))) {
        this.extractPythonModels(content, relPath, models);
      }

      // 4. TypeORM / MikroORM
      if ((ext === ".ts" || ext === ".js") && content.includes("@Entity")) {
        this.extractTypeOrmModels(content, relPath, models);
      }

      // 5. Java / Kotlin JPA Hibernate
      if ((ext === ".java" || ext === ".kt") && (content.includes("@Entity") || content.includes("@Table"))) {
        this.extractJpaModels(content, relPath, models);
      }

      // 6. C# EF Core
      if (ext === ".cs" && (content.includes("DbContext") || content.includes("[Table") || content.includes("HasDiscriminator"))) {
        this.extractEfCoreModels(content, relPath, models);
      }

      // 7. Go GORM / Ent
      if (ext === ".go" && (content.includes("gorm.Model") || content.includes("`gorm:"))) {
        this.extractGormModels(content, relPath, models);
      }
    }

    const normalized: Map<string, DataModelContract> = new Map();
    for (const [name, model] of models.entries()) {
      const lower = name.toLowerCase();
      const existing = normalized.get(lower);
      if (!existing) {
        normalized.set(lower, { ...model });
      } else {
        if (/^[A-Z]/.test(model.modelName) && !/^[A-Z]/.test(existing.modelName)) {
          existing.modelName = model.modelName;
          existing.collectionOrTable = model.collectionOrTable;
        }
        if (model.fields.length > existing.fields.length) {
          existing.fields = model.fields;
        }
        if (model.compoundIndexes && model.compoundIndexes.length > 0) {
          existing.compoundIndexes = [...(existing.compoundIndexes || []), ...model.compoundIndexes];
        }
        if (model.isDiscriminator) {
          existing.isDiscriminator = true;
          if (model.baseModel) existing.baseModel = model.baseModel;
          if (model.discriminatorKey) existing.discriminatorKey = model.discriminatorKey;
        }
        if (model.hasSoftDelete) existing.hasSoftDelete = true;
        if (model.hasTimestamps) existing.hasTimestamps = true;
        if (model.isSubdocument === false) {
          existing.isSubdocument = false;
          if (existing.collectionOrTable === "(embedded subdocument)") {
            existing.collectionOrTable = model.collectionOrTable;
          }
        }
      }
    }

    let list = Array.from(normalized.values());
    if (!includeSubdocuments) {
      list = list.filter((m) => !m.isSubdocument);
    }
    list.sort((a, b) => a.modelName.localeCompare(b.modelName));
    return list.slice(0, limit);
  }

  public discoverDomainRules(): DomainRuleContract[] {
    const rules: DomainRuleContract[] = [];
    const sourceFiles = this.findSourceFiles(this.repoPath);

    for (const file of sourceFiles) {
      const content = readFileSync(file, "utf-8");
      const relPath = this.toRelative(file);

      if (/Status|State|Phase|StateMachine|Transition/i.test(content)) {
        const enumMatch = /(?:export\s+)?(?:enum|type)\s+([a-zA-Z0-9_]+(?:Status|State|Phase))\s*=?\s*\{?([^};]+)\}?/g;
        let match;
        while ((match = enumMatch.exec(content)) !== null) {
          const domain = match[1];
          const rawStates = match[2]
            .split(/[,\n|]/)
            .map((s) => s.trim().replace(/['"=\d]/g, "").trim())
            .filter((s) => s.length > 0 && !s.startsWith("//"));

          if (rawStates.length > 1) {
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
    }

    return rules;
  }

  private extractMongooseModels(content: string, relPath: string, out: Map<string, DataModelContract>) {
    // 1. Registered Root Models via mongoose.model(...)
    const modelCallRegex = /(?:mongoose\.)?model(?:<[^>]+>)?\s*\(\s*['"`]([^'"`]+)['"`](?:\s*,\s*([a-zA-Z0-9_]+))?(?:\s*,\s*['"`]([^'"`]+)['"`])?/g;
    const registeredRootModels = new Map<string, { modelName: string; schemaVar?: string; collection?: string }>();
    let mMatch;
    while ((mMatch = modelCallRegex.exec(content)) !== null) {
      const modelName = mMatch[1];
      const schemaVar = mMatch[2];
      const customColl = mMatch[3];
      registeredRootModels.set(modelName, {
        modelName,
        schemaVar,
        collection: customColl || (modelName.toLowerCase() + "s"),
      });
    }

    const exportModelRegex = /(?:export\s+const|const|let|var)\s+([a-zA-Z0-9_]+)\s*=\s*(?:mongoose\.)?model/g;
    let expMatch;
    while ((expMatch = exportModelRegex.exec(content)) !== null) {
      const varName = expMatch[1];
      if (!registeredRootModels.has(varName)) {
        registeredRootModels.set(varName, {
          modelName: varName,
          collection: varName.toLowerCase() + "s",
        });
      }
    }

    // 2. Mongoose Discriminators: Base.discriminator('VariantName', schema)
    const discRegex = /([a-zA-Z0-9_]+)\.discriminator(?:<[^>]+>)?\s*\(\s*['"`]([^'"`]+)['"`]/g;
    let discMatch;
    while ((discMatch = discRegex.exec(content)) !== null) {
      const baseVar = discMatch[1];
      const discName = discMatch[2];
      const baseModel = baseVar ? baseVar.replace(/Model$/i, "") : "Match";
      out.set(discName, {
        modelName: discName,
        collectionOrTable: `${baseModel.toLowerCase()}s (discriminator)`,
        fields: [],
        sourceFile: relPath,
        framework: "Mongoose",
        hasSoftDelete: true,
        hasTimestamps: true,
        isDiscriminator: true,
        baseModel,
        discriminatorKey: "moduleId",
        isSubdocument: false,
      });
    }

    // Module Registry Discriminators
    const regMatchDiscRegex = /registerMatchDiscriminator\s*\(\s*(?:['"`]([^'"`]+)['"`]|([a-zA-Z0-9_.]+))/g;
    let regMatch;
    while ((regMatch = regMatchDiscRegex.exec(content)) !== null) {
      const id = (regMatch[1] || regMatch[2] || "").replace(/['"`]/g, "");
      if (id && id !== "moduleId") {
        const discName = `Match:${id}`;
        out.set(discName, {
          modelName: discName,
          collectionOrTable: "matches (discriminator)",
          fields: [],
          sourceFile: relPath,
          framework: "Mongoose",
          hasSoftDelete: true,
          hasTimestamps: true,
          isDiscriminator: true,
          baseModel: "Match",
          discriminatorKey: "moduleId",
          isSubdocument: false,
        });
      }
    }

    // 3. Find all schemas defined via new Schema(...)
    const schemaRegex = /(?:const|let|var|export\s+const)\s+([a-zA-Z0-9_]+Schema)\s*=\s*new\s+(?:mongoose\.)?Schema(?:<[^>]+>)?\s*\(\s*\{([^}]+)\}(?:,\s*\{([^}]+)\})?/g;
    let sMatch;
    const schemasFound: Array<{
      rawSchemaName: string;
      modelName: string;
      fields: DataField[];
      schemaOpts: string;
      hasIdFalse: boolean;
      hasTimestamps: boolean;
      hasSoftDelete: boolean;
      compoundIndexes?: CompoundIndex[];
    }> = [];

    while ((sMatch = schemaRegex.exec(content)) !== null) {
      const rawSchemaName = sMatch[1];
      const modelName = rawSchemaName.replace(/Schema$/i, "");
      const schemaBody = sMatch[2];
      const schemaOpts = sMatch[3] || "";
      const fields = this.parseMongooseFields(schemaBody);
      const hasIdFalse = /_id:\s*false/i.test(schemaOpts) || /_id:\s*false/i.test(schemaBody);
      const hasTimestamps = /timestamps:\s*true/i.test(schemaOpts) || /timestamps:\s*true/i.test(content);
      const hasSoftDelete = /softDeletePlugin|deletedAt|isDeleted/i.test(content);
      const compoundIndexes = this.parseCompoundIndexes(content);

      schemasFound.push({
        rawSchemaName,
        modelName,
        fields,
        schemaOpts,
        hasIdFalse,
        hasTimestamps,
        hasSoftDelete,
        compoundIndexes,
      });
    }

    // 4. Correlate schemas with root models vs subdocuments
    if (registeredRootModels.size > 0) {
      for (const [rName, rInfo] of registeredRootModels.entries()) {
        const matchingSchema =
          schemasFound.find(
            (s) => (rInfo.schemaVar && s.rawSchemaName === rInfo.schemaVar) || s.modelName.toLowerCase() === rName.toLowerCase()
          ) || schemasFound[schemasFound.length - 1];

        out.set(rName, {
          modelName: rName,
          collectionOrTable: rInfo.collection || (rName.toLowerCase() + "s"),
          fields: matchingSchema ? matchingSchema.fields : [],
          compoundIndexes: matchingSchema?.compoundIndexes,
          sourceFile: relPath,
          framework: "Mongoose",
          hasSoftDelete: matchingSchema ? matchingSchema.hasSoftDelete : /softDelete|deletedAt/i.test(content),
          hasTimestamps: matchingSchema ? matchingSchema.hasTimestamps : /timestamps/i.test(content),
          isSubdocument: false,
        });

        // Any other schema in this file is an embedded subdocument
        for (const s of schemasFound) {
          if (matchingSchema && s.rawSchemaName === matchingSchema.rawSchemaName) continue;
          out.set(s.modelName, {
            modelName: s.modelName,
            collectionOrTable: "(embedded subdocument)",
            fields: s.fields,
            compoundIndexes: s.compoundIndexes,
            sourceFile: relPath,
            framework: "Mongoose",
            hasSoftDelete: s.hasSoftDelete,
            hasTimestamps: s.hasTimestamps,
            isSubdocument: true,
            parentModel: rName,
          });
        }
      }
    } else {
      // No explicit root model registered in this file
      for (const s of schemasFound) {
        const isLikelySubdoc = s.hasIdFalse || /Data$|Viewer$|Member$|Item$|Option$|Answer$/i.test(s.modelName);
        out.set(s.modelName, {
          modelName: s.modelName,
          collectionOrTable: isLikelySubdoc ? "(embedded subdocument)" : s.modelName.toLowerCase() + "s",
          fields: s.fields,
          compoundIndexes: s.compoundIndexes,
          sourceFile: relPath,
          framework: "Mongoose",
          hasSoftDelete: s.hasSoftDelete,
          hasTimestamps: s.hasTimestamps,
          isSubdocument: isLikelySubdoc,
        });
      }
    }

    // Check matches: { schema: ... } in module definitions
    if (content.includes("matches:") && relPath.includes("modules/")) {
      const modName = basename(join(relPath, ".."));
      const discName = `Match:${modName}`;
      if (!out.has(discName)) {
        out.set(discName, {
          modelName: discName,
          collectionOrTable: "matches (discriminator)",
          fields: [],
          sourceFile: relPath,
          framework: "Mongoose",
          hasSoftDelete: true,
          hasTimestamps: true,
          isDiscriminator: true,
          baseModel: "Match",
          discriminatorKey: "moduleId",
          isSubdocument: false,
        });
      }
    }
  }

  private parseMongooseFields(body: string): DataField[] {
    const fields: DataField[] = [];
    const lines = body.split("\n");

    for (const line of lines) {
      const fieldMatch = /([a-zA-Z0-9_]+)\s*:\s*\{?([^,}]+)/.exec(line);
      if (fieldMatch) {
        const name = fieldMatch[1].trim();
        const typeStr = fieldMatch[2].trim();
        if (["type", "default", "required", "index", "unique", "ref", "enum"].includes(name)) continue;

        let ref: string | undefined;
        const refMatch = /ref:\s*['"`]([^'"`]+)['"`]/.exec(line);
        if (refMatch) ref = refMatch[1];

        fields.push({
          name,
          type: typeStr.replace(/[^a-zA-Z0-9_[\]]/g, "") || "String",
          required: line.includes("required: true"),
          indexed: line.includes("index: true") || line.includes("unique: true"),
          ref,
        });
      }
    }
    return fields.slice(0, 20);
  }

  private parseCompoundIndexes(content: string): CompoundIndex[] {
    const indexes: CompoundIndex[] = [];
    const indexRegex = /\.index\s*\(\s*\{([^}]+)\}(?:,\s*\{([^}]+)\})?\s*\)/g;
    let match;
    while ((match = indexRegex.exec(content)) !== null) {
      const fieldsBody = match[1];
      const optsBody = match[2] || "";

      const fields: Record<string, number> = {};
      for (const pair of fieldsBody.split(",")) {
        const parts = pair.split(":");
        if (parts.length === 2) {
          const k = parts[0].trim().replace(/['"`]/g, "");
          const v = parseInt(parts[1].trim(), 10) || 1;
          if (k) fields[k] = v;
        }
      }

      indexes.push({
        fields,
        unique: optsBody.includes("unique: true"),
        partialFilterExpression: optsBody.includes("partialFilterExpression") ? "filtered" : undefined,
      });
    }
    return indexes;
  }

  private extractPrismaModels(content: string, relPath: string, out: Map<string, DataModelContract>) {
    const modelRegex = /model\s+([a-zA-Z0-9_]+)\s*\{([^}]+)\}/g;
    let match;
    while ((match = modelRegex.exec(content)) !== null) {
      const modelName = match[1];
      const body = match[2];
      const fields: DataField[] = [];

      for (const line of body.split("\n")) {
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

      out.set(modelName, {
        modelName,
        collectionOrTable: modelName.toLowerCase(),
        fields: fields.slice(0, 20),
        sourceFile: relPath,
        framework: "Prisma",
        hasSoftDelete: /deletedAt/i.test(body),
        hasTimestamps: /createdAt|updatedAt/i.test(body),
      });
    }
  }

  private extractPythonModels(content: string, relPath: string, out: Map<string, DataModelContract>) {
    const pyClassRegex = /class\s+([a-zA-Z0-9_]+)\s*\((?:Base|models\.Model|db\.Model)\):/g;
    let match;
    while ((match = pyClassRegex.exec(content)) !== null) {
      const modelName = match[1];
      const tableMatch = /__tablename__\s*=\s*['"`]([^'"`]+)['"`]/.exec(content);
      const isDisc = content.includes("polymorphic_on") || content.includes("polymorphic_identity");

      out.set(modelName, {
        modelName,
        collectionOrTable: tableMatch ? tableMatch[1] : modelName.toLowerCase(),
        fields: [],
        sourceFile: relPath,
        framework: "SQLAlchemy",
        hasSoftDelete: /is_deleted|deleted_at/i.test(content),
        hasTimestamps: /created_at|updated_at/i.test(content),
        isDiscriminator: isDisc,
      });
    }
  }

  private extractTypeOrmModels(content: string, relPath: string, out: Map<string, DataModelContract>) {
    const entityRegex = /@Entity\s*\((?:['"`]([^'"`]+)['"`])?\)\s*(?:export\s+)?class\s+([a-zA-Z0-9_]+)/g;
    let match;
    while ((match = entityRegex.exec(content)) !== null) {
      const tableName = match[1] || match[2].toLowerCase();
      const modelName = match[2];

      out.set(modelName, {
        modelName,
        collectionOrTable: tableName,
        fields: [],
        sourceFile: relPath,
        framework: "TypeORM",
        hasSoftDelete: /@DeleteDateColumn/i.test(content),
        hasTimestamps: /@CreateDateColumn/i.test(content),
      });
    }
  }

  private extractJpaModels(content: string, relPath: string, out: Map<string, DataModelContract>) {
    const jpaRegex = /(?:@Entity[^\n]*\n)?(?:@Table\s*\(\s*name\s*=\s*['"`]([^'"`]+)['"`]\s*\)\s*)?(?:public\s+)?class\s+([a-zA-Z0-9_]+)/g;
    let match;
    while ((match = jpaRegex.exec(content)) !== null) {
      const tableName = match[1] || match[2].toLowerCase();
      const modelName = match[2];
      const isInheritance = content.includes("@Inheritance") || content.includes("@DiscriminatorValue");

      out.set(modelName, {
        modelName,
        collectionOrTable: tableName,
        fields: [],
        sourceFile: relPath,
        framework: "JPA/Hibernate",
        hasSoftDelete: /deleted|active/i.test(content),
        hasTimestamps: /createdDate|lastModifiedDate/i.test(content),
        isDiscriminator: isInheritance,
      });
    }
  }

  private extractEfCoreModels(content: string, relPath: string, out: Map<string, DataModelContract>) {
    const efRegex = /public\s+class\s+([a-zA-Z0-9_]+)(?:\s*:\s*([a-zA-Z0-9_]+))?/g;
    let match;
    while ((match = efRegex.exec(content)) !== null) {
      const modelName = match[1];
      if (content.includes("DbSet<" + modelName + ">") || content.includes("HasDiscriminator")) {
        out.set(modelName, {
          modelName,
          collectionOrTable: modelName.toLowerCase() + "s",
          fields: [],
          sourceFile: relPath,
          framework: "EFCore",
          hasSoftDelete: /IsDeleted/i.test(content),
          hasTimestamps: /CreatedAt/i.test(content),
          isDiscriminator: content.includes("HasDiscriminator"),
        });
      }
    }
  }

  private extractGormModels(content: string, relPath: string, out: Map<string, DataModelContract>) {
    const gormRegex = /type\s+([a-zA-Z0-9_]+)\s+struct\s*\{[^}]*gorm\.Model/g;
    let match;
    while ((match = gormRegex.exec(content)) !== null) {
      const modelName = match[1];
      out.set(modelName, {
        modelName,
        collectionOrTable: modelName.toLowerCase() + "s",
        fields: [],
        sourceFile: relPath,
        framework: "GORM",
        hasSoftDelete: true, // gorm.Model has DeletedAt soft delete
        hasTimestamps: true,
      });
    }
  }

  private findSourceFiles(dir: string, depth: number = 0, includeTests: boolean = this.includeTests): string[] {
    if (depth > 15) return [];
    const files: string[] = [];
    try {
      const entries = readdirSync(dir);
      for (const entry of entries) {
        if (isIgnoredDirectory(entry, includeTests)) {
          continue;
        }
        const fullPath = join(dir, entry);
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          files.push(...this.findSourceFiles(fullPath, depth + 1, includeTests));
        } else if (stat.isFile()) {
          if (!includeTests && isTestPath(fullPath)) {
            continue;
          }
          const ext = extname(fullPath);
          if ([".ts", ".tsx", ".js", ".jsx", ".prisma", ".sql", ".py", ".go", ".rs", ".java", ".kt", ".cs"].includes(ext)) {
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
