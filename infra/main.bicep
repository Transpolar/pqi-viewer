// ============================================================
// PQI Viewer — Azure Container Apps deployment (azure branch)
// ============================================================
// Resources created:
//   - Log Analytics Workspace
//   - Azure Container Registry (ACR)
//   - Azure Database for PostgreSQL Flexible Server (B1ms)
//   - Container Apps Environment
//   - Container App (pqi-viewer)
//
// Why Postgres and not SQLite-on-Azure-Files: Container Apps' Azure Files
// volumes are SMB-backed, which doesn't implement the POSIX byte-range
// locks SQLite needs. The NFS workaround requires Premium FileStorage
// (~$16/mo minimum) and workload-profile environments with VNet
// integration. A B1ms managed Postgres is ~$13/mo, simpler to wire up,
// and actually scales beyond one replica.
//
// Deployed in two passes by deploy.sh:
//   pass 1: deployContainerApp=false  → infra (ACR, LA, Postgres, env)
//   pass 2: deployContainerApp=true   → Container App with image
//                                        built into ACR between passes
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

@description('Postgres admin username')
param pgAdminUser string = 'pqiadmin'

@description('Postgres admin password. Defaults to a deterministic value derived from the resource group id so reruns of the same deploy hit the same password.')
@secure()
param pgAdminPassword string = '${uniqueString(resourceGroup().id, 'pqi-pg')}Aa1!'

// ── Derived names ────────────────────────────────────────────
var acrName          = '${appName}acr${uniqueString(resourceGroup().id)}'
var logName          = '${appName}-logs'
var envName          = '${appName}-env'
var pgServerName     = '${appName}-pg'
var pgDatabaseName   = 'pqi'
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

// ── Azure Database for PostgreSQL Flexible Server ─────────────
// B1ms (burstable, 1 vCPU, 2 GiB) is the cheapest tier — ~$13/mo at
// Norway East list price. 32 GiB is the smallest disk option.
resource pgServer 'Microsoft.DBforPostgreSQL/flexibleServers@2023-06-01-preview' = {
  name: pgServerName
  location: location
  sku: {
    name: 'Standard_B1ms'
    tier: 'Burstable'
  }
  properties: {
    version: '16'
    administratorLogin: pgAdminUser
    administratorLoginPassword: pgAdminPassword
    storage: {
      storageSizeGB: 32
    }
    backup: {
      backupRetentionDays: 7
      geoRedundantBackup: 'Disabled'
    }
    highAvailability: {
      mode: 'Disabled'
    }
  }
}

// Allow Azure-internal traffic. The special 0.0.0.0 → 0.0.0.0 rule is
// "Allow public access from any Azure service within Azure to this
// server" — that includes Container Apps managed environments. Without
// this the Container App can't reach the DB.
resource pgFirewallAllowAzure 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2023-06-01-preview' = {
  parent: pgServer
  name: 'AllowAllAzureServices'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
}

resource pgDatabase 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2023-06-01-preview' = {
  parent: pgServer
  name: pgDatabaseName
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
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

// ── Container App ─────────────────────────────────────────────
resource containerApp 'Microsoft.App/containerApps@2024-03-01' = if (deployContainerApp) {
  name: appContainerName
  location: location
  properties: {
    environmentId: containerEnv.id
    configuration: {
      ingress: {
        external: true
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
        {
          // App reads DATABASE_URL at startup. Storing it as a secret keeps
          // the password out of `az containerapp show` output (it shows up
          // as `secretref:database-url` instead of plaintext).
          name: 'database-url'
          value: 'postgres://${pgAdminUser}:${pgAdminPassword}@${pgServer.properties.fullyQualifiedDomainName}:5432/${pgDatabaseName}?sslmode=require'
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
          env: [
            {
              name: 'DATABASE_URL'
              secretRef: 'database-url'
            }
          ]
        }
      ]
      scale: {
        minReplicas: 0          // scales to zero when idle
        maxReplicas: 2          // can scale up now that state lives in Postgres
      }
    }
  }
  dependsOn: [pgDatabase]
}

// ── Outputs ───────────────────────────────────────────────────
output acrName string = acr.name
output acrLoginServer string = acr.properties.loginServer
output pgServerName string = pgServer.name
output pgFqdn string = pgServer.properties.fullyQualifiedDomainName
var fqdn = containerApp.?properties.configuration.ingress.fqdn ?? ''
output appUrl string = empty(fqdn) ? '' : 'https://${fqdn}'
