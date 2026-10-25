// Helpers for newline-delimited JSON streams, as produced by Ollama and /api/chat.

/**
 * Splits streamed text into complete, non-empty lines. A trailing partial line
 * is held back until the rest of it arrives or `flush` is called.
 */
export function createLineSplitter() {
  let buffer = "";
  const complete = (lines: string[]) => lines.map((l) => l.trim()).filter(Boolean);
  return {
    push(text: string): string[] {
      buffer += text;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      return complete(lines);
    },
    flush(): string[] {
      const rest = buffer;
      buffer = "";
      return complete([rest]);
    },
  };
}

/** Reads an NDJSON body and calls `onObject` for each line that parses as JSON. */
export async function readNdjson(body: ReadableStream<Uint8Array>, onObject: (obj: unknown) => void) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const lines = createLineSplitter();

  const handle = (line: string) => {
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      return; // skip malformed lines
    }
    onObject(obj);
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    lines.push(decoder.decode(value, { stream: true })).forEach(handle);
  }
  lines.push(decoder.decode()).forEach(handle);
  lines.flush().forEach(handle);
}
