import { EventEmitter } from "node:events";

export interface LogEntry {
  readonly id: number;
  readonly timestamp: string;
  readonly stream: "stdout" | "stderr" | "system";
  readonly line: string;
}

export class LogRingBuffer {
  private readonly entries: LogEntry[] = [];
  private nextId = 1;
  private readonly emitter = new EventEmitter();

  public constructor(private readonly capacity = 2000) {
    this.emitter.setMaxListeners(100);
  }

  public push(stream: LogEntry["stream"], rawChunk: string): void {
    const lines = rawChunk.replace(/\r\n/g, "\n").split("\n");
    for (const line of lines) {
      if (!line.trim() && lines.length > 1) continue;
      const entry: LogEntry = {
        id: this.nextId++,
        timestamp: new Date().toISOString(),
        stream,
        line,
      };
      this.entries.push(entry);
      if (this.entries.length > this.capacity) {
        this.entries.shift();
      }
      this.emitter.emit("entry", entry);
    }
  }

  public snapshot(limit = 300): LogEntry[] {
    if (limit >= this.entries.length) {
      return [...this.entries];
    }
    return this.entries.slice(this.entries.length - limit);
  }

  public subscribe(listener: (entry: LogEntry) => void): () => void {
    this.emitter.on("entry", listener);
    return () => {
      this.emitter.off("entry", listener);
    };
  }

  public clear(): void {
    this.entries.length = 0;
  }
}
