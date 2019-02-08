# fleet

Manage a fleet of Confluence instances with ease. For development and testing purposes.

<p align="center">
  <br>
    <img src="https://sope.io/fleet/screencast.svg" width="650">
  <br>
</p>

## Features

* Each Confluence instance is initialized together with a Postgres database
* Run multiple Confluence instances in parallel, fleet dynamically assigns ports to each instance
* Confluence instances can be exported and imported
* Two layered settings: Define global settings and optionally overwrite them on an instance level
* fleet can be used programmatically
* Define one instance as master. The master instance will listen on port 8090

## Requirements

* NodeJS >= 8
* Docker

## Install

```
npm install @xat/fleet --global
```

## Usage

#### Add a new instance to your fleet

```
fleet add <id> [--version=<confluence-version>] [--start] [--open] [--<setting>=<value>]
```

* **id** The id of the instance
* **--version=&lt;confluence-version&gt;** The Confluence version. Defaults to the latest version
* **--start** Directly start the instance after it was created
* **--open** Open Confluence in the browser after it was started
* **--&lt;setting&gt;=&lt;value&gt;** See [available settings](#settings)

#### Start an instance

```
fleet start <id> [--open]
```

* **id** The id of the instance
* **--open** Open Confluence in the browser after it was started

#### Open a Confluence instance in the browser

```
fleet open <id>
```

* **id** The id of the instance

#### Stop an instance

```
fleet stop <id>
```

* **id** The id of the instance


#### Show a list of all instances

```
fleet list
fleet
```

#### Show information about a specific instance

```
fleet info <id>
```

* **id** The id of the instance

#### Clone an instance

```
fleet clone <id> <newId> [--version=<confluence-version>] [--<setting>=<value>]
```

* **id** The id of the instance
* **newId** The id of the duplicate
* **--version=&lt;confluence-version&gt;** The Confluence version of the duplicate
* **--&lt;setting&gt;=&lt;value&gt;** See [available settings](#settings)

#### Rebuild an instance

Rebuilding an instance means that its Docker containers will be re-recreated.

```
fleet rebuild <id>
```

* **id** The id of the instance

#### Rebuild all instances

```
fleet rebuild-all
```

#### Set an instance to be the master

One instance in the fleet can be the master instance. The master Confluence instance will listen on port 8090. 

```
fleet master <id>
```

* **id** The id of the instance

#### Purge the cache of an instance

Deletes the directories bundled-plugins, plugins-cache, plugins-osgi-cache, plugins-temp and bundled-plugins_language inside of the Confluence home directory.

```
fleet purge-cache <id>
```

* **id** The id of the instance

#### Remove an instance

Removing an instance will delete its Docker containers as well as the Confluence home directory and the database.

```
fleet remove <id>
```

* **id** The id of the instance

#### Change global settings

Settings can be defined globally and and on an instance level. Settings on an instance level are prioritized over global settings. This means that you can define common settings globally and then overwrite them on an instance level.

```
fleet global-settings [--<setting>=<value>]
```

* **--&lt;setting&gt;=&lt;value&gt;** See [available settings](#settings)

#### Change the settings of a specific instance

After changing the settings of an instance you will likely need to rebuild it.

```
fleet settings <id> [--<setting>=<value>]
```

* **id** The id of the instance
* **--&lt;setting&gt;=&lt;value&gt;** See [available settings](#settings)

#### Export an instance

The export will include the Confluence home directory and the database.

```
fleet export <id> > <filename.tar>
```

* **id** The id of the instance

#### Import an instance

```
cat <filename.tar> | fleet import <id> [--version=<confluence-version>] [--start] [--open] [--<setting>=<value>]
```

* **id** The id of the instance
* **--version=&lt;confluence-version&gt;** The Confluence version of the imported instance
* **--start** Directly start the instance after it was created
* **--open** Open Confluence in the browser after it was started
* **--&lt;setting&gt;=&lt;value&gt;** See [available settings](#settings)

## Settings

These are the available settings:

#### jvm-support-recommended-args

Additional JVM arguments for Confluence

*Default: ''*

#### jvm-minimum-memory

The minimum heap size of the JVM

*Default: 2048m*

#### jvm-maximum-memory

The maximum heap size of the JVM

*Default: 2048m*

#### port-mappings

fleet assigns a range of 10 ports to each instance starting from port 30000. This means the first instance has a port range from 30000 to 30009, the second instance has a port range from 30010 to 30019 and so on.

Port mappings can be defined like this:

*&lt;container-type&gt;:&lt;source-port&gt;:&lt;exposed-dynamic-port&gt;:&lt;exposed-master-port&gt;:&lt;alias&gt;*

* **container-type** Can be either *confluence* or *postgres*.
* **source-port** The source port (e.g. 8090 in case of Confluence).
* **exposed-dynamic-port** The port under which the source port should be available on the host machine (e.g. PORT_0 references the first port of the dynamic port range. So this port would be set to 30000 on the first instance and to 30010 on the second instance).
* **exposed-master-port** The port under which the source port should be available on the host machine in the case the instance is the master (e.g. 8090).
* **alias** An alias name. This should be set to *confluence* in case of the main Confluence port (8090) and to *postgres* if it's the main Postgres port (5432).


*Default: confluence:8090:PORT_0:8090:confluence,postgres:5432:PORT_1::postgres*

#### mount-path-[1-5]

Define up to 5 paths which will get mounted as volumes into the Confluence Docker container.
For example, if you set *mount-path-1* to */foo* then the path */opt/mount-path-1* inside of the Confluence Docker container will link to the */foo* path of the host machine.

*Default: ''*

## Programmatic Usage

fleet was developed with an API-First approach. This means, everything which can be done in the cli can also be done programmatically. Here is a short example script:

```JavaScript
const fleet = require('@xat/fleet');

(async function() {
  // add a new instance
  await fleet.add('foo', { version: '6.6.3' });

  // ...then start it
  await fleet.start('foo');

  // ...then remove it again
  await fleet.remove('foo');
})();
```

## Good to know

#### Postgres

In order to connect Confluence with the Postgres database you can use these settings:

* **Host:** postgres
* **User:** confluence
* **Password:** confluence
* **Database:** confluence

#### Paths

The settings, the Confluence home directories and the Postgres Databases are all stored under *~/.fleet* 


## License
Copyright (c) 2018 Simon Kusterer

Licensed under the MIT license.