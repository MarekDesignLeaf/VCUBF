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
    assert.equal(parseTextCommand("show contacts").intent, "list_contacts");
    assert.deepEqual(parseTextCommand("read my emails"), { intent: "list_channel_messages", entities: { channel: "email" } });
    assert.deepEqual(parseTextCommand("show whatsapp messages"), { intent: "list_channel_messages", entities: { channel: "whatsapp" } });
    assert.equal(parseTextCommand("show jobs").intent, "list_jobs");
    assert.equal(parseTextCommand("list leads").intent, "list_leads");
  });

  it("parses direct navigation across the Secretary hierarchy", () => {
    assert.deepEqual(parseTextCommand("open dashboard"), { intent: "navigate", entities: { page: "dashboard" } });
    assert.deepEqual(parseTextCommand("go to invoices"), { intent: "navigate", entities: { page: "invoices" } });
    assert.deepEqual(parseTextCommand("take me to communication intake"), { intent: "navigate", entities: { page: "communication_intake" } });
    assert.deepEqual(parseTextCommand("show me business metrics"), { intent: "navigate", entities: { page: "metrics" } });
  });

  it("parses 'assign job X to Y'", () => {
    const result = parseTextCommand("assign job Hedge trimming to Test Worker");
    assert.equal(result.intent, "assign_job");
    if (result.intent === "assign_job") {
      assert.equal(result.entities.job_title, "Hedge trimming");
      assert.equal(result.entities.employee_name, "Test Worker");
    }
  });

  it("parses 'show overload'", () => {
    assert.equal(parseTextCommand("show overload").intent, "detect_overload");
    assert.equal(parseTextCommand("check overload").intent, "detect_overload");
  });

  it("parses unresolved enquiry commands with an optional evidence window", () => {
    const all = parseTextCommand("show unresolved enquiries");
    assert.equal(all.intent, "list_unresolved_enquiries");
    if (all.intent === "list_unresolved_enquiries") assert.equal(all.entities.since_days, undefined);

    const week = parseTextCommand("check unresolved enquiries from the last week");
    assert.equal(week.intent, "list_unresolved_enquiries");
    if (week.intent === "list_unresolved_enquiries") assert.equal(week.entities.since_days, 7);

    const days = parseTextCommand("find unresolved enquiries in last 3 days");
    assert.equal(days.intent, "list_unresolved_enquiries");
    if (days.intent === "list_unresolved_enquiries") assert.equal(days.entities.since_days, 3);
  });

  it("parses task creation and listing commands", () => {
    const assigned = parseTextCommand("create task for Test Worker: Prepare materials");
    assert.equal(assigned.intent, "create_task");
    if (assigned.intent === "create_task") {
      assert.equal(assigned.entities.title, "Prepare materials");
      assert.equal(assigned.entities.employee_name, "Test Worker");
    }

    const dated = parseTextCommand(
      "create task Send quote, assigned to Test Admin, due 2027-01-04T09:00:00.000Z"
    );
    assert.equal(dated.intent, "create_task");
    if (dated.intent === "create_task") {
      assert.equal(dated.entities.title, "Send quote");
      assert.equal(dated.entities.employee_name, "Test Admin");
      assert.equal(dated.entities.due_at, "2027-01-04T09:00:00.000Z");
    }
    assert.equal(parseTextCommand("list tasks").intent, "list_tasks");
  });

  it("parses 'create service X, category Y'", () => {
    const result = parseTextCommand("create service Fence repair, category Fencing");
    assert.equal(result.intent, "create_service");
    if (result.intent === "create_service") {
      assert.equal(result.entities.name, "Fence repair");
      assert.equal(result.entities.category, "Fencing");
    }
  });

  it("parses a bare 'create service X' with no category", () => {
    const result = parseTextCommand("create service Hedge trim");
    assert.equal(result.intent, "create_service");
    if (result.intent === "create_service") {
      assert.equal(result.entities.name, "Hedge trim");
      assert.equal(result.entities.category, undefined);
    }
  });

  it("parses 'list quotes' and 'list quotes for X'", () => {
    const bare = parseTextCommand("list quotes");
    assert.equal(bare.intent, "list_quotes");
    if (bare.intent === "list_quotes") assert.equal(bare.entities.client_name, undefined);

    const scoped = parseTextCommand("show quotes for Quote Test Client");
    assert.equal(scoped.intent, "list_quotes");
    if (scoped.intent === "list_quotes") assert.equal(scoped.entities.client_name, "Quote Test Client");
  });

  it("parses 'list job openings'", () => {
    const result = parseTextCommand("list job openings");
    assert.equal(result.intent, "list_job_openings");
    assert.equal(parseTextCommand("show job opening").intent, "list_job_openings");
  });

  it("parses 'when I say X I mean Y' and 'teach me X means Y'", () => {
    const r1 = parseTextCommand("when I say old client I mean a client from the last two years");
    assert.equal(r1.intent, "create_learning_rule");
    if (r1.intent === "create_learning_rule") {
      assert.equal(r1.entities.term, "old client");
      assert.equal(r1.entities.meaning, "a client from the last two years");
    }

    const r2 = parseTextCommand("teach me: Riverside means Riverside Apartments Ltd");
    assert.equal(r2.intent, "create_learning_rule");
    if (r2.intent === "create_learning_rule") {
      assert.equal(r2.entities.term, "Riverside");
      assert.equal(r2.entities.meaning, "Riverside Apartments Ltd");
    }
  });

  it("parses 'list learning rules'", () => {
    assert.equal(parseTextCommand("list learning rules").intent, "list_learning_rules");
    assert.equal(parseTextCommand("show learning rule").intent, "list_learning_rules");
  });

  it("returns unrecognized for gibberish instead of guessing", () => {
    const result = parseTextCommand("please make the weather nicer today");
    assert.equal(result.intent, "unrecognized");
  });
});
