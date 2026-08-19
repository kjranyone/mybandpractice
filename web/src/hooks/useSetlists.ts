import { useCallback, useEffect, useState } from "react";
import {
  deleteNativeSetlist,
  isNative,
  listNativeSetlists,
  saveNativeSetlist,
} from "../utils/nativeSongs";

export type Setlist = {
  id: string; // filesystem-safe id (filename stem)
  name: string; // display name, any unicode
  songs: string[]; // slugs in play order
};

/**
 * Setlists (ordered song lists), stored as setlists/<id>.json.
 *  - web dev server: /api/setlists (vite plugin, full CRUD)
 *  - native (Capacitor): scan + write to the external files dir
 * Editing happens in the Manage Songs modal on any platform.
 */

/** Filesystem-safe id from a display name (ASCII slug when possible). */
function toId(name: string): string {
  const ascii = name
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .toLowerCase();
  if (ascii) return ascii;
  // pure-unicode name: fall back to a timestamp id
  return `sl-${Date.now().toString(36)}`;
}

export function useSetlists() {
  const [setlists, setSetlists] = useState<Setlist[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      if (isNative()) {
        setSetlists(await listNativeSetlists());
      } else {
        const res = await fetch("/api/setlists");
        if (res.ok) {
          const data = (await res.json()) as {
            id: string;
            name: string;
            songs: string[];
          }[];
          setSetlists(
            data.map((d) => ({
              id: d.id,
              name: d.name,
              songs: Array.isArray(d.songs) ? d.songs : [],
            })),
          );
        } else {
          setSetlists([]);
        }
      }
    } catch {
      setSetlists([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const save = useCallback(async (setlist: Setlist): Promise<boolean> => {
    if (!setlist.id || !setlist.name.trim()) return false;
    const payload = { name: setlist.name.trim(), songs: setlist.songs };
    setSetlists((prev) => {
      const i = prev.findIndex((s) => s.id === setlist.id);
      if (i === -1) return [...prev, { ...setlist, ...payload }];
      const next = [...prev];
      next[i] = { ...next[i], ...payload };
      return next;
    });
    try {
      if (isNative()) {
        await saveNativeSetlist(setlist.id, payload.name, payload.songs);
        return true;
      }
      const res = await fetch(
        `/api/setlists/${encodeURIComponent(setlist.id)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      return res.ok;
    } catch {
      return false;
    }
  }, []);

  const remove = useCallback(async (id: string): Promise<boolean> => {
    setSetlists((prev) => prev.filter((s) => s.id !== id));
    try {
      if (isNative()) {
        await deleteNativeSetlist(id);
        return true;
      }
      const res = await fetch(`/api/setlists/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      return res.ok;
    } catch {
      return false;
    }
  }, []);

  const create = useCallback(
    (name: string, songs: string[] = []): Setlist => ({
      id: toId(name),
      name: name.trim(),
      songs,
    }),
    [],
  );

  return {
    setlists,
    loading,
    reload,
    save,
    remove,
    create,
  };
}
