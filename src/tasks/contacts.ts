import { join } from "node:path";
import { EventQueue, runPool } from "../concurrency.ts";
import { archiveOverwrite, atomicWrite, fileExists, TEMP_SUFFIX_BYTES } from "../copier.ts";
import { type ContactsFormat, DEFAULT_CONTACTS_FORMAT } from "../destination.ts";
import {
  DEFAULT_MAX_FILENAME_BYTES,
  mkdirp,
  probeMaxFilenameBytes,
  sanitizeFilename,
  sha256,
} from "../fsutil.ts";
import { type Contact, Contacts } from "../macos.ts";
import { Manifest } from "../manifest.ts";
import type { ProgressEvent } from "../tui.ts";
import { toVCard } from "../vcard.ts";

export interface ContactsCfg {
  dest: string;
  concurrency: number;
  snapshot?: boolean;
  contactsFormat?: ContactsFormat;
}

export async function* runContacts({
  dest,
  concurrency,
  snapshot = true,
  contactsFormat = DEFAULT_CONTACTS_FORMAT,
}: ContactsCfg): AsyncIterable<ProgressEvent> {
  const ext = contactsFormat === "json" ? "json" : "vcf";
  const root = `${dest}/contacts`;
  const mf = await Manifest.open("contacts");
  const db = new Contacts();

  try {
    yield { type: "phase", label: "probing destination" };
    await mkdirp(root);
    const probedMax = await probeMaxFilenameBytes(root);
    const nameCap = Math.min(probedMax - TEMP_SUFFIX_BYTES, DEFAULT_MAX_FILENAME_BYTES);
    yield {
      type: "log",
      level: "info",
      message: `destination NAME_MAX=${probedMax}, sanitizing filenames to ${nameCap} bytes`,
    };

    yield { type: "phase", label: "scanning Contacts" };
    const all = db.contacts({ sortBy: "displayName", order: "asc" });
    yield { type: "total", files: all.length };

    const queue = new EventQueue<ProgressEvent>();
    let completed = 0;
    let nextId = 0;
    let filesTransferred = 0;
    let bytesTransferred = 0;

    const processOne = async (c: Contact): Promise<void> => {
      const idStr = `${c.id}`;
      const display = c.displayName || `${c.firstName} ${c.lastName}`.trim() || `contact-${c.id}`;
      let bytesDelta = 0;
      const id = ++nextId;
      queue.push({ type: "start", name: display, id });

      try {
        let details: ReturnType<typeof db.getContact>;
        try {
          details = db.getContact(c.id);
        } catch (err) {
          queue.push({
            type: "log",
            level: "warn",
            message: `getContact failed: ${display} (${(err as Error).message})`,
          });
          return;
        }

        const canonical = stableStringify(details);
        const sourceKey = sha256(canonical);
        const existing = mf.get(idStr);
        const fnameSuffix = `-${c.id}.${ext}`;
        const titleCap = Math.max(8, nameCap - fnameSuffix.length);
        const out = join(
          root,
          `${sanitizeFilename(display, { maxBytes: titleCap })}${fnameSuffix}`,
        );

        if (
          existing &&
          existing.source_key === sourceKey &&
          existing.dest_path === out &&
          (await fileExists(existing.dest_path))
        ) {
          return;
        }

        const version = (existing?.version ?? 0) + 1;
        if (existing) await archiveOverwrite(existing.dest_path, existing.version, root);

        const payload =
          contactsFormat === "json" ? `${JSON.stringify(details, null, 2)}\n` : toVCard(details);
        const bytes = await atomicWrite(out, payload);

        mf.upsert({
          source_id: idStr,
          dest_path: out,
          source_key: sourceKey,
          size_bytes: bytes,
          backed_up_at: Date.now(),
          version,
        });

        bytesDelta = bytes;
        filesTransferred++;
        bytesTransferred += bytes;
      } catch (err) {
        queue.push({
          type: "log",
          level: "warn",
          message: `${display}: ${(err as Error).message}`,
        });
      } finally {
        completed++;
        queue.push({ type: "file", name: display, bytesDelta, index: completed, id });
      }
    };

    const poolDone = runPool(all, concurrency, processOne).finally(() => queue.close());

    for await (const ev of queue) yield ev;
    await poolDone;

    if (snapshot) await mf.snapshot(dest);
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
