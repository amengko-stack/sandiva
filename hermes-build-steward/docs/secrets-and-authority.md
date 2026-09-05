# Secrets, credentials, and authority

No secret value belongs in source, Build Tasks, prompts, logs, results, synced folders, or this inventory.

| Logical name | Purpose | Required scope | Storage type/location | Rotation | Revocation |
|---|---|---|---|---|---|
| `HermesVmManagedIdentity` | Obtain short-lived Microsoft Graph tokens | Read approved specification/acceptance drive items; read/write only the dedicated Hermes runtime-state list | Azure VM system-assigned or approved user-assigned managed identity; no secret file | Rotate by replacing/rebinding the managed identity and re-granting the narrow resource permissions | Remove the selected permission grant or disable/delete the managed identity |
| `HermesGitHubReadIdentity` | Read designated private repository commit/PR/check evidence if anonymous read is unavailable | Read-only metadata/checks for explicitly designated repositories | Approved GitHub App/workload token broker on the VM; not implemented or provisioned by this build | Rotate in the GitHub App/token broker | Revoke installation or repository grant |
| `VerificationImageDigest` | Pin the approved untrusted-job runtime image | Pull/use one approved image only | Non-secret VM runtime configuration | Approve and deploy a new digest | Remove the digest/image from the VM allowlist/cache |

The production path implemented here uses Azure Instance Metadata Service to mint the Graph token. The token is held only in process memory and is never passed to the container job. A GitHub token provider is injectable for a private repository, but this build neither stores nor provisions one.

The intended Microsoft 365 permission is a resource-specific selected permission narrowed to the approved Control Tower evidence location and the dedicated runtime list. If tenant policy or the selected-permission model cannot narrow writes to that list, that is a qualification issue requiring architecture/security review before production use. Broad tenant write authority is not acceptable merely because it is convenient.

Phase 1 explicitly denies merge, deployment, production-code mutation, specification mutation, Partner Decision resolution, production client-document access, Codex dispatch, and Claude Code dispatch. The container gets none of the trusted coordinator authorities.
