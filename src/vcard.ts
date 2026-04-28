import type { ContactDetails } from "macos-ts";
import VCard, {
  type AddressType,
  type EmailType,
  type PhoneType,
  type UrlType,
} from "vcard-creator";

export interface VCardOptions {
  /** Override the REV timestamp for deterministic output (testing). */
  now?: () => Date;
}

export function toVCard(details: ContactDetails, options: VCardOptions = {}): string {
  const card = new VCard();

  // addFullName must run before addName: addName auto-derives FN, and the
  // library throws if FN is set twice.
  const fn = pickFullName(details);
  if (fn) card.addFullName(fn);

  card.addName({
    familyName: details.lastName,
    givenName: details.firstName,
  });

  if (details.organization) {
    card.addCompany({
      name: details.organization,
      ...(details.department ? { department: details.department } : {}),
    });
  }
  if (details.jobTitle) card.addJobtitle(details.jobTitle);

  for (const e of details.emails) {
    if (!e.address) continue;
    card.addEmail({ address: e.address, type: emailTypes(e.label, e.isPrimary) });
  }
  for (const p of details.phones) {
    if (!p.number) continue;
    card.addPhoneNumber({ number: p.number, type: phoneTypes(p.label, p.isPrimary) });
  }
  for (const a of details.addresses) {
    const street = a.street ?? "";
    const locality = a.city ?? "";
    const region = a.state ?? "";
    const postalCode = a.zipCode ?? "";
    const country = a.country ?? "";
    if (!street && !locality && !region && !postalCode && !country) continue;
    card.addAddress({
      street,
      locality,
      region,
      postalCode,
      country,
      type: addressTypes(a.label),
    });
  }
  for (const u of details.urls) {
    if (!u.url) continue;
    card.addUrl({ url: u.url, type: urlTypes(u.label) });
  }
  for (const s of details.socialProfiles) {
    const url = s.url ?? s.username;
    if (!url) continue;
    card.addSocial({
      url,
      type: s.service ?? s.label ?? "other",
      ...(s.username ? { user: s.username } : {}),
    });
  }
  for (const r of details.relatedNames) {
    if (!r.name) continue;
    const params = r.label ? `TYPE=${typeParam(r.label)}` : undefined;
    card.addCustomProperty({
      name: "X-ABRELATEDNAMES",
      value: escapeText(r.name),
      ...(params ? { params } : {}),
    });
  }

  if (details.birthday) card.addBirthday(details.birthday);
  for (const d of details.dates) {
    if (!d.date) continue;
    const params = `TYPE=${typeParam(d.label ?? "anniversary")}`;
    card.addCustomProperty({
      name: "X-ABDATE",
      value: formatDate(d.date),
      params,
    });
  }

  if (details.note) card.addNote(details.note);

  card.addUid(`apple-contact-${details.id}`);
  card.addRevision(options.now?.() ?? new Date());

  return card.toString();
}

function pickFullName(d: ContactDetails): string | null {
  const candidates = [d.displayName, `${d.firstName} ${d.lastName}`.trim(), d.organization ?? ""];
  for (const c of candidates) {
    const trimmed = c.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return `contact-${d.id}`;
}

const EMAIL_LABEL_TO_TYPE: Record<string, EmailType> = {
  home: "home",
  work: "work",
};
const PHONE_LABEL_TO_TYPE: Record<string, PhoneType> = {
  home: "home",
  work: "work",
  mobile: "cell",
  iphone: "cell",
  cell: "cell",
  fax: "fax",
  homefax: "fax",
  workfax: "fax",
  pager: "pager",
  car: "car",
  voice: "voice",
};
const ADDRESS_LABEL_TO_TYPE: Record<string, AddressType> = {
  home: "home",
  work: "work",
};
const URL_LABEL_TO_TYPE: Record<string, UrlType> = {
  home: "home",
  work: "work",
};

function emailTypes(label: string | null, isPrimary: boolean): EmailType[] {
  const types: EmailType[] = [];
  const mapped = label ? EMAIL_LABEL_TO_TYPE[normalizeLabel(label)] : undefined;
  if (mapped) types.push(mapped);
  if (isPrimary) types.push("pref");
  return types;
}
function phoneTypes(label: string | null, isPrimary: boolean): PhoneType[] {
  const types: PhoneType[] = [];
  const mapped = label ? PHONE_LABEL_TO_TYPE[normalizeLabel(label)] : undefined;
  if (mapped) types.push(mapped);
  if (isPrimary) types.push("pref");
  return types;
}
function addressTypes(label: string | null): AddressType[] {
  const mapped = label ? ADDRESS_LABEL_TO_TYPE[normalizeLabel(label)] : undefined;
  return mapped ? [mapped] : [];
}
function urlTypes(label: string | null): UrlType[] {
  const mapped = label ? URL_LABEL_TO_TYPE[normalizeLabel(label)] : undefined;
  return mapped ? [mapped] : [];
}

function normalizeLabel(label: string): string {
  return label.toLowerCase().replace(/\s+/g, "");
}

function typeParam(label: string): string {
  const cleaned = label.replace(/[;,:\s]+/g, "_").toUpperCase();
  return cleaned.length > 0 ? cleaned : "OTHER";
}

function formatDate(d: Date): string {
  const year = d.getFullYear().toString().padStart(4, "0");
  const month = (d.getMonth() + 1).toString().padStart(2, "0");
  const day = d.getDate().toString().padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Escape per RFC 2426 §4 for use with addCustomProperty (which does NOT auto-escape). */
function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\r\n|\r|\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}
