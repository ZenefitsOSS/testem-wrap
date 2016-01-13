#!/usr/bin/env node

// var debug = require('debug');
// debug.enable('testServer:*');
// var log = debug('testServer:runner:');

var spawn = require('child_process').spawn;
var path = require('path');
var args = process.argv.slice(3);
var projectPath = process.argv[2];
var Bridge = require('../lib/proxy_bridge').Bridge;
var bridge;
var testemPath = '../node_modules/testem';
var program = require('commander')
var progOptions = program
var Config = require(path.join(testemPath, 'lib/config'));
var Api = require(path.join(testemPath, 'lib/api'));
var appMode = 'dev'
var proc;

var log = function() {
  var args = Array.prototype.slice.call(arguments);
  args.unshift('testServer:runner:');
  console.log.apply(console, args);
}

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
  .option('-u, --proxy_port [num]', 'overwrite port for proxies')


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

    bridge = new Bridge(program.channel_uuid, program.proxy_port);
    var bridgeHandlersSet = false;
    var currentSocket;
    var resumeAckTimeout;
    var lastFilter;
    var gotFirstAllTestsMsg = false;

    var pingTimer;

    bridge.on('test-resume', function() {
      currentSocket.emit('test-resume');
      clearTimeout(resumeAckTimeout);
      resumeAckTimeout = setTimeout(function() {
        bridge.sendCmd({command: 'resume-timeout-browser'});
      }, 1000);
    });

    bridge.on('start-next-test', function(data) {
      lastFilter = data.test_filter;
      // pingTimer = setInterval(function() {
      //   log('sent ping to pyhton');
      //   bridge.sendCmd({command: 'ping'});
      // }, 5000);
      // bridge.sendCmd({command: 'log', msg: 'runner.js: got start-next-test from bridge, send to browser'});
      log('Start test: ' + data.test_filter);
      if ( data.data ) {
        log('data for browser:\n' + JSON.stringify(data.data, '', '  '));
        data.data = encodeURIComponent(JSON.stringify(data.data));
      }
      
      log('run id: ' + data.run_id);
      // log('python >>> start-next-test >>> browser', JSON.stringify(data, '', '  ') );
      currentSocket.emit('start-next-test', data, function() {
        setTimeout(function(){
          bridge.currentRunId = data.run_id;
          bridge.sendCmd({command: 'start-next-test-ack'});
        }, 100);
      });
    });

    bridge.start();

    api.setup = function(mode, dependency, finalizer) {
      var self = this;
      var App = require(path.join(testemPath, 'lib', dependency));
      var config = this.config = new Config(mode, this.options);
      // Expose the SocketIO connection for reporting results
      // var configureSocket = function () {
      //   var server = self.app.server;
      //   server.on('server-start', function () {

      //     server.io.on('connection', function (socket) {
      //       socket.on('console', function (data) {
      //         var method = data.method;
      //         var args = ['console.' + method + ':'].concat(JSON.parse(data.args));
      //         console[data.method].apply(console, args);
      //       });
      //       socket.on('ping', function() {
      //         // log('browser >>> ping');
      //         // bridge.sendCmd({command: 'log', msg: 'runner.js: got ping'});
      //       });
      //       //socket.on('test-result', function (data) {
      //       //  writer.call(process.stdout, '{"result": ' + JSON.stringify(data) + '}\n');
      //       //});
      //       socket.on('all-test-results', function (data) {
      //         // log('browser >>> all-test-results', data);
      //         // bridge.sendCmd({command: 'log', msg: 'runner.js: all-test-results'});
      //         bridge.sendCmd({command: 'done'});
      //         // bridge.stop();
      //         //writer.call(process.stdout, '{"results": ' + JSON.stringify(data) + '}\n');
      //       });
      //     });
      //   });
      // };

      var configureSocketToPassCommands = function() {
        var server = self.app.server;
        server.io.on('connection', function (socket) {

          var pingInterval = setInterval(function() {
            socket.emit('server-ping', '', function() {
              log('server-ping ack');
            });
          }, 1000);

          log('new connection');

          currentSocket = socket;

          socket.on('disconnect', function() {
            clearInterval(pingInterval);
            log('socket disconnect');
          });

          socket.on('ping', function(data, fn) {
            log('browser >>> ping', data);
            fn();
            // bridge.sendCmd({command: 'log', msg: 'runner.js: got ping'});
          });


          socket.on('start-next-test-ack', function (data, fn) {
            log('browser >>> start-next-test-ack, newHref: ' + data.newHref);
            fn()
            // bridge.sendCmd({command: 'log', msg: 'runner.js: browser sent start-next-test-ack'});
          });

          socket.on('test-resume-ack', function (data) {
            clearTimeout(resumeAckTimeout);
            bridge.sendCmd({command: 'test-resume-ack'});
          });

          socket.on('test-pause', function (data) {
            bridge.sendCmd({command: 'test-pause'});
          });

          socket.on('all-test-results', function (data) {
            clearInterval(pingTimer);
            if ( !gotFirstAllTestsMsg ) {
              gotFirstAllTestsMsg = true;
              log('Browser loaded and ready');
              return;
            }
            if ( !bridge.currentRunId ) {
              log('got all-test-results without bridge.currentRunId');
              return;
            }
            // log('browser >>> all-test-results >>> python(done)', data);
            var msg = {
              command: 'done', 
              result: true,
              data: data,
              error: null
            };
            if ( data.failed === 0 ) {
              if ( data.passed > 0 ) {
                log('Tests PASSED:')
                data.tests.forEach(function(t) {
                  log('' + t.id + '. ' + t.name);
                });
              } else {
                msg.result = false;
                msg.error = 'No tests found for filter ' + lastFilter;
                log('No tests found for filter ' + lastFilter);
              }
            } else {
              log('Tests FAILED');
              msg.result = false;
              msg.error = 'ERROR';
              var str;
              try {
                str = JSON.stringify(data, '', '  ');
                msg.error = str;
              } catch(e) {
                str = data;
              }
              log(str);
            }
            log('------------------------------------------------------------------------------------');
            
            // bridge.sendCmd({command: 'log', msg: 'runner.js: all-test-results: ' + JSON.stringify(data)});
            bridge.sendCmd(msg);
            // bridge.stop();
            //writer.call(process.stdout, '{"results": ' + JSON.stringify(data) + '}\n');
          });
        });
      }

      this.configureLogging();
      config.read(function () {
        self.app = new App(config, finalizer)
        self.app.start();

        if (appMode == 'ci') {
          // configureSocket();
          self.app.server.on('server-start', configureSocketToPassCommands);
        } else if (appMode == 'dev') {
          var origConfigure = self.app.configure;
          setTimeout(configureSocketToPassCommands, 1000);
          self.app.configure = function (cb) {
            origConfigure.call(self.app, function () {
              cb.call(this);
              // configureSocket();
            });
          };
        }
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
    bridge.sendCmd({command: 'interrupted'});
    bridge.stop();
  }
}


process.on('SIGINT', end);
process.on('exit', function(code) {
  console.log('runner exit' + code);
});
process.on('uncaughtException', function (err) {
  log('Uncaught global exception in testem-wrap', err.message, err.stack);
  console.error('Uncaught global exception in testem-wrap', new Date());
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

