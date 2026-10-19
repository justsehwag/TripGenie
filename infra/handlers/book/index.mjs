import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.TRIPGENIE_TRIPS_TABLE;

const json = (s, b) => ({ statusCode: s, headers: { "content-type": "application/json" }, body: JSON.stringify(b) });

function ownerFrom(event) {
  const c = event?.requestContext?.authorizer?.jwt?.claims;
  return c && (c.sub || c["cognito:username"]) ? (c.sub || c["cognito:username"]) : null;
}

/** At-most-once order: a conditional put keyed on the idempotency token wins
 * once; duplicates read back the same order and never place a second. */
export const handler = async (event) => {
  const owner = ownerFrom(event);
  if (!owner) return json(401, { error: "unauthenticated" });
  let body = {};
  try { body = event.body ? JSON.parse(event.body) : {}; } catch { return json(400, { error: "invalid json" }); }
  const key = String(body.idempotencyKey || "").trim();
  if (!key) return json(400, { error: "idempotencyKey required" });

  const tripId = `order#${key}`;
  const orderId = randomUUID();
  try {
    await ddb.send(new PutCommand({
      TableName: TABLE,
      Item: {
        owner,
        tripId,
        orderId,
        kind: "order",
        createdAt: Date.now(),
      },
      ConditionExpression: "attribute_not_exists(tripId)",
    }));
    return json(200, { orderId, deduped: false });
  } catch (e) {
    if (e?.name === "ConditionalCheckFailedException") {
      // Duplicate: return the already-placed order.
      const existing = await ddb.send(new GetCommand({ TableName: TABLE, Key: { owner, tripId } }));
      return json(200, { orderId: existing.Item?.orderId || orderId, deduped: true });
    }
    throw e;
  }
};
