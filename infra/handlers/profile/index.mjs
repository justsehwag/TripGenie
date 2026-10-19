import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.TRIPGENIE_PROFILES_TABLE;

const json = (s, b) => ({ statusCode: s, headers: { "content-type": "application/json" }, body: JSON.stringify(b) });

function userFrom(event) {
  const c = event?.requestContext?.authorizer?.jwt?.claims;
  return c && (c.sub || c["cognito:username"]) ? (c.sub || c["cognito:username"]) : null;
}

export const handler = async (event) => {
  const userId = userFrom(event);
  if (!userId) return json(401, { error: "unauthenticated" });
  const method = event.requestContext?.http?.method;

  if (method === "GET") {
    const out = await ddb.send(new GetCommand({ TableName: TABLE, Key: { userId } }));
    if (!out.Item) return json(404, { error: "not found" });
    return json(200, out.Item);
  }

  if (method === "PUT") {
    let body = {};
    try { body = event.body ? JSON.parse(event.body) : {}; } catch { return json(400, { error: "invalid json" }); }
    const expectedVersion = Number(body.expectedVersion);
    if (!Number.isInteger(expectedVersion)) return json(400, { error: "expectedVersion required" });
    const changes = body.changes && typeof body.changes === "object" ? body.changes : {};

    const current = (await ddb.send(new GetCommand({ TableName: TABLE, Key: { userId } }))).Item;
    const currentVersion = current?.version ?? 0;
    if (current && currentVersion !== expectedVersion) return json(409, { error: "version conflict", currentVersion });
    if (!current && expectedVersion !== 0) return json(409, { error: "version conflict", currentVersion: 0 });
    delete changes.userId; delete changes.version;
    const next = { ...(current || {}), ...changes, userId, version: currentVersion + 1 };
    try {
      await ddb.send(new PutCommand({
        TableName: TABLE,
        Item: next,
        ConditionExpression: current ? "attribute_exists(userId) AND #v = :ev" : "attribute_not_exists(userId)",
        ExpressionAttributeNames: current ? { "#v": "version" } : undefined,
        ExpressionAttributeValues: current ? { ":ev": expectedVersion } : undefined,
      }));
    } catch (e) {
      if (e?.name === "ConditionalCheckFailedException") return json(409, { error: "version conflict" });
      throw e;
    }
    return json(200, next);
  }

  return json(405, { error: "method not allowed" });
};
