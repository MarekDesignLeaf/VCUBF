import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isValidPhoneNumberFormat,
  normalizePhone,
  phoneNumberSchema,
} from "../src/lib/contactNormalization.js";

describe("phone number validation", () => {
  it("accepts UK national numbers and stores them in E.164 format", () => {
    assert.equal(normalizePhone("07700 900123"), "+447700900123");
    assert.equal(phoneNumberSchema.parse("(07700) 900-123"), "+447700900123");
  });

  it("accepts international numbers using their country numbering plan", () => {
    assert.equal(normalizePhone("+420 777 123 456"), "+420777123456");
    assert.equal(normalizePhone("00420 777 123 456"), "+420777123456");
  });

  it("rejects numbers with an impossible country-specific length", () => {
    assert.equal(isValidPhoneNumberFormat("07700 12"), false);
    assert.equal(isValidPhoneNumberFormat("+420 777 123 4567"), false);
    assert.equal(isValidPhoneNumberFormat("123456"), false);
  });

  it("rejects unknown calling codes and non-phone characters", () => {
    assert.equal(normalizePhone("+999 123 456 789"), null);
    assert.equal(normalizePhone("07700 CALLME"), null);
    assert.equal(normalizePhone("++44 7700 900123"), null);
  });
});
