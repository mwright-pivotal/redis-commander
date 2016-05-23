#!/usr/bin/env node

var optimist = require('optimist');
var Redis = require('ioredis');
var app = require('../lib/app');
var fs = require('fs');
var myUtils = require('../lib/util');
var cfenv = require("cfenv");

var redisConnections = [];
redisConnections.getLast = myUtils.getLast;

var args = optimist
  .alias('h', 'help')
  .alias('h', '?')
  .options('redis-port', {
    string: true,
    describe: 'The port to find redis on.'
  })
  .options('sentinel-port', {
    string: true,
    describe: 'The port to find sentinel on.'
  })
  .options('redis-host', {
    string: true,
    describe: 'The host to find redis on.'
  })
  .options('sentinel-host', {
    string: true,
    describe: 'The host to find sentinel on.'
  })
  .options('redis-socket', {
    string: true,
    describe: 'The unix-socket to find redis on.'
  })
  .options('redis-password', {
    string: true,
    describe: 'The redis password.'
  })
  .options('redis-db', {
    string: true,
    describe: 'The redis database.'
  })
  .options('http-auth-username', {
    alias: "http-u",
    string: true,
    describe: 'The http authorisation username.'
  })
  .options('http-auth-password', {
    alias: "http-p",
    string: true,
    describe: 'The http authorisation password.'
  })
  .options('address', {
    alias: 'a',
    string: true,
    describe: 'The address to run the server on.',
    default: "0.0.0.0"
  })
  .options('port', {
    alias: 'p',
    string: true,
    describe: 'The port to run the server on.',
    default: 8081
  })
  .options('nosave', {
     alias: 'ns',
    boolean: true,
    describe: 'Do not save new connections to config.'
  })
  .options('noload', {
     alias: 'nl',
    boolean: true,
    describe: 'Do not load connections from config.'
  })
  .options('clear-config', {
     alias: 'cc',
    boolean: false,
    describe: 'clear configuration file'
  })
  .argv;

if (args.help) {
  optimist.showHelp();
  return process.exit(-1);
}


if(args['clear-config']) {
  myUtils.deleteConfig(function(err) {
    if (err) {
    console.log("Failed to delete existing config file.");
    }
  });
}

myUtils.getConfig(function (err, config) {
  if (err) {
    console.dir(err);
    console.log("No config found or was invalid.\nUsing default configuration.");
    config = {
      "sidebarWidth": 250,
      "locked": false,
      "CLIHeight": 50,
      "CLIOpen": false,
      "default_connections": []
    };
  }
  if (!config.default_connections) {
    config.default_connections = [];
  }
  startDefaultConnections(config.default_connections, function (err) {
    if (err) {
      console.log(err);
      process.exit();
    }
    var vcap_services = JSON.parse(process.env.VCAP_SERVICES);
    var appEnv = cfenv.getAppEnv();
    if (args['sentinel-host'] || args['redis-host'] || args['redis-port'] || args['redis-socket'] || args['redis-password']) {
      var db = parseInt(args['redis-db']);
      if (db == null || isNaN(db)) {
        db = 0
      }

      newDefault = {
        "label": args['redis-label'] || "p-redis",
        "host": args['redis-host'] || vcap_services.my-redis[0].credentials.host,
        "sentinel_host": args['sentinel-host'],
        "sentinel_port": args['sentinel-port'],
        "port": args['redis-port'] || args['redis-socket'] || vcap_services.my-redis[0].credentials.port,
        "password": args['redis-password'] || vcap_services.my-redis[0].credentials.password,
        "dbIndex": db
      };

      if (!myUtils.containsConnection(config.default_connections, newDefault)) {
        var client;
	if (newDefault.sentinel_host) {
		client = new Redis({showFriendlyErrorStack: true , sentinels: [{ host: newDefault.sentinel_host, port: newDefault.sentinel_port}],name: 'mymaster' });
	}
	else
           client = new Redis(newDefault.port, vcap_services.my-redis[0].credentials.host);
        client.label = newDefault.label;
        redisConnections.push(client);
        if (args['redis-password']) {
          redisConnections.getLast().auth(args['redis-password'], function (err) {
            if (err) {
              console.log(err);
              process.exit();
            }
          });
        }
        config.default_connections.push(newDefault);
        myUtils.saveConfig(config, function (err) {
          if (err) {
            console.log("Problem saving config.");
            console.error(err);
          }
        });
        setUpConnection(redisConnections.getLast(), db);
      }
    } else if (config.default_connections.length == 0) {
      var db = parseInt(args['redis-db']);
      if (db == null || isNaN(db)) {
        db = 0
      }
      console.log("Before redis connect");
      console.log("Password="+appEnv.getService("my-redis").credentials.password);
      client = new Redis(appEnv.getService("my-redis").credentials.port, appEnv.getService("my-redis").credentials.host, {password: appEnv.getService("my-redis").credentials.password});
      client.label = "my-redis";
      client.auth(appEnv.getService("my-redis").credentials.password, function (err) {
                  if (err) {
                    console.log("Problem authenticating with " + appEnv.getService("my-redis").credentials.password );
                    console.log(err);
                    process.exit();
                  }
                });
      redisConnections.push(client);
      setUpConnection(redisConnections.getLast(), db);
    }
  });
  return startWebApp();
});

function startDefaultConnections (connections, callback) {
  if (connections) {
    connections.forEach(function (connection) {
      var client = new Redis(connection.port, connection.host);
      client.label = connection.label;
      redisConnections.push(client);
      if (connection.password) {
        redisConnections.getLast().auth(connection.password, function (err) {
          if (err) {
            return callback(err);
          }
        });
      }
      setUpConnection(redisConnections.getLast(), connection.dbIndex);
    });
  }
  return callback(null);
}

function setUpConnection (redisConnection, db) {
  redisConnection.on("error", function (err) {
    console.error("Redis error", err.stack);
  });
  redisConnection.on("end", function () {
    console.log("Connection closed. Attempting to Reconnect...");
  });
  redisConnection.once("connect", connectToDB.bind(this, redisConnection, db));
}

function connectToDB (redisConnection, db) {
  redisConnection.select(db, function (err) {
    if (err) {
      console.log(err);
      process.exit();
    }
    console.log("Redis Connection " + redisConnection.options.host + ":" + redisConnection.options.port + " Using Redis DB #" + redisConnection.options.db);
  });
}

function startWebApp () {
  httpServerOptions = {webPort: process.env.PORT || 3000, webAddress: args.address, username: args["http-auth-username"], password: args["http-auth-password"]};
  console.log("No Save: " + args["nosave"]);
  app(httpServerOptions, redisConnections, args["nosave"]);
}
