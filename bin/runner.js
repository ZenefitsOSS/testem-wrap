#!/usr/bin/env node
require('dependency-checker')();
var spawn = require('child_process').spawn;
var path = require('path');
var args = process.argv.slice(3);
var projectPath = process.argv[2];
var Bridge = require('../lib/proxy_bridge').Bridge;
var startGraphqlServer = require('../lib/graphql').startGraphqlServer;
var bridge;
var testemPath = require.resolve('testem').replace('/lib/api.js', '');
var program = require('commander')
var progOptions = program
var Config = require(path.join(testemPath, 'lib/config'));
var Api = require(path.join(testemPath, 'lib/api'));
var appMode = 'dev'
var proc;
var url = require('url');

process.chdir(path.join(process.cwd(), projectPath));

args.unshift('node');
args.unshift(path.join(process.cwd(), './node_modules/.bin/testem'));

program
  .version(require(testemPath + '/package').version)
  .usage('[options]')
  .option('-f, --file [file]', 'config file - defaults to testem.json or testem.yml')
  .option('-p, --port [num]', 'server port - defaults to 7357', Number)
  .option('--host [hostname]', 'host name - defaults to localhost', String)
  .option('-l, --launch [list]', 'list of launchers to launch(comma separated)')
  .option('-s, --skip [list]', 'list of launchers to skip(comma separated)')
  .option('-d, --debug', 'output debug to debug log - testem.log')
  .option('-t, --test_page [page]', 'the html page to drive the tests')
  .option('-g, --growl', 'turn on growl notifications')
  .option('-u, --channel_uuid [uuid]', 'UUID to use for Redis pub/sub channels')


program
  .command('launchers')
  .description('Print the list of available launchers (browsers & process launchers)')
  .action(act(function(env){
    env.__proto__ = program
    progOptions = env
    appMode = 'launchers'
  }))

program
  .command('ci')
  .description('Continuous integration mode')
  .option('-T, --timeout [sec]', 'timeout a browser after [sec] seconds', null)
  .option('-P, --parallel [num]', 'number of browsers to run in parallel, defaults to 1', Number)
  .option('-b, --bail_on_uncaught_error', 'Bail on any uncaught errors')
  .option('-R, --reporter [reporter]', 'Test reporter to use [tap|dot|xunit]', 'tap')
  .action(act(function(env){
    env.__proto__ = program
    progOptions = env
    appMode = 'ci'
  }))

program
  .command('server')
  .description('Run just the server')
  .action(act(function(env){
    env.__proto__ = program
    progOptions = env
    appMode = 'server'
  }))


main()
function main(){
  program.parse(args)

  var config = new Config(appMode, progOptions);

  if (appMode === 'launchers'){
    config.read(function(){
      config.printLauncherInfo()
    })
  }
  else {
    var api = new Api();
    config.read(function(){
      var proxiesConfig = config.getConfigProperty('proxies');
      var graphqlUrl = url.parse(proxiesConfig['/graphql']['target']);
      var apiUrl = url.parse(proxiesConfig['/api']['target']);

      bridge = new Bridge(program.channel_uuid, apiUrl);
      bridge.start();
      process.env.PORT = graphqlUrl.port;
      process.env.BASEURL = apiUrl.href;
      startGraphqlServer();
    });

    api.setup = function(mode, finalizer) {
      var self = this;
      var App = require(path.join(testemPath, 'lib', 'app'));
      var config = this.config = new Config(mode, this.options);

      this.configureLogging();
      config.read(function () {
        self.app = new App(config, finalizer);

        self.app.on('server-io-start', function (io) {
          io.on('connection', function (socket) {
            socket.on('console', function (data) {
              var method = data.method;
              var args = ['console.' + method + ':'].concat(JSON.parse(data.args));
              console[data.method].apply(console, args);
            });
            /*
            socket.on('test-result', function (data) {
              bridge.sendResult({outputType: 'test-result', output: data});
            });
            socket.on('all-test-results', function (data) {
              bridge.sendResult({outputType: 'all-test-results', output: data});
            });
            */
          });
        });

        self.app.start();
      });
    };

    if (appMode === 'ci') {
      api.startCI(progOptions)
    }
    else if (appMode === 'dev') {
      api.startDev(progOptions)
    }
    else if (appMode === 'server') {
      api.startServer(progOptions)
    }
  }
}

// this is to workaround the weird behavior in command where
// if you provide additional command line arguments that aren't
// options, it goes in as a string as the 1st arguments of the
// "action" callback, we don't want this
function act(fun){
  return function(){
    var options = arguments[arguments.length - 1]
    fun(options)
  }
}

var ended = false;
var end = function () {
  if (!ended) {
    end = true;
    bridge.sendCmd({command: 'done'});
    bridge.stop();
  }
}


process.on('SIGINT', end);
process.on('exit', end);
process.on('uncaughtException', function (err) {
  console.error('Uncaught global exception in testem-wrap');
  console.error(err.message);
  if (err.stack) {
    console.error(err.stack);
  }
  try {
    end();
  }
  catch(e) {}
  process.exit();
});

