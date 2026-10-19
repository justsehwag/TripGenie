# TripGenie - compute/API deploy (SAM)

Infrastructure-as-Code for the TripGenie Lambda + API Gateway layer. The data
(DynamoDB) and identity (Cognito) resources are already provisioned live in
ap-south-1; this template references them by name/id (see Parameters).

## What this deploys
- HTTP API (API Gateway v2) with a Cognito JWT authorizer bound to pool
  `ap-south-1_zwNRjgYl8` / client `1uitrschuc3inufk423c9534ak`.
- `TripsFunction` (POST/GET /trips) - idempotent save + newest-5 retention.
- `ProfileFunction` (GET/PUT /profile) - version CAS, HTTP 409 on stale.
- `BookFunction` (POST /book) - at-most-once order via conditional put.

Each Lambda role is least-privilege: scoped to only the DynamoDB table(s)
it touches. All functions carry the governance tags (owner/activity/Name/Purpose).

## Prerequisites
- AWS SAM CLI (`sam --version`) and Docker (for `sam build`).
- A shell where the aws CLI and npm run normally (not the degraded session
  used to write these files).
- Lambda creation in this account is governed by `FinOpsTaggingPolicy-Data`:
  every resource must carry lowercase `owner` (@ingrammicro.com) and `activity`
  tags. The template already sets these via Globals.Tags.

## Deploy
```
cd infra
sam build
sam deploy --guided \
  --stack-name tripgenie-api \
  --region ap-south-1 \
  --capabilities CAPABILITY_IAM
```
On `--guided` the first time, accept the defaults; the Parameters already point
at the live table/pool ids. The stack output `ApiBaseUrl` is your API root.

## Using the API
All routes require a Cognito access token:
```
Authorization: Bearer <access_token>
```
Get a token via the hosted UI:
```
https://tripgenie-915233244358.auth.ap-south-1.amazoncognito.com/login?client_id=1uitrschuc3inufk423c9534ak&response_type=code&scope=openid+email+profile&redirect_uri=https://localhost:3000/auth/callback
```

## Notes
- These handlers mirror the tested pure core in `lib/dynamo-store.ts` and
  `lib/booking-store.ts`. They were authored but not executed in the build
  environment; run `sam local invoke` or deploy to a dev stage to verify live.
- No secrets are in this template; the Cognito app client is public (PKCE).
