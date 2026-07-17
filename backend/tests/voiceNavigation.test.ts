import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildCommandUiAction, completedVoiceCommandMessage, openingVoiceLabelMessage, openingVoicePageMessage, resolveVoicePage, voicePageLabel } from "../src/lib/voiceNavigation.js";

describe("voice application navigation", () => {
  it("resolves natural page names without inventing routes", () => {
    assert.equal(resolveVoicePage("the business metrics page"), "metrics");
    assert.equal(resolveVoicePage("my account"), "account");
    assert.equal(resolveVoicePage("Oferty"), "quotes");
    assert.equal(resolveVoicePage("Usługi"), "services");
    assert.equal(resolveVoicePage("Angebote"), "quotes");
    assert.equal(resolveVoicePage("Presupuestos"), "quotes");
    assert.equal(resolveVoicePage("Preventivi"), "quotes");
    assert.equal(resolveVoicePage("Devis"), "quotes");
    assert.equal(resolveVoicePage("somewhere imaginary"), undefined);
  });

  it("uses the selected language for navigation labels and replies", () => {
    assert.equal(voicePageLabel("quotes", "pl-PL"), "Oferty");
    assert.equal(voicePageLabel("services", "pl-PL"), "Usługi");
    assert.equal(openingVoicePageMessage("quotes", "pl-PL"), "Otwieram: Oferty.");
    assert.equal(openingVoiceLabelMessage("Klienti", "cs-CZ"), "Otevírám: Klienti.");
    assert.equal(completedVoiceCommandMessage("cs-CZ"), "Požadavek byl úspěšně dokončen.");
    assert.deepEqual(buildCommandUiAction("navigate", [], { page: "services" }, "pl-PL"), {
      kind: "navigate", path: "/services", label: "Usługi",
    });
  });

  it("opens list views with the filters the user requested", () => {
    assert.deepEqual(buildCommandUiAction("list_contacts", [], {}), {
      kind: "navigate", path: "/contacts", label: "Contacts",
    });
    assert.deepEqual(buildCommandUiAction("list_channel_messages", [], { channel: "whatsapp" }), {
      kind: "navigate", path: "/enquiries?resolution=all&channel=whatsapp", label: "Enquiries",
    });
  });

  it("opens the record produced by a successful business action", () => {
    assert.deepEqual(buildCommandUiAction("create_client", { id: "client-1" }, {}), {
      kind: "navigate", path: "/clients/client-1", label: "Clients",
    });
    assert.deepEqual(buildCommandUiAction("convert_lead", { client: { id: "client-2" } }, {}), {
      kind: "navigate", path: "/clients/client-2", label: "Clients",
    });
  });

  it("opens guided connector setup with the requested target", () => {
    assert.deepEqual(buildCommandUiAction("setup_connectors", {}, { connector_key: "google_contacts" }), {
      kind: "navigate", path: "/connectors?setup=google_contacts", label: "Connectors",
    });
  });

  it("opens a new invoice with the resolved client preselected", () => {
    assert.deepEqual(buildCommandUiAction("execute_action", { clientId: "client-7" }, {
      action: "prepare_invoice_for_client",
    }, "cs-CZ"), {
      kind: "navigate", path: "/invoices?client=client-7", label: "Faktury",
    });
  });
});
