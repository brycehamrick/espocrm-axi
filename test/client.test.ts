import { describe, expect, it } from "vitest";
import { AxiError } from "axi-sdk-js";
import { resolveConfig } from "../src/lib/env.js";
import { parseDotEnv } from "../src/lib/dotenv.js";
import { encodeListParams, parseWhereClause, parseWhereJson, WhereError } from "../src/lib/where.js";
import { normalizeEspoTime, toEspoDateTime, htmlToText } from "../src/lib/time.js";
import { parseScalar, parseAssignments } from "../src/lib/args.js";
import { ERR, OK, OK_LIST, TEST_CONFIG, TEST_ENV, clientFor, lastUrl } from "./helpers.js";

describe("env", () => {
  it("normalizes bare hostnames and strips trailing slashes", () => {
    expect(resolveConfig({ ...TEST_ENV, ESPO_CRM_DOMAIN: "crm.example.com/" }).domain).toBe("https://crm.example.com");
    expect(resolveConfig({ ...TEST_ENV, ESPO_CRM_DOMAIN: "https://host/crm/" }).domain).toBe("https://host/crm");
  });

  it("allows http only for loopback and rejects credentials in the domain", () => {
    expect(resolveConfig({ ...TEST_ENV, ESPO_CRM_DOMAIN: "http://localhost:8080" }).domain).toBe("http://localhost:8080");
    expect(() => resolveConfig({ ...TEST_ENV, ESPO_CRM_DOMAIN: "http://crm.example.com" })).toThrow(/https/);
    expect(() => resolveConfig({ ...TEST_ENV, ESPO_CRM_DOMAIN: "https://user:pw@crm.example.com" })).toThrow(/credentials/);
  });

  it("picks the auth mode automatically from the username and accepts hermes aliases", () => {
    expect(resolveConfig({ ESPO_CRM_DOMAIN: "a.test", ESPO_CRM_API_KEY: "k" }).authMode).toBe("api-key");
    expect(resolveConfig({ ESPO_CRM_DOMAIN: "a.test", ESPO_CRM_API_KEY: "k", ESPO_CRM_AUTH_USER: "ada" }).authMode).toBe("basic");
    expect(resolveConfig({ ESPO_CRM_DOMAIN: "a.test", ESPO_CRM_API_KEY: "k", ESPO_CRM_AUTH_MODE: "api-key", ESPO_CRM_AUTH_USER: "ada" }).authMode).toBe("api-key");
    expect(() => resolveConfig({ ESPO_CRM_DOMAIN: "a.test", ESPO_CRM_API_KEY: "k", ESPO_CRM_AUTH_MODE: "weird" })).toThrow(/AUTH_MODE must be one of/);
  });

  it(".env parser keeps real env vars ahead of file values and only copies ESPO_CRM_* keys", () => {
    const parsed = parseDotEnv('export ESPO_CRM_DOMAIN="crm.example.com"\nOTHER=x\nESPO_CRM_API_KEY=abc # trailing\n# comment\n');
    expect(parsed).toEqual({ ESPO_CRM_DOMAIN: "crm.example.com", ESPO_CRM_API_KEY: "abc # trailing" });
  });
});

describe("client auth", () => {
  it("sends X-Api-Key in api-key mode and builds the v1 URL", async () => {
    const { client, calls } = clientFor([OK({ id: "1" })], { ESPO_CRM_DOMAIN: "crm.example.com", ESPO_CRM_API_KEY: "k" });
    await client.request("GET", "Lead", { query: { maxSize: 2, skip: undefined } });
    const url = lastUrl(calls);
    expect(url.toString()).toBe("https://crm.example.com/api/v1/Lead?maxSize=2");
    expect(calls[0]!.headers["x-api-key"]).toBe("k");
    expect(calls[0]!.headers["authorization"]).toBeUndefined();
    expect(calls[0]!.headers["user-agent"]).toMatch(/espocrm-axi/);
  });

  it("sends Basic user:token in basic mode", async () => {
    const { client, calls } = clientFor([OK({})]);
    await client.request("GET", "App/user");
    expect(calls[0]!.headers["authorization"]).toBe(`Basic ${Buffer.from("ada:kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk").toString("base64")}`);
  });

  it("signs HMAC as base64(key:hex(hmac(method + ' ' + resourcePath)))", async () => {
    const { client, calls } = clientFor([OK({})], { ESPO_CRM_DOMAIN: "crm.example.com", ESPO_CRM_API_KEY: "key1", ESPO_CRM_AUTH_MODE: "hmac", ESPO_CRM_SECRET_KEY: "s3cret" });
    await client.request("GET", "Lead/abc");
    const { createHmac } = await import("node:crypto");
    const expected = Buffer.from(`key1:${createHmac("sha256", "s3cret").update("GET /Lead/abc").digest("hex")}`).toString("base64");
    expect(calls[0]!.headers["x-hmac-authorization"]).toBe(expected);
  });

  it("bootstraps a fresh token on 401 in basic mode when a password is configured, then retries once", async () => {
    const { client, calls } = clientFor([ERR(401), OK({ token: "fresh-token" }), OK({ id: "1" })]);
    const result = await client.request("GET", "Lead/1");
    expect(result).toEqual({ id: "1" });
    expect(calls).toHaveLength(3);
    expect(calls[1]!.url).toBe("https://crm.example.test/api/v1/App/user");
    expect(calls[1]!.headers["espo-authorization"]).toBe(Buffer.from("ada:pw-secret-123").toString("base64"));
    expect(calls[2]!.headers["authorization"]).toBe(`Basic ${Buffer.from("ada:fresh-token").toString("base64")}`);
    expect(client.auth.refreshed).toBe(true);
  });

  it("fails with AUTH_REQUIRED guidance when the token is stale and no password is set", async () => {
    const { client } = clientFor([ERR(401)], { ESPO_CRM_DOMAIN: "crm.example.com", ESPO_CRM_API_KEY: "k", ESPO_CRM_USERNAME: "ada" });
    await expect(client.request("GET", "Lead")).rejects.toMatchObject({ code: "AUTH_REQUIRED", message: expect.stringContaining("ESPO_CRM_PASSWORD") });
  });
});

describe("client errors", () => {
  it("maps X-Status-Reason to structured errors with exit-2 validation codes for 400", async () => {
    const { client } = clientFor([ERR(400, "Empty To address.")]);
    await expect(client.request("POST", "Email", { body: {} })).rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("Empty To address.") });
  });

  it("treats sendingFail bodies ({id,message}) as a kept-Draft failure", async () => {
    const { client } = clientFor([ERR(500, undefined, JSON.stringify({ id: "e1", message: "SMTP connection refused" }))]);
    await expect(client.request("POST", "Email", { body: {} })).rejects.toMatchObject({ code: "API_ERROR", message: expect.stringContaining("SMTP connection refused") });
  });

  it("redacts the api key from network error text", async () => {
    const { client } = clientFor([ERR(500, "bad key kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk")]);
    const error = await client.request("GET", "Lead").catch((e: unknown) => e as AxiError);
    expect((error as AxiError).message).not.toContain("k".repeat(32));
  });

  it("maps 404 / 403 / 409", async () => {
    const { client } = clientFor([ERR(404), ERR(403, "No access"), ERR(409, "Record is locked")]);
    await expect(client.request("GET", "Lead/nope")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(client.request("GET", "Lead/nope")).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    await expect(client.request("PUT", "Lead/nope", { body: {} })).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("client lists and the WAF fallback", () => {
  it("encodes list params with bracket-style where and select", async () => {
    const { client, calls } = clientFor([OK_LIST([{ id: "1" }], 7)]);
    const result = await client.list("Lead", { maxSize: 5, offset: 10, select: ["id", "name"], where: [{ type: "equals", attribute: "status", value: "New" }], orderBy: "createdAt", order: "desc", textFilter: "acme" });
    expect(result).toEqual({ list: [{ id: "1" }], total: 7 });
    const url = lastUrl(calls);
    expect(url.pathname).toBe("/api/v1/Lead");
    expect(url.searchParams.get("where[0][type]")).toBe("equals");
    expect(url.searchParams.get("where[0][attribute]")).toBe("status");
    expect(url.searchParams.get("where[0][value]")).toBe("New");
    expect(url.searchParams.get("select")).toBe("id,name");
    expect(url.searchParams.get("q")).toBe("acme");
  });

  it("retries once with the whereGroup alias on an empty-body 500 and remembers it", async () => {
    const { client, calls } = clientFor([ERR(500), OK_LIST([{ id: "1" }], -1), OK_LIST([{ id: "2" }], -2)]);
    const where = { type: "inFolder", attribute: "folderId", value: "inbox" } as const;
    await client.list("Email", { maxSize: 1, where: [where] });
    await client.list("Email", { maxSize: 1, where: [where] });
    expect(calls[0]!.url).toContain("where%5B0%5D%5Btype%5D=inFolder");
    expect(calls[1]!.url).toContain("whereGroup%5B0%5D%5Btype%5D=inFolder");
    expect(calls[2]!.url).toContain("whereGroup");
    expect(client.auth.whereStyle).toBe("whereGroup");
  });

  it("does not retry when the where style is pinned", async () => {
    const { client, calls } = clientFor([ERR(500)], { ...TEST_ENV, ESPO_CRM_WHERE_STYLE: "where" });
    await expect(client.list("Email", { where: [{ type: "equals", attribute: "status", value: "Sent" }] })).rejects.toBeInstanceOf(AxiError);
    expect(calls).toHaveLength(1);
  });
});

describe("where DSL", () => {
  it("parses operators, null, booleans, lists, and OR groups", () => {
    expect(parseWhereClause("status=New")).toEqual([{ type: "equals", attribute: "status", value: "New" }]);
    expect(parseWhereClause("amount>1000")).toEqual([{ type: "greaterThan", attribute: "amount", value: 1000 }]);
    expect(parseWhereClause("name~=Brighten")).toEqual([{ type: "contains", attribute: "name", value: "Brighten" }]);
    expect(parseWhereClause("assignedUserId=null")).toEqual([{ type: "isNull", attribute: "assignedUserId" }]);
    expect(parseWhereClause("assignedUserId!=null")).toEqual([{ type: "isNotNull", attribute: "assignedUserId" }]);
    expect(parseWhereClause("doNotCall=true")).toEqual([{ type: "isTrue", attribute: "doNotCall" }]);
    expect(parseWhereClause("status=in:New,Assigned")).toEqual([{ type: "in", attribute: "status", value: ["New", "Assigned"] }]);
    expect(parseWhereClause("teams=linkedWith:abc")).toEqual([{ type: "linkedWith", attribute: "teams", value: ["abc"] }]);
    expect(parseWhereClause("createdAt=lastXDays:7")).toEqual([{ type: "lastXDays", attribute: "createdAt", value: 7 }]);
    expect(parseWhereClause("a=1 OR b=2")).toEqual([{ type: "or", value: [
      { type: "equals", attribute: "a", value: 1 },
      { type: "equals", attribute: "b", value: 2 },
    ] }]);
    expect(() => parseWhereClause("status New")).toThrow(WhereError);
    expect(() => parseWhereJson("{bad")).toThrow(WhereError);
  });

  it("encodes nested groups and array values", () => {
    const q = encodeListParams({ where: [{ type: "or", value: [{ type: "equals", attribute: "a", value: 1 }] }, { type: "in", attribute: "s", value: ["x", "y"] }] }, "where");
    expect(q.get("where[0][value][0][type]")).toBe("equals");
    expect(q.get("where[1][value][0]")).toBe("x");
    expect(q.get("where[1][value][1]")).toBe("y");
  });
});

describe("time and scalars", () => {
  it("converts human datetimes to EspoCRM UTC format", () => {
    const now = new Date("2026-11-24T10:00:00Z");
    expect(toEspoDateTime("2026-11-01", now)).toBe("2026-11-01 00:00:00");
    expect(toEspoDateTime("2026-11-01T08:30:00Z", now)).toBe("2026-11-01 08:30:00");
    expect(toEspoDateTime("2026-11-01T08:30:00+02:00", now)).toBe("2026-11-01 06:30:00");
    expect(toEspoDateTime("7d", now)).toBe("2026-11-17 10:00:00");
    expect(toEspoDateTime("90m", now)).toBe("2026-11-24 08:30:00");
    expect(toEspoDateTime("today", now)).toBe("2026-11-24 00:00:00");
    expect(() => toEspoDateTime("next tuesday", now)).toThrow();
    expect(normalizeEspoTime("2026-05-14 01:41:01")).toBe("2026-05-14T01:41:01");
    expect(normalizeEspoTime("2026-05-14T01:41:01+00:00")).toBe("2026-05-14T01:41:01");
  });

  it("strips HTML to readable text", () => {
    expect(htmlToText("<p>Hi <b>Ada</b>,<br>line two</p><style>x{}</style>")).toBe("Hi Ada,\nline two");
  });

  it("parses scalars and assignments", () => {
    expect(parseScalar("1000")).toBe(1000);
    expect(parseScalar("true")).toBe(true);
    expect(parseScalar("null")).toBeNull();
    expect(parseScalar('["a","b"]')).toEqual(["a", "b"]);
    expect(parseScalar("New")).toBe("New");
    expect(parseAssignments({ set: ["amount=1000", "name=Acme, Inc."] }, "set")).toEqual({ amount: 1000, name: "Acme, Inc." });
  });

  it("exposes a resolved test config", () => {
    expect(TEST_CONFIG.authMode).toBe("basic");
  });
});
