import { describe, expect, test } from "bun:test";
import { chooseAttachmentName } from "../src/tasks/notes.ts";

describe("chooseAttachmentName", () => {
  test("returns sanitized base name when nothing is taken", () => {
    const seen = new Set<string>();
    expect(chooseAttachmentName("photo.jpeg", 42, seen)).toBe("photo.jpeg");
    expect(seen.has("photo.jpeg")).toBe(true);
  });

  test("disambiguates a collision by inserting -id before the extension", () => {
    const seen = new Set<string>();
    expect(chooseAttachmentName("Hospital Discharge.jpeg", 100, seen)).toBe(
      "Hospital Discharge.jpeg",
    );
    expect(chooseAttachmentName("Hospital Discharge.jpeg", 200, seen)).toBe(
      "Hospital Discharge-200.jpeg",
    );
  });

  test("disambiguates three identical names with each id", () => {
    const seen = new Set<string>();
    expect(chooseAttachmentName("foo.jpeg", 1, seen)).toBe("foo.jpeg");
    expect(chooseAttachmentName("foo.jpeg", 2, seen)).toBe("foo-2.jpeg");
    expect(chooseAttachmentName("foo.jpeg", 3, seen)).toBe("foo-3.jpeg");
    expect(seen.size).toBe(3);
  });

  test("appends -id when the name has no extension", () => {
    const seen = new Set<string>();
    expect(chooseAttachmentName("README", 1, seen)).toBe("README");
    expect(chooseAttachmentName("README", 2, seen)).toBe("README-2");
  });

  test("treats dot-led names as having no extension after sanitization", () => {
    const seen = new Set<string>();
    expect(chooseAttachmentName(".hidden", 1, seen)).toBe("_hidden");
    expect(chooseAttachmentName(".hidden", 2, seen)).toBe("_hidden-2");
  });

  test("falls back to attachment-id when name is null or empty", () => {
    const seen = new Set<string>();
    expect(chooseAttachmentName(null, 7, seen)).toBe("attachment-7");
    expect(chooseAttachmentName("", 8, seen)).toBe("attachment-8");
    expect(chooseAttachmentName(undefined, 9, seen)).toBe("attachment-9");
  });

  test("falls back to numeric escape hatch when -id name is also already taken", () => {
    const seen = new Set<string>();
    // Earlier attachment happens to literally be named foo-2.jpeg.
    expect(chooseAttachmentName("foo-2.jpeg", 99, seen)).toBe("foo-2.jpeg");
    // First foo.jpeg lands as foo.jpeg.
    expect(chooseAttachmentName("foo.jpeg", 1, seen)).toBe("foo.jpeg");
    // Second foo.jpeg with id=2 would collide with the existing foo-2.jpeg, so
    // the helper falls through to foo-2-2.jpeg.
    expect(chooseAttachmentName("foo.jpeg", 2, seen)).toBe("foo-2-2.jpeg");
  });

  test("produces unique disk paths for repeated identical names (regression for #8)", () => {
    const seen = new Set<string>();
    const names = [
      chooseAttachmentName("Hospital Discharge.jpeg", 1001, seen),
      chooseAttachmentName("Hospital Discharge.jpeg", 1002, seen),
      chooseAttachmentName("Hospital Discharge.jpeg", 1003, seen),
      chooseAttachmentName("Hospital Discharge.jpeg", 1004, seen),
      chooseAttachmentName("Hospital Discharge.jpeg", 1005, seen),
    ];
    expect(new Set(names).size).toBe(5);
  });
});
