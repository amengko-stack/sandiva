targetScope = 'resourceGroup'

@description('Non-production Azure region. Production deployment requires a separate approval.')
param location string = resourceGroup().location
@minLength(1)
@maxLength(22)
param prefix string = 'sandiva-ai02-nonprod'
@description('Image is supplied only to create an inert Container App definition.')
param workerImage string
param containerAppsEnvironmentId string
param workerManagedIdentityResourceId string

var serviceBusNamespaceName = '${prefix}-servicebus'

resource serviceBus 'Microsoft.ServiceBus/namespaces@2024-01-01' = {
  name: serviceBusNamespaceName
  location: location
  sku: { name: 'Premium', tier: 'Premium', capacity: 1 }
  properties: {
    disableLocalAuth: true
    publicNetworkAccess: 'Disabled'
    minimumTlsVersion: '1.2'
  }
}

resource queue 'Microsoft.ServiceBus/namespaces/queues@2024-01-01' = {
  parent: serviceBus
  name: 'document-shadow-stage1'
  properties: {
    lockDuration: 'PT5M'
    requiresDuplicateDetection: true
    duplicateDetectionHistoryTimeWindow: 'P1D'
    requiresSession: false
    defaultMessageTimeToLive: 'P7D'
    deadLetteringOnMessageExpiration: true
    maxDeliveryCount: 5
    enablePartitioning: false
  }
}

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: replace('${prefix}st', '-', '')
  location: location
  sku: { name: 'Standard_GRS' }
  kind: 'StorageV2'
  properties: {
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    supportsHttpsTrafficOnly: true
    minimumTlsVersion: 'TLS1_2'
    publicNetworkAccess: 'Disabled'
    defaultToOAuthAuthentication: true
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    isVersioningEnabled: true
    deleteRetentionPolicy: { enabled: true, days: 14 }
    containerDeleteRetentionPolicy: { enabled: true, days: 14 }
  }
}

resource inputContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'shadow-input'
  properties: {
    publicAccess: 'None'
    immutableStorageWithVersioning: { enabled: true }
  }
}

resource cosmos 'Microsoft.DocumentDB/databaseAccounts@2024-05-15' = {
  name: '${prefix}-cosmos'
  location: location
  kind: 'GlobalDocumentDB'
  properties: {
    databaseAccountOfferType: 'Standard'
    disableLocalAuth: true
    publicNetworkAccess: 'Disabled'
    locations: [{ locationName: location, failoverPriority: 0, isZoneRedundant: false }]
    consistencyPolicy: { defaultConsistencyLevel: 'Session' }
  }
}

resource database 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases@2024-05-15' = {
  parent: cosmos
  name: 'sandiva-ai02'
  properties: { resource: { id: 'sandiva-ai02' } }
}

resource lifecycle 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-05-15' = {
  parent: database
  name: 'shadow-lifecycle'
  properties: {
    resource: {
      id: 'shadow-lifecycle'
      partitionKey: { paths: ['/tenantKey'], kind: 'Hash', version: 2 }
      defaultTtl: -1
    }
  }
}

resource worker 'Microsoft.App/containerApps@2024-03-01' = {
  name: '${prefix}-worker'
  location: location
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${workerManagedIdentityResourceId}': {} } }
  properties: {
    managedEnvironmentId: containerAppsEnvironmentId
    configuration: { activeRevisionsMode: 'Single', ingress: null }
    template: {
      containers: [{
        name: 'document-shadow-worker'
        image: workerImage
        env: [
          { name: 'DOCUMENT_SHADOW_STAGE1_PUBLISHER_ENABLED', value: 'false' }
          { name: 'DOCUMENT_SHADOW_STAGE1_WORKER_ENABLED', value: 'false' }
          { name: 'DOCUMENT_SHADOW_STAGE1_OUTBOX_ENABLED', value: 'false' }
          { name: 'DOCUMENT_SHADOW_STAGE1_SAMPLE_RATE', value: '0' }
          { name: 'DOCUMENT_SHADOW_STAGE1_KILL_SWITCH', value: 'true' }
          { name: 'DOCUMENT_SHADOW_STAGE1_LEASE_MS', value: '180000' }
          { name: 'DOCUMENT_SHADOW_STAGE1_LEASE_RENEWAL_MS', value: '60000' }
          { name: 'DOCUMENT_SHADOW_STAGE1_RETENTION_MS', value: '1209600000' }
        ]
      }]
      scale: {
        minReplicas: 0
        maxReplicas: 1
        rules: []
      }
    }
  }
}

output serviceBusNamespaceId string = serviceBus.id
output queueId string = queue.id
output storageAccountId string = storage.id
output cosmosAccountId string = cosmos.id
output workerId string = worker.id
