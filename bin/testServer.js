process.chdir(process.cwd());

var debug = require('debug');
debug.enable('testServer:*');
var log = debug('testServer:');
var runnerLogPrefix = 'testServer:runner:';
var bridgeLogPrefix = 'testServer:bridge:';
var logRunner = debug(runnerLogPrefix);
var logBridge = debug(bridgeLogPrefix);
log('Start server');
log('---------------------------')


var path = require('path');
var spawn = require('child_process').spawn;
var fs = require('fs');
var uuid = require('uuid');
var redis = require('redis');
var CONSTANTS = require('../lib/constants');
var channelUuid = uuid.v4();
var appPath = process.argv[2];
var proxyPort = process.argv[3];
var testemPort = process.argv[4];
var isChrome = process.argv[5];
var testemPath = './node_modules/testem';
var tempConfigPath = path.join(process.cwd(), appPath, 'tmp/testem.json');
var config = require('../testem.json');
log('default config', config, appPath, proxyPort, isChrome);

var redisInClient = redis.createClient();
var redisOutClient = redis.createClient();
var channelIn = [CONSTANTS.REDIS_CHANNEL_IN, channelUuid].join('-');
var channelOut = [CONSTANTS.REDIS_CHANNEL_OUT, channelUuid].join('-');

// Write testem.json config into app's temp dir with correct port
Object.keys(config.proxies).forEach(function(proxyPath) {
  config.proxies[proxyPath].target = config.proxies[proxyPath].target.replace(/:[0-9]+$/, ':' + proxyPort);
});

config.channelUuid = channelUuid;
// config.proxyPort = proxyPort;
// log('temp config', config);

fs.writeFileSync(tempConfigPath, JSON.stringify(config, '', '  '));


// run runner.js in child process
var ch = spawn('node', [
  './node_modules/testem-wrap/bin/runner.js',
  appPath,
  'dev',
  '--port=' + testemPort,
  '--file=' + tempConfigPath,
  '--test_page=tests/index.html?nojshint=1&module_filter=%5E.*acceptance.*%24&filter=empty_filter',
  '--launch=' + (isChrome === 'chrome' ? 'Chrome' : 'PhantomJS'),
  '--channel_uuid=' + channelUuid,
  '--proxy_port=' + proxyPort
], {
  // cwd: './'
});

ch.stdout.on('data', function (data, a, b) {
  // console.log('runner stdout: ' + data);
  var msg = data.toString().trim();
  if ( msg.indexOf(runnerLogPrefix) === 0 ) {
    logRunner(msg.substr(runnerLogPrefix.length));
  }
  if ( msg.indexOf(bridgeLogPrefix) === 0 ) {
    logBridge(msg.substr(bridgeLogPrefix.length));
  }
});

ch.stderr.on('data', function (data) {
  // console.log('runner stderr: ' + data.toString().trim());
  // var msg = data.toString().trim();
  // var idx = msg.indexOf('testServer:runner:');
  // if ( idx !== -1 ) {
  //   logRunner(msg.substr(idx));
  // }
});

ch.on('error', function (err) {
  // console.log('error ', err);
});

ch.on('close', function (code) {
  console.log('close');
  process.exit();
});

function killRunner() {
  ch.kill();
  process.exit();
}

process.on('SIGINT', killRunner);
process.on('exit', killRunner);
process.on('error', function() {
  try {
    killRunner();
  } catch(e) {}
});
process.on('uncaughtException', function (err) {
  try {
    killRunner();
  } catch(e) {}
});
