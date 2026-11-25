import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { AxiError } from "axi-sdk-js";
import { emailCommand, buildBody, normalizeAddress, replySubject, splitAddresses } from "../src/commands/email.js";
import { ERR, OK, OK_LIST, contextFor, lastUrl, type Recorded } from "./helpers.js";

const SENT = { id: "e1", status: "Sent", dateSent: "2026-11-24 10:00:00", name: "Hi" };
const USER = OK({ user: { id: "u1", userName: "ada", emailAddress: "ada@example.com" }, token: "t" });

async function run(args: string[], script = [USER, OK(SENT)]) {
  const { ctx, calls } = contextFor(script);
  const output = await emailCommand(args, ctx);
  return { output, calls };
}

function postBody(calls: Recorded[], path: string): Record<string, unknown> {
  const call = calls.find((c) => c.method === "POST" && new URL(c.url).pathname.endsWith(path));
  expect(call, `no POST to ${path}`).toBeDefined();
  return call!.body as Record<string, unknown>;
}

describe("email send", () => {
  it("creates status=Sending records and reports delivery when the server stamps dateSent", async () => {
    const { output, calls } = await run(["send", "--to", "Ada <ada@example.com>, bob@example.com", "--subject", "Hi", "--text", "Hello", "--confirm"]);
    expect(postBody(calls, "/Email")).toMatchObject({ status: "Sending", from: "ada@example.com", to: "ada@example.com, bob@example.com", name: "Hi", body: "Hello", isHtml: false, bodyPlain: "Hello" });
    expect(calls).toHaveLength(2);
    expect(output).toMatchObject({ sent: { id: "e1", delivered: true, status: "Sent", waited_seconds: 0, to: "ada@example.com, bob@example.com" } });
  });

  it("gates before any network call", async () => {
    const { ctx, calls } = contextFor([USER]);
    const error = await emailCommand(["send", "--to", "ada@example.com", "--subject", "Hi", "--text", "x"], ctx).catch((e: unknown) => e as AxiError);
    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.message).toContain("--confirm");
    expect(calls).toHaveLength(0);
  });

  it("requires recipients, a subject, and exactly one content source", async () => {
    const { ctx } = contextFor([USER]);
    await expect(emailCommand(["send", "--subject", "Hi", "--text", "x", "--confirm"], ctx)).rejects.toMatchObject({ message: expect.stringContaining("--to") });
    await expect(emailCommand(["send", "--to", "ada@example.com", "--text", "x", "--confirm"], ctx)).rejects.toMatchObject({ message: expect.stringContaining("--subject") });
    await expect(emailCommand(["send", "--to", "ada@example.com", "--subject", "Hi", "--confirm"], ctx)).rejects.toMatchObject({ message: expect.stringContaining("content") });
    await expect(emailCommand(["send", "--to", "ada@example.com", "--subject", "Hi", "--text", "x", "--html", "<b>x</b>", "--confirm"], ctx)).rejects.toMatchObject({ message: expect.stringContaining("exactly one") });
    await expect(emailCommand(["send", "--to", "not-an-email", "--subject", "Hi", "--text", "x", "--confirm"], ctx)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("passes --from through and uses html mode with attachments and teams", async () => {
    const { calls } = await run([
      "send", "--to", "ada@example.com", "--subject", "Hi", "--html", "<p>Hello</p>", "--from", "Team <team@example.com>", "--attach-id", "a1,a2", "--teams", "t1,t2", "--parent-type", "Lead", "--parent-id", "l1", "--confirm",
    ], [OK(SENT)]);
    expect(postBody(calls, "/Email")).toMatchObject({ from: "team@example.com", isHtml: true, body: "<p>Hello</p>", attachmentsIds: ["a1", "a2"], teamsIds: ["t1", "t2"], parentType: "Lead", parentId: "l1" });
    expect(postBody(calls, "/Email")["bodyPlain"]).toBeUndefined();
  });

  it("polls until dateSent appears when the create response is still Sending", async () => {
    const { output, calls } = await run(["send", "--to", "ada@example.com", "--subject", "Hi", "--text", "x", "--from", "ada@example.com", "--wait", "1", "--confirm"], [OK({ id: "e1", status: "Sending" }), OK({ id: "e1", status: "Sent", dateSent: "2026-11-24 10:00:01" })]);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.method).toBe("GET");
    expect(output).toMatchObject({ sent: { delivered: true, waited_seconds: 1 } });
  });

  it("reports NOT delivered when the record stays in Draft or Sending", async () => {
    const { output } = await run(["send", "--to", "ada@example.com", "--subject", "Hi", "--text", "x", "--from", "ada@example.com", "--wait", "0", "--confirm"], [OK({ id: "e1", status: "Draft" })]);
    expect(output).toMatchObject({ sent: { delivered: false, status: "Draft" } });
    expect(JSON.stringify(output)).toContain("NOT sent");
  });

  it("--dry-run resolves from/attachments and sends nothing (no gate, no upload, no POST)", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "espo-dry-"));
    writeFileSync(resolve(dir, "a.txt"), "hello");
    const { output, calls } = await run(["send", "--to", "ada@example.com", "--subject", "Hi", "--text", "x", "--attach", resolve(dir, "a.txt"), "--dry-run"], [USER]);
    expect(calls).toHaveLength(1); // only App/user for the default --from
    expect(new URL(calls[0]!.url).pathname).toBe("/api/v1/App/user");
    expect(output).toMatchObject({ dry_run: { would: "send", status: "Sending", from: "ada@example.com", to: "ada@example.com", body: "x" } });
    expect(JSON.stringify(output)).toContain("would upload a.txt");
    rmSync(dir, { recursive: true, force: true });
    const draft = await run(["draft", "--to", "ada@example.com", "--text", "x", "--dry-run"], [USER]);
    expect(draft.output).toMatchObject({ dry_run: { would: "create draft", status: "Draft" } });
    expect(draft.calls).toHaveLength(1);
  });

  it("reply --dry-run shows the derived reply without sending", async () => {
    const original = { id: "in1", name: "Pitch idea", fromAddress: "jane@example.com", replyToAddress: "noreply@example.com", parentType: "Lead", parentId: "l1" };
    const { output, calls } = await run(["reply", "in1", "--text", "x", "--dry-run"], [OK_LIST([original], 1), USER]);
    expect(calls.some((c) => c.method === "POST" && new URL(c.url).pathname === "/api/v1/Email")).toBe(false);
    expect(output).toMatchObject({ dry_run: { would: "send", to: "noreply@example.com", name: "Re: Pitch idea", repliedId: "in1", parentType: "Lead" } });
  });

  it("creating a draft never sends and links attachments", async () => {
    const { output, calls } = await run(["draft", "--to", "ada@example.com", "--subject", "Later", "--text", "x", "--confirm"], [USER, OK({ id: "d1", status: "Draft" })]);
    expect(postBody(calls, "/Email")).toMatchObject({ status: "Draft", from: "ada@example.com" });
    expect(output).toMatchObject({ draft: { id: "d1", status: "Draft" } });
    expect(calls).toHaveLength(2);
  });

  it("sending an existing draft PUTs status=Sending and verifies", async () => {
    const { calls, output } = await run(["send", "d1", "--wait", "0", "--confirm"], [OK(SENT)]);
    const put = calls.find((c) => c.method === "PUT")!;
    expect(new URL(put.url).pathname).toBe("/api/v1/Email/d1");
    expect(put.body).toEqual({ status: "Sending" });
    expect(output).toMatchObject({ sent: { id: "d1", delivered: true } });
  });

  it("schedules a draft with sendAt in UTC", async () => {
    const { calls } = await run(["schedule", "d1", "--at", "2026-12-01 09:00", "--confirm"], [OK({ id: "d1", status: "Draft", sendAt: "2026-12-01 09:00:00" })]);
    expect(calls[0]!.body).toEqual({ status: "Draft", sendAt: "2026-12-01 09:00:00" });
  });
});

describe("email reply", () => {
  const ORIGINAL = { id: "in1", name: "Pitch idea", fromAddress: "jane@example.com", replyToAddress: "noreply@example.com", parentType: "Lead", parentId: "l1", ccEmailAddressesNames: { a: "cc@example.com" } };

  it("derives to/subject/parent and threads via repliedId", async () => {
    const { calls, output } = await run(["reply", "in1", "--text", "Thanks!", "--confirm"], [OK_LIST([ORIGINAL], 1), USER, OK({ ...SENT, name: "Re: Pitch idea" })]);
    expect(lastUrl(calls.slice(0, 1)).searchParams.get("where[0][attribute]")).toBe("id");
    const body = postBody(calls, "/Email");
    expect(body).toMatchObject({ status: "Sending", to: "noreply@example.com", name: "Re: Pitch idea", repliedId: "in1", parentType: "Lead", parentId: "l1" });
    expect(output).toMatchObject({ sent: { thread: "in1 -> e1" } });
  });

  it("replies inside a group folder default --from to that group's mailbox address", async () => {
    const GROUP_ORIGINAL = { ...ORIGINAL, groupFolderId: "gf1", groupFolderName: "Collabs" };
    const { calls, output } = await run(["reply", "in1", "--text", "x", "--confirm"], [OK_LIST([GROUP_ORIGINAL], 1), OK_LIST([{ id: "mb1", emailAddress: "collabs@example.com" }]), OK(SENT)]);
    expect(new URL(calls[1]!.url).pathname).toBe("/api/v1/InboundEmail");
    expect(new URL(calls[1]!.url).searchParams.get("where[0][value]")).toBe("gf1");
    expect(postBody(calls, "/Email").from).toBe("collabs@example.com");
    expect(output).toMatchObject({ sent: { from: "collabs@example.com" } });
  });

  it("--all copies original cc, explicit --to/--subject win", async () => {
    const { calls } = await run(["reply", "in1", "--text", "x", "--all", "--to", "zed@example.com", "--subject", "Custom", "--confirm"], [OK_LIST([ORIGINAL], 1), USER, OK(SENT)]);
    expect(postBody(calls, "/Email")).toMatchObject({ to: "zed@example.com", cc: "cc@example.com", name: "Custom" });
  });

  it("replySubject helper", () => {
    expect(replySubject("Pitch idea")).toBe("Re: Pitch idea");
    expect(replySubject("Re: Pitch idea")).toBe("Re: Pitch idea");
    expect(replySubject(undefined)).toBe("Re: (no subject)");
  });
});

describe("email helpers", () => {
  it("normalizes addresses", () => {
    expect(normalizeAddress("Ada Lovelace <Ada@Example.com>")).toBe("ada@example.com");
    expect(() => normalizeAddress("nope")).toThrow();
    expect(splitAddresses("a@b.com, c@d.com;e@f.com")).toEqual(["a@b.com", "c@d.com", "e@f.com"]);
  });

  it("builds html and plain bodies with signatures", () => {
    expect(buildBody({ html: "<p>Hi</p>", signatureFile: undefined })).toEqual({ body: "<p>Hi</p>", isHtml: true });
    expect(buildBody({ text: "Hi\nthere" })).toEqual({ body: "Hi\nthere", bodyPlain: "Hi\nthere", isHtml: false });
  });
});

describe("mailbox state", () => {
  it("read/unread/important/trash post or delete the inbox endpoints with ids", async () => {
    const { calls, output } = await run(["read", "e1", "e2"]);
    expect(calls[0]!.method).toBe("POST");
    expect(new URL(calls[0]!.url).pathname).toBe("/api/v1/Email/inbox/read");
    expect(calls[0]!.body).toEqual({ ids: ["e1", "e2"] });
    expect(output).toMatchObject({ read: { count: 2 } });

    const unread = await run(["unread", "e1"]);
    expect(unread.calls[0]!.method).toBe("DELETE");
    expect(new URL(unread.calls[0]!.url).pathname).toBe("/api/v1/Email/inbox/read");
    expect(new URL((await run(["trash", "e1"])).calls[0]!.url).pathname).toBe("/api/v1/Email/inbox/inTrash");
    expect((await run(["untrash", "e1"])).calls[0]!.method).toBe("DELETE");
    expect(new URL((await run(["important", "e1"])).calls[0]!.url).pathname).toBe("/api/v1/Email/inbox/important");
    expect(new URL((await run(["unimportant", "e1"])).calls[0]!.url).pathname).toBe("/api/v1/Email/inbox/important");
  });

  it("read --all marks the whole inbox", async () => {
    const { calls } = await run(["read", "--all"]);
    expect(calls[0]!.body).toEqual({ all: true });
  });

  it("requires ids", async () => {
    const { ctx } = contextFor([OK(true)]);
    await expect(emailCommand(["read"], ctx)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("archive/unarchive/move use the special folder ids", async () => {
    const { calls } = await run(["archive", "e1"]);
    expect(new URL(calls[0]!.url).pathname).toBe("/api/v1/Email/inbox/folders/archive");
    expect(new URL((await run(["unarchive", "e1"])).calls[0]!.url).pathname).toBe("/api/v1/Email/inbox/folders/inbox");
    expect(new URL((await run(["move", "e1", "--folder", "group:abc"])).calls[0]!.url).pathname).toBe("/api/v1/Email/inbox/folders/group%3Aabc");
  });
});

describe("email lists", () => {
  it("inbox uses inFolder, adds isRead=false for --unread, and reports unread counts", async () => {
    const { calls, output } = await run(["inbox", "--unread", "--limit", "2"], [OK_LIST([{ id: "e1", name: "Hi", fromEmailAddressName: "a@b.com", dateSent: "2026-11-24 10:00:00", isRead: false }], -1), OK({ inbox: 3 })]);
    const url = lastUrl(calls.slice(0, 1));
    expect(url.searchParams.get("where[0][type]")).toBe("inFolder");
    expect(url.searchParams.get("where[0][value]")).toBe("inbox");
    expect(url.searchParams.get("where[1][type]")).toBe("isFalse");
    expect(url.searchParams.get("where[1][attribute]")).toBe("isRead");
    expect(output).toMatchObject({ folder: "inbox", count: 1, more: true, unread_inbox: 3 });
  });

  it("sent shows recipients; folders fail loud with no auth", async () => {
    const { output } = await run(["sent"], [OK_LIST([{ id: "e1", name: "Hi", toEmailAddressesNames: { x: "a@b.com" }, status: "Sent", dateSent: "x" }], -2)]);
    expect(JSON.stringify(output)).toContain('"to":"a@b.com"');
    expect(output).not.toHaveProperty("more");
  });

  it("definitive empty state", async () => {
    const { output } = await run(["drafts"], [OK_LIST([], -2)]);
    expect(output).toMatchObject({ count: 0, result: "0 emails in drafts" });
  });

  it("folders combine personal, group, and unread counts with their filter ids", async () => {
    const { output } = await run(["folders"], [OK_LIST([{ id: "f1", name: "Clients" }]), OK_LIST([{ id: "g1", name: "PR" }]), OK({ inbox: 2, "group:g1": 5 })]);
    expect(output).toMatchObject({ unread_inbox: 2, personal_folders: [{ id: "f1", name: "Clients" }], group_folders: [{ id: "g1", name: "PR", unread: 5, filter: "group:g1" }] });
  });

  it("email folder <name> lists a group folder via inFolder=group:<id>; personal folders use the id", async () => {
    const group = OK_LIST([{ id: "g1", name: "Collabs" }]);
    const personal = OK_LIST([{ id: "p1", name: "Later" }]);
    const { calls, output } = await run(["folder", "collabs", "--unread", "--limit", "5"], [group, personal, OK_LIST([{ id: "e1", name: "Hi", fromEmailAddressName: "a@b.com", isRead: false }], -1)]);
    const url = lastUrl(calls.slice(0, 3));
    expect(url.searchParams.get("where[0][type]")).toBe("inFolder");
    expect(url.searchParams.get("where[0][value]")).toBe("group:g1");
    expect(url.searchParams.get("where[1][value]") ?? url.searchParams.get("where[1][attribute]")).toBe("isRead");
    expect(output).toMatchObject({ folder: "Collabs", count: 1 });

    const second = await run(["folder", "later"], [group, personal, OK_LIST([{ id: "e2", name: "x", fromEmailAddressName: "a@b.com" }], -2)]);
    expect(lastUrl(second.calls.slice(0, 3)).searchParams.get("where[0][value]")).toBe("p1");
    expect(second.output).toMatchObject({ folder: "Later" });

    const { ctx } = contextFor([group, personal]);
    const error = await emailCommand(["folder", "nope"], ctx).catch((e: unknown) => e as AxiError);
    expect(error.code).toBe("NOT_FOUND");
    expect(error.message).toContain('no folder named "nope"');
    expect(error.suggestions.join(" ")).toContain("Collabs (group:g1)");
    expect(error.suggestions.join(" ")).toContain("Later (p1)");
  });

  it("accounts redact passwords", async () => {
    const { output } = await run(["accounts", "--full"], [OK_LIST([{ id: "a1", name: "ada", smtpPassword: "hunter2", status: "Active", emailAddress: "ada@example.com" }])]);
    expect(JSON.stringify(output)).not.toContain("hunter2");
    expect(JSON.stringify(output)).toContain("<redacted>");
  });

  it("get renders headers and truncates the body unless --full", async () => {
    const long = "x".repeat(2000);
    const { output: short } = await run(["get", "e1"], [OK({ id: "e1", name: "Hi", status: "Archived", fromString: "Jane <jane@example.com>", toEmailAddressesNames: { a: "ada@example.com" }, body: `<p>${long}</p>`, bodyPlain: long, dateSent: "2026-11-24 10:00:00" })]);
    expect(JSON.stringify(short)).toContain("use --full");
    const { output: full } = await run(["get", "e1", "--full"], [OK({ id: "e1", name: "Hi", bodyPlain: long })]);
    expect(JSON.stringify(full)).toContain(long);
  });

  it("surfaces server errors (404) as NOT_FOUND", async () => {
    const { ctx } = contextFor([ERR(404)]);
    await expect(emailCommand(["get", "nope"], ctx)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
