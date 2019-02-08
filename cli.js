#!/usr/bin/env node

const minimist = require('minimist');
const open = require('opn');
const ora = require('ora');
const Table = require('easy-table');
const chalk = require('chalk');
const fleet = require('./fleet.js');
const utils = require('./utils.js');

const opts = minimist(process.argv.slice(2));
const cmd = opts._[0];

function printHelp() {
  console.log(`
  Usage:

    # Add a new instance to your fleet:
    fleet add <id> [--version=<confluence-version>] [--start] [--open] [--<setting>=<value>]

    # Start an instance:
    fleet start <id> [--open]

    # Open a Confluence instance in the browser:
    fleet open <id>

    # Stop an instance:
    fleet stop <id>

    # Show a list of all instances:
    fleet list

    # Show information about a specific instance:
    fleet info <id>

    # Clone an instance:
    fleet clone <id> <newId> [--version=<confluence-version>] [--<setting>=<value>]

    # Rebuild an instance:
    fleet rebuild <id>

    # Rebuild all instances:
    fleet rebuild-all

    # Set an instance to be the master:
    fleet master <id>

    # Purge the cache of an instance:
    fleet purge-cache <id>

    # Remove an instance:
    fleet remove <id>

    # Change global settings:
    fleet global-settings [--<setting>=<value>]

    # Change the settings of a specific instance:
    fleet settings <id> [--<setting>=<value>]

    # Export an instance:
    fleet export <id> > <filename.tar>

    # Import an instance:
    cat <filename.tar> | fleet import <id> [--version=<confluence-version>] [--start] [--open] [--<setting>=<value>]
  `);
}

if (opts.help) {
  printHelp();
  return;
}

function extractSettingsFromOpts(availableSettings) {
  return availableSettings
    .filter(key => opts[key])
    .reduce((memo, key) => {
      memo[key] = opts[key];
      return memo;
    }, {});
}

function printList(data, transposed = false) {
  const table = new Table();

  data.forEach(({ id, status, baseUrl, version, isMaster, ...otherData }) => {
    table.cell('ID', id);
    table.cell('Status', status === 'running' ? chalk.green(status) : status);
    table.cell('Version', version);
    table.cell('URL', baseUrl);
    table.cell('Master', isMaster ? '*' : '-');

    if (transposed) {
      table.cell('jvm-minimum-memory', otherData['jvm-minimum-memory']);
      table.cell('jvm-maximum-memory', otherData['jvm-maximum-memory']);
      table.cell('port-mappings', otherData['port-mappings']);
      table.cell('mount-path-1', otherData['mount-path-1']);
      table.cell('mount-path-2', otherData['mount-path-2']);
      table.cell('mount-path-3', otherData['mount-path-3']);
      table.cell('mount-path-4', otherData['mount-path-4']);
      table.cell('mount-path-5', otherData['mount-path-5']);
    }

    table.newRow();
  });

  console.log('');

  if (transposed) {
    console.log(table.printTransposed());
  } else {
    console.log(table.toString());
  }
}

function buildCommand(fn, withInstanceId = true, defaultToMaster = true) {
  return async () => {
    const spinner = ora();
    const args = [spinner];

    if (withInstanceId) {
      let instanceId = opts._[1];

      if (!instanceId && defaultToMaster) {
        instanceId = await fleet.getMasterInstanceId();
      }

      if (!instanceId) {
        spinner.fail(`Missing instance ID`);
        return;
      }

      args.push(instanceId);
    }

    return fn(...args);
  };
}

const commands = {
  add: buildCommand(
    async function(spinner, instanceId) {
      try {
        const type = opts.type || 'confluence';
        const availableSettings = await fleet.getAvailableSettings(null, type);
        const settings = extractSettingsFromOpts(availableSettings);

        spinner.info(`Preparing new instance "${instanceId}"`);

        await fleet.add(instanceId, settings, false, message => {
          if (spinner.isSpinning) {
            spinner.succeed();
          }
          spinner.start(message);
        });

        spinner.succeed();

        if (opts.start) {
          await commands.start();
        }
      } catch (err) {
        spinner.fail(err.message);
      }
    },
    true,
    false
  ),

  start: buildCommand(async function(spinner, instanceId) {
    try {
      spinner.info(`Starting instance "${instanceId}"`);

      const meta = await fleet.start(instanceId, message => {
        if (spinner.isSpinning) {
          spinner.succeed();
        }
        spinner.start(message);
      });

      if (opts.open) {
        open(meta.baseUrl, { wait: false });
        spinner.info(`Opened instance "${instanceId}" in the browser`);
      }

      spinner.info(`The instance is now ready for usage: ${meta.baseUrl}`);
    } catch (err) {
      spinner.fail(err.message);
    }
  }),

  stop: buildCommand(async function(spinner, instanceId) {
    try {
      spinner.start(`Stopping instance "${instanceId}"`);
      await fleet.stop(instanceId);
      spinner.succeed();
    } catch (err) {
      spinner.fail(err.message);
    }
  }),

  open: buildCommand(async function(spinner, instanceId) {
    try {
      const baseUrl = (await fleet.info(instanceId)).baseUrl;
      open(baseUrl, { wait: false });
      spinner.info(`Opened instance "${instanceId}" in the browser`);
    } catch (err) {
      spinner.fail(err.message);
    }
  }),

  master: buildCommand(
    async function(spinner, instanceId) {
      try {
        spinner.start(`Setting instance "${instanceId}" to be master`);
        await fleet.master(instanceId);
        spinner.succeed();
        const baseUrl = (await fleet.info(instanceId)).baseUrl;
        spinner.info(`Master is now ready: ${baseUrl}`);
      } catch (err) {
        spinner.fail(err.message);
      }
    },
    true,
    false
  ),

  settings: buildCommand(async function(spinner, instanceId) {
    try {
      const availableSettings = await fleet.getAvailableSettings(instanceId);
      const settings = extractSettingsFromOpts(availableSettings);
      fleet.updateInstanceSettings(instanceId, settings);
      spinner.info('Updated instance settings.');
      if (opts.rebuild) {
        await commands.rebuild();
      } else {
        spinner.info('You might need to rebuild the instance.');
      }
    } catch (err) {
      spinner.fail(err.message);
    }
  }),

  rebuild: buildCommand(async function(spinner, instanceId) {
    try {
      spinner.start(`Rebuilding instance "${instanceId}".`);
      await fleet.rebuild(instanceId);
      spinner.succeed();
    } catch (err) {
      spinner.fail(err.message);
    }
  }),

  'purge-cache': buildCommand(async function(spinner, instanceId) {
    try {
      spinner.start(`Purching cache of instance "${instanceId}".`);
      await fleet.purgeCache(instanceId);
      spinner.succeed();
    } catch (err) {
      spinner.fail(err.message);
    }
  }),

  remove: buildCommand(
    async function(spinner) {
      try {
        for (instanceId of opts._.slice(1)) {
          spinner.start(`Removing instance "${instanceId}"`);
          await fleet.remove(instanceId);
          spinner.succeed();
        }
      } catch (err) {
        spinner.fail(err.message);
      }
    },
    true,
    false
  ),

  rm: (...args) => commands.remove(...args),

  export: buildCommand(
    async function(spinner, instanceId) {
      try {
        (await fleet.createExportStream(instanceId)).pipe(process.stdout);
      } catch (err) {
        spinner.fail(err.message);
      }
    },
    true,
    false
  ),

  import: buildCommand(
    async function(spinner, instanceId) {
      try {
        const availableSettings = await fleet.getAvailableSettings(null, 'confluence');
        const settings = extractSettingsFromOpts(availableSettings);
        spinner.info(`Importing instance "${instanceId}"`);
        await fleet.add(instanceId, settings, process.stdin, message => {
          if (spinner.isSpinning) {
            spinner.succeed();
          }
          spinner.start(message);
        });
        spinner.succeed();
        if (opts.start) {
          await commands.start();
        }
      } catch (err) {
        spinner.fail(err.message);
      }
    },
    true,
    false
  ),

  clone: buildCommand(
    async function(spinner, instanceId) {
      try {
        const newInstanceId = opts._[2];
        utils.validateInstanceId(newInstanceId);
        spinner.info(`Cloning instance "${instanceId}" to "${newInstanceId}"`);
        const availableSettings = await fleet.getAvailableSettings(instanceId);
        const settings = extractSettingsFromOpts(availableSettings);
        const importStream = await fleet.createExportStream(instanceId);
        await fleet.add(newInstanceId, settings, importStream, message => {
          if (spinner.isSpinning) {
            spinner.succeed();
          }
          spinner.start(message);
        });
        spinner.succeed();
        spinner.info('Finished cloning');
      } catch (err) {
        spinner.fail(err.message);
      }
    },
    true,
    false
  ),

  info: buildCommand(async function(spinner, instanceId) {
    try {
      const info = await fleet.info(instanceId);
      printList([info], true);
    } catch (err) {
      spinner.fail(err.message);
    }
  }),

  list: buildCommand(
    async function(spinner) {
      try {
        const data = await fleet.list();
        if (data.length) {
          printList(data);
        } else {
          spinner.info('No instances added yet');
        }
      } catch (err) {
        spinner.fail(err.message);
      }
    },
    false,
    false
  ),

  ls: (...args) => commands.list(...args),

  'global-settings': buildCommand(
    async function(spinner) {
      try {
        const type = opts.type || 'confluence';
        const availableSettings = await fleet.getAvailableSettings(null, type);
        const settings = extractSettingsFromOpts(availableSettings);
        fleet.updateSettings(type, settings);
        spinner.info('Updated global settings');
        spinner.info('You might need to rebuild the instances');
      } catch (err) {
        spinner.fail(err.message);
      }
    },
    false,
    false
  ),

  'rebuild-all': buildCommand(
    async function(spinner) {
      try {
        spinner.start('Rebuilding all instances');
        await fleet.rebuildAll();
        spinner.succeed();
      } catch (err) {
        spinner.fail(err.message);
      }
    },
    false,
    false
  )
};

if (!cmd) {
  commands.list();
  return;
}

if (commands[cmd]) {
  commands[cmd]();
} else {
  console.log('unknown command');
}
