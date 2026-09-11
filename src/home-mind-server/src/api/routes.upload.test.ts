import { describe, it, expect } from "vitest";
import { UPLOAD_LIMITS } from "./routes.js";

// GHSA-535w-7cp7-47q4: a crafted multipart field name such as `items[4294967294]`
// makes append-field allocate a maximum-length sparse array, and a second field on
// the same base converts it by walking the whole length — one request and the
// process answers nothing else.
//
// The trap is that upgrading multer does NOT fix this. The option defaults to
// Infinity and is only enforced when the key is present, so a well-meaning cleanup
// that drops it as "redundant" silently reopens the hole. Hence this test.

describe("multipart upload limits", () => {
  it("caps the array index in field names", () => {
    expect(UPLOAD_LIMITS.fieldArrayIndexLimit).toBe(0);
  });

  it("keeps the key present, since multer only enforces what is explicitly set", () => {
    expect(Object.prototype.hasOwnProperty.call(UPLOAD_LIMITS, "fieldArrayIndexLimit")).toBe(true);
  });

  it("still caps the upload size", () => {
    expect(UPLOAD_LIMITS.fileSize).toBe(25 * 1024 * 1024);
  });
});
