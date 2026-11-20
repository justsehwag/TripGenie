// SERVER-ONLY. Do not import from a "use client" module: this file pulls in the
// AWS SDK and resolves credentials from the default provider chain.
//
// DynamoDB implementation of the account store (account-sync design, "KvStore
// implementation"). Every key includes the owner and no code path issues Scan.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { VersionConflictError, type KvStore } from "../dynamo-store";
import { stripSensitive, type StoredTrip } from "../trip-retention";
import type { TravelerProfile } from "../types";
import { dynamoRegion, profilesTableName, tripsTableName } from "./env";

export const OWNER_UPDATED_INDEX = "owner-updated";
export const PROFILE_RECORD = "PROFILE";
export const PREFS_RECORD = "PREFS";
export const XP_RECORD = "XP";

const BATCH_SIZE = 25;
const MAX_QUERY_PAGES = 50;
const MAX_UNPROCESSED_RETRIES = 3;
const BACKOFF_MS = 50;

export interface AccountStore extends KvStore {
  /** UpdateItem; keeps the original createdAt. */
  upsertTrip(trip: StoredTrip): Promise<void>;
  /** False when a trip with the same key already exists. */
  putTripIfAbsent(trip: StoredTrip): Promise<boolean>;
  /** Keys of the owner's trips, newest first, from the owner-updated index. */
  listTripKeys(owner: string): Promise<{ tripId: string; updatedAt: string }[]>;
  getPreferences(userId: string): Promise<{ data: unknown; version: number } | null>;
  /** Compare-and-swap on `expectedVersion`; returns the new version. */
  putPreferences(userId: string, data: unknown, expectedVersion: number): Promise<{ version: number }>;
  getXp(userId: string): Promise<{ data: unknown; version: number } | null>;
  /** Compare-and-swap on `expectedVersion`; returns the new version. */
  putXp(userId: string, data: unknown, expectedVersion: number): Promise<{ version: number }>;
}

export interface DynamoAccountStoreOptions {
  doc: Pick<DynamoDBDocumentClient, "send">;
  tripsTable: string;
  profilesTable: string;
  /** Defaults to "owner-updated". */
  updatedIndex?: string;
  /** Injectable for tests; defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function errorName(err: unknown): string {
  return typeof err === "object" && err !== null && typeof (err as { name?: unknown }).name === "string"
    ? (err as { name: string }).name
    : "";
}

/** Reads `version` from an item that may be plain or still in DynamoDB attribute-value form. */
function versionFromItem(item: unknown): number | null {
  if (typeof item !== "object" || item === null) return null;
  const v = (item as Record<string, unknown>).version;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "object" && v !== null && typeof (v as { N?: unknown }).N === "string") {
    const n = Number((v as { N: string }).N);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export class DynamoAccountStore implements AccountStore {
  private readonly doc: Pick<DynamoDBDocumentClient, "send">;
  private readonly tripsTable: string;
  private readonly profilesTable: string;
  private readonly updatedIndex: string;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: DynamoAccountStoreOptions) {
    this.doc = opts.doc;
    this.tripsTable = opts.tripsTable;
    this.profilesTable = opts.profilesTable;
    this.updatedIndex = opts.updatedIndex ?? OWNER_UPDATED_INDEX;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  async listTrips(owner: string): Promise<StoredTrip[]> {
    const out: StoredTrip[] = [];
    let startKey: Record<string, unknown> | undefined;
    for (let page = 0; page < MAX_QUERY_PAGES; page++) {
      const res = await this.doc.send(
        new QueryCommand({
          TableName: this.tripsTable,
          KeyConditionExpression: "#o = :o",
          ExpressionAttributeNames: { "#o": "owner" },
          ExpressionAttributeValues: { ":o": owner },
          ConsistentRead: true,
          ExclusiveStartKey: startKey,
        }),
      );
      for (const item of res.Items ?? []) out.push(item as StoredTrip);
      startKey = res.LastEvaluatedKey;
      if (!startKey) break;
    }
    return out;
  }

  async putTrip(trip: StoredTrip): Promise<void> {
    await this.upsertTrip(trip);
  }

  async upsertTrip(trip: StoredTrip): Promise<void> {
    const hasTtl = typeof trip.ttl === "number";
    const values: Record<string, unknown> = {
      ":n": trip.name,
      ":s": trip.status,
      ":d": trip.clientDraftId,
      ":p": stripSensitive(trip.payload),
      ":u": trip.updatedAt,
      ":c": trip.createdAt,
    };
    if (hasTtl) values[":t"] = trip.ttl;
    const update =
      "SET #n = :n, #s = :s, clientDraftId = :d, payload = :p, updatedAt = :u, " +
      "createdAt = if_not_exists(createdAt, :c)" +
      (hasTtl ? ", #ttl = :t" : " REMOVE #ttl");
    await this.doc.send(
      new UpdateCommand({
        TableName: this.tripsTable,
        Key: { owner: trip.owner, tripId: trip.tripId },
        UpdateExpression: update,
        ExpressionAttributeNames: { "#n": "name", "#s": "status", "#ttl": "ttl" },
        ExpressionAttributeValues: values,
      }),
    );
  }

  async putTripIfAbsent(trip: StoredTrip): Promise<boolean> {
    const item: Record<string, unknown> = { ...trip, payload: stripSensitive(trip.payload) };
    if (typeof trip.ttl !== "number") delete item.ttl;
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.tripsTable,
          Item: item,
          ConditionExpression: "attribute_not_exists(tripId)",
        }),
      );
      return true;
    } catch (err) {
      if (errorName(err) === "ConditionalCheckFailedException") return false;
      throw err;
    }
  }

  async listTripKeys(owner: string): Promise<{ tripId: string; updatedAt: string }[]> {
    const out: { tripId: string; updatedAt: string }[] = [];
    let startKey: Record<string, unknown> | undefined;
    for (let page = 0; page < MAX_QUERY_PAGES; page++) {
      const res = await this.doc.send(
        new QueryCommand({
          TableName: this.tripsTable,
          IndexName: this.updatedIndex,
          KeyConditionExpression: "#o = :o",
          ExpressionAttributeNames: { "#o": "owner" },
          ExpressionAttributeValues: { ":o": owner },
          ScanIndexForward: false,
          ExclusiveStartKey: startKey,
        }),
      );
      for (const item of res.Items ?? []) {
        out.push({ tripId: String(item.tripId), updatedAt: String(item.updatedAt) });
      }
      startKey = res.LastEvaluatedKey;
      if (!startKey) break;
    }
    return out;
  }

  async deleteTrips(owner: string, tripIds: string[]): Promise<void> {
    const ids = [...new Set(tripIds)];
    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      let pending: Record<string, unknown>[] = ids
        .slice(i, i + BATCH_SIZE)
        .map((tripId) => ({ DeleteRequest: { Key: { owner, tripId } } }));
      for (let attempt = 0; ; attempt++) {
        const res = await this.doc.send(
          new BatchWriteCommand({ RequestItems: { [this.tripsTable]: pending as never } }),
        );
        const left = res.UnprocessedItems?.[this.tripsTable];
        if (!left || left.length === 0) break;
        if (attempt >= MAX_UNPROCESSED_RETRIES) {
          throw new Error("Batch delete left unprocessed items.");
        }
        pending = left as Record<string, unknown>[];
        await this.sleep(BACKOFF_MS * (attempt + 1));
      }
    }
  }

  async getProfile(userId: string): Promise<TravelerProfile | null> {
    const res = await this.doc.send(
      new GetCommand({
        TableName: this.profilesTable,
        Key: { userId, recordType: PROFILE_RECORD },
        ConsistentRead: true,
      }),
    );
    if (!res.Item) return null;
    const { recordType: _recordType, updatedAt: _updatedAt, ...profile } = res.Item;
    void _recordType;
    void _updatedAt;
    return profile as TravelerProfile;
  }

  async putProfile(profile: TravelerProfile): Promise<void> {
    await this.conditionalPut(
      profile.userId,
      PROFILE_RECORD,
      { ...profile },
      profile.version - 1,
    );
  }

  async getPreferences(userId: string): Promise<{ data: unknown; version: number } | null> {
    const res = await this.doc.send(
      new GetCommand({
        TableName: this.profilesTable,
        Key: { userId, recordType: PREFS_RECORD },
        ConsistentRead: true,
      }),
    );
    if (!res.Item) return null;
    return { data: res.Item.data, version: Number(res.Item.version) || 0 };
  }

  async putPreferences(userId: string, data: unknown, expectedVersion: number): Promise<{ version: number }> {
    const version = expectedVersion + 1;
    await this.conditionalPut(userId, PREFS_RECORD, { userId, data, version }, expectedVersion);
    return { version };
  }

  async getXp(userId: string): Promise<{ data: unknown; version: number } | null> {
    const res = await this.doc.send(
      new GetCommand({
        TableName: this.profilesTable,
        Key: { userId, recordType: XP_RECORD },
        ConsistentRead: true,
      }),
    );
    if (!res.Item) return null;
    return { data: res.Item.data, version: Number(res.Item.version) || 0 };
  }

  async putXp(userId: string, data: unknown, expectedVersion: number): Promise<{ version: number }> {
    const version = expectedVersion + 1;
    await this.conditionalPut(userId, XP_RECORD, { userId, data, version }, expectedVersion);
    return { version };
  }

  /** Put with `attribute_not_exists(userId) OR #v = :prev`; a failed condition becomes VersionConflictError. */
  private async conditionalPut(
    userId: string,
    recordType: string,
    attrs: Record<string, unknown>,
    prevVersion: number,
  ): Promise<void> {
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.profilesTable,
          Item: { ...attrs, userId, recordType, updatedAt: new Date().toISOString() },
          ConditionExpression: "attribute_not_exists(userId) OR #v = :prev",
          ExpressionAttributeNames: { "#v": "version" },
          ExpressionAttributeValues: { ":prev": prevVersion },
          ReturnValuesOnConditionCheckFailure: "ALL_OLD",
        }),
      );
    } catch (err) {
      if (errorName(err) !== "ConditionalCheckFailedException") throw err;
      let current = versionFromItem((err as { Item?: unknown }).Item);
      if (current === null) {
        const res = await this.doc.send(
          new GetCommand({
            TableName: this.profilesTable,
            Key: { userId, recordType },
            ConsistentRead: true,
          }),
        );
        current = versionFromItem(res.Item) ?? 0;
      }
      throw new VersionConflictError(current);
    }
  }
}

/**
 * Builds the SDK document client. Region: TRIPGENIE_DYNAMO_REGION, then
 * AWS_REGION, then us-east-1. Credentials come from the default provider chain
 * only; no access keys are read or passed.
 */
export function createDynamoDocClient(): DynamoDBDocumentClient {
  const region = dynamoRegion() || (process.env.AWS_REGION ?? "").trim() || "us-east-1";
  return DynamoDBDocumentClient.from(new DynamoDBClient({ region, maxAttempts: 3 }), {
    marshallOptions: { removeUndefinedValues: true },
  });
}

/** Builds a store from the environment (table names from env.ts). */
export function createDynamoAccountStore(): DynamoAccountStore {
  return new DynamoAccountStore({
    doc: createDynamoDocClient(),
    tripsTable: tripsTableName(),
    profilesTable: profilesTableName(),
  });
}
