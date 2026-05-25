// ============================================================
// PQI Viewer — Azure Container Apps deployment
// ============================================================
// Resources created:
//   - Resource Group (via deploy script)
//   - Log Analytics Workspace
//   - Container Apps Environment
//   - Azure Container Registry (ACR)
//   - Container App (pqi-viewer)
//   - Azure Storage Account + File Share (persistent SQLite)
// ============================================================

@description('Azure region for all resources')
param location string = 'norwayeast'

@description('Base name used for all resources, e.g. pqiviewer')
@minLength(3)
@maxLength(16)
param appName string = 'pqiviewer'

@description('Container image tag to deploy')
param imageTag string = 'latest'

@description('Your Docker Hub username OR leave empty to use ACR')
param dockerHubUser string = ''

// ── Derived names ────────────────────────────────────────────
var acrName         = '${appName}acr${uniqueString(resourceGroup().id)}'
var logName         = '${appName}-logs'
var envName         = '${appName}-env'
var storageName     = '${appName}st${uniqueString(resourceGroup().id)}'
var shareName       = 'pqi-data'
var appContainerName = 'pqi-viewer'
var useAcr          = empty(dockerHubUser)
var imageName       = useAcr
  ? '${acrName}.azurecr.io/pqi-viewer:${imageTag}'
  : '${dockerHubUser}/pqi-viewer:${imageTag}'

// ── Log Analytics ─────────────────────────────────────────────
resource logWorkspace 'Microsoft.OperationalInsights/workspaces@2022-10-01' = {
  name: logName
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

// ── Azure Container Registry ──────────────────────────────────
resource acr 'Microsoft.ContainerRegistry/registries@2023-01-01-preview' = if (useAcr) {
  name: acrName
  location: location
  sku: { name: 'Basic' }
  properties: {
    adminUserEnabled: true   // needed for Container Apps pull
  }
}

// ── Storage Account + File Share (persistent SQLite volume) ───
resource storageAccount 'Microsoft.Storage/storageAccounts@2023-01-01' = {
  name: storageName
  location: location
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
  }
}

resource fileService 'Microsoft.Storage/storageAccounts/fileServices@2023-01-01' = {
  parent: storageAccount
  name: 'default'
}

resource fileShare 'Microsoft.Storage/storageAccounts/fileServices/shares@2023-01-01' = {
  parent: fileService
  name: shareName
  properties: { shareQuota: 1 }  // 1 GiB — plenty for SQLite
}

// ── Container Apps Environment ────────────────────────────────
resource containerEnv 'Microsoft.App/managedEnvironments@2023-05-01' = {
  name: envName
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logWorkspace.properties.customerId
        sharedKey: logWorkspace.listKeys().primarySharedKey
      }
    }
  }
}

// Attach the Azure Files share to the environment
resource envStorage 'Microsoft.App/managedEnvironments/storages@2023-05-01' = {
  parent: containerEnv
  name: 'pqi-data-storage'
  properties: {
    azureFile: {
      accountName: storageAccount.name
      accountKey: storageAccount.listKeys().keys[0].value
      shareName: shareName
      accessMode: 'ReadWrite'
    }
  }
}

// ── Container App ─────────────────────────────────────────────
resource containerApp 'Microsoft.App/containerApps@2023-05-01' = {
  name: appContainerName
  location: location
  properties: {
    environmentId: containerEnv.id
    configuration: {
      ingress: {
        external: true          // public HTTPS endpoint
        targetPort: 8080
        transport: 'auto'
      }
      registries: useAcr ? [
        {
          server: '${acrName}.azurecr.io'
          username: acr.listCredentials().username
          passwordSecretRef: 'acr-password'
        }
      ] : []
      secrets: useAcr ? [
        {
          name: 'acr-password'
          value: acr.listCredentials().passwords[0].value
        }
      ] : []
    }
    template: {
      containers: [
        {
          name: appContainerName
          image: imageName
          resources: {
            cpu: json('0.5')    // 0.5 vCPU
            memory: '1Gi'
          }
          volumeMounts: [
            {
              volumeName: 'pqi-data'
              mountPath: '/app/data'  // matches Dockerfile volume
            }
          ]
        }
      ]
      scale: {
        minReplicas: 0          // scales to zero when idle = cheapest option
        maxReplicas: 1
      }
      volumes: [
        {
          name: 'pqi-data'
          storageType: 'AzureFile'
          storageName: 'pqi-data-storage'
        }
      ]
    }
  }
  dependsOn: [envStorage]
}

// ── Outputs ───────────────────────────────────────────────────
output appUrl string = 'https://${containerApp.properties.configuration.ingress.fqdn}'
output acrLoginServer string = useAcr ? acr.properties.loginServer : 'n/a (using Docker Hub)'
