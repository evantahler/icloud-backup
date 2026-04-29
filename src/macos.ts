import {
  type Contact,
  type ContactDetails,
  type NoteMeta,
  type PhotoMeta,
  Contacts as RealContacts,
  Notes as RealNotes,
  Photos as RealPhotos,
} from "macos-ts";
import { FakeContacts, FakeNotes, FakePhotos } from "./macos-fake.ts";

const FAKE = process.env.ICLOUD_BACKUP_FAKE === "1";

export const Photos: typeof RealPhotos = FAKE
  ? (FakePhotos as unknown as typeof RealPhotos)
  : RealPhotos;
export const Notes: typeof RealNotes = FAKE
  ? (FakeNotes as unknown as typeof RealNotes)
  : RealNotes;
export const Contacts: typeof RealContacts = FAKE
  ? (FakeContacts as unknown as typeof RealContacts)
  : RealContacts;

export type Photos = RealPhotos;
export type Notes = RealNotes;
export type Contacts = RealContacts;

export type { Contact, ContactDetails, NoteMeta, PhotoMeta };
