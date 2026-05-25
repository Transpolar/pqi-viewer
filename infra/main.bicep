// ============================================================
// PQI Viewer — Azure Container Apps deployment
// ============================================================
// Deployed in two passes by deploy.sh:
//   pass 1: deployContainerApp=false  → ACR + Log Analytics + Storage + Env
//           (so the image can be built into ACR before the app needs it)
//   pass 2: deployContainerApp=true   → adds the Container App
//
// Storage: NFS-protocol Azure Files on a Premium FileStorage account.
// SMB-backed Azure Files doesn't implement the POSIX byte-range locks
// SQLite needs (WAL mode, and even just opening the DB). NFS does, so
// SQLite works without any application-side changes.
// Tradeoff: Premium FileStorage requires 100 GiB minimum provisioned
// capacity (~$16/month at LRS pricing in most regions).
// ============================================================

@description('Azure region for all resources')
param location string = 'norwayeast'

@description('Base name used for all resources, e.g. pqiviewer')
@minLength(3)
@maxLength(16)
param appName string = 'pqiviewer'

@description('Container image tag to deploy')
param imageTag string = 'latest'

@description('Set to false to skip creating the Container App. Used during pass 1 so the image can be built before the app tries to pull it.')
param deployContainerApp bool = true

// ── Derived names ────────────────────────────────────────────
// Storage account names are capped at 24 chars. take() keeps us in budget
// even when appName uses the full @maxLength(16) allowance.
var acrName          = '${appName}acr${uniqueString(resourceGroup().id)}'
var logName          = '${appName}-logs'
var envName          = '${appName}-env'
var storageName      = '${take(appName, 9)}st${take(uniqueString(resourceGroup().id), 13)}'
var shareName        = 'pqi-data'
var appContainerName = 'pqi-viewer'
var imageName        = '${acr.properties.loginServer}/pqi-viewer:${imageTag}'

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
resource acr 'Microsoft.ContainerRegistry/registries@2023-01-01-preview' = {
  name: acrName
  location: location
  sku: { name: 'Basic' }
  properties: {
    adminUserEnabled: true   // needed for Container Apps pull
  }
}

// ── Storage Account + File Share (NFS, Premium FileStorage) ───
// kind=FileStorage + sku=Premium_LRS is the SKU required for NFS shares.
resource storageAccount 'Microsoft.Storage/storageAccounts@2023-01-01' = {
  name: storageName
  location: location
  kind: 'FileStorage'
  sku: { name: 'Premium_LRS' }
  properties: {
    // NFS uses port 2049 and no TLS. minimumTlsVersion only affects the
    // REST plane (blob/file SMB); NFS traffic is unaffected.
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    // SECURITY NOTE: NFS Azure Files is network-only auth — anyone who
    // can reach the storage endpoint AND knows both the account and share
    // names can mount it. For a personal/team tool this is acceptable
    // (account+share names act as a weak shared secret). To harden,
    // VNet-integrate the Container Apps env and add a private endpoint
    // on the storage account.
  }
}

resource fileService 'Microsoft.Storage/storageAccounts/fileServices@2023-01-01' = {
  parent: storageAccount
  name: 'default'
}

resource fileShare 'Microsoft.Storage/storageAccounts/fileServices/shares@2023-01-01' = {
  parent: fileService
  name: shareName
  properties: {
    shareQuota: 100               // 100 GiB — Premium minimum
    enabledProtocols: 'NFS'
    rootSquash: 'NoRootSquash'    // container runs as root by default
  }
}

// ── Container Apps Environment ────────────────────────────────
resource containerEnv 'Microsoft.App/managedEnvironments@2024-03-01' = {
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

// Attach the NFS file share to the environment.
// The `server` field encodes both account host and the NFS export path,
// matching the same form `mount -t nfs` would use.
resource envStorage 'Microsoft.App/managedEnvironments/storages@2024-03-01' = {
  parent: containerEnv
  name: 'pqi-data-storage'
  properties: {
    nfsAzureFile: {
      server: '${storageAccount.name}.file.${environment().suffixes.storage}:/${storageAccount.name}/${shareName}'
      accessMode: 'ReadWrite'
    }
  }
}

// ── Container App ─────────────────────────────────────────────
resource containerApp 'Microsoft.App/containerApps@2024-03-01' = if (deployContainerApp) {
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
      registries: [
        {
          server: acr.properties.loginServer
          username: acr.listCredentials().username
          passwordSecretRef: 'acr-password'
        }
      ]
      secrets: [
        {
          name: 'acr-password'
          value: acr.listCredentials().passwords[0].value
        }
      ]
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
          storageType: 'NfsAzureFile'
          storageName: 'pqi-data-storage'
        }
      ]
    }
  }
  dependsOn: [envStorage]
}

// ── Outputs ───────────────────────────────────────────────────
output acrName string = acr.name
output acrLoginServer string = acr.properties.loginServer
var fqdn = containerApp.?properties.configuration.ingress.fqdn ?? ''
output appUrl string = empty(fqdn) ? '' : 'https://${fqdn}'
