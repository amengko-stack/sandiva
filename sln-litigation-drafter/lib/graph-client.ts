import { Client } from "@microsoft/microsoft-graph-client";
import { TokenCredentialAuthenticationProvider } from "@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials/index.js";
import { ClientSecretCredential } from "@azure/identity";

let _client: Client | null = null;

function getGraphClient(): Client {
  if (_client) return _client;

  const credential = new ClientSecretCredential(
    process.env.AZURE_TENANT_ID!,
    process.env.AZURE_CLIENT_ID!,
    process.env.AZURE_CLIENT_SECRET!
  );

  const authProvider = new TokenCredentialAuthenticationProvider(credential, {
    scopes: ["https://graph.microsoft.com/.default"],
  });

  _client = Client.initWithMiddleware({ authProvider });
  return _client;
}

export async function uploadFileToSharePoint(
  remotePath: string,
  filename: string,
  fileBuffer: Buffer,
  mimeType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
): Promise<string> {
  const client = getGraphClient();
  const siteId = process.env.SHAREPOINT_SITE_ID!;

  const path = remotePath.endsWith("/") ? remotePath : remotePath + "/";
  const endpoint = `/sites/${siteId}/drive/root:/${path}${filename}:/content`;

  const response = await client
    .api(endpoint)
    .header("Content-Type", mimeType)
    .put(fileBuffer);

  return response.webUrl || "";
}
