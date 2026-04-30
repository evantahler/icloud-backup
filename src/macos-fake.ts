// Fixture-driven stand-ins for the macos-ts Photos / Notes / Contacts classes.
// Activated by `src/macos.ts` when `ICLOUD_BACKUP_FAKE=1`. Used to drive
// deterministic VHS captures (see scripts/capture.ts) — never imported in
// production code paths.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AttachmentRef,
  Contact,
  ContactDetails,
  NoteMeta,
  PhotoDetails,
  PhotoMeta,
} from "macos-ts";

const FIXTURES_DIR =
  process.env.ICLOUD_BACKUP_FAKE_FIXTURES_DIR ??
  resolve(dirname(fileURLToPath(import.meta.url)), "..", "docs", "tapes", "fixtures", "data");

// Per-item synthetic delay so VHS captures show the progress bars actually
// filling rather than snapping to 100% the moment Enter is pressed. Local SSD
// I/O is too fast to observe otherwise. Zero by default — only set in the
// capture pipeline (scripts/capture.ts).
const DELAY_MS = Number.parseInt(process.env.ICLOUD_BACKUP_FAKE_DELAY_MS ?? "0", 10);

function pace(): void {
  if (DELAY_MS > 0) Bun.sleepSync(DELAY_MS);
}

function loadJson<T>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, name), "utf8")) as T;
}

function fileUrl(rel: string): string {
  return `file://${join(FIXTURES_DIR, "sources", rel)}`;
}

interface PhotoEntry {
  id: number;
  uuid: string;
  filename: string;
  mediaType: "photo" | "video";
  width: number;
  height: number;
  dateCreated: string;
  dateAdded: string;
  // Optional in fixture JSON; falls back to dateCreated if absent so older
  // fixtures keep working after macos-ts >= 0.10.7 promoted modifiedAt onto
  // PhotoMeta.
  modifiedAt?: string;
  favorite: boolean;
  hidden: boolean;
  latitude: number | null;
  longitude: number | null;
  uniformTypeIdentifier: string;
  duration: number;
  orientation: number;
  originalFilename: string | null;
  title: string | null;
  fileSize: number | null;
  locallyAvailable: boolean;
  sourceFile: string;
}

export class FakePhotos {
  private entries: PhotoEntry[];
  constructor() {
    this.entries = loadJson<{ photos: PhotoEntry[] }>("photos.json").photos;
  }
  photos(opts?: { order?: "asc" | "desc"; limit?: number }): PhotoMeta[] {
    let list = this.entries.map((e) => toPhotoMeta(e));
    if (opts?.order === "desc") list = list.slice().reverse();
    if (opts?.limit) list = list.slice(0, opts.limit);
    return list;
  }
  getPhoto(photoId: number): PhotoDetails {
    pace();
    return toPhotoDetails(this.findOrThrow(photoId));
  }
  getPhotoUrl(photoId: number): { url: string; locallyAvailable: boolean } {
    pace();
    const e = this.findOrThrow(photoId);
    return { url: fileUrl(e.sourceFile), locallyAvailable: e.locallyAvailable };
  }
  close(): void {}
  private findOrThrow(id: number): PhotoEntry {
    const e = this.entries.find((x) => x.id === id);
    if (!e) throw new Error(`fake-photos: id ${id} not in fixture`);
    return e;
  }
}

function toPhotoMeta(e: PhotoEntry): PhotoMeta {
  return {
    id: e.id,
    filename: e.filename,
    mediaType: e.mediaType,
    width: e.width,
    height: e.height,
    dateCreated: new Date(e.dateCreated),
    dateAdded: new Date(e.dateAdded),
    modifiedAt: new Date(e.modifiedAt ?? e.dateCreated),
    fileSize: e.fileSize,
    favorite: e.favorite,
    hidden: e.hidden,
    latitude: e.latitude,
    longitude: e.longitude,
  };
}

function toPhotoDetails(e: PhotoEntry): PhotoDetails {
  return {
    ...toPhotoMeta(e),
    uuid: e.uuid,
    uniformTypeIdentifier: e.uniformTypeIdentifier,
    duration: e.duration,
    orientation: e.orientation,
    originalFilename: e.originalFilename,
    title: e.title,
    locallyAvailable: e.locallyAvailable,
  };
}

interface NoteAttachmentEntry {
  id: number;
  identifier: string;
  name: string;
  contentType: string;
  sourceFile: string | null;
}

interface NoteEntry {
  id: number;
  title: string;
  snippet: string;
  folderId: number;
  folderName: string;
  accountId: number;
  accountName: string;
  createdAt: string;
  modifiedAt: string;
  isPasswordProtected: boolean;
  markdown: string;
  attachments: NoteAttachmentEntry[];
}

export class FakeNotes {
  private entries: NoteEntry[];
  constructor() {
    this.entries = loadJson<{ notes: NoteEntry[] }>("notes.json").notes;
  }
  notes(opts?: { order?: "asc" | "desc"; limit?: number }): NoteMeta[] {
    let list = this.entries.map(toNoteMeta);
    if (opts?.order === "desc") list = list.slice().reverse();
    if (opts?.limit) list = list.slice(0, opts.limit);
    return list;
  }
  listAttachments(noteId: number): AttachmentRef[] {
    pace();
    return this.findOrThrow(noteId).attachments.map((a) => ({
      id: a.id,
      identifier: a.identifier,
      name: a.name,
      contentType: a.contentType,
      url: a.sourceFile ? fileUrl(a.sourceFile) : null,
    }));
  }
  resolveAttachment(_id: string): { error: string } {
    return { error: "fake-mode-unresolvable" };
  }
  read(noteId: number, _opts?: unknown): { meta: NoteMeta; markdown: string } {
    const e = this.findOrThrow(noteId);
    return { meta: toNoteMeta(e), markdown: e.markdown };
  }
  close(): void {}
  private findOrThrow(id: number): NoteEntry {
    const e = this.entries.find((x) => x.id === id);
    if (!e) throw new Error(`fake-notes: id ${id} not in fixture`);
    return e;
  }
}

function toNoteMeta(e: NoteEntry): NoteMeta {
  return {
    id: e.id,
    title: e.title,
    snippet: e.snippet,
    folderId: e.folderId,
    folderName: e.folderName,
    accountId: e.accountId,
    accountName: e.accountName,
    createdAt: new Date(e.createdAt),
    modifiedAt: new Date(e.modifiedAt),
    isPasswordProtected: e.isPasswordProtected,
  };
}

interface ContactEntry {
  id: number;
  firstName: string;
  lastName: string;
  displayName: string;
  organization: string | null;
  jobTitle: string | null;
  department: string | null;
  birthday: string | null;
  note: string | null;
  hasImage: boolean;
  createdAt: string;
  modifiedAt: string;
  emails: ContactDetails["emails"];
  phones: ContactDetails["phones"];
  addresses: ContactDetails["addresses"];
  urls: ContactDetails["urls"];
  socialProfiles: ContactDetails["socialProfiles"];
  relatedNames: ContactDetails["relatedNames"];
  dates: { date: string; label: string | null }[];
}

export class FakeContacts {
  private entries: ContactEntry[];
  constructor() {
    this.entries = loadJson<{ contacts: ContactEntry[] }>("contacts.json").contacts;
  }
  contacts(opts?: { order?: "asc" | "desc"; limit?: number }): Contact[] {
    let list = this.entries.map(toContact);
    if (opts?.order === "desc") list = list.slice().reverse();
    if (opts?.limit) list = list.slice(0, opts.limit);
    return list;
  }
  getContact(contactId: number): ContactDetails {
    pace();
    const e = this.findOrThrow(contactId);
    return {
      ...toContact(e),
      emails: e.emails,
      phones: e.phones,
      addresses: e.addresses,
      urls: e.urls,
      socialProfiles: e.socialProfiles,
      relatedNames: e.relatedNames,
      dates: e.dates.map((d) => ({ date: new Date(d.date), label: d.label })),
    };
  }
  close(): void {}
  private findOrThrow(id: number): ContactEntry {
    const e = this.entries.find((x) => x.id === id);
    if (!e) throw new Error(`fake-contacts: id ${id} not in fixture`);
    return e;
  }
}

function toContact(e: ContactEntry): Contact {
  return {
    id: e.id,
    firstName: e.firstName,
    lastName: e.lastName,
    displayName: e.displayName,
    organization: e.organization,
    jobTitle: e.jobTitle,
    department: e.department,
    birthday: e.birthday ? new Date(e.birthday) : null,
    note: e.note,
    hasImage: e.hasImage,
    createdAt: new Date(e.createdAt),
    modifiedAt: new Date(e.modifiedAt),
  };
}
