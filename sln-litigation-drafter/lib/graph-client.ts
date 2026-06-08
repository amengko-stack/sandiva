let _cachedToken: { token: string; expiresAt: number } | null = null;

async function getGraphToken(): Promise<string> {
  const now = Date.now();
  if (_cachedToken && _cachedToken.expiresAt > now + 60_000) {
    return _cachedToken.token;
  }

  const tenantId = process.env.AZURE_TENANT_ID!;
  const params = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: process.env.AZURE_CLIENT_ID!,
    client_secret: process.env.AZURE_CLIENT_SECRET!,
    scope: "https://graph.microsoft.com/.default",
  });

  const res = await fetch(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    { method: "POST", body: params }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Azure token error ${res.status}: ${text}`);
  }

  const json = await res.json();
  _cachedToken = {
    token: json.access_token,
    expiresAt: now + json.expires_in * 1000,
  };
  return _cachedToken.token;
}

export async function uploadFileToSharePoint(
  remotePath: string,
  filename: string,
  fileBuffer: Buffer,
  mimeType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
): Promise<string> {
  const token = await getGraphToken();
  const siteId = process.env.SHAREPOINT_SITE_ID!;
  const path = remotePath.endsWith("/") ? remotePath : remotePath + "/";
  const url = `https://graph.microsoft.com/v1.0/sites/${siteId}/drive/root:/${path}${filename}:/content`;

  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": mimeType,
    },
    body: fileBuffer,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Graph upload error ${res.status}: ${text}`);
  }

  const data = await res.json();
  return data.webUrl || "";
}
