import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, extname } from "node:path";

export interface DiscoveredSocketEvent {
  eventName: string;
  direction: "CLIENT_TO_SERVER" | "SERVER_TO_CLIENT" | "BIDIRECTIONAL";
  payloadType?: string;
  sourceFile: string;
  protocol: "SOCKET_IO" | "WEBRTC" | "WEBSOCKET";
  roomOrChannel?: string;
  isTypedContract: boolean;
  acknowledgement?: boolean;
}

export class RealtimeAnalyzer {
  private repoPath: string;

  constructor(repoPath: string = process.cwd()) {
    this.repoPath = repoPath;
  }

  public discoverSocketContracts(directionFilter: string = "ALL", limit: number = 200): DiscoveredSocketEvent[] {
    const events: Map<string, DiscoveredSocketEvent> = new Map();
    const sourceFiles = this.findSourceFiles(this.repoPath);

    for (const file of sourceFiles) {
      const content = readFileSync(file, "utf-8");
      const relPath = this.toRelative(file);
      const isClientFile = relPath.includes("client") || relPath.includes("frontend") || relPath.includes("ui") || relPath.includes("web");

      // 1. Inspect TypeScript Typed Socket Interfaces
      this.extractTypedSocketInterfaces(content, relPath, events);

      // 2. Inspect Module Registries / Declared Socket Events
      this.extractModuleDeclaredSocketEvents(content, relPath, events);

      // 3. Inspect Shared Room Runtime Events
      this.extractRoomRuntimeEvents(content, relPath, events);

      // 4. Inspect Imperative socket.on / socket.emit / io.emit
      this.extractImperativeSocketCalls(content, relPath, isClientFile, events);

      // 5. Inspect WebRTC Signaling & SFU Calls
      this.extractWebRtcSignals(content, relPath, events);

      // 6. Inspect Polyglot Realtime (Python, Go, Rust)
      this.extractPolyglotSockets(content, relPath, events);
    }

    let list = Array.from(events.values());
    if (directionFilter !== "ALL") {
      list = list.filter((e) => e.direction === directionFilter);
    }

    // Sort by event name for deterministic documentation
    list.sort((a, b) => a.eventName.localeCompare(b.eventName));

    return list.slice(0, limit);
  }

  private extractTypedSocketInterfaces(content: string, relPath: string, out: Map<string, DiscoveredSocketEvent>) {
    // 1. ClientToServerEvents
    const c2sMatch = /interface\s+(?:[a-zA-Z0-9_]*ClientToServerEvents|[a-zA-Z0-9_]*C2SEvents)\s*\{([^}]+)\}/s.exec(content);
    if (c2sMatch) {
      const body = c2sMatch[1];
      this.parseInterfaceBody(body, relPath, "CLIENT_TO_SERVER", out);
    }

    // 2. ServerToClientEvents
    const s2cMatch = /interface\s+(?:[a-zA-Z0-9_]*ServerToClientEvents|[a-zA-Z0-9_]*S2CEvents)\s*\{([^}]+)\}/s.exec(content);
    if (s2cMatch) {
      const body = s2cMatch[1];
      this.parseInterfaceBody(body, relPath, "SERVER_TO_CLIENT", out);
    }
  }

  private parseInterfaceBody(
    body: string,
    relPath: string,
    direction: "CLIENT_TO_SERVER" | "SERVER_TO_CLIENT",
    out: Map<string, DiscoveredSocketEvent>
  ) {
    const methodRegex = /['"`]?([a-zA-Z0-9_:-]+)['"`]?\s*:\s*\(([^)]*)\)\s*=>/g;
    let m;
    while ((m = methodRegex.exec(body)) !== null) {
      const evName = m[1];
      const params = m[2] ? m[2].trim() : "void";
      const hasAck = /ack|callback|\(response:|\(err:/i.test(params);

      const existing = out.get(evName);
      if (existing) {
        if (existing.direction !== direction) {
          existing.direction = "BIDIRECTIONAL";
        }
        existing.isTypedContract = true;
        if (!existing.payloadType) existing.payloadType = `(${params})`;
        if (hasAck) existing.acknowledgement = true;
      } else {
        out.set(evName, {
          eventName: evName,
          direction,
          payloadType: `(${params})`,
          sourceFile: relPath,
          protocol: "SOCKET_IO",
          isTypedContract: true,
          acknowledgement: hasAck,
        });
      }
    }
  }

  private extractModuleDeclaredSocketEvents(content: string, relPath: string, out: Map<string, DiscoveredSocketEvent>) {
    // Look for socketEvents: ["roulette:join", "roulette:leave", ...]
    const socketEventsRegex = /socketEvents\s*:\s*\[([^\]]+)\]/g;
    let match;
    while ((match = socketEventsRegex.exec(content)) !== null) {
      const arrayContent = match[1];
      const eventNames = arrayContent.match(/['"`]([^'"`]+)['"`]/g);
      if (eventNames) {
        for (const rawName of eventNames) {
          const evName = rawName.replace(/['"`]/g, "");
          if (!evName) continue;

          let direction: DiscoveredSocketEvent["direction"] = "CLIENT_TO_SERVER";
          if (evName.includes("state") || evName.includes("result") || evName.includes("sync") || evName.includes("open") || evName.includes("closed") || evName.includes("update")) {
            direction = "SERVER_TO_CLIENT";
          }

          const existing = out.get(evName);
          if (existing) {
            existing.isTypedContract = true;
          } else {
            out.set(evName, {
              eventName: evName,
              direction,
              payloadType: "ModulePayload",
              sourceFile: relPath,
              protocol: "SOCKET_IO",
              isTypedContract: true,
            });
          }
        }
      }
    }
  }

  private extractRoomRuntimeEvents(content: string, relPath: string, out: Map<string, DiscoveredSocketEvent>) {
    if (relPath.includes("rooms") || relPath.includes("room")) {
      const roomEventRegex = /['"`](room:[a-zA-Z0-9_:-]+)['"`]/g;
      let match;
      while ((match = roomEventRegex.exec(content)) !== null) {
        const evName = match[1];
        let direction: DiscoveredSocketEvent["direction"] = "CLIENT_TO_SERVER";
        if (
          evName.includes("state") ||
          evName.includes("ended") ||
          evName.includes("countdown") ||
          evName.includes("error") ||
          evName.includes("broadcast")
        ) {
          direction = "SERVER_TO_CLIENT";
        }

        const existing = out.get(evName);
        if (!existing) {
          out.set(evName, {
            eventName: evName,
            direction,
            payloadType: "RoomRuntimePayload",
            sourceFile: relPath,
            protocol: "SOCKET_IO",
            isTypedContract: false,
          });
        }
      }
    }
  }

  private extractImperativeSocketCalls(
    content: string,
    relPath: string,
    isClientFile: boolean,
    out: Map<string, DiscoveredSocketEvent>
  ) {
    // 1. Listeners: socket.on('eventName', ...)
    const onRegex = /(?:socket|io|emitter)\.on\s*\(\s*['"`]([^'"`]+)['"`]/g;
    let match;
    while ((match = onRegex.exec(content)) !== null) {
      const evName = match[1];
      if (evName === "disconnect" || evName === "connect_error") continue;

      const direction = isClientFile ? "SERVER_TO_CLIENT" : "CLIENT_TO_SERVER";
      const existing = out.get(evName);
      if (existing) {
        if (existing.direction !== direction) {
          existing.direction = "BIDIRECTIONAL";
        }
      } else {
        out.set(evName, {
          eventName: evName,
          direction,
          sourceFile: relPath,
          protocol: "SOCKET_IO",
          isTypedContract: false,
        });
      }
    }

    // 2. Emitters: socket.emit('eventName', ...) / io.emit(...) / io.to(...).emit(...) / io.of(...).emit(...)
    const emitRegex = /(?:socket|io|broadcast|ws|client)(?:\.to\([^)]+\)|\.in\([^)]+\)|\.of\([^)]+\))?\.emit\s*\(\s*['"`]([^'"`]+)['"`]/g;
    while ((match = emitRegex.exec(content)) !== null) {
      const evName = match[1];
      const direction = isClientFile ? "CLIENT_TO_SERVER" : "SERVER_TO_CLIENT";
      const existing = out.get(evName);
      if (existing) {
        if (existing.direction !== direction) {
          existing.direction = "BIDIRECTIONAL";
        }
      } else {
        out.set(evName, {
          eventName: evName,
          direction,
          sourceFile: relPath,
          protocol: "SOCKET_IO",
          isTypedContract: false,
        });
      }
    }
  }

  private extractWebRtcSignals(content: string, relPath: string, out: Map<string, DiscoveredSocketEvent>) {
    if (/RTCPeerConnection|createOffer|createAnswer|onicecandidate|cloudflareSfu|mediasoup|livekit/i.test(content)) {
      const candidates = [
        "webrtc:signal",
        "webrtc:offer",
        "webrtc:answer",
        "webrtc:candidate",
        "webrtc:ice-candidate",
        "sfu:join",
        "sfu:leave",
        "sfu:track",
      ];
      for (const cand of candidates) {
        if (content.includes(cand) && !out.has(cand)) {
          out.set(cand, {
            eventName: cand,
            direction: "BIDIRECTIONAL",
            payloadType: "RTCSessionDescriptionInit | RTCIceCandidateInit",
            sourceFile: relPath,
            protocol: "WEBRTC",
            isTypedContract: true,
          });
        }
      }
    }
  }

  private extractPolyglotSockets(content: string, relPath: string, out: Map<string, DiscoveredSocketEvent>) {
    // Python socketio: @sio.on('eventName') or sio.emit('eventName')
    const pyOnRegex = /@(?:sio|socketio)\.on\s*\(\s*['"`]([^'"`]+)['"`]/g;
    let match;
    while ((match = pyOnRegex.exec(content)) !== null) {
      const evName = match[1];
      if (!out.has(evName)) {
        out.set(evName, {
          eventName: evName,
          direction: "CLIENT_TO_SERVER",
          sourceFile: relPath,
          protocol: "SOCKET_IO",
          isTypedContract: false,
        });
      }
    }

    const pyEmitRegex = /(?:sio|socketio)\.emit\s*\(\s*['"`]([^'"`]+)['"`]/g;
    while ((match = pyEmitRegex.exec(content)) !== null) {
      const evName = match[1];
      if (!out.has(evName)) {
        out.set(evName, {
          eventName: evName,
          direction: "SERVER_TO_CLIENT",
          sourceFile: relPath,
          protocol: "SOCKET_IO",
          isTypedContract: false,
        });
      }
    }

    // Go Gorilla / socketio: .OnEvent("eventName", ...)
    const goOnRegex = /\.OnEvent\s*\(\s*["']([^"']+)["']/g;
    while ((match = goOnRegex.exec(content)) !== null) {
      const evName = match[1];
      if (!out.has(evName)) {
        out.set(evName, {
          eventName: evName,
          direction: "CLIENT_TO_SERVER",
          sourceFile: relPath,
          protocol: "SOCKET_IO",
          isTypedContract: false,
        });
      }
    }
  }

  private findSourceFiles(dir: string, depth: number = 0): string[] {
    if (depth > 15) return [];
    const files: string[] = [];
    try {
      const entries = readdirSync(dir);
      for (const entry of entries) {
        if (
          entry === "node_modules" ||
          entry === "target" ||
          entry === ".git" ||
          entry === "dist" ||
          entry === "build" ||
          entry === ".autodoc" ||
          entry === ".turbo" ||
          entry === ".next" ||
          entry === "vendor" ||
          entry === "__pycache__" ||
          entry === ".venv" ||
          entry === ".cargo" ||
          entry.startsWith(".")
        ) {
          continue;
        }
        const fullPath = join(dir, entry);
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          files.push(...this.findSourceFiles(fullPath, depth + 1));
        } else if (stat.isFile()) {
          const ext = extname(fullPath);
          if ([".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java", ".kt", ".cs"].includes(ext)) {
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
