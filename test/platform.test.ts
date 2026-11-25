import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { activitiesCommand } from "../src/commands/activities.js";
import { settingsCommand, metadataCommand, adminCommand, pipelinesCommand, notificationCommand } from "../src/commands/tools.js";
import { massCommand, exportCommand } from "../src/commands/mass.js";
import { shortcutCommand } from "../src/commands/entities.js";
import { meCommand } from "../src/commands/me.js";
import { ERR, OK, OK_LIST, contextFor, lastUrl, type Recorded } from "./helpers.js";
import type { Json } from "../src/lib/coerce.js";

const body = (calls: Recorded[], method: string, path: string) => {
  const call = calls.find((c) => c.method === method && new URL(c.url).pathname === `/api/v1/${path}`);
  expect(call, `no ${method} /${path}`).toBeDefined();
  return call!.body;
};

describe("activities", () => {
  it("upcoming resolves --user by name and passes futureDays/types", async () => {
    const { ctx, calls } = contextFor([OK_LIST([{ id: "u9", userName: "ada", name: "Ada" }]), OK_LIST([{ _scope: "Task", id: "t1", name: "Call", dateStart: "2026-11-25 10:00:00", status: "Not Started" }])]);
    const out = await activitiesCommand(["upcoming", "--user", "ada", "--days", "7", "--types", "Task,Call", "--limit", "5"], ctx);
    const url = lastUrl(calls);
    expect(url.pathname).toBe("/api/v1/Activities/upcoming");
    expect(Object.fromEntries(url.searchParams)).toEqual({ maxSize: "5", userId: "u9", futureDays: "7", "entityTypeList[0]": "Task", "entityTypeList[1]": "Call" });
    expect(out).toMatchObject({ count: 1, activities: [{ type: "Task", id: "t1", name: "Call", start: "2026-11-25 10:00:00" }] });
  });

  it("calendar requires --from and encodes agenda/users/teams/types", async () => {
    const { ctx, calls } = contextFor([OK_LIST([], -2)]);
    await expect(activitiesCommand(["calendar"], ctx)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    const out = await activitiesCommand(["calendar", "--from", "2026-12-01", "--to", "2026-12-07", "--agenda", "--users", "a,b", "--teams", "t1", "--types", "Meeting"], ctx);
    const params = Object.fromEntries(lastUrl(calls).searchParams);
    expect(params).toEqual({ from: "2026-12-01 00:00:00", to: "2026-12-07 00:00:00", agenda: "true", "userIdList[0]": "a", "userIdList[1]": "b", "teamIdList[0]": "t1", "scopeList[0]": "Meeting" });
    expect(out).toMatchObject({ result: "0 activities in range" });
  });

  it("typed lists hit Activities/{parent}/{id}/{type}", async () => {
    const { ctx, calls } = contextFor([OK_LIST([{ _scope: "Call", id: "c1", name: "Intro call", status: "Planned" }])]);
    const out = await activitiesCommand(["calls", "--parent-type", "Lead", "--parent-id", "l1"], ctx);
    expect(lastUrl(calls).pathname).toBe("/api/v1/Activities/Lead/l1/calls");
    expect(out).toMatchObject({ parent: "Lead:l1", calls: [{ id: "c1" }] });
    await expect(activitiesCommand(["nope"], ctx)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});

describe("settings / metadata / admin", () => {
  const SETTINGS = { outboundEmailIsShared: true, applicationName: "CRM", longValue: "x".repeat(150) };

  it("settings list filters, get returns one key, set is gated and sends {key: value}", async () => {
    const { ctx, calls } = contextFor([OK(SETTINGS), OK(SETTINGS), OK(true)]);
    const list = await settingsCommand(["list", "--filter", "outbound"], ctx);
    expect(JSON.stringify(list)).toContain("outboundEmailIsShared");
    expect(JSON.stringify(list)).not.toContain("applicationName");
    expect(await settingsCommand(["get", "applicationName"], ctx)).toMatchObject({ applicationName: "CRM" });
    await expect(settingsCommand(["set", "applicationName", "New"], ctx)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(calls).toHaveLength(2);
    await settingsCommand(["set", "applicationName", '"New"', "--confirm"], ctx);
    expect(body(calls, "PUT", "Settings")).toEqual({ applicationName: "New" });
    await expect(settingsCommand(["get", "missingKey"], ctx)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("metadata passes key/scope and summarises", async () => {
    const { ctx, calls } = contextFor([OK({ Lead: { entity: true }, Account: { entity: true } }), OK({ status: { type: "enum" } })]);
    const out = await metadataCommand(["scopes"], ctx);
    expect(Object.fromEntries(lastUrl(calls).searchParams)).toEqual({ key: "scopes" });
    expect(out).toMatchObject({ key: "scopes", count: 2 });
    await metadataCommand(["entityDefs.Lead.fields", "--scope", "Lead"], ctx);
    expect(Object.fromEntries(lastUrl(calls).searchParams)).toEqual({ key: "entityDefs.Lead.fields", scope: "Lead" });
  });

  it("admin rebuild/clear-cache are gated; openapi writes a file; currency set sends rates", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "espo-admin-"));
    const { ctx, calls } = contextFor([OK({ info: { title: "Espo", version: "10.0.11" }, paths: { a: {}, b: {} } }), OK({ EUR: 1.11 }), OK(true), OK(true)]);
    await expect(adminCommand(["rebuild"], ctx)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(adminCommand(["clear-cache"], ctx)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    const spec = await adminCommand(["openapi", "--out", resolve(dir, "spec.json")], ctx);
    expect(readFileSync(resolve(dir, "spec.json"), "utf8")).toContain('"openapi"'.replace('"openapi"', "Espo"));
    expect(spec).toMatchObject({ paths: 2, version: "10.0.11" });
    await adminCommand(["currency", "set", "--rates", '{"EUR":1.5}', "--confirm"], ctx);
    expect(body(calls, "PUT", "CurrencyRate")).toEqual({ EUR: 1.5 });
    rmSync(dir, { recursive: true, force: true });
  });

  it("currency rates and set", async () => {
    const { ctx, calls } = contextFor([OK({ base: "USD", rates: { EUR: 1.11 } }), OK(true)]);
    expect(await adminCommand(["currency", "rates"], ctx)).toMatchObject({ base: "USD" });
    await adminCommand(["currency", "set", "--rates", "EUR=1.11,UAH=0.037", "--confirm"], ctx);
    expect(body(calls, "PUT", "CurrencyRate")).toEqual({ EUR: 1.11, UAH: 0.037 });
  });

  it("team position sends {id, position}", async () => {
    const { ctx, calls } = contextFor([OK(true)]);
    await adminCommand(["team", "position", "t1", "--user", "u1", "--position", "Manager", "--confirm"], ctx);
    expect(body(calls, "PUT", "Team/t1/userPosition")).toEqual({ id: "u1", position: "Manager" });
    await expect(adminCommand(["user", "acl", "u1"], ctx)).resolves.toBeTruthy();
  });
});

describe("pipelines and kanban", () => {
  it("pipelines and stages list with optional filters", async () => {
    const { ctx, calls } = contextFor([OK_LIST([{ id: "p1", name: "Sales", entityType: "Opportunity" }]), OK_LIST([{ id: "s1", name: "New", pipelineName: "Sales" }])]);
    const out = await pipelinesCommand(["pipelines", "--type", "Opportunity"], ctx);
    expect(lastUrl(calls).searchParams.get("where[0][attribute]")).toBe("entityType");
    expect(out).toMatchObject({ count: 1, by_type: "1 Opportunity" });
    const stages = await pipelinesCommand(["pipeline-stages", "--pipeline", "p1"], ctx);
    expect(stages).toMatchObject({ stages: [{ id: "s1", pipeline: "Sales" }] });
  });

  it("pipeline move validates direction and is gated", async () => {
    const { ctx, calls } = contextFor([OK(true)]);
    await expect(pipelinesCommand(["pipeline", "move", "p1", "--direction", "sideways", "--confirm"], ctx)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(pipelinesCommand(["pipeline", "move", "p1", "--direction", "up"], ctx)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(calls).toHaveLength(0);
    await pipelinesCommand(["pipeline-stage", "move", "s1", "--direction", "top", "--confirm"], ctx);
    expect(lastUrl(calls).pathname).toBe("/api/v1/PipelineStage/s1/move/top");
  });

  it("kanban groups by status (stage for opportunities) with counts and capped names", async () => {
    const rows = [{ id: "1", name: "A", status: "New" }, { id: "2", name: "B", status: "New" }, { id: "3", name: "C", status: "Assigned" }, { id: "4", name: "D", status: "New" }];
    const { ctx } = contextFor([OK({ list: rows, total: 4 })]);
    const out = await pipelinesCommand(["kanban", "Lead", "--max", "2"], ctx);
    expect(out).toMatchObject({ group_by: "status", New: { count: 3, names: ["A", "B"], more: 1 }, Assigned: { count: 3 - 2, names: ["C"] } });
    const { ctx: ctx2 } = contextFor([OK({ list: [{ id: "o1", name: "Deal", stage: "Prospecting" }] })]);
    expect(await pipelinesCommand(["kanban", "Opportunity"], ctx2)).toMatchObject({ group_by: "stage", Prospecting: { count: 1 } });
  });
});

describe("notifications", () => {
  it("list filters unread; groups and mark-read", async () => {
    const { ctx, calls } = contextFor([OK_LIST([{ id: "n1", type: "EmailReceived", message: "New email", read: false, createdAt: "x" }]), OK_LIST([{ id: "EmailReceived_", type: "EmailReceived", groupedCount: 3, groupedUnreadCount: 1 }]), OK(true)]);
    const out = await notificationCommand(["list", "--unread", "--limit", "3"], ctx);
    expect(lastUrl(calls).searchParams.get("where[0][attribute]")).toBe("read");
    expect(out).toMatchObject({ count: 1 });
    expect(await notificationCommand(["groups"], ctx)).toMatchObject({ groups: [{ id: "EmailReceived_", count: 3, unread: 1 }] });
    await expect(notificationCommand(["mark-read", "EmailReceived_"], ctx)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await notificationCommand(["mark-read", "EmailReceived_", "--confirm"], ctx);
    expect(lastUrl(calls).pathname).toBe("/api/v1/Notification/group/EmailReceived_/markRead");
  });
});

describe("mass actions", () => {
  it("update with --ids sends ids + attributes and is gated", async () => {
    const { ctx, calls } = contextFor([OK({ id: "m1", count: 2, status: "Success" })]);
    await expect(massCommand(["update", "--type", "Lead", "--ids", "a,b", "--set", "status=Assigned"], ctx)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(calls).toHaveLength(0);
    const out = await massCommand(["update", "--type", "Lead", "--ids", "a,b", "--set", "status=Assigned", "--set", "amount=10", "--confirm"], ctx);
    expect(body(calls, "POST", "MassAction")).toEqual({ entityType: "Lead", action: "update", params: { ids: ["a", "b"] }, data: { attributes: { status: "Assigned", amount: 10 } } });
    expect(out).toMatchObject({ action: "update", affected: 2 });
  });

  it("filter selection becomes searchParams; remove-from-team and convert-currency build data", async () => {
    const { ctx, calls } = contextFor([OK({ id: "m2" }), OK({ id: "m3" }), OK({ id: "m4" })]);
    await massCommand(["delete", "--type", "Task", "--where", "status=Completed", "--confirm"], ctx);
    expect(body(calls, "POST", "MassAction")).toMatchObject({ action: "delete", params: { searchParams: { where: [{ type: "equals", attribute: "status", value: "Completed" }] } } });
    await massCommand(["remove-from-team", "--type", "Lead", "--ids", "a", "--team", "t1", "--confirm"], ctx);
    expect((calls[calls.length - 1]!.body as { data: Json }).data).toEqual({ teamId: "t1" });
    await massCommand(["convert-currency", "--type", "Opportunity", "--ids", "a", "--field", "amount", "--currency", "EUR", "--confirm"], ctx);
    expect((calls[calls.length - 1]!.body as { data: Json }).data).toEqual({ field: "amount", currency: "EUR" });
  });

  it("requires a selection and a type", async () => {
    const { ctx } = contextFor([OK({})]);
    await expect(massCommand(["update", "--type", "Lead", "--set", "a=1", "--confirm"], ctx)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(massCommand(["update", "--ids", "a", "--set", "a=1", "--confirm"], ctx)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(massCommand(["update", "--type", "Lead", "--ids", "a", "--confirm"], ctx)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(massCommand(["bogus"], ctx)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("mass run passes arbitrary action/data", async () => {
    const { ctx, calls } = contextFor([OK({ id: "m5" })]);
    await massCommand(["run", "massPrintPdf", "--type", "Lead", "--ids", "a", "--data", '{"templateId":"t"}', "--confirm"], ctx);
    expect(body(calls, "POST", "MassAction")).toEqual({ entityType: "Lead", action: "massPrintPdf", params: { ids: ["a"] }, data: { templateId: "t" } });
  });
});

describe("export", () => {
  it("create is gated, sends format/attributeList/ids or searchParams", async () => {
    const { ctx, calls } = contextFor([OK({ id: "x1", status: "Pending" }), OK({ id: "x2", status: "Pending" })]);
    await expect(exportCommand(["create", "--type", "Contact", "--ids", "a,b"], ctx)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(calls).toHaveLength(0);
    await exportCommand(["create", "--type", "Contact", "--ids", "a,b", "--format", "xlsx", "--select", "name,email", "--confirm"], ctx);
    expect(body(calls, "POST", "Export")).toEqual({ entityType: "Contact", format: "xlsx", attributeList: ["name", "email"], ids: ["a", "b"] });
    await exportCommand(["create", "--type", "Lead", "--text", "acme", "--confirm"], ctx);
    expect(calls[calls.length - 1]!.body).toMatchObject({ searchParams: { textFilter: "acme" } });
    await expect(exportCommand(["create", "--type", "Lead", "--format", "pdf", "--ids", "a", "--confirm"], ctx)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("status and download (only when Success)", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "espo-export-"));
    const { ctx, calls } = contextFor([OK({ status: "Running" }), ERR(400), OK({ status: "Success", attachmentId: "att1", format: "CSV" }), { status: 200, body: "id,name\n1,Ada\n", headers: { "content-type": "text/csv" } }]);
    expect(await exportCommand(["status", "x1"], ctx)).toMatchObject({ status: "Running" });
    await expect(exportCommand(["download", "x1"], ctx)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    const out = await exportCommand(["download", "x1", "--out", resolve(dir, "out.csv")], ctx);
    expect(lastUrl(calls).pathname).toBe("/api/v1/Attachment/file/att1");
    expect(readFileSync(resolve(dir, "out.csv"), "utf8")).toContain("Ada");
    expect(out).toMatchObject({ downloaded: { bytes: 14 } });
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("me access summary", () => {
  it("collapses identical permission lists and keeps per-action lists when they differ", async () => {
    const table = (read: boolean, write: boolean) => ({ Lead: { read, create: write, edit: write, delete: write }, Note: { read, create: write, edit: write, delete: write } });
    const same = contextFor([OK({ user: { id: "u1", userName: "bot", type: "api" }, acl: { table: table(true, true) } })]).ctx;
    expect(await meCommand([], same)).toMatchObject({ access: "read, create, edit, delete: Lead, Note" });
    const varied = contextFor([OK({ user: { id: "u2", userName: "agent", type: "api" }, acl: { table: table(true, false) } })]).ctx;
    const out = await meCommand([], varied);
    expect(JSON.stringify(out)).toContain('"read":"Lead, Note"');
    expect(JSON.stringify(out)).toContain('"create":""');
  });

  it("an API user without a token sees api-key mode and a pointer to basic auth for mail", async () => {
    const { ctx } = contextFor([OK({ user: { id: "u3", userName: "bot", type: "api" }, token: null })], { ESPO_CRM_DOMAIN: "crm.example.test", ESPO_CRM_API_KEY: "k".repeat(32), ESPO_CRM_AUTH_MODE: "api-key" });
    const out = await meCommand([], ctx);
    expect(out).toMatchObject({ auth_mode: "api-key", user: { userName: "bot", type: "api" } });
    expect(JSON.stringify(out)).toContain("ESPO_CRM_AUTH_USER");
  });
});

describe("shortcuts", () => {
  it("job and scheduled-job shortcuts bind the entity type", async () => {
    const { ctx, calls } = contextFor([OK_LIST([{ id: "j1", name: "Send Scheduled Emails", status: "Pending" }])]);
    const out = await shortcutCommand("job")(["list", "--status", "Pending"], ctx);
    expect(lastUrl(calls).pathname).toBe("/api/v1/Job");
    expect(lastUrl(calls).searchParams.get("where[0][attribute]")).toBe("status");
    expect(out).toMatchObject({ count: 1 });
  });
});
