# AI-02 Azure Stage 1 deployment (disabled)

This directory defines the provider resources approved for the disabled Stage 1 adapter PR. It does not activate production shadow traffic.

## Fixed safety state

- Container App scale is `minReplicas: 0`, `maxReplicas: 1`, with no scale rules.
- Publisher, worker, and outbox dispatcher are disabled.
- Sampling is `0` and the kill switch is `true`.
- Service Bus sessions are disabled.
- No production queue binding or credential is included.
- Blob version-level immutability support is enabled, but no production WORM retention policy is created or locked.
- SharePoint remains authoritative; these resources cannot change extraction, cache, OCR, LDD, Litigation, or user-visible output.

## Identity

Runtime authentication is Microsoft Entra only. Local/shared-key authentication is disabled in the resource definitions. Assign separate user-assigned managed identities outside this template after governance approval:

| Identity | Minimum data-plane permission |
| --- | --- |
| Publisher | Service Bus Data Sender; Storage Blob Data Contributor limited to `shadow-input`; Cosmos item create/read |
| Worker | Service Bus Data Receiver; Storage Blob Data Reader limited to exact versions; Cosmos item read/write |
| Outbox dispatcher | Service Bus Data Sender; Cosmos pending-action read/write |
| Operator | DLQ receive/replay only under the operational approval process |

The Vercel publisher may use Entra workload identity federation or a narrowly scoped service principal. Secrets, connection strings, storage keys, Service Bus SAS keys, Cosmos keys, and signed URLs are not configuration inputs to the adapters.

## Network boundary

The template disables public network access on Service Bus, Blob Storage, and Cosmos DB. Private endpoints, private DNS links, and Container Apps VNet integration are environment-owned prerequisites because their subnet and DNS resource IDs are tenant-specific. Do not bind a production publisher until the approved Vercel static-egress or Azure-ingress-gateway pattern is implemented and tested.

## Provider settings

Service Bus queue:

- Premium, peek-lock, deterministic `messageId`, duplicate detection for one day;
- five-minute delivery lock, five deliveries, seven-day TTL, native DLQ;
- no sessions and no production scaler.

Cosmos DB:

- database `sandiva-ai02`, container `shadow-lifecycle`;
- partition key `/tenantKey`, document `id = jobId`, no redundant unique-key policy;
- session consistency; ETag CAS and monotonically increasing fencing tokens;
- lifecycle lease 180 seconds, renewed every 60 seconds.

Blob Storage:

- GPv2 block blobs, OAuth-only, versioning and version-level immutability support;
- exact version ID, byte length, SHA-256, logical account alias and tenant prefix required for reads;
- synthetic/non-production use only until retention and locked WORM receive separate approval.

## Required environment identifiers

```text
DOCUMENT_SHADOW_STAGE1_PROVIDER=azure
DOCUMENT_SHADOW_AZURE_SERVICE_BUS_NAMESPACE=<namespace>.servicebus.windows.net
DOCUMENT_SHADOW_AZURE_SERVICE_BUS_QUEUE=document-shadow-stage1
DOCUMENT_SHADOW_AZURE_STORAGE_ACCOUNT_URL=https://<account>.blob.core.windows.net
DOCUMENT_SHADOW_AZURE_STORAGE_ACCOUNT_ALIAS=<opaque-logical-alias>
DOCUMENT_SHADOW_AZURE_STORAGE_CONTAINER=shadow-input
DOCUMENT_SHADOW_AZURE_COSMOS_ENDPOINT=https://<account>.documents.azure.com:443/
DOCUMENT_SHADOW_AZURE_COSMOS_DATABASE=sandiva-ai02
DOCUMENT_SHADOW_AZURE_COSMOS_CONTAINER=shadow-lifecycle
DOCUMENT_SHADOW_AZURE_MANAGED_IDENTITY_CLIENT_ID=<user-assigned-managed-identity-client-id>
```

The production-disabled values remain:

```text
DOCUMENT_SHADOW_STAGE1_PUBLISHER_ENABLED=false
DOCUMENT_SHADOW_STAGE1_WORKER_ENABLED=false
DOCUMENT_SHADOW_STAGE1_OUTBOX_ENABLED=false
DOCUMENT_SHADOW_STAGE1_SAMPLE_RATE=0
DOCUMENT_SHADOW_STAGE1_KILL_SWITCH=true
DOCUMENT_SHADOW_STAGE1_LEASE_MS=180000
DOCUMENT_SHADOW_STAGE1_LEASE_RENEWAL_MS=60000
```

## Activation gates

Production deployment additionally requires partner approval of region/data residency, cost, retention, WORM locking, identity ownership, private networking, operational ownership, live-data scope, sampling, and rollback authority. Activation must be a separate ADR-014 decision and PR.
