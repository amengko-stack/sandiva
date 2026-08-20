const SECRET_KEYS = ["AZURE_STORAGE_CONNECTION_STRING", "DOCUMENT_SHADOW_AZURE_SERVICE_BUS_CONNECTION_STRING",
  "DOCUMENT_SHADOW_AZURE_COSMOS_KEY", "DOCUMENT_SHADOW_AZURE_STORAGE_KEY", "DOCUMENT_SHADOW_AZURE_SAS"];
const REQUIRED = ["DOCUMENT_SHADOW_AZURE_SERVICE_BUS_NAMESPACE", "DOCUMENT_SHADOW_AZURE_SERVICE_BUS_QUEUE",
  "DOCUMENT_SHADOW_AZURE_STORAGE_ACCOUNT_URL", "DOCUMENT_SHADOW_AZURE_STORAGE_ACCOUNT_ALIAS",
  "DOCUMENT_SHADOW_AZURE_STORAGE_CONTAINER", "DOCUMENT_SHADOW_AZURE_COSMOS_ENDPOINT",
  "DOCUMENT_SHADOW_AZURE_COSMOS_DATABASE", "DOCUMENT_SHADOW_AZURE_COSMOS_CONTAINER"];

export function loadAzureProviderConfig(environment: Record<string, string | undefined>) {
  if (SECRET_KEYS.some((key) => environment[key])) throw new Error("shadow_azure_secret_configuration_forbidden");
  if (REQUIRED.some((key) => !environment[key])) throw new Error("shadow_azure_configuration_incomplete");
  return Object.freeze({ enabled: true, authentication: "entra" as const,
    serviceBusNamespace: environment.DOCUMENT_SHADOW_AZURE_SERVICE_BUS_NAMESPACE!,
    queueName: environment.DOCUMENT_SHADOW_AZURE_SERVICE_BUS_QUEUE!, storageAccountUrl: environment.DOCUMENT_SHADOW_AZURE_STORAGE_ACCOUNT_URL!,
    storageAccountAlias: environment.DOCUMENT_SHADOW_AZURE_STORAGE_ACCOUNT_ALIAS!, containerName: environment.DOCUMENT_SHADOW_AZURE_STORAGE_CONTAINER!,
    cosmosEndpoint: environment.DOCUMENT_SHADOW_AZURE_COSMOS_ENDPOINT!, databaseName: environment.DOCUMENT_SHADOW_AZURE_COSMOS_DATABASE!,
    cosmosContainerName: environment.DOCUMENT_SHADOW_AZURE_COSMOS_CONTAINER!, managedIdentityClientId: environment.DOCUMENT_SHADOW_AZURE_MANAGED_IDENTITY_CLIENT_ID });
}

export function selectStage1Providers(environment: Record<string, string | undefined>) {
  if (environment.DOCUMENT_SHADOW_STAGE1_PROVIDER !== "azure") return { provider: "memory" as const, enabled: false };
  return { provider: "azure" as const, enabled: false, config: loadAzureProviderConfig(environment) };
}
