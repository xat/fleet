const path = require('path');
const mkdirp = require('mkdirp');
const tarfs = require('tar-fs');
const waitOn = require('wait-on');
const utils = require('../../utils');

const CONFLUENCE_CONTEXT_PATH = '/confluence';

const POSTGRES_USER = 'confluence';
const POSTGRES_PASSWORD = 'confluence';
const POSTGRES_CONFLUENCE_DB = 'confluence';

const POSTGRES_PORT = 5432;
const POSTGRES_IMAGE_NAME = 'postgres:11';

const CONFLUENCE_PORT = 8090;

function getAvailableSettings() {
  return [
    'version',
    'jvm-support-recommended-args',
    'jvm-minimum-memory',
    'jvm-maximum-memory',
    'port-mappings',
    'mount-path-1',
    'mount-path-2',
    'mount-path-3',
    'mount-path-4',
    'mount-path-5'
  ];
}

async function getDynamicConfluenceBasePath(instanceId) {
  const portMappings = await utils.getPortMappings(instanceId);

  return `http://localhost:${portMappings.confluence.dynamicPort}${CONFLUENCE_CONTEXT_PATH}`;
}

async function getMasterConfluenceBasePath(instanceId) {
  const portMappings = await utils.getPortMappings(instanceId);

  return `http://localhost:${portMappings.confluence.staticPort}${CONFLUENCE_CONTEXT_PATH}`;
}

async function getConfluenceBaseUrl(instanceId) {
  if (await isMaster(instanceId)) {
    return await getMasterConfluenceBasePath(instanceId);
  }

  return await getDynamicConfluenceBasePath(instanceId);
}

function getDataPath(instanceId) {
  return path.join(utils.MOUNTS_PATH, instanceId, 'data');
}

function getHomePath(instanceId) {
  return path.join(utils.MOUNTS_PATH, instanceId, 'home');
}

function getConfluenceContainterName(instanceId) {
  return `${instanceId}_confluence`;
}

function getPostgresContainterName(instanceId) {
  return `${instanceId}_postgres`;
}

async function isMaster(instanceId) {
  const socatContainer = await utils.getSocatContainer();
  return socatContainer && socatContainer.Labels[utils.INSTANCE_ID_LABEL] === instanceId;
}

async function getMasterInstanceId() {
  const socatContainer = await utils.getSocatContainer();
  return socatContainer && socatContainer.Labels[utils.INSTANCE_ID_LABEL];
}

async function getConfluenceContainers() {
  const containers = await utils.getAllContainers();
  return containers.filter(({ Labels }) => Labels[utils.CONTAINER_TYPE_LABEL] === 'confluence');
}

async function getConfluenceContainer(instanceId) {
  return (await getConfluenceContainers()).find(({ Labels }) => Labels[utils.INSTANCE_ID_LABEL] === instanceId);
}

async function getPostgresContainer(instanceId) {
  const containers = await utils.getAllContainers();

  return containers
    .filter(({ Labels }) => Labels[utils.CONTAINER_TYPE_LABEL] === 'postgres')
    .find(({ Labels }) => Labels[utils.INSTANCE_ID_LABEL] === instanceId);
}

async function createPostgresContainer(instanceId, portRange, settings) {
  const portMappings = await utils.getPortMappings(instanceId, portRange);

  return utils.createContainer(getPostgresContainterName(instanceId), {
    Image: settings['postgres-image-name'] || POSTGRES_IMAGE_NAME,
    ExposedPorts: {
      [`${POSTGRES_PORT}/tcp`]: {}
    },
    Volumes: {
      '/var/lib/postgresql/data': {}
    },
    Labels: {
      [utils.CONTAINER_TYPE_LABEL]: 'postgres',
      [utils.INSTANCE_ID_LABEL]: instanceId,
      [utils.IMPLEMENTATION_TYPE_LABEL]: 'confluence'
    },
    Env: [`POSTGRES_USER=${POSTGRES_USER}`, `POSTGRES_PASSWORD=${POSTGRES_PASSWORD}`, `POSTGRES_DB=${POSTGRES_CONFLUENCE_DB}`],
    HostConfig: {
      PortBindings: {
        [`${POSTGRES_PORT}/tcp`]: [
          {
            HostPort: `${portMappings.postgres.dynamicPort}`
          }
        ]
      },
      NetworkMode: utils.getNetworkName(instanceId),
      Mounts: [
        {
          Target: '/var/lib/postgresql/data',
          Source: getDataPath(instanceId),
          Type: 'bind',
          ReadOnly: false
        }
      ]
    }
  });
}

async function createConfluenceContainer(instanceId, portRange) {
  const settings = utils.getMergedInstanceSettings(instanceId);
  const portMappings = await utils.getPortMappings(instanceId, portRange);

  const mounts = Object.entries(settings)
    .filter(([key, val]) => key.startsWith('mount-path') && val)
    .map(([key, val]) => {
      return {
        Target: `/opt/${key}`,
        Source: val,
        Type: 'bind',
        ReadOnly: false
      };
    });

  return utils.createContainer(getConfluenceContainterName(instanceId), {
    Image: `fleetconfluence:${settings.version}`,
    ExposedPorts: {
      [`${CONFLUENCE_PORT}/tcp`]: {}
    },
    Volumes: {
      '/var/atlassian/application-data/confluence': {}
    },
    Labels: {
      [utils.CONTAINER_TYPE_LABEL]: 'confluence',
      [utils.INSTANCE_ID_LABEL]: instanceId,
      [utils.IMPLEMENTATION_TYPE_LABEL]: 'confluence',
      [utils.PORT_RANGE_LABEL]: `${portRange.start}-${portRange.end}`
    },
    Env: [
      `JVM_SUPPORT_RECOMMENDED_ARGS=${settings['jvm-support-recommended-args']}`,
      `JVM_MINIMUM_MEMORY=${settings['jvm-minimum-memory']}`,
      `JVM_MAXIMUM_MEMORY=${settings['jvm-maximum-memory']}`
    ],
    HostConfig: {
      PortBindings: {
        [`${CONFLUENCE_PORT}/tcp`]: [
          {
            HostPort: `${portMappings.confluence.dynamicPort}`
          }
        ]
      },
      NetworkMode: utils.getNetworkName(instanceId),
      Mounts: [
        {
          Target: '/var/atlassian/application-data/confluence',
          Source: getHomePath(instanceId),
          Type: 'bind',
          ReadOnly: false
        },
        ...mounts
      ]
    },
    NetworkingConfig: {
      EndpointsConfig: {
        [utils.getNetworkName(instanceId)]: {
          Links: [`${getPostgresContainterName(instanceId)}:postgres`]
        }
      }
    }
  });
}

async function buildConfluenceImage(settings, instanceId) {
  const baseConfluenceImageName = `atlassian/confluence-server:${settings.version}-ubuntu-18.04-adoptopenjdk8`;
  // TODO: should we give the user the possibility to define a custom docker file?
  return utils.buildImageFromDockerfile(
    `
        FROM ${baseConfluenceImageName}
        RUN apt-get update && apt-get install -y xmlstarlet
        RUN xmlstarlet ed -P --inplace --update "//Context[contains(@docBase,'../confluence')]/@path" --value "${CONFLUENCE_CONTEXT_PATH}" /opt/atlassian/confluence/conf/server.xml
        RUN xmlstarlet ed -P --inplace --insert "/Context" --type attr -n "sessionCookieName" -v "${instanceId.toUpperCase()}_SESSIONID" /opt/atlassian/confluence/conf/context.xml
        RUN mkdir -p /opt/mount-path-1
        RUN mkdir -p /opt/mount-path-2
        RUN mkdir -p /opt/mount-path-3
        RUN mkdir -p /opt/mount-path-4
        RUN mkdir -p /opt/mount-path-5
    `,
    `fleetconfluence:${settings.version}`
  );
}

async function add(instanceId, instanceSettings = {}, importStream = false, onProgress = noop) {
  mkdirp.sync(getDataPath(instanceId));
  mkdirp.sync(getHomePath(instanceId));

  if (!importStream) {
    if (!instanceSettings.version) {
      instanceSettings.version = (await utils.getConfluenceVersions())[0];
    }

    if (!instanceSettings.type) {
      instanceSettings.type = 'confluence';
    }

    utils.saveInstanceSettings(instanceId, instanceSettings);
  } else {
    onProgress(`Importing instance`);
    await utils.importInstance(instanceId, importStream);
    utils.updateInstanceSettings(instanceId, instanceSettings);
  }

  const settings = utils.getMergedInstanceSettings(instanceId);
  const portRange = await utils.getAvailablePortRange();
  const networkName = utils.getNetworkName(instanceId);

  await utils.createNetworkIfNotExists(networkName);
  onProgress(`Building Confluence image`);
  await buildConfluenceImage(settings, instanceId);
  onProgress(`Creating Confluence container`);
  await createConfluenceContainer(instanceId, portRange);
  onProgress(`Pulling Postgres image`);
  await utils.pullImageIfNotExists(settings['postgres-image-name'] || POSTGRES_IMAGE_NAME);
  onProgress(`Creating Postgres container`);
  await createPostgresContainer(instanceId, portRange, settings);
}

async function start(instanceId, onProgress = noop) {
  const confluenceContainer = await getConfluenceContainer(instanceId);
  const postgresContainer = await getPostgresContainer(instanceId);

  onProgress(`Starting Postgres container`);
  await utils.startContainer(postgresContainer.Id);
  onProgress(`Starting Confluence container`);
  await utils.startContainer(confluenceContainer.Id);

  if (await isMaster(instanceId)) {
    // make sure the socat container gets started
    const socatContainer = await utils.getSocatContainer();
    await utils.startContainer(socatContainer.Id);
  }

  const baseUrl = await getConfluenceBaseUrl(instanceId);

  onProgress(`Waiting for Confluence to be ready`);

  await waitOn({
    resources: [baseUrl]
  });

  return {
    baseUrl
  };
}

async function stop(instanceId) {
  const confluenceContainer = await getConfluenceContainer(instanceId);
  const postgresContainer = await getPostgresContainer(instanceId);

  await utils.stopContainer(confluenceContainer.Id);
  await utils.stopContainer(postgresContainer.Id);
}

async function remove(instanceId) {
  try {
    await utils.removeContainer(getConfluenceContainterName(instanceId));
  } catch (err) {}

  try {
    await utils.removeContainer(getPostgresContainterName(instanceId));
  } catch (err) {}
}

async function info(instanceId) {
  const confluenceContainter = await getConfluenceContainer(instanceId);
  const settings = await utils.getMergedInstanceSettings(instanceId);
  const master = await isMaster(instanceId);
  const baseUrl = master ? await getMasterConfluenceBasePath(instanceId) : await getDynamicConfluenceBasePath(instanceId);
  const status = confluenceContainter.State;

  return Object.assign({}, settings, {
    id: instanceId,
    isMaster: master,
    status,
    baseUrl
  });
}

async function list() {
  const confluenceContainers = await getConfluenceContainers();
  const promises = confluenceContainers.map(confluenceContainer => info(confluenceContainer.Labels[utils.INSTANCE_ID_LABEL]));

  const data = await Promise.all(promises);

  const statusPrios = {
    running: 30,
    created: 20,
    exited: 10
  };

  return data.sort((infoA, infoB) => statusPrios[infoB.status] - statusPrios[infoA.status]);
}

async function rebuild(instanceId) {
  const settings = utils.getMergedInstanceSettings(instanceId);
  let portRange;

  try {
    portRange = await utils.getPortRange(instanceId);
  } catch (e) {
    portRange = await utils.getAvailablePortRange();
  }

  await remove(instanceId);

  await buildConfluenceImage(settings, instanceId);
  await createConfluenceContainer(instanceId, portRange);
  await createPostgresContainer(instanceId, portRange, settings);
}

async function createExportStream(instanceId) {
  const mountPath = utils.getMountPath(instanceId);

  const ignoredDirectories = [
    'home/plugins-cache',
    'home/plugins-osgi-cache',
    'home/plugins-temp',
    'home/temp',
    'home/webresource-temp'
  ].map(dirName => path.join(mountPath, dirName));

  return tarfs.pack(mountPath, {
    ignore: function(name) {
      return ignoredDirectories.some(function(ignoredDirectory) {
        return name.startsWith(ignoredDirectory);
      });
    }
  });
}

module.exports = {
  add,
  remove,
  start,
  stop,
  info,
  list,
  rebuild,
  createExportStream,
  getAvailableSettings,
  getMasterInstanceId
};
