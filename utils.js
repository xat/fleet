const os = require('os');
const path = require('path');
const got = require('got');
const fs = require('fs');
const dockerRemoteApi = require('docker-remote-api');
const dockerPull = require('docker-pull');
const tstream = require('tar-stream');
const tarfs = require('tar-fs');
const mkdirp = require('mkdirp');
const dockerBuild = require('docker-build');
const endOfStream = require('end-of-stream');
const { promisify } = require('util');

const START_PORT = 30000;
const END_PORT = 32000;
const PORTS_PER_INSTANCE = 9;

const DOCKER_SOCKET_PATH = '/var/run/docker.sock';
const HOME_DIR = os.homedir();
const FLEET_BASE_PATH = path.join(HOME_DIR, '.fleet');
const MOUNTS_PATH = path.join(FLEET_BASE_PATH, 'mounts');

const CONTAINER_TYPE_LABEL = 'fleet.containerType';
const PORT_RANGE_LABEL = 'fleet.portRange';
const INSTANCE_ID_LABEL = 'fleet.instanceId';
const IMPLEMENTATION_TYPE_LABEL = 'fleet.implementationType';
const SOCAT_IMAGE_NAME = 'alpine/socat:1.0.3';

const CONFLUENCE_DOCKER_REPO = 'atlassian/confluence-server';

// Helpers

function noop() {}

function createDockerRemoteApiInstance(opts) {
  return ['get', 'put', 'post', 'head', 'delete', 'request'].reduce((instance, methodName) => {
    instance[methodName] = promisify(instance[methodName].bind(instance));
    return instance;
  }, dockerRemoteApi(opts));
}

function createDockerRequest() {
  return createDockerRemoteApiInstance({
    host: DOCKER_SOCKET_PATH
  });
}

const request = createDockerRequest();

function getSettingsPath(implementationType) {
  return path.join(FLEET_BASE_PATH, `${implementationType}.json`);
}

function validateInstanceId(instanceId) {
  if (!/^\w+$/g.test(instanceId)) {
    throw new Error(`"${instanceId}" is an invalid ID, only these characters are allowed: (A-Z, a-z, 0-9, _)`);
  }
}

function init(implementationType) {
  mkdirp.sync(MOUNTS_PATH);

  if (!fs.existsSync(getSettingsPath(implementationType))) {
    saveSettings(implementationType, getDefaultSettings(implementationType));
  }
}
function compareVersions(versionA, versionB) {
  const piecesA = versionA.split('.').map(v => parseInt(v, 10));
  const piecesB = versionB.split('.').map(v => parseInt(v, 10));

  if (piecesA[0] !== piecesB[0]) {
    return piecesA[0] - piecesB[0];
  }

  if (piecesA[1] !== piecesB[1] && (piecesA[1] || piecesB[1])) {
    return (piecesA[1] || 0) - (piecesB[1] || 0);
  }

  return (piecesA[2] || 0) - (piecesB[2] || 0);
}

async function getConfluenceVersions() {
  const response = await got(`https://registry.hub.docker.com/v1/repositories/${CONFLUENCE_DOCKER_REPO}/tags`, { json: true });
  const postfix = '-ubuntu-18.04-adoptopenjdk8';

  return response.body
    .filter(tag => tag.name.endsWith(postfix))
    .map(tag => tag.name.replace(postfix, ''))
    .sort(compareVersions)
    .reverse();
}

// Network

async function getAllNetworks() {
  return request.get('/networks', { json: true });
}

async function getNetworkByName(name) {
  const networks = await getAllNetworks();
  return networks.find(({ Name }) => Name === name);
}

async function createNetwork(name, opts = {}) {
  return request.post('/networks/create', { json: { Name: name, ...opts } });
}

async function createNetworkIfNotExists(name, opts = {}) {
  const network = await getNetworkByName(name);
  return network || createNetwork(name, opts);
}

function getNetworkName(instanceId) {
  return 'fleet_net';
  //return `${instanceId}_net`;
}

// Images

async function getAllImages() {
  return request.get('/images/json', { json: true });
}

async function getImageByName(name) {
  return (await getAllImages()).find(({ RepoTags }) => (RepoTags || []).includes(name));
}

async function pullImage(name, onProgress = noop) {
  return new Promise(function(resolve, reject) {
    return dockerPull(name, err => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    }).on('progress', onProgress);
  });
}

async function pullImageIfNotExists(name, onProgress = noop) {
  const image = await getImageByName(name);
  return image || pullImage(name, onProgress);
}

// TODO: make this function more robust.. handle error cases
async function buildImageFromDockerfile(data, tag) {
  return new Promise((resolve, reject) => {
    const pack = tstream.pack();
    pack.entry({ name: 'Dockerfile', type: 'file' }, data);
    pack.finalize();

    pack.pipe(
      dockerBuild(tag, { host: DOCKER_SOCKET_PATH }).on('data', data => {
        const message = data.toString();
        if (message.startsWith('Successfully tagged')) {
          resolve();
        }
      })
    );
  });
}

// Containers

async function getAllContainers() {
  return request.get('/containers/json?all=true', { json: true });
}

async function createContainer(name, opts = {}) {
  return request.post(`/containers/create?name=${name}`, { json: opts });
}

async function startContainer(id) {
  return request.post(`/containers/${id}/start`, { body: null });
}

async function stopContainer(id) {
  return request.post(`/containers/${id}/stop`, { body: null });
}

async function removeContainer(id) {
  return request.delete(`/containers/${id}?force=true`, { body: null });
}

async function getContainerByInstanceIdAndType(instanceId, type) {
  return (await getAllContainers()).find(({ Labels }) => Labels[INSTANCE_ID_LABEL] === instanceId && Labels[CONTAINER_TYPE_LABEL] === type);
}

async function getImplementationType(instanceId) {
  const container = (await getAllContainers()).find(
    ({ Labels }) => Labels[INSTANCE_ID_LABEL] === instanceId && Labels[IMPLEMENTATION_TYPE_LABEL]
  );

  if (container) {
    return container.Labels[IMPLEMENTATION_TYPE_LABEL];
  }
}

function saveSettings(implementationType, settings) {
  fs.writeFileSync(getSettingsPath(implementationType), JSON.stringify(settings));
}

function loadSettings(implementationType) {
  if (fs.existsSync(getSettingsPath(implementationType))) {
    return JSON.parse(fs.readFileSync(getSettingsPath(implementationType), 'utf8'));
  }
  return false;
}

function updateSettings(implementationType, settings) {
  const oldSettings = loadSettings(implementationType) || {};
  saveSettings(implementationType, Object.assign({}, oldSettings, settings));
}

function checkIfMountExists(instanceId) {
  return fs.existsSync(getMountPath(instanceId));
}

function getMountPath(instanceId) {
  return path.join(MOUNTS_PATH, instanceId);
}

function getInstanceSettingsPath(instanceId) {
  return path.join(MOUNTS_PATH, instanceId, 'instance.json');
}

function saveInstanceSettings(instanceId, settings) {
  fs.writeFileSync(getInstanceSettingsPath(instanceId), JSON.stringify(settings));
}

function loadInstanceSettings(instanceId) {
  const instanceSettingsPath = getInstanceSettingsPath(instanceId);
  if (fs.existsSync(instanceSettingsPath)) {
    return JSON.parse(fs.readFileSync(instanceSettingsPath, 'utf8'));
  }
  return false;
}

function updateInstanceSettings(instanceId, settings) {
  const oldSettings = loadInstanceSettings(instanceId) || {};
  saveInstanceSettings(instanceId, Object.assign({}, oldSettings, settings));
}

function getDefaultSettings(type) {
  return require(`./implementations/${type}/default-settings.js`);
}

function getMergedInstanceSettings(instanceId) {
  const instanceSettings = loadInstanceSettings(instanceId);

  if (!instanceSettings) {
    throw new Error(`The instance with the name "${instanceId}" does not exist.`);
  }

  const defaultSettings = getDefaultSettings(instanceSettings.type);
  const globalSettings = loadSettings(instanceSettings.type) || {};

  return Object.assign({}, defaultSettings, globalSettings, instanceSettings);
}

async function getSocatContainer() {
  const containers = await getAllContainers();

  return containers.find(({ Labels }) => Labels[CONTAINER_TYPE_LABEL] === 'socat');
}

function extractPortRangeFromLabels(Labels) {
  const [startPort, endPort] = Labels[PORT_RANGE_LABEL].split('-');

  return {
    start: parseInt(startPort, 10),
    end: parseInt(endPort, 10)
  };
}

async function getPortRange(instanceId) {
  const container = (await getAllContainers(instanceId)).find(
    ({ Labels }) => Labels[PORT_RANGE_LABEL] && Labels[INSTANCE_ID_LABEL] === instanceId
  );

  return extractPortRangeFromLabels(container.Labels);
}

async function getPortMappings(instanceId, portRange) {
  portRange = portRange || (await getPortRange(instanceId));
  const settings = getMergedInstanceSettings(instanceId);

  return settings['port-mappings']
    .split(',')
    .map(mapping => mapping.split(':'))
    .reduce((memo, [type, internalPort, dynamicPortPlaceholder, staticPort, alias]) => {
      const dynamicPort = portRange.start + parseInt(dynamicPortPlaceholder.split('_')[1], 10);

      memo[alias] = {
        type,
        internalPort,
        dynamicPort,
        staticPort
      };

      return memo;
    }, {});
}

async function getAvailablePortRange() {
  const containers = await getAllContainers();
  const usedPortRanges = containers
    .filter(({ Labels }) => Labels[PORT_RANGE_LABEL])
    .map(({ Labels }) => extractPortRangeFromLabels(Labels));

  for (let i = START_PORT; i < END_PORT; i += PORTS_PER_INSTANCE + 1) {
    const startRange = i;
    const endRange = startRange + PORTS_PER_INSTANCE;

    const isAvailableRange = usedPortRanges.every(({ start, end }) => {
      return (start < startRange || start > endRange) && (end < startRange || end > endRange);
    });

    if (isAvailableRange) {
      return {
        start: startRange,
        end: endRange
      };
    }
  }

  throw new Error('No more available ports.');
}

async function createSocatContainer(instanceId) {
  const networkName = getNetworkName(instanceId);
  const portMappings = await getPortMappings(instanceId);

  // TODO: refactor this wtf code...
  const types = Object.keys(
    Object.values(portMappings).reduce((memo, { type }) => {
      memo[type] = null;
      return memo;
    }, {})
  );

  const typeToContainerName = {};

  for (let type of types) {
    // ...and this code as well...
    typeToContainerName[type] = (await getContainerByInstanceIdAndType(instanceId, type)).Names[0].substr(1);
  }

  const mappings = Object.values(portMappings)
    .filter(mapping => mapping.staticPort)
    .map(({ type, internalPort, staticPort }) => ({
      containerName: typeToContainerName[type],
      internalPort: internalPort,
      externalPort: staticPort
    }));

  const exposedPorts = mappings.reduce((memo, { internalPort }) => {
    memo[`${internalPort}/tcp`] = {};
    return memo;
  }, {});

  const cmd = mappings.reduce((arr, { containerName, internalPort }) => {
    arr.push(`tcp-listen:${internalPort},fork,reuseaddr`);
    arr.push(`tcp-connect:${containerName}:${internalPort}`);
    return arr;
  }, []);

  const portBindings = mappings.reduce((memo, { internalPort, externalPort }) => {
    memo[`${internalPort}/tcp`] = [{ HostPort: `${externalPort}` }];
    return memo;
  }, {});

  return createContainer('socat', {
    Image: SOCAT_IMAGE_NAME,
    ExposedPorts: exposedPorts,
    Labels: {
      [CONTAINER_TYPE_LABEL]: 'socat',
      [INSTANCE_ID_LABEL]: instanceId
    },
    Cmd: cmd,
    HostConfig: {
      NetworkMode: networkName,
      PortBindings: portBindings
    }
  });
}

async function importInstance(instanceId, importStream) {
  const mountPath = getMountPath(instanceId);

  return new Promise(function(resolve, reject) {
    endOfStream(importStream.pipe(tarfs.extract(mountPath)), function(err) {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

module.exports = {
  MOUNTS_PATH,
  CONTAINER_TYPE_LABEL,
  INSTANCE_ID_LABEL,
  IMPLEMENTATION_TYPE_LABEL,
  PORT_RANGE_LABEL,

  init,
  noop,
  getConfluenceVersions,
  validateInstanceId,
  request,

  getAllNetworks,
  getNetworkByName,
  createNetwork,
  createNetworkIfNotExists,
  getNetworkName,

  getAllImages,
  getImageByName,
  pullImage,
  pullImageIfNotExists,
  buildImageFromDockerfile,

  getAllContainers,
  createContainer,
  startContainer,
  stopContainer,
  removeContainer,
  getImplementationType,

  saveSettings,
  loadSettings,
  updateSettings,
  checkIfMountExists,
  getMountPath,
  getInstanceSettingsPath,
  saveInstanceSettings,
  loadInstanceSettings,
  updateInstanceSettings,
  getMergedInstanceSettings,

  getSocatContainer,

  extractPortRangeFromLabels,
  getPortRange,
  getPortMappings,
  getAvailablePortRange,

  createSocatContainer,
  importInstance,

  createDockerRequest
};
