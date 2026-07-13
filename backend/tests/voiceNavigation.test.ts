import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildCommandUiAction, resolveVoicePage } from "../src/lib/voiceNavigation.js";

describe("voice application navigation", () => {
  it("resolves natural page names without inventing routes", () => {
    assert.equal(resolveVoicePage("the business metrics page"), "metrics");
    assert.equal(resolveVoicePage("my account"), "account");
    assert.equal(resolveVoicePage("somewhere imaginary"), undefined);
  });

  it("opens list views with the filters the user requested", () => {
    assert.deepEqual(buildCommandUiAction("list_contacts", [], {}), {
      kind: "navigate", path: "/contacts", label: "Contacts",
    });
    assert.deepEqual(buildCommandUiAction("list_channel_messages", [], { channel: "whatsapp" }), {
      kind: "navigate", path: "/enquiries?resolution=all&channel=whatsapp", label: "WhatsApp Messages",
    });
  });

  it("opens the record produced by a successful business action", () => {
    assert.deepEqual(buildCommandUiAction("create_client", { id: "client-1" }, {}), {
      kind: "navigate", path: "/clients/client-1", label: "Client",
    });
    assert.deepEqual(buildCommandUiAction("convert_lead", { client: { id: "client-2" } }, {}), {
      kind: "navigate", path: "/clients/client-2", label: "Client",
    });
  });
});
