import { join } from "node:path";
import { type Contact, Contacts } from "macos-ts";
import { archiveOverwrite, atomicWrite, fileExists } from "../copier.ts";
import { sanitizeFilename, sha256 } from "../fsutil.ts";
import { Manifest } from "../manifest.ts";
import type { ProgressEvent } from "../tui.ts";

export interface ContactsCfg {
  dest: string;
}

export async function* runContacts({ dest }: ContactsCfg): AsyncIterable<ProgressEvent> {
  const root = `${dest}/contacts`;
  const mf = await Manifest.open("contacts");
  const db = new Contacts();

  try {
    yield { type: "phase", label: "scanning Contacts" };
    const all = db.contacts({ sortBy: "displayName", order: "asc" });
    yield { type: "total", files: all.length };

    let filesTransferred = 0;
    let bytesTransferred = 0;

    for (let i = 0; i < all.length; i++) {
      const c = all[i] as Contact;
      const idStr = `${c.id}`;
      const display = c.displayName || `${c.firstName} ${c.lastName}`.trim() || `contact-${c.id}`;

      let details: ReturnType<typeof db.getContact>;
      try {
        details = db.getContact(c.id);
      } catch (err) {
        yield {
          type: "log",
          level: "warn",
          message: `getContact failed: ${display} (${(err as Error).message})`,
        };
        yield { type: "file", name: display, bytesDelta: 0, index: i + 1 };
        continue;
      }

      const canonical = stableStringify(details);
      const sourceKey = sha256(canonical);
      const existing = mf.get(idStr);
      const out = join(root, `${sanitizeFilename(display)}-${c.id}.json`);

      if (existing && existing.source_key === sourceKey && (await fileExists(existing.dest_path))) {
        yield { type: "file", name: display, bytesDelta: 0, index: i + 1 };
        continue;
      }

      const version = (existing?.version ?? 0) + 1;
      if (existing) await archiveOverwrite(existing.dest_path, existing.version, root);

      const pretty = `${JSON.stringify(details, null, 2)}\n`;
      const bytes = await atomicWrite(out, pretty);

      mf.upsert({
        source_id: idStr,
        dest_path: out,
        source_key: sourceKey,
        size_bytes: bytes,
        backed_up_at: Date.now(),
        version,
      });

      filesTransferred++;
      bytesTransferred += bytes;
      yield { type: "file", name: display, bytesDelta: bytes, index: i + 1 };
    }

    yield { type: "done", filesTransferred, bytesTransferred };
  } finally {
    mf.close();
    db.close();
  }
}

/** Deterministic JSON stringification — used as input to sha256 for change detection. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
  return `{${parts.join(",")}}`;
}
