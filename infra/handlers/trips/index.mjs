import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  QueryCommand,
  PutCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.TRIPGENIE_TRIPS_TABLE;
const UPDATED_IDX = process.env.TRIPGENIE_TRIPS_OWNER_UPDATED_INDEX || "owner-updated";
const MAX_RETAINED = 5;

const json = (status, body) => ({
  statusCode: status,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

/** Resolve the stable user id from the Cognito JWT claims (API GW JWT authorizer). */
function ownerFrom(event) {
  const c = event?.requestContext?.authorizer?.jwt?.claims;
  return c && (c.sub || c["cognito:username"]) ? (c.sub || c["cognito:username"]) : null;
}

async function listTrips(owner) {
  const out = await ddb.send(new QueryCommand({
    TableName: TABLE,
    IndexName: UPDATED_IDX,
    KeyConditionExpression: "#o = :o",
    ExpressionAttributeNames: { "#o": "owner" },
    ExpressionAttributeValues: { ":o": owner },
    ScanIndexForward: false,
  }));
  return out.Items || [];
}

export const handler = async (event) => {
  const owner = ownerFrom(event);
  if (!owner) return json(401, { error: "unauthenticated" });
  const method = event.requestContext?.http?.method;

  if (method === "GET") {
    const trips = (await listTrips(owner)).slice(0, MAX_RETAINED);
    return json(200, { trips });
  }

  if (method === "POST") {
    let body = {};
    try { body = event.body ? JSON.parse(event.body) : {}; } catch { return json(400, { error: "invalid json" }); }
    const clientDraftId = String(body.clientDraftId || "").trim();
    if (!clientDraftId) return json(400, { error: "clientDraftId required" });

    // Idempotency: reuse the existing tripId for this (owner, clientDraftId).
    const existing = await listTrips(owner);
    const prior = existing.find((t) => t.clientDraftId === clientDraftId);
    const tripId = prior?.tripId || randomUUID();
    const updatedAt = Date.now();
    const record = {
      owner,
      tripId,
      clientDraftId,
      name: String(body.name || "Trip"),
      payload: body.payload ?? {},
      updatedAt,
    };
    if (body.ttl != null) record.ttl = Number(body.ttl);
    await ddb.send(new PutCommand({ TableName: TABLE, Item: record }));

    // Newest-5 retention: delete anything older than the five most recent.
    const all = await listTrips(owner);
    const older = all.slice(MAX_RETAINED);
    for (const o of older) {
      await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { owner, tripId: o.tripId } }));
    }
    return json(200, { id: tripId, saved: true, updatedAt });
  }

  return json(405, { error: "method not allowed" });
};
