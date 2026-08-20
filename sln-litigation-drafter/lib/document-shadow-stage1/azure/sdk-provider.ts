import { DefaultAzureCredential, ManagedIdentityCredential, type TokenCredential } from "@azure/identity";
import { ServiceBusClient } from "@azure/service-bus";
import { BlobServiceClient } from "@azure/storage-blob";
import { CosmosClient } from "@azure/cosmos";
import { AzureServiceBusShadowQueue } from "@/lib/document-shadow-stage1/azure/service-bus";
import { AzureBlobShadowObjectStore } from "@/lib/document-shadow-stage1/azure/blob";
import { AzureCosmosLifecycleStore } from "@/lib/document-shadow-stage1/azure/cosmos";
import type { loadAzureProviderConfig } from "@/lib/document-shadow-stage1/provider-factory";

type AzureProviderConfig = ReturnType<typeof loadAzureProviderConfig>;

interface ClientOverrides {
  credential?: TokenCredential;
  serviceBusClient?: Pick<ServiceBusClient, "createSender" | "createReceiver">;
  blobServiceClient?: Pick<BlobServiceClient, "getContainerClient">;
  cosmosClient?: Pick<CosmosClient, "database">;
}

export function createAzureProviderAdapters(config: AzureProviderConfig, overrides: ClientOverrides = {}) {
  const credential = overrides.credential ?? (config.managedIdentityClientId
    ? new ManagedIdentityCredential({ clientId: config.managedIdentityClientId })
    : new DefaultAzureCredential());
  const serviceBus = overrides.serviceBusClient ?? new ServiceBusClient(config.serviceBusNamespace, credential);
  const blob = overrides.blobServiceClient ?? new BlobServiceClient(config.storageAccountUrl, credential);
  const cosmos = overrides.cosmosClient ?? new CosmosClient({ endpoint: config.cosmosEndpoint, aadCredentials: credential });

  return Object.freeze({
    queue: new AzureServiceBusShadowQueue({
      sender: serviceBus.createSender(config.queueName) as never,
      receiver: serviceBus.createReceiver(config.queueName, { receiveMode: "peekLock" }) as never,
    }),
    store: new AzureBlobShadowObjectStore({
      accountAlias: config.storageAccountAlias,
      containerName: config.containerName,
      containerClient: blob.getContainerClient(config.containerName) as never,
    }),
    lifecycle: new AzureCosmosLifecycleStore({
      container: cosmos.database(config.databaseName).container(config.cosmosContainerName) as never,
    }),
  });
}
