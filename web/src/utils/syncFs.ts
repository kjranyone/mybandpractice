/**
 * Sync file IO abstraction.
 *  - native (Capacitor): app external files dir (songs/, setlists/)
 *  - web (PC browser): the vite dev/preview server library API
 *    (/api/sync-list, /api/sync-file, /api/sync-rename) — no prompts
 */

import { Capacitor } from "@capacitor/core";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { Sha256, toHex } from "./sha256";

export interface SyncFs {
  /** Ensure a directory (recursive) exists at a "/"-separated path. */
  mkdir(path: string): Promise<void>;
  /** Write the whole file (create/overwrite). */
  writeFile(path: string, data: Uint8Array): Promise<void>;
  /** Append bytes to a file. */
  appendFile(path: string, data: Uint8Array): Promise<void>;
  /** Atomically publish `<path>` (expects `<path>` to exist as .part target). */
  rename(from: string, to: string): Promise<void>;
  /** Remove a file; resolves also when missing. */
  deleteFile(path: string): Promise<void>;
  /** File size in bytes, or null when missing. */
  size(path: string): Promise<number | null>;
  /** Recursively list files under a directory with sizes.
   *  Returns [] when the directory does not exist. */
  listFiles(dir: string): Promise<{ name: string; bytes: number }[]>;
  /** Read a whole file as bytes (small files: json/md). */
  readFile(path: string): Promise<Uint8Array | null>;
  /** Streaming sha256 of a file - never holds the whole file in memory. */
  hashFile(path: string): Promise<string | null>;
  /** Stream a file in chunks (for sending). Returns null when missing. */
  readFileStream(
    path: string,
    onChunk: (data: Uint8Array) => void | Promise<void>,
  ): Promise<null | undefined>;
}

// ---- native (Capacitor) ----

class NativeSyncFs implements SyncFs {
  async mkdir(path: string): Promise<void> {
    await Filesystem.mkdir({
      path,
      directory: Directory.External,
      recursive: true,
    });
  }

  async writeFile(path: string, data: Uint8Array): Promise<void> {
    await Filesystem.writeFile({
      path,
      directory: Directory.External,
      data: bytesToBase64(data),
    });
  }

  async appendFile(path: string, data: Uint8Array): Promise<void> {
    await Filesystem.appendFile({
      path,
      directory: Directory.External,
      data: bytesToBase64(data),
    });
  }

  async rename(from: string, to: string): Promise<void> {
    await Filesystem.rename({
      from,
      to,
      directory: Directory.External,
      toDirectory: Directory.External,
    });
  }

  async deleteFile(path: string): Promise<void> {
    try {
      await Filesystem.deleteFile({ path, directory: Directory.External });
    } catch {
      /* already gone */
    }
  }

  async size(path: string): Promise<number | null> {
    try {
      const st = await Filesystem.stat({
        path,
        directory: Directory.External,
      });
      return st.size;
    } catch {
      return null;
    }
  }

  async listFiles(dir: string): Promise<{ name: string; bytes: number }[]> {
    const out: { name: string; bytes: number }[] = [];
    let entries: { name?: string; type?: string }[] = [];
    try {
      const res = await Filesystem.readdir({
        path: dir,
        directory: Directory.External,
      });
      entries = res.files;
    } catch {
      return out;
    }
    for (const e of entries) {
      const name = e.name ?? "";
      if (!name) continue;
      const type = (e.type ?? "file").toLowerCase();
      if (type === "directory" || type === "dir") {
        const sub = await this.listFiles(`${dir}/${name}`);
        for (const s of sub) out.push({ ...s, name: `${name}/${s.name}` });
      } else {
        const size = await this.size(`${dir}/${name}`);
        if (size != null) out.push({ name, bytes: size });
      }
    }
    return out;
  }

  async readFile(path: string): Promise<Uint8Array | null> {
    try {
      const res = await Filesystem.readFile({
        path,
        directory: Directory.External,
      });
      if (typeof res.data === "string") {
        return base64ToBytes(res.data);
      }
      // web fallback: Blob
      return new Uint8Array(await res.data.arrayBuffer());
    } catch {
      return null;
    }
  }

  /** Native streaming via readFileInChunks (base64 chunks across the
   *  JS bridge) — constant memory regardless of file size. */
  private readInChunks(
    path: string,
    onChunk: (data: Uint8Array) => void | Promise<void>,
  ): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (ok: boolean) => {
        if (!settled) {
          settled = true;
          resolve(ok);
        }
      };
      void Filesystem.readFileInChunks(
        {
          path,
          directory: Directory.External,
          chunkSize: 512 * 1024,
        },
        (chunk, err) => {
          if (settled) return;
          if (err) {
            finish(false);
            return;
          }
          if (chunk == null) {
            finish(true);
            return;
          }
          const data =
            typeof chunk.data === "string"
              ? base64ToBytes(chunk.data)
              : null;
          if (!data) {
            finish(false);
            return;
          }
          void Promise.resolve(onChunk(data)).catch(() => finish(false));
        },
      ).catch(() => finish(false));
    });
  }

  async hashFile(path: string): Promise<string | null> {
    const hash = new Sha256();
    const ok = await this.readInChunks(path, (c) => {
      hash.update(c);
    });
    return ok ? toHex(hash.digest()) : null;
  }

  async readFileStream(
    path: string,
    onChunk: (data: Uint8Array) => void | Promise<void>,
  ): Promise<null | undefined> {
    const ok = await this.readInChunks(path, onChunk);
    return ok ? undefined : null;
  }
}

// ---- web (dev/preview server API) ----

class HttpSyncFs implements SyncFs {
  /** In-memory chunks per .part path, flushed as one PUT on rename. */
  private buffers = new Map<string, Uint8Array[]>();

  private fileUrl(path: string): string {
    return `/api/sync-file?path=${encodeURIComponent(path)}`;
  }

  async mkdir(): Promise<void> {
    /* server creates parent dirs on write */
  }

  async writeFile(path: string, data: Uint8Array): Promise<void> {
    const res = await fetch(this.fileUrl(path), {
      method: "PUT",
      body: data as unknown as BodyInit,
    });
    if (!res.ok) throw new Error(`write failed (${res.status})`);
  }

  async appendFile(path: string, data: Uint8Array): Promise<void> {
    const arr = this.buffers.get(path) ?? [];
    arr.push(data);
    this.buffers.set(path, arr);
  }

  async rename(from: string, to: string): Promise<void> {
    const buf = this.buffers.get(from);
    if (buf) {
      const total = buf.reduce((a, c) => a + c.length, 0);
      const data = new Uint8Array(total);
      let off = 0;
      for (const c of buf) {
        data.set(c, off);
        off += c.length;
      }
      this.buffers.delete(from);
      await this.writeFile(to, data);
      return;
    }
    const res = await fetch(
      `/api/sync-rename?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      { method: "POST" },
    );
    if (!res.ok) throw new Error(`rename failed (${res.status})`);
  }

  async deleteFile(path: string): Promise<void> {
    this.buffers.delete(path);
    try {
      await fetch(this.fileUrl(path), { method: "DELETE" });
    } catch {
      /* already gone */
    }
  }

  async size(path: string): Promise<number | null> {
    try {
      const res = await fetch(this.fileUrl(path), { method: "HEAD" });
      if (!res.ok) return null;
      const len = res.headers.get("content-length");
      return len ? Number(len) : null;
    } catch {
      return null;
    }
  }

  async listFiles(dir: string): Promise<{ name: string; bytes: number }[]> {
    try {
      const res = await fetch(
        `/api/sync-list?dir=${encodeURIComponent(dir)}`,
      );
      if (!res.ok) return [];
      const data = (await res.json()) as {
        files?: { name?: unknown; bytes?: unknown }[];
      };
      return (data.files ?? [])
        .filter(
          (f): f is { name: string; bytes: number } =>
            typeof f.name === "string" && typeof f.bytes === "number",
        )
        .map((f) => ({ name: f.name, bytes: f.bytes }));
    } catch {
      return [];
    }
  }

  async readFile(path: string): Promise<Uint8Array | null> {
    try {
      const res = await fetch(this.fileUrl(path));
      if (!res.ok) return null;
      return new Uint8Array(await res.arrayBuffer());
    } catch {
      return null;
    }
  }

  async hashFile(path: string): Promise<string | null> {
    try {
      const res = await fetch(this.fileUrl(path));
      if (!res.ok) return null;
      const hash = new Sha256();
      const reader = res.body?.getReader();
      if (!reader) {
        // no streaming support: fall back to buffering
        const buf = new Uint8Array(await res.arrayBuffer());
        hash.update(buf);
        return toHex(hash.digest());
      }
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) hash.update(value);
      }
      return toHex(hash.digest());
    } catch {
      return null;
    }
  }

  async readFileStream(
    path: string,
    onChunk: (data: Uint8Array) => void | Promise<void>,
  ): Promise<null | undefined> {
    try {
      const res = await fetch(this.fileUrl(path));
      if (!res.ok) return null;
      const reader = res.body?.getReader();
      if (!reader) {
        const buf = new Uint8Array(await res.arrayBuffer());
        await onChunk(buf);
        return undefined;
      }
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) await onChunk(value);
      }
      return undefined;
    } catch {
      return null;
    }
  }
}

export function isNativePlatform(): boolean {
  return Capacitor.isNativePlatform();
}

export function nativeSyncFs(): SyncFs {
  return new NativeSyncFs();
}

/** Dev/preview-server library (PC) — read/write, no prompts. */
export function httpSyncFs(): SyncFs {
  return new HttpSyncFs();
}

/** The sync storage for the current platform. */
export function defaultSyncFs(): SyncFs {
  return Capacitor.isNativePlatform() ? nativeSyncFs() : httpSyncFs();
}

/** sha256 of a byte array (helpers shared by both platforms). */
export async function sha256Hex(data: Uint8Array): Promise<string> {
  const h = new Sha256();
  h.update(data);
  return toHex(h.digest());
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
