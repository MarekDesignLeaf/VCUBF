import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isValidPhoneNumberFormat,
  normalizePhone,
  phoneNumberSchema,
  withDialledPlus,
} from "../src/lib/contactNormalization.js";

describe("phone number validation", () => {
  it("accepts UK national numbers and stores them in E.164 format", () => {
    assert.equal(normalizePhone("07700 900123"), "+447700900123");
    assert.equal(normalizePhone("+44 7700 900123"), "+447700900123");
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

describe("a number dictated without plus", () => {
  it("gets the plus when it is a valid international number only with it", () => {
    // 11. 10.: a North American number spoken digit by digit.
    assert.equal(withDialledPlus("1 6 7 2 9 1 0 2 1 1 4"), "+16729102114");
    assert.equal(withDialledPlus("420603123456"), "+420603123456");
  });

  it("leaves numbers that are valid as they stand, and the rest, alone", () => {
    assert.equal(withDialledPlus("07700 900123"), "07700 900123");
    assert.equal(withDialledPlus("7700900123"), "7700900123", "a UK number without its 0 stays a UK number");
    assert.equal(withDialledPlus("447700900123"), "447700900123");
    assert.equal(withDialledPlus("+1 672 910 2114"), "+1 672 910 2114");
    assert.equal(withDialledPlus("1234567"), "1234567");
    assert.equal(withDialledPlus("call me"), "call me");
    assert.equal(withDialledPlus(undefined), undefined);
  });
});
