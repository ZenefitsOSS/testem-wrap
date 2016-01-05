var http = require('http');
var redis = require('redis');
var domain = require('domain');
var util = require('util');
var EventEmitter = require('events').EventEmitter
var REDIS_CHANNEL_IN = 'testem-wrap-proxy-bridge-python-js';
var REDIS_CHANNEL_OUT = 'testem-wrap-proxy-bridge-js-python';
var uuid = require('uuid');

var log = function() {
  var args = Array.prototype.slice.call(arguments);
  args.unshift('testServer:bridge:');
  console.log.apply(console, args);
}

var _expectBody = function (req) {
  var contentType = req.headers['content-type'];
  // Buffer the body if needed
  return ((req.method == 'POST' || req.method == 'PUT') &&
    (contentType && (contentType.indexOf('form-urlencoded') > -1 ||
    contentType.indexOf('application/json') > -1)));
};

var Bridge = function (channelUuid, httpPort) {
  var inClient = redis.createClient();
  var outClient = redis.createClient();

  inClient.on('error', console.error);
  outClient.on('error', console.error);

  this.channelIn = [REDIS_CHANNEL_IN, channelUuid].join('-');
  this.channelOut = [REDIS_CHANNEL_OUT, channelUuid].join('-');
  this.server = http.createServer();
  this.retries = 0;
  this.inClient = inClient;
  this.outClient = outClient;
  this.inFlight = {};
  this.httpPort = httpPort;
};

util.inherits(Bridge, EventEmitter);

Bridge.prototype.start = function () {
  var server = this.server;
  var client = this.inClient;

  server.addListener('request', this.acceptRequest.bind(this));
  server.addListener('error', this.handleServerError.bind(this));

  this.startServer();

  client.subscribe(this.channelIn);
  client.on('message', this.handleInMessage.bind(this));
};

Bridge.prototype.handleServerError = function (err) {
  if (err.code == 'EADDRINUSE') {
    this.retries++;
    if (this.retries > 6) {
      throw new Error('Could not bind the testem-wrap proxy server to the right port');
    }
    // Try restarting with exponential backoff -- 1, 2, 4, 8, 16, 32 seconds
    log('handleServerError');
    setTimeout(this.startServer.bind(this), Math.pow(2, this.retries) * 500);
  }
  else {
    throw new Error('Something went wrong starting the testem-wrap proxy server.');
  }
};

Bridge.prototype.startServer = function () {
  log('start http proxy server at ' + this.httpPort);
  this.server.listen(this.httpPort, '127.0.0.1');
};

Bridge.prototype.acceptRequest = function (req, resp) {
  var self = this;
  var dmn = domain.create();
  var handle = this.handleRequest.bind(this);
  var body = '';

  dmn.on('error', function (err) {
    resp.writeHead(500, {'Content-Type': 'text/plain'});
    resp.write(err.message || 'Something went wrong');
    resp.end();
  });
  dmn.add(req);
  dmn.add(resp);

  dmn.run(function () {
    // Buffer the body if needed
    if (_expectBody(req)) {
      // FIXME: Assumes the entire request body is in the buffer,
      // not streaming request
      req.addListener('readable', function (data) {
        var chunk;
        while ((chunk = req.read())) {
          body += chunk;
        }
      });

      req.addListener('end', function () {
        req.body = body;
        handle(req, resp);
      });
    }
    else {
      handle(req, resp);
    }
  });
};

Bridge.prototype.handleRequest = function  (req, resp) {
  var _this = this;
  var id = uuid.v4();
  var req = {
    reqId: id,
    method: req.method,
    contentType: req.headers['content-type'],
    url: req.url,
    body: req.body || null,
    qs: req.url.split('?')[1] || null
  };
  var message = {
    type: 'api-request',
    data: req
  };
  this.inFlight[id] = {
    req: req,
    resp: resp,
    time: Date.now(),
    // pingInterval: setInterval(function() {
    //   _this.sendCmd({command: 'ping'});
    // }, 5000)
  };
  resp.socket.setTimeout(0);
  // log('proxied api request ' + req.method.toUpperCase() + ' ' + req.url, req);
  log([
    'API request >>> ',
    id,
    req.method.toUpperCase(),
    req.url
  ].join(' '));
  // setTimeout(function() {
    // log('1proxied api request ' + req.method.toUpperCase() + ' ' + req.url);
    this.outClient.publish(this.channelOut, JSON.stringify(message));
  // }.bind(this), 1500);
};

Bridge.prototype.handleInMessage = function (channel, messageJson) {
  var message = JSON.parse(messageJson);
  if (channel == this.channelIn) {
    if ( message.type === 'stopped' ) {
      log('py bridge stopped')
      return;
    }

    if ( message.type === 'api-response' ) {
      var current = this.inFlight[message.data.reqId];
      if ( !current ) {
        return;
      }
      var resp = current.resp;
      clearInterval(current.pingInterval);
      delete this.inFlight[message.data.reqId];
      
      // log('got api response ' + message.data.status_code + ' ' + current.req.method.toUpperCase() + ' ' + 
      //     current.req.url, message.data.content);
      
      var reqTime = (Date.now() - current.time)/1000;
      var bodyStr = current.req.body ? '\n' + JSON.stringify(current.req.body, '', '  ') : '';
      log([
        'API request <<< ' + reqTime + 's,',
        message.data.reqId,
        message.data.status_code,
        current.req.method.toUpperCase(),
        current.req.url,
        bodyStr
      ].join(' '));
      
      if ( reqTime > 120 ) {
        log('WARNING, SLOW API ^^^');
      }
      
      var content = message.data.content.length ? message.data.content : '{}';
      // setTimeout(function(){
        resp.writeHead(message.data.status_code, {
          'Content-Type': message.data.content_type,
          'Content-Length': Buffer.byteLength(content)
        });
        resp.write(content); // default empty error content to get response object to parse properly
        resp.end();
      // }, 2*61*1000);
      
    } else if ( message.type === 'command') {
      if ( message.data.command === 'test-resume' ) {
        this.emit('test-resume');
      } else if ( message.data.command === 'start-next-test' ) {
        // this.sendCmd({command: 'log', msg: 'proxy_bridge.js: start-next-test' + JSON.stringify(message.data) });
        this.emit('start-next-test', message.data);
      }
    }
  }
};

Bridge.prototype.stop = function () {
  this.server.close();
  this.inClient.end();
  this.outClient.end();
};

Bridge.prototype.sendCmd = function (message) {
  this.outClient.publish(this.channelOut, JSON.stringify({
    type: 'cmd',
    data: message
  }));
};

exports.Bridge = Bridge;
