const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const app = express();
const fleet = require('./fleet');

const BLUEPRINT_INSTANCE_ID = 'documents_blueprint';
const NUM_PREPARED_INSTANCES = 3;
// const EXPIRES_IN = 2 * 1000 * 60 * 60;
const EXPIRES_IN = 2 * 1000 * 60;
const DELAY_BETWEEN_UPDATES = 1000 * 10; // 10 seconds 
const INSTANCE_START_TIMEOUT = 1000 * 60; // 1 min
const PORT = 4444;

function sleep(ms) {
    return new Promise(function(resolve) {
        setTimeout(resolve, ms);
    });
}

function createId() {
    return Math.random().toString(36).substr(2, 9);
}

async function update() {
    const instances = await getDemoInstances();
    const now = Date.now();

    const expiredInstances = instances.filter(({ demoExpires }) => now > demoExpires);
    const preparedInstances = instances.filter(({ demoExpires }) => !demoExpires);
    const exitedPreparedInstances = instances.filter(({ status }) => status === 'exited');
    const preparedInstancesCount = preparedInstances.length;

    console.log('running update');

    // TODO: start stopped instances
    for (const instance of exitedPreparedInstances) {
        try {
            await start(instance.id);
            console.log('started instance', instance.id);
        } catch (err) {
            console.log('update start error', err.message);
        }
    }

    // remove expired demo instances
    for (const instance of expiredInstances) {
        await fleet.stop(instance.id);
        await fleet.remove(instance.id);
        console.log('removed expired instance', instance.id);
    }

    // add new instances
    for (let i = preparedInstancesCount; i < NUM_PREPARED_INSTANCES; i++) {
        // add timeout...
        const newInstanceId = await create();
        console.log('prepared instance', newInstanceId);
    }
}

async function getNextAvailableInstance() {
    const instances = await getDemoInstances();
    return instances.find(({ demoExpires, status }) => !demoExpires && status === 'running');
}

async function activateDemoInstance(instanceId) {
    const now = Date.now();
    const expires = now + EXPIRES_IN;

    await fleet.updateInstanceSettings(instanceId, { demoExpires: expires });

    return expires;
}

async function getDemoInstances() {
    const instances = await fleet.list();
    return instances.filter(({ isDemo }) => isDemo);
}

async function start(instanceId) {
    return Promise.race([
        fleet.start(instanceId),
        sleep(INSTANCE_START_TIMEOUT)
            .then(() => Promise.reject(new Error('timeout reached')))
    ]);
}

async function create() {
    const newInstanceId = createId();
    const sourceSettings = await fleet.getAvailableSettings(BLUEPRINT_INSTANCE_ID);
    const importStream = await fleet.createExportStream(BLUEPRINT_INSTANCE_ID);
    const settings = Object.assign({}, sourceSettings, { isDemo: true });

    await fleet.add(newInstanceId, settings, importStream);

    try {
        await start(newInstanceId);
    } catch (err) {
        console.log('create start error', err.message);
    }

    return newInstanceId;
}

function runUpdate() {
    return update()
        .then(() => sleep(DELAY_BETWEEN_UPDATES))
        .then(runUpdate);
}

runUpdate();

app.use(cors());
app.use(bodyParser.json());

app.post('/instance', async function(req, res) {
    const instance = await getNextAvailableInstance();
    
    if (!instance) {
        console.log('no available instance');
        res.status(400).end({ error: 'no available instance' });
        return;
    }

    const expires = await  activateDemoInstance(instance.id);

    console.log('activated demo instance', instance.baseUrl, expires);

    res.json({
        url: instance.baseUrl,
        expires
    });
});

app.listen(PORT);
