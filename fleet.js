const mkdirp = require('mkdirp');
const fs = require('fs');
const rimraf = require('rimraf');
const utils = require('./utils');

const implementations = {
  confluence: require('./implementations/confluence')
  // jira: require('./implementations/jira') // TODO: implement me :)
};

const SOCAT_IMAGE_NAME = 'alpine/socat:1.0.3';

async function getImplementation(instanceId) {
  let implementationType;

  try {
    implementationType = utils.getMergedInstanceSettings(instanceId).type;
  } catch (err) {
    // in case the mount was already deleted, try to get the implementation type
    // by checking the container labels.
    implementationType = await utils.getImplementationType(instanceId);

    if (!implementationType) {
      throw new Error('Could not determ implementation type');
    }
  }

  if (!(implementationType in implementations)) {
    throw new Error(`Invalid implementation type "${implementationType}"`);
  }

  return implementations[implementationType];
}

async function add(instanceId, instanceSettings = {}, importStream = false, onProgress = utils.noop, implementationType = 'confluence') {
  utils.validateInstanceId(instanceId);

  if (utils.checkIfMountExists(instanceId)) {
    throw new Error(`There is an existing instance with the ID "${instanceId}"`);
  }

  if (!(implementationType in implementations)) {
    throw new Error(`Invalid implementation type "${implementationType}"`);
  }

  const impl = implementations[implementationType];

  utils.init(implementationType);

  mkdirp.sync(utils.getMountPath(instanceId));

  try {
    return impl.add(instanceId, instanceSettings, importStream, onProgress);
  } catch (err) {
    try {
      // Clean-Up instance if it couldn't be added
      await impl.remove(instanceId);
    } catch (err) {}

    throw err;
  }
}

async function start(instanceId, onProgress = utils.noop) {
  return (await getImplementation(instanceId)).start(instanceId, onProgress);
}

async function stop(instanceId) {
  return (await getImplementation(instanceId)).stop(instanceId);
}

async function remove(instanceId, deleteMount = true) {
  const impl = await getImplementation(instanceId);

  if (deleteMount) {
    rimraf.sync(utils.getMountPath(instanceId));
  }

  return impl.remove(instanceId);
}

async function rebuild(instanceId) {
  return (await getImplementation(instanceId)).rebuild(instanceId);
}

async function master(instanceId) {
  await utils.pullImageIfNotExists(SOCAT_IMAGE_NAME);

  try {
    await utils.removeContainer('socat');
  } catch (err) {}

  const socatContainer = await utils.createSocatContainer(instanceId);

  await utils.startContainer(socatContainer.Id);
}

async function getMasterInstanceId(fallbackImplementationType = 'confluence') {
  return implementations[fallbackImplementationType].getMasterInstanceId();
}

async function purgeCache(instanceId) {
  return (await getImplementation(instanceId)).purgeCache(instanceId);
}

async function createExportStream(instanceId) {
  return (await getImplementation(instanceId)).createExportStream(instanceId);
}

async function info(instanceId) {
  return (await getImplementation(instanceId)).info(instanceId);
}

async function list() {
  const lists = await Promise.all(Object.values(implementations).map(impl => impl.list()));

  return lists.reduce((memo, list) => memo.concat(list), []);
}

async function rebuildAll() {
  const instanceIds = fs.readdirSync(utils.MOUNTS_PATH).filter(instanceId => instanceId !== '.DS_Store');

  for (const instanceId of instanceIds) {
    try {
      await rebuild(instanceId);
    } catch (err) {
      console.log(err);
    }
  }
}

async function getAvailableSettings(instanceId, fallbackImplementationType = 'confluence') {
  if (instanceId) {
    return (await getImplementation(instanceId)).getAvailableSettings();
  }

  return implementations[fallbackImplementationType].getAvailableSettings();
}

module.exports = {
  add,
  remove,
  master,
  start,
  stop,
  info,
  list,
  rebuild,
  rebuildAll,
  createExportStream,
  updateSettings: utils.updateSettings,
  updateInstanceSettings: utils.updateInstanceSettings,
  getAvailableSettings,
  getMasterInstanceId,
  purgeCache
};
