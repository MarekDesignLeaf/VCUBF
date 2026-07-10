import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseTextCommand } from "../src/lib/commandParser.js";

describe("commandParser", () => {
  it("parses 'create client' with email and phone", () => {
    const result = parseTextCommand("create client Jane Smith, email jane@example.com, phone 07700900000");
    assert.equal(result.intent, "create_client");
    if (result.intent === "create_client") {
      assert.equal(result.entities.display_name, "Jane Smith");
      assert.equal(result.entities.email_primary, "jane@example.com");
      assert.equal(result.entities.phone_primary, "07700900000");
    }
  });

  it("parses a bare 'add client' with no extra fields", () => {
    const result = parseTextCommand("add client Bob Jones");
    assert.equal(result.intent, "create_client");
    if (result.intent === "create_client") {
      assert.equal(result.entities.display_name, "Bob Jones");
      assert.equal(result.entities.email_primary, undefined);
    }
  });

  it("parses 'create lead' with a service and email", () => {
    const result = parseTextCommand("new lead Alice Green, email alice@example.com for fencing");
    assert.equal(result.intent, "create_lead");
    if (result.intent === "create_lead") {
      assert.equal(result.entities.name, "Alice Green");
      assert.equal(result.entities.service_requested, "fencing");
      assert.equal(result.entities.email, "alice@example.com");
    }
  });

  it("parses 'create job X for Y'", () => {
    const result = parseTextCommand("create job Hedge trimming for Jane Smith");
    assert.equal(result.intent, "create_job");
    if (result.intent === "create_job") {
      assert.equal(result.entities.job_title, "Hedge trimming");
      assert.equal(result.entities.client_name, "Jane Smith");
    }
  });

  it("parses 'set job X as scheduled'", () => {
    const result = parseTextCommand("set job Hedge trimming as scheduled");
    assert.equal(result.intent, "change_job_status");
    if (result.intent === "change_job_status") {
      assert.equal(result.entities.job_title, "Hedge trimming");
      assert.equal(result.entities.job_status, "scheduled");
    }
  });

  it("parses 'convert lead X'", () => {
    const result = parseTextCommand("convert lead Alice Green");
    assert.equal(result.intent, "convert_lead");
    if (result.intent === "convert_lead") {
      assert.equal(result.entities.lead_name, "Alice Green");
    }
  });

  it("parses list commands", () => {
    assert.equal(parseTextCommand("list clients").intent, "list_clients");
    assert.equal(parseTextCommand("show jobs").intent, "list_jobs");
    assert.equal(parseTextCommand("list leads").intent, "list_leads");
  });

  it("returns unrecognized for gibberish instead of guessing", () => {
    const result = parseTextCommand("please make the weather nicer today");
    assert.equal(result.intent, "unrecognized");
  });
});
