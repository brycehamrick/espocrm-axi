/**
 * Search-parameter helpers for list endpoints.
 *
 * EspoCRM accepts `where[i][type|attribute|value]` bracket params. Some
 * WAFs (notably Cloudflare in front of EspoCRM) false-positive on those and
 * answer 500; v9.0 added the `whereGroup` alias for exactly that reason. The
 * client encodes whichever style is configured/auto-detected.
 */
export function isWhereGroup(item) {
    return (item.type === "or" || item.type === "and") && Array.isArray(item.value);
}
export class WhereError extends Error {
}
const OPERATORS = {
    "=": "equals",
    "!=": "notEquals",
    ">": "greaterThan",
    ">=": "greaterThanOrEquals",
    "<": "lessThan",
    "<=": "lessThanOrEquals",
    "~=": "contains",
    "^=": "startsWith",
    "$=": "endsWith",
};
const DATED_OPERATORS = new Set([
    "today",
    "past",
    "future",
    "lastSevenDays",
    "currentMonth",
    "lastMonth",
    "nextMonth",
    "currentQuarter",
    "lastQuarter",
    "currentYear",
    "lastYear",
    "currentFiscalYear",
    "lastFiscalYear",
    "currentFiscalQuarter",
    "lastFiscalQuarter",
    "lastXDays",
    "nextXDays",
    "olderThanXDays",
    "afterXDays",
]);
/**
 * Compact where DSL, one clause per flag use:
 *   status=New            equals            status!=New        notEquals
 *   amount>1000           greaterThan       (>=, <, <= likewise)
 *   name~=Brighten        contains          ^= startsWith, $= endsWith
 *   assignedUserId=null   isNull            !=null             isNotNull
 *   doNotCall=true        isTrue / isFalse
 *   status=in:New,Assigned                   in / notIn
 *   teams=linkedWith:<id>                    linkedWith / notLinkedWith / linkedWithAll
 *   amount=between:100,200                   between
 *   name=like:%text%                         like / notLike
 *   createdAt=lastXDays:7                    dated operators (today, past, lastSevenDays, ...)
 *   a=1 OR b=2                               OR group (AND is the default between clauses)
 * Use --where-json for nested groups and anything else.
 */
export function parseWhereClause(clause) {
    const text = clause.trim();
    if (text.length === 0)
        return [];
    const or = text.split(/\s+OR\s+/i);
    if (or.length > 1) {
        return [{ type: "or", value: or.flatMap((part) => parseWhereClause(part)) }];
    }
    const match = /^([A-Za-z0-9_.]+)\s*(!=|>=|<=|~=|\^=|\$=|=|>|<)\s*([\s\S]*)$/.exec(text);
    if (!match) {
        throw new WhereError(`where clause must look like attribute=value, got: ${clause}`);
    }
    const attribute = match[1];
    const operator = match[2];
    const raw = (match[3] ?? "").trim();
    if (operator === "!=" && raw === "null")
        return [{ type: "isNotNull", attribute }];
    if (operator === "=" && raw === "null")
        return [{ type: "isNull", attribute }];
    if (operator === "=" && raw === "true")
        return [{ type: "isTrue", attribute }];
    if (operator === "=" && raw === "false")
        return [{ type: "isFalse", attribute }];
    if (operator === "=") {
        const special = /^([a-zA-Z]+):([\s\S]*)$/.exec(raw);
        if (special) {
            const kind = special[1];
            const rest = special[2] ?? "";
            if (kind === "in" || kind === "notIn")
                return [{ type: kind, attribute, value: splitEscaped(rest) }];
            if (kind === "linkedWith" || kind === "linkedWithAll" || kind === "notLinkedWith") {
                return [{ type: kind, attribute, value: splitEscaped(rest) }];
            }
            if (kind === "arrayAnyOf" || kind === "arrayNoneOf" || kind === "arrayAllOf") {
                return [{ type: kind, attribute, value: splitEscaped(rest) }];
            }
            if (kind === "between") {
                return [{ type: "between", attribute, value: splitEscaped(rest).map((v) => (typeof v === "number" ? v : String(v))) }];
            }
            if (kind === "like" || kind === "notLike")
                return [{ type: kind, attribute, value: rest }];
            if (DATED_OPERATORS.has(kind)) {
                const n = Number(rest);
                return [{ type: kind, attribute, ...(rest !== "" && Number.isFinite(n) ? { value: n } : {}) }];
            }
        }
    }
    return [{ type: OPERATORS[operator] ?? operator, attribute, value: coerce(raw) }];
}
function splitEscaped(text) {
    return text
        .split(/(?<!\\),/)
        .map((part) => part.trim().replace(/\\,/g, ","))
        .filter((part) => part.length > 0);
}
function coerce(text) {
    const t = text.trim();
    if (/^-?\d+(\.\d+)?$/.test(t))
        return Number(t);
    if (t === "true")
        return true;
    if (t === "false")
        return false;
    if (t === "null")
        return null;
    return t;
}
export function parseWhereJson(raw) {
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        throw new WhereError("--where-json must be valid JSON");
    }
    const items = Array.isArray(parsed) ? parsed : [parsed];
    return items.map((item) => {
        if (typeof item !== "object" ||
            item === null ||
            Array.isArray(item) ||
            typeof item.type !== "string") {
            throw new WhereError('--where-json items must be objects like {"type":"equals","attribute":"status","value":"New"}');
        }
        return item;
    });
}
function encodeValue(params, prefix, value) {
    if (Array.isArray(value)) {
        value.forEach((item, i) => params.set(`${prefix}[${i}]`, String(item)));
        return;
    }
    params.set(prefix, String(value));
}
function encodeItem(q, key, item) {
    q.set(`${key}[type]`, item.type);
    if (isWhereGroup(item)) {
        item.value.forEach((nested, j) => encodeItem(q, `${key}[value][${j}]`, nested));
        return;
    }
    if (item.attribute)
        q.set(`${key}[attribute]`, item.attribute);
    if (item.value !== undefined)
        encodeValue(q, `${key}[value]`, item.value);
    if (item.dateTime)
        q.set(`${key}[dateTime]`, "true");
    if (item.timeZone)
        q.set(`${key}[timeZone]`, item.timeZone);
}
export function encodeListParams(params, whereStyle) {
    const q = new URLSearchParams();
    if (params.maxSize !== undefined)
        q.set("maxSize", String(params.maxSize));
    if (params.offset !== undefined)
        q.set("offset", String(params.offset));
    if (params.select && params.select.length > 0)
        q.set("select", params.select.join(","));
    if (params.orderBy)
        q.set("orderBy", params.orderBy);
    if (params.order)
        q.set("order", params.order);
    if (params.primaryFilter)
        q.set("primaryFilter", params.primaryFilter);
    for (const [i, name] of (params.boolFilterList ?? []).entries())
        q.set(`boolFilterList[${i}]`, name);
    if (params.textFilter)
        q.set("q", params.textFilter);
    (params.where ?? []).forEach((item, i) => encodeItem(q, `${whereStyle}[${i}]`, item));
    return q;
}
