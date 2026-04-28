import { describe, expect, test } from "bun:test";
import type { ContactDetails } from "macos-ts";
import { toVCard } from "../src/vcard.ts";

const FROZEN_NOW = () => new Date("2026-04-27T12:00:00Z");

function base(overrides: Partial<ContactDetails> = {}): ContactDetails {
  return {
    id: 1,
    firstName: "",
    lastName: "",
    displayName: "",
    organization: null,
    jobTitle: null,
    department: null,
    birthday: null,
    note: null,
    hasImage: false,
    createdAt: new Date(0),
    modifiedAt: new Date(0),
    emails: [],
    phones: [],
    addresses: [],
    urls: [],
    socialProfiles: [],
    relatedNames: [],
    dates: [],
    ...overrides,
  };
}

describe("toVCard", () => {
  test("emits a valid 3.0 envelope with FN/UID/REV for a near-empty contact", () => {
    const out = toVCard(base({ id: 7, displayName: "Alice", firstName: "Alice", lastName: "" }), {
      now: FROZEN_NOW,
    });
    expect(out.startsWith("BEGIN:VCARD\r\n")).toBe(true);
    expect(out).toContain("VERSION:3.0\r\n");
    expect(out).toContain("FN:Alice\r\n");
    expect(out).toContain("UID:apple-contact-7\r\n");
    expect(out).toContain("REV:2026-04-27T12:00:00.000Z\r\n");
    expect(out.endsWith("END:VCARD\r\n")).toBe(true);
  });

  test("falls back to contact-{id} when no name fields are populated", () => {
    const out = toVCard(base({ id: 99 }), { now: FROZEN_NOW });
    expect(out).toContain("FN:contact-99\r\n");
  });

  test("escapes \\, ;, , and newlines in NOTE per RFC 2426 §4", () => {
    const out = toVCard(
      base({ id: 1, displayName: "X", note: "back\\slash; semi, comma\nnewline" }),
      { now: FROZEN_NOW },
    );
    expect(out).toContain("NOTE:back\\\\slash\\; semi\\, comma\\nnewline\r\n");
  });

  test("emails get TYPE=WORK,PREF for primary work address", () => {
    const out = toVCard(
      base({
        id: 1,
        displayName: "X",
        emails: [{ address: "a@b.com", label: "work", isPrimary: true }],
      }),
      { now: FROZEN_NOW },
    );
    expect(out).toContain("EMAIL;TYPE=WORK,PREF:a@b.com\r\n");
  });

  test("phone label 'mobile' maps to TEL;TYPE=CELL", () => {
    const out = toVCard(
      base({
        id: 1,
        displayName: "X",
        phones: [{ number: "555-0100", label: "mobile", isPrimary: false }],
      }),
      { now: FROZEN_NOW },
    );
    expect(out).toContain("TEL;TYPE=CELL:555-0100\r\n");
  });

  test("addresses emit ADR with the standard 7-component layout", () => {
    const out = toVCard(
      base({
        id: 1,
        displayName: "X",
        addresses: [
          {
            street: "1 Main St",
            city: "SF",
            state: "CA",
            zipCode: "94110",
            country: "USA",
            label: "home",
          },
        ],
      }),
      { now: FROZEN_NOW },
    );
    expect(out).toContain("ADR;TYPE=HOME:;;1 Main St;SF;CA;94110;USA\r\n");
  });

  test("addresses with all empty parts are skipped", () => {
    const out = toVCard(
      base({
        id: 1,
        displayName: "X",
        addresses: [
          {
            street: null,
            city: null,
            state: null,
            zipCode: null,
            country: null,
            label: "home",
          },
        ],
      }),
      { now: FROZEN_NOW },
    );
    expect(out).not.toContain("ADR");
  });

  test("birthday formats as YYYY-MM-DD", () => {
    const out = toVCard(
      base({ id: 1, displayName: "X", birthday: new Date("1990-05-15T00:00:00Z") }),
      { now: FROZEN_NOW },
    );
    expect(out).toMatch(/BDAY:1990-05-1[45]\r\n/);
  });

  test("uses CRLF line endings throughout", () => {
    const out = toVCard(base({ id: 1, displayName: "X" }), { now: FROZEN_NOW });
    const lines = out.split("\r\n");
    expect(lines.length).toBeGreaterThan(2);
    expect(out.includes("\n\r")).toBe(false);
    const bareLF = out.replace(/\r\n/g, "").includes("\n");
    expect(bareLF).toBe(false);
  });

  test("output is deterministic for the same input + frozen now()", () => {
    const input = base({
      id: 5,
      displayName: "Same",
      firstName: "Same",
      emails: [{ address: "s@s.com", label: "home", isPrimary: false }],
    });
    const a = toVCard(input, { now: FROZEN_NOW });
    const b = toVCard(input, { now: FROZEN_NOW });
    expect(a).toBe(b);
  });

  test("UID embeds the Apple contact id", () => {
    const out = toVCard(base({ id: 12345, displayName: "X" }), { now: FROZEN_NOW });
    expect(out).toContain("UID:apple-contact-12345\r\n");
  });

  test("X-ABRELATEDNAMES entry is emitted with TYPE param and escaped value", () => {
    const out = toVCard(
      base({
        id: 1,
        displayName: "X",
        relatedNames: [{ name: "Bob; Smith", label: "spouse" }],
      }),
      { now: FROZEN_NOW },
    );
    expect(out).toContain("X-ABRELATEDNAMES;TYPE=SPOUSE:Bob\\; Smith\r\n");
  });
});
